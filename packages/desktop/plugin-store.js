"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readPackage, normalizeBundleCommands } = require("./plugin-package");

/**
 * 界面插件的本机注册表（主进程持有，规格 §3.1）。
 *
 * 目录布局（`<userData>/plugins`）：
 * ```
 * installed.json                 # [{id, version, enabled, packageSha256, installedAt, widget, permissions}]
 * heming.pet/current.json        # {"version":"1.0.0"}
 * heming.pet/1.0.0/plugin.json + files/**
 * heming.pet/state.json          # 窗口几何/缩放/穿透/可见（原 pet-state.json 迁移）
 * heming.pet/settings.json       # 表单值（原 heming.pet.v1 迁移）
 * heming.pet/data/<key>.json     # 插件自有业务数据（通用 data API，单文件 ≤1MB）
 * .staging/<id>-<version>-<pid>  # 解包中转，全部校验通过后 rename 到位
 * ```
 *
 * ★ 为什么注册表在主进程而不是 localStorage：窗口是主进程建的，安装状态必须
 *   在窗口之前就可用；而且渲染层（哪怕是主窗）不该通过 localStorage 决定
 *   "哪个插件有权限建窗口"。
 * ★ 所有写盘走 tmp + rename：装到一半断电不能留下半个 installed.json。
 * ★ 升级保留 settings/state：用户调过的位置与绑定不该因为插件更新丢掉。
 */

const REGISTRY_FILE = "installed.json";
const CURRENT_FILE = "current.json";
const STATE_FILE = "state.json";
const SETTINGS_FILE = "settings.json";
const STAGING_DIR = ".staging";

/** 插件自有数据（不是用户偏好）：`<userData>/plugins/<id>/data/<key>.json`。 */
const DATA_DIR = "data";
/** key 允许字符：小写/大写字母、数字、点、下划线、连字符；长度 1–64（见 `assertDataKey`）。 */
const DATA_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** 单文件上限 1MB：超了报错而不是截断（截断的 JSON 比报错更难查）。 */
const DATA_MAX_BYTES = 1024 * 1024;
const DATA_EXT = ".json";
/** 插件 id 的形状（与 plugin-package 的 ID_RE 同源）：`data` 路径拼接前再兜一次。 */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function writeTextAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 目标不存在 */
  }
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file, value) {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 校验插件数据 key，非法直接抛可读错误（读写删一律先过这一关）。
 *
 * 规则：`[A-Za-z0-9._-]{1,64}`，且不允许 `..` / `.` / 空。路径分隔符本来就不在
 * 字符集里，这里显式挡 `..` 是为了「即使以后有人放宽字符集」也不至于穿越。
 */
function assertDataKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("插件数据 key 必须是非空字符串");
  }
  if (key.length > 64) {
    throw new Error(`插件数据 key 过长（上限 64，实际 ${key.length}）：${key.slice(0, 32)}…`);
  }
  if (key === "." || key.includes("..") || !DATA_KEY_RE.test(key)) {
    throw new Error(`插件数据 key 不合法：${JSON.stringify(key)}（只允许字母/数字/./_/-，不含 ".."，长度 1–64）`);
  }
  return key;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 已经不在 */
  }
}

/** 设置值的类型收敛：只接受清单声明过、且取值合法的项（渲染层是可信的，但主进程有最终解释权）。 */
function coerceSetting(field, value) {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case "select": {
      const options = Array.isArray(field.options) ? field.options : [];
      return options.some((option) => option.value === value) ? value : undefined;
    }
    case "agent":
      return value === null || typeof value === "string" ? value : undefined;
    case "text":
    default:
      return typeof value === "string" ? value.slice(0, 500) : undefined;
  }
}

/** 按清单字段给一份完整设置（缺省值 + 已存值）。 */
function resolveSettings(widget, stored) {
  const values = {};
  const fields = (widget && widget.settings && widget.settings.fields) || [];
  const input = stored && typeof stored === "object" ? stored : {};
  for (const field of fields) {
    const coerced = coerceSetting(field, input[field.key]);
    if (coerced !== undefined) values[field.key] = coerced;
    else if (field.default !== undefined) values[field.key] = field.default;
  }
  return values;
}

