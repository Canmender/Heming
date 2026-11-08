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

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 目标不存在 */
  }
  fs.renameSync(tmp, file);
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
    writeJsonAtomic(registryPath(), data);
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

    try {
      removeDir(targetDir);
      fs.mkdirSync(pluginDir(id), { recursive: true });
      fs.renameSync(staging, targetDir);
    } catch (err) {
      removeDir(staging);
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
    if (existing) Object.assign(existing, record);
    else data.plugins.push(record);

    // 切指针（先写 current.json 再写注册表：中途失败时下次启动自检会发现目录齐但
    // 注册表未更新，重新安装即可；不会出现"注册表指向不存在的版本"）
    try {
      writeJsonAtomic(path.join(pluginDir(id), CURRENT_FILE), { version });
    } catch (err) {
      return { ok: false, error: `写入版本指针失败：${(err && err.message) || err}` };
    }
    save();

    // 旧版本目录清理（升级路径）：只保留 current
    for (const entry of fs.readdirSync(pluginDir(id), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === version) continue;
      removeDir(path.join(pluginDir(id), entry.name));
    }

    if (previous && previous !== version) log(`[widgets] ${id} 已从 ${previous} 升级到 ${version}`);
    else log(`[widgets] ${id}@${version} 安装完成`);
    return { ok: true, record: recordOf(find(id)) };
  }

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
    // 先删文件目录（含 current.json 与所有版本），再删记录
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      entries = []; // 目录已经不在（自检已标 error 的记录）：只删注册表记录即可
    }
    for (const entry of entries) {
      if (entry.isDirectory()) removeDir(path.join(base, entry.name));
      else if (!keepData || (entry.name !== SETTINGS_FILE && entry.name !== STATE_FILE)) {
        try {
          fs.rmSync(path.join(base, entry.name), { force: true });
        } catch {
          /* 已不在 */
        }
      }
    }
    if (keepData) {
      if (settings) writeJsonAtomic(path.join(base, SETTINGS_FILE), settings);
      if (state) writeJsonAtomic(path.join(base, STATE_FILE), state);
    } else {
      removeDir(base);
    }
    data.plugins = data.plugins.filter((item) => item.id !== id);
    save();
    log(`[widgets] ${id} 已卸载`);
    return { ok: true };
  }

  function setEnabled(id, enabled) {
    const plugin = find(id);
    if (!plugin) return { ok: false, error: `插件不存在：${id}` };
    plugin.enabled = enabled === true;
    plugin.updatedAt = new Date(now()).toISOString();
    save();
    return { ok: true, record: recordOf(plugin) };
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
    seedLegacyState,
    migrateLegacy,
    _internal: { resolveSettings, coerceSetting },
  };
  return api;
}

module.exports = { createPluginStore, resolveSettings, coerceSetting, REGISTRY_FILE, CURRENT_FILE, STATE_FILE, SETTINGS_FILE };