/**
 * @param {object} options
 * @param {string} options.dir `<userData>/plugins`
 * @param {(line: string) => void} [options.log]
 * @param {() => number} [options.now]
 */
function createPluginStore(options = {}) {
  const dir = options.dir;
  if (typeof dir !== "string" || !dir) throw new Error("plugin-store: 缺少 dir");
  const log = options.log || (() => {});
  const now = options.now || (() => Date.now());
  // 注入点（审计 P1-4）：测试用来制造「注册表写失败」「目录删失败」，生产用默认实现。
  const writeJson = options.writeJson || writeJsonAtomic;
  const removeDirectory = options.removeDir || removeDir;

  let data = { plugins: [] };

  const registryPath = () => path.join(dir, REGISTRY_FILE);
  const pluginDir = (id) => path.join(dir, id);
  const versionDir = (id, version) => path.join(pluginDir(id), version);
  const stagingDir = (id, version) => path.join(dir, STAGING_DIR, `${id}-${version}-${process.pid}`);

  function currentVersion(id) {
    const record = find(id);
    return record ? record.version : null;
  }

  /** 当前版本目录（协议服务与窗口加载都从这里取文件）。 */
  function currentDir(id) {
    const version = currentVersion(id);
    if (!version) return null;
    return versionDir(id, version);
  }

  function find(id) {
    return data.plugins.find((plugin) => plugin.id === id) || null;
  }

  function save() {
    writeJson(registryPath(), data);
  }

  /** 事务化安装/卸载用：先写一份「候选注册表」，成功后再切换内存引用（审计 P1-4）。 */
  function saveData(nextData) {
    writeJson(registryPath(), nextData);
  }

  function init() {
    fs.mkdirSync(path.join(dir, STAGING_DIR), { recursive: true });
    const raw = readJson(registryPath());
    const plugins = raw && Array.isArray(raw.plugins) ? raw.plugins : [];
    data = { plugins: plugins.filter((plugin) => plugin && typeof plugin.id === "string") };
    // 启动自检：文件缺失/半装的记录标记 error 并停用，不让宿主去建一块打不开的透明窗
    for (const plugin of data.plugins) {
      const versionDirPath = versionDir(plugin.id, plugin.version);
      const manifestPath = path.join(versionDirPath, "plugin.json");
      if (!fs.existsSync(manifestPath)) {
        plugin.error = "插件文件缺失，请重新安装";
        plugin.enabled = false;
        log(`[widgets] ${plugin.id} 文件缺失（${manifestPath}），已停用`);
        continue;
      }
      // d.109：命令面板物化读的是注册表记录；旧安装记录没有 `commands`，
      // 从当前版本的 plugin.json 回填一次（纯函数会逐项收紧，磁盘被改也不怕）。
      plugin.commands = normalizeBundleCommands(readJson(manifestPath));
    }
    save();
    return api;
  }

  function recordOf(plugin) {
    const stored = readJson(path.join(pluginDir(plugin.id), SETTINGS_FILE));
    return {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      enabled: plugin.enabled === true,
      widget: plugin.widget || null,
      permissions: plugin.permissions || null,
      settings: resolveSettings(plugin.widget, stored),
      installedAt: plugin.installedAt,
      updatedAt: plugin.updatedAt,
      signed: plugin.signed === true,
      // d.109：命令面板用（主窗 `widgets:list` 直接读；停用/损坏记录也带上，由 web 侧决定是否展示）
      commands: Array.isArray(plugin.commands) ? plugin.commands : [],
      ...(plugin.error ? { error: plugin.error } : {}),
    };
  }

  function list() {
    return data.plugins.map(recordOf);
  }

  function get(id) {
    const plugin = find(id);
    return plugin ? recordOf(plugin) : null;
  }

  /**
   * 安装 / 升级一个 `package.tgz`。
   *
   * 任一步失败都不落盘（staging 目录会被清掉），失败也不会覆盖已装版本。
   *
   * @param {{ bytes: Buffer|ArrayBuffer|Uint8Array, expectedSha256?: string }} input
   * @returns {{ ok: true, record: object } | { ok: false, error: string }}
   */
  function install(input) {
    const parsed = readPackage(input && input.bytes, {
      expectedSha256: input && input.expectedSha256,
    });
    if (!parsed.ok) {
      return { ok: false, error: parsed.errors.join("；") };
    }

    const { manifest, widget, permissions, sha256, files } = parsed;
    const id = manifest.id;
    const version = manifest.version;
    const existing = find(id);

    // 版本目录已存在（重装同一版本）：先拆掉旧目录，避免 rename 目标非空
    const targetDir = versionDir(id, version);
    const staging = stagingDir(id, version);
    removeDir(staging);
    fs.mkdirSync(staging, { recursive: true });
    try {
      for (const file of files) {
        const target = path.join(staging, file.path);
        // 包内路径已由 plugin-tar 归一化（相对、无 ..、无绝对路径），这里再兜一次
        const resolved = path.resolve(staging, file.path);
        if (resolved !== staging && !resolved.startsWith(staging + path.sep)) {
          throw new Error(`非法包内路径：${file.path}`);
        }
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, file.data);
      }
    } catch (err) {
      removeDir(staging);
      return { ok: false, error: `写入插件文件失败：${(err && err.message) || err}` };
    }

    // 覆盖同一版本时先把旧目录挪到备份位：任何后续步骤失败都能还原（审计 P1-4）
    const backupDir = `${targetDir}.${process.pid}.bak`;
    removeDir(backupDir);
    let hadTarget = false;
    try {
      fs.mkdirSync(pluginDir(id), { recursive: true });
      if (fs.existsSync(targetDir)) {
        fs.renameSync(targetDir, backupDir);
        hadTarget = true;
      }
      fs.renameSync(staging, targetDir);
    } catch (err) {
      removeDir(staging);
      try {
        if (hadTarget) fs.renameSync(backupDir, targetDir);
      } catch {
        /* 尽力还原 */
      }
      return { ok: false, error: `落盘失败：${(err && err.message) || err}` };
    }

    const timestamp = new Date(now()).toISOString();
    const previous = existing ? existing.version : null;
    const record = {
      id,
      name: typeof manifest.name === "string" ? manifest.name : id,
      version,
      enabled: existing ? existing.enabled !== false : true,
      packageSha256: sha256,
      installedAt: existing ? existing.installedAt : timestamp,
      updatedAt: timestamp,
      widget,
      permissions,
      // 包是否带 ed25519 签名；d.105 起 readPackage 已强制首方验签，能走到这里即已通过
      signed: parsed.signed === true,
      publisherId: parsed.publisherId,
      // d.109：命令面板物化（target 已由 readPackage 按 bundle 允许集合收紧）
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      migratedAt: existing ? existing.migratedAt || null : null,
    };
    // 内存不原地改：先在候选注册表里生成，等两处落盘都成功后再切换（失败可完整回滚）
    const nextPlugins = existing
      ? data.plugins.map((item) => (item.id === id ? { ...item, ...record } : item))
      : [...data.plugins, record];
    const nextData = { plugins: nextPlugins };
    const currentPath = path.join(pluginDir(id), CURRENT_FILE);
    const previousCurrent = readJson(currentPath);

    const rollbackInstall = () => {
      try {
        removeDir(targetDir);
      } catch {
        /* 尽力 */
      }
      if (hadTarget) {
        try {
          fs.renameSync(backupDir, targetDir);
        } catch {
          /* 尽力 */
        }
      }
      try {
        if (previousCurrent) writeJsonAtomic(currentPath, previousCurrent);
        else fs.rmSync(currentPath, { force: true });
      } catch {
        /* 尽力 */
      }
    };

    // 提交顺序：版本指针 → 注册表 → 内存。任一步失败：目录回到备份位、指针还原，
    // 注册表保持旧内容（下次启动自检不会出现「指针指向不存在版本」的悬空态）。
    try {
      writeJson(currentPath, { version });
    } catch (err) {
      rollbackInstall();
      removeDir(staging);
      return { ok: false, error: `写入版本指针失败：${(err && err.message) || err}` };
    }
    try {
      saveData(nextData);
    } catch (err) {
      rollbackInstall();
      removeDir(staging);
      return { ok: false, error: `写入插件注册表失败：${(err && err.message) || err}` };
    }
    data = nextData; // 两处落盘成功后才切换内存
    removeDir(backupDir);

    // 旧版本目录清理（升级路径）：只保留 current。
    // ★ `data/` 是用户/插件数据，不是版本目录，升级必须原样保留（否则一升级就清空）。
    for (const entry of fs.readdirSync(pluginDir(id), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === version || entry.name === DATA_DIR) continue;
      removeDir(path.join(pluginDir(id), entry.name));
    }

    if (previous && previous !== version) log(`[widgets] ${id} 已从 ${previous} 升级到 ${version}`);
    else log(`[widgets] ${id}@${version} 安装完成`);
    return { ok: true, record: recordOf(find(id)) };
  }

  /**
   * 卸载（审计 P1-4 事务化：先摘记录落盘，成功后再删文件）。
   *
   * - 注册表写失败 → 直接返回错误，**文件与记录都不动**（用户可重试）；
   * - 记录摘除成功但删文件失败 → 记录以 `error` 状态写回（「卸载未完成」），
   *   界面能看到并可重试，不会出现「文件还在、列表里却消失了」的空账；
   * - 文件目录本来就不在（自检标 error 的记录）→ 只摘记录即可成功。
   *
   * ★ `removeData:false` 只保留 `settings.json` / `state.json`（用户偏好），
   *   其余目录——包括插件自己的 `data/`——一样随插件删除（卸载即删）。
   */
  function uninstall(id, uninstallOptions = {}) {
    const plugin = find(id);
    if (!plugin) return { ok: false, error: `插件不存在：${id}` };
    const base = pluginDir(id);
    const keepData = uninstallOptions.removeData === false;
    let settings = null;
    let state = null;
    if (keepData) {
      settings = readJson(path.join(base, SETTINGS_FILE));
      state = readJson(path.join(base, STATE_FILE));
    }

    // 1) 先在候选注册表里摘掉记录并落盘；失败则 untouched（文件/内存都不动）
    const nextPlugins = data.plugins.filter((item) => item.id !== id);
    const nextData = { plugins: nextPlugins };
    try {
      saveData(nextData);
    } catch (err) {
      return { ok: false, error: `卸载失败（未改动本机文件）：${(err && err.message) || err}` };
    }
    data = nextData;

    // 2) 记录已摘除，再删文件。失败时把记录以 error 状态写回（不谎报成功）。
    const deletionErrors = [];
    const removeFile = (target) => {
      try {
        fs.rmSync(target, { force: true });
      } catch (err) {
        deletionErrors.push(`${path.basename(target)}：${(err && err.message) || err}`);
      }
    };
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      entries = []; // 目录已经不在（自检标 error 的记录）：只摘记录即可
    }
    for (const entry of entries) {
      const target = path.join(base, entry.name);
      if (entry.isDirectory()) {
        try {
          removeDirectory(target);
        } catch (err) {
          deletionErrors.push(`${entry.name}/：${(err && err.message) || err}`);
        }
      } else if (!keepData || (entry.name !== SETTINGS_FILE && entry.name !== STATE_FILE)) {
        removeFile(target);
      }
    }
    if (keepData) {
      try {
        if (settings) writeJsonAtomic(path.join(base, SETTINGS_FILE), settings);
        if (state) writeJsonAtomic(path.join(base, STATE_FILE), state);
      } catch (err) {
        deletionErrors.push(`保留设置/状态写回失败：${(err && err.message) || err}`);
      }
    } else {
      try {
        removeDirectory(base);
      } catch (err) {
        deletionErrors.push(`插件目录：${(err && err.message) || err}`);
      }
    }

    if (deletionErrors.length > 0) {
      // 记录写回「卸载未完成」状态（写回失败只能靠日志，尽力而为）
      const broken = {
        ...plugin,
        error: `卸载未完成：${deletionErrors.join("；")}（可重试卸载）`,
        enabled: false,
      };
      data = { plugins: [...data.plugins, broken] };
      try {
        saveData(data);
      } catch (err) {
        log(`[widgets] ${id} 卸载后写回 error 记录失败：${(err && err.message) || err}`);
      }
      log(`[widgets] ${id} 卸载未完成：${deletionErrors.join("；")}`);
      return { ok: false, error: `卸载未完成：${deletionErrors.join("；")}（可重试卸载）` };
    }

    log(`[widgets] ${id} 已卸载`);
    return { ok: true };
  }

  function setEnabled(id, enabled) {
    const plugin = find(id);
    if (!plugin) return { ok: false, error: `插件不存在：${id}` };
    // 与 install/uninstall 同一事务口径：先落盘候选注册表，成功后再切内存（P1-4 同类）
    const nextData = {
      plugins: data.plugins.map((item) =>
        item.id === id
          ? { ...item, enabled: enabled === true, updatedAt: new Date(now()).toISOString() }
          : item,
      ),
    };
    try {
      saveData(nextData);
    } catch (err) {
      return { ok: false, error: `切换失败（未改动）：${(err && err.message) || err}` };
    }
    data = nextData;
    return { ok: true, record: recordOf(find(id)) };
  }

  function settingsFile(id) {
    return path.join(pluginDir(id), SETTINGS_FILE);
  }

  function readSettings(id) {
    const plugin = find(id);
    if (!plugin) return {};
    return resolveSettings(plugin.widget, readJson(settingsFile(id)));
  }

  /** 合并写入（只接受清单声明的字段）；返回合并后的全量。 */
  function patchSettings(id, patch) {
    const plugin = find(id);
    if (!plugin || !plugin.widget) return {};
    const fields = (plugin.widget.settings && plugin.widget.settings.fields) || [];
    const current = readSettings(id);
    const next = { ...current };
    const input = patch && typeof patch === "object" ? patch : {};
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(input, field.key)) continue;
      const coerced = coerceSetting(field, input[field.key]);
      if (coerced !== undefined) next[field.key] = coerced;
    }
    writeJsonAtomic(settingsFile(id), next);
    return next;
  }

  function stateFile(id) {
    return path.join(pluginDir(id), STATE_FILE);
  }

  function readState(id) {
    return readJson(stateFile(id));
  }

  function writeState(id, state) {
    if (!find(id)) return;
    writeJsonAtomic(stateFile(id), state && typeof state === "object" ? state : {});
  }

  /* ───────────────────── 插件自有数据（通用 data API） ───────────────────── */

  /**
   * 插件数据目录：`<userData>/plugins/<id>/data`（绝对路径，不保证已存在）。
   *
   * ★ 这是「插件自己的业务数据」的默认落点：与 settings/state 同属安装目录，
   *   卸载即随插件删除，不写 localStorage、不随插件包分发、不上云。
   */
  function dataDirOf(id) {
    if (typeof id !== "string" || !PLUGIN_ID_RE.test(id)) {
      throw new Error(`插件 id 不合法，拒绝解析数据目录：${JSON.stringify(id)}`);
    }
    return path.join(pluginDir(id), DATA_DIR);
  }

  /** key → 绝对文件路径；key 非法一律抛可读错误（所有读写删先过这里）。 */
  function dataFileOf(id, key) {
    assertDataKey(key);
    const dir = dataDirOf(id);
    const file = path.join(dir, `${key}${DATA_EXT}`);
    // 字符集已经排除分隔符，这里再确认落点确实在 data/ 内（纵深防御）
    if (path.dirname(file) !== dir) {
      throw new Error(`插件数据 key 不合法：${JSON.stringify(key)}`);
    }
    return file;
  }

  /** 读一个 key；文件不存在 / JSON 坏了都返回 null（读失败不该把插件页面搞崩）。 */
  function readData(id, key) {
    return readJson(dataFileOf(id, key));
  }

  /**
   * 写一个 key（JSON only，单文件 ≤1MB）。
   *
   * 写失败**抛错**（与读相反）：插件必须知道自己没存上，而不是以为存上了。
   * @returns {{ key: string, bytes: number }}
   */
  function writeData(id, key, value) {
    const file = dataFileOf(id, key);
    if (!find(id)) throw new Error(`插件不存在：${id}`);
    let serialized;
    try {
      serialized = JSON.stringify(value, null, 2);
    } catch (err) {
      throw new Error(`插件数据无法序列化为 JSON（${key}）：${(err && err.message) || err}`);
    }
    if (serialized === undefined) {
      throw new Error(`插件数据必须是可 JSON 序列化的值（${key}）：不接受 undefined / 函数 / Symbol`);
    }
    const text = `${serialized}\n`;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > DATA_MAX_BYTES) {
      throw new Error(`插件数据超过单文件上限 1MB（${key}）：${bytes} 字节`);
    }
    writeTextAtomic(file, text);
    return { key, bytes };
  }

  /** 删一个 key；返回「是否真的删掉了文件」（不存在 = false，不算错误）。 */
  function deleteData(id, key) {
    const file = dataFileOf(id, key);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  }

  /** 列出已有 key（只认 `*.json`，tmp/其他文件一律忽略；文件系统不支持时返回空数组）。 */
  function listDataKeys(id) {
    const dir = dataDirOf(id);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return []; // data/ 还没建
    }
    const keys = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(DATA_EXT)) continue;
      const key = entry.name.slice(0, -DATA_EXT.length);
      if (key === "." || key.includes("..") || !DATA_KEY_RE.test(key)) continue;
      keys.push(key);
    }
    return keys.sort();
  }

  /** 老 `pet-state.json` 一次性种入（只在 state.json 不存在时写；幂等）。 */
  function seedLegacyState(id, legacyState) {
    if (!find(id)) return false;
    if (fs.existsSync(stateFile(id))) return false;
    if (!legacyState || typeof legacyState !== "object") return false;
    writeJsonAtomic(stateFile(id), legacyState);
    return true;
  }

  /**
   * 老 `localStorage["heming.pet.v1"]` 一次性并入设置（幂等；老键保留一版由 web 侧负责）。
   *
   * @param {Record<string, unknown>} prefs
   * @returns {{ ok: boolean, migrated: boolean }}
   */
  function migrateLegacy(prefs) {
    const plugin = find("heming.pet");
    if (!plugin) return { ok: true, migrated: false };
    if (plugin.migratedAt) return { ok: true, migrated: false };
    const fields = (plugin.widget && plugin.widget.settings && plugin.widget.settings.fields) || [];
    const input = prefs && typeof prefs === "object" ? prefs : {};
    const patch = {};
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(input, field.key)) patch[field.key] = input[field.key];
    }
    // 老键名与字段名不完全一致时的显式映射（d.46 的 prefs 口径）
    if (patch.agentId === undefined && typeof input.boundAgentId === "string") patch.agentId = input.boundAgentId;
    if (patch.modelPath === undefined && typeof input.model === "string") patch.modelPath = input.model;
    if (Object.keys(patch).length > 0) patchSettings(plugin.id, patch);
    // 老 prefs 的「总开关」兜底：旧版 `enabled: true` 表示用户是开着桌宠的，而
    // `pet-state.json` 可能缺失或 visible=false（异常退出的常见结果）。这种情况下
    // 用 prefs.enabled 把 state.visible 兜回 true —— 一次性（migratedAt 幂等），
    // 只补「该出现却没出现」，不覆盖用户明确关掉（两者都 false）的情况。
    if (input.enabled === true) {
      const current = readState(plugin.id);
      if (!current || current.visible !== true) {
        writeJsonAtomic(stateFile(plugin.id), {
          ...(current && typeof current === "object" ? current : {}),
          visible: true,
        });
      }
    }
    plugin.migratedAt = new Date(now()).toISOString();
    save();
    return { ok: true, migrated: true };
  }

  const api = {
    dir,
    init,
    list,
    get,
    find,
    install,
    uninstall,
    setEnabled,
    currentVersion,
    currentDir,
    readSettings,
    patchSettings,
    readState,
    writeState,
    // 插件自有数据（通用 data API）：默认落 `<userData>/plugins/<id>/data/`
    dataDirOf,
    readData,
    writeData,
    deleteData,
    listDataKeys,
    seedLegacyState,
    migrateLegacy,
    _internal: { resolveSettings, coerceSetting },
  };
  return api;
}

module.exports = {
  createPluginStore,
  resolveSettings,
  coerceSetting,
  assertDataKey,
  REGISTRY_FILE,
  CURRENT_FILE,
  STATE_FILE,
  SETTINGS_FILE,
  DATA_DIR,
  DATA_MAX_BYTES,
};
