"use strict";
/**
 * 原生知识库（vault）文件桥（桌面端主进程）。
 *
 * 为什么新建一层而不是改 `wiki-fs.js`：
 * 老 wiki 桥把根目录与允许路径都写死（`~/Heming/wiki`、三档白名单），是「一个固定库」的模型；
 * 这一轮要做的是**多库 + 任意目录 + 任意层级**（Obsidian 风格 vault），所以根必须可登记、
 * 路径必须按库根动态夹取。老桥原样保留（老用户与 `wiki_search` 工具不回归）。
 *
 * 安全模型（规格 §4，渲染层是网页内容 = 不可信输入）：
 * - 库根只来自 `vault:pick` 的系统目录对话框，**绝不接受渲染层传绝对路径**；
 * - 渲染层只传 `vaultId` + 库内相对路径，主进程每次操作都重新夹一次：
 *   `path-guard.resolveInsideRoot` + 逐级软链检查 + `fsp.realpath` 复核；
 * - 拒绝 NUL、盘符/前导分隔符（绝对路径）、`..`/`.` 段、Windows 保留名、300 字上限、
 *   Windows 非法字符；
 * - 扩展名分级：可写文本 `TEXT_EXTS`（≤ 2MB，与 wiki-fs 同口径）、只读图片 `IMAGE_EXTS`
 *   （≤ 8MB，`vault:readBinary` 转 data URL）；其它扩展名一律不可读写；
 * - 默认忽略 `.git`/`node_modules`/任何隐藏目录与文件；`.obsidian` 允许**读**但永不写
 *   （那是 Obsidian 自己的配置，写坏会连带影响用户在 Obsidian 里的库）；
 * - 删除只删单个文件、不递归；移动不跨库（本桥只有库内相对路径，天然不跨库）。
 *
 * 双写通道（规格 §0 / §4）：
 * - `vault:write`：用户在界面里编辑，库内任意可写文本路径；
 * - `vault:apply`：智能体通道，仅 `writeDirs` 内（默认 `["inbox"]`），越界返回 outside-write-dirs。
 *
 * IPC 边界约定：
 * - 每个处理器都先做类型/长度校验，**渲染层随便传什么都不能让主进程抛裸异常**；
 * - 统一返回 `{ ok: true, value }` / `{ ok: false, code, message }`（message 中文）；
 *   preload 再把失败 envelope 转成带 `code` 的 Error，交给 web 侧 bridge.ts 归一化。
 *
 * 红线：本模块只碰文件系统，不引入任何网络能力。
 */

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  MAX_PATH_CHARS,
  resolveInsideRoot,
  isReservedName,
  assertNoSymlinkAncestor,
} = require("./path-guard");
const { createVaultWatcher } = require("./vault-watch");

/** 可写文本扩展名（与 web 侧 types.ts 的 TEXT_EXTS 一致；改一处必须改两处）。 */
const TEXT_EXTS = [".md", ".canvas", ".json", ".txt", ".csv"];
/** 只读图片扩展名（与 web 侧 IMAGE_EXTS 一致）。 */
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
const TEXT_EXT_SET = new Set(TEXT_EXTS);
const IMAGE_EXT_SET = new Set(IMAGE_EXTS);
const MOVE_EXT_SET = new Set([...TEXT_EXTS, ...IMAGE_EXTS]);

/** 文本文件上限：2MB，与 `wiki-fs.js` / web 侧 `MAX_TEXT_BYTES` 同口径。 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** 图片文件上限：8MB（转 data URL 后 base64 会再膨胀约 1/3，主进程不再放大上限）。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 目录树单次返回节点上限：超大库分页懒加载，防止一次 IPC 打爆（与 web 侧一致）。 */
const MAX_TREE_NODES = 20000;
/** 目录树深度上限：懒加载的兜底，避免一次递归整棵大库。 */
const MAX_TREE_DEPTH = 6;
/** 库名长度上限。 */
const MAX_VAULT_NAME = 64;
/** 库根绝对路径长度上限（Windows 长路径已按前缀处理，这里只防明显异常输入）。 */
const MAX_ROOT_CHARS = 1000;
/** 智能体默认可写目录（规格 §4：默认 inbox）。显式空数组表示「智能体对本库只读」。 */
const DEFAULT_WRITE_DIRS = ["inbox"];
/** 目录树里恒定跳过的目录名（隐藏目录另按 `.` 前缀判断）。 */
const IGNORED_TREE_NAMES = new Set(["node_modules"]);
/** 图片扩展名 → data URL 的 mime。 */
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** UTF-8 严格解码器：非法字节序列直接抛，用来判「这不是文本文件」。 */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** 中文路径里也不能接受的 Windows 非法字符（含控制字符）。 */
const ILLEGAL_PATH_CHARS = /[<>:"|?*\u0000-\u001f]/;
/** 非法的库名字符：换行会把 UI 列表撑坏，控制字符一并无意义。 */
const ILLEGAL_NAME_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * 桥内统一错误类型：带机器码（VaultErrorCode 的子集）与中文 message。
 * 主进程内部抛出，IPC 层统一转成 `{ok:false, code, message}`，不把裸异常漏给渲染层。
 */
class VaultError extends Error {
  /**
   * @param {string} code 机器码
   * @param {string} message 中文原因（直接给用户看）
   */
  constructor(code, message) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

/** 抛一个桥内错误。 */
function fail(code, message) {
  throw new VaultError(code, message);
}

/** 供 IPC 层统一把异常转成失败 envelope（非 VaultError 一律按 io-error 兜底）。 */
function toFailureEnvelope(error) {
  if (error instanceof VaultError) {
    return { ok: false, code: error.code, message: error.message };
  }
  const detail = error && error.message ? error.message : String(error);
  return { ok: false, code: "io-error", message: `知识库操作失败：${detail}` };
}

/** 注册表路径：环境变量优先（测试注入），否则 `~/Heming/vaults.json`。 */
function defaultRegistryFile() {
  const env = process.env.HEMING_VAULTS_FILE && process.env.HEMING_VAULTS_FILE.trim();
  return env ? path.resolve(env) : path.join(os.homedir(), "Heming", "vaults.json");
}

/** 路径比较：Windows 文件系统大小写不敏感，其它平台按原样比较。 */
function samePath(a, b) {
  const left = path.resolve(String(a));
  const right = path.resolve(String(b));
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** 库内相对路径比较：Windows 上大小写不敏感（与文件系统一致）。 */
function sameRel(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 是否等于根或落在根内（`path-guard.isInsideRoot` 不含根本身，这里补上）。 */
function isSameOrInsideRoot(rootAbs, absPath) {
  if (typeof rootAbs !== "string" || typeof absPath !== "string") return false;
  const root = path.resolve(rootAbs);
  const full = path.resolve(absPath);
  const relCheck = path.relative(root, full);
  if (relCheck === "") return true;
  return !relCheck.startsWith("..") && !path.isAbsolute(relCheck);
}

/** 取小写扩展名（含点）；没有扩展名返回空串。 */
function extOf(rel) {
  return path.extname(String(rel || "")).toLowerCase();
}

/** 把任意异常/参数字符串化，用于拼中文错误文案。 */
function textOf(value) {
  if (value instanceof Error) return value.message;
  return String(value);
}

/**
 * 校验库内相对路径并归一化（`/` 分隔、无前导/尾随分隔符）。
 *
 * ★ 这里在 `resolveInsideRoot` 之前先做一层「明显越界写法」的拒绝：
 * 共享函数为了兼容老 wiki 桥会把前导斜杠/盘符当普通字符收进根内（见 path-guard 注释），
 * 但 vault 桥的契约是**只接受库内相对路径**，盘符/绝对路径应当直接报错而不是
 * 悄悄变成一个位于库根下、名字里带 `C:` 的奇怪文件。两道一起用：这里挡写法，
 * `resolveInsideRoot` 挡真正的 `..` 逃逸。
 *
 * @param {unknown} rel 渲染层传来的相对路径
 * @param {{forRead?: boolean, allowDir?: boolean}} [options]
 * @returns {string} 归一化后的相对路径
 */
function checkRel(rel, options) {
  const opts = options && typeof options === "object" ? options : {};
  if (typeof rel !== "string" || !rel.trim()) fail("forbidden-path", "路径不能为空");
  if (rel.includes("\0")) fail("forbidden-path", "路径里含非法字符（NUL）");
  if (rel.length > MAX_PATH_CHARS) fail("forbidden-path", `路径过长（超过 ${MAX_PATH_CHARS} 字符）`);
  if (/^[a-zA-Z]:/.test(rel)) fail("forbidden-path", "只接受库内相对路径，不接受盘符路径");
  if (rel.startsWith("/") || rel.startsWith("\\")) {
    fail("forbidden-path", "只接受库内相对路径，不接受绝对路径");
  }
  if (path.isAbsolute(rel)) fail("forbidden-path", "只接受库内相对路径，不接受绝对路径");

  let norm = rel.replace(/\\/g, "/");
  if (opts.allowDir) norm = norm.replace(/\/+$/, "");
  if (!norm) fail("forbidden-path", "路径不能为空");
  const segments = norm.split("/");
  for (const segment of segments) {
    if (!segment) fail("forbidden-path", "路径里存在空目录段（连续分隔符）");
    if (segment === "." || segment === "..") fail("forbidden-path", "路径里不允许 . 或 .. 段");
    if (ILLEGAL_PATH_CHARS.test(segment)) {
      fail("forbidden-path", "路径里含 Windows 不允许的字符（< > : \" | ? * 或控制字符）");
    }
    if (isReservedName(segment)) fail("forbidden-path", `文件名是 Windows 保留名：${segment}`);
    if (segment === ".git" || segment === "node_modules") {
      fail("forbidden-path", `该目录被忽略，不可读写：${segment}`);
    }
    if (segment.startsWith(".")) {
      // `.obsidian` 是唯一例外：允许读（Obsidian 的配置/主题对展示有用），但永不写。
      if (opts.forRead && segment === ".obsidian") continue;
      fail("forbidden-path", opts.forRead ? "隐藏目录与隐藏文件不可读写" : "隐藏目录与隐藏文件不可写入");
    }
  }
  if (!opts.forRead && segments.includes(".obsidian")) {
    fail("forbidden-path", ".obsidian 是 Obsidian 自己的配置目录，和鸣永不写入");
  }
  return norm;
}

/** 文本内容校验：必须是字符串、无 NUL、不超过单文件上限；返回 UTF-8 字节数。 */
function assertTextContent(text) {
  if (typeof text !== "string") fail("forbidden-path", "写入内容必须是字符串");
  if (text.includes("\0")) fail("forbidden-path", "内容里含 NUL，拒绝写入二进制内容");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_TEXT_BYTES) {
    fail(
      "too-large",
      `内容约 ${Math.round(bytes / 1024)} KB，超过单文件上限 ${Math.round(MAX_TEXT_BYTES / 1024)} KB`,
    );
  }
  return bytes;
}

/** 可写文本扩展名校验。 */
function assertTextExt(rel) {
  const ext = extOf(rel);
  if (!TEXT_EXT_SET.has(ext)) {
    fail(
      "forbidden-ext",
      `不支持写入该类型文件：${ext || "（无扩展名）"}（可写：${TEXT_EXTS.join(" ")}）`,
    );
  }
}

/** 只读图片扩展名校验。 */
function assertImageExt(rel) {
  const ext = extOf(rel);
  if (!IMAGE_EXT_SET.has(ext)) {
    fail("forbidden-ext", `不是受支持的图片类型：${ext || "（无扩展名）"}（可读：${IMAGE_EXTS.join(" ")}）`);
  }
}

/** 库名规整：去空白、限长、拒绝控制字符；不合法抛中文错误。 */
function normalizeVaultName(name) {
  if (typeof name !== "string") fail("forbidden-path", "库名称必须是字符串");
  const trimmed = name.trim();
  if (!trimmed) fail("forbidden-path", "库名称不能为空");
  if (ILLEGAL_NAME_CHARS.test(trimmed)) fail("forbidden-path", "库名称不能包含控制字符或换行");
  if (trimmed.length > MAX_VAULT_NAME) fail("forbidden-path", `库名称过长（最多 ${MAX_VAULT_NAME} 个字符）`);
  return trimmed;
}

/**
 * 规整 `writeDirs`：逐条校验，坏条目直接丢弃（不因为一条脏配置让整库不可用）。
 *
 * 为什么拒绝空串/`/`：那等价于「整库可写」，与规格「智能体只能写指定目录」冲突；
 * 想放开整库就显式列出各顶层目录。
 *
 * @param {unknown} raw 注册表里的原始值
 * @param {boolean} [defaultIfMissing] 字段缺失时是否使用默认值（老数据兼容）
 * @returns {string[]}
 */
function normalizeWriteDirs(raw, defaultIfMissing) {
  if (raw === undefined) return defaultIfMissing === false ? [] : [...DEFAULT_WRITE_DIRS];
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const dir = item.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!dir) continue;
    if (dir.length > MAX_PATH_CHARS) continue;
    const segments = dir.split("/");
    let bad = false;
    for (const segment of segments) {
      if (!segment || segment === "." || segment === "..") {
        bad = true;
        break;
      }
      if (ILLEGAL_PATH_CHARS.test(segment) || isReservedName(segment) || segment.startsWith(".")) {
        bad = true;
        break;
      }
      if (segment === "node_modules" || segment === ".git") {
        bad = true;
        break;
      }
    }
    if (bad) continue;
    if (!out.some((existing) => sameRel(existing, dir))) out.push(dir);
  }
  return out;
}

/** 注册表条目规整：形状不对的整条丢弃（坏数据不能把它变成可用凭据）。 */
function sanitizeMeta(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && raw.id.trim() && raw.id.length <= 128 ? raw.id.trim() : null;
  const rootIsValid =
    typeof raw.root === "string" &&
    raw.root.trim() &&
    raw.root.length <= MAX_ROOT_CHARS &&
    !raw.root.includes("\0") &&
    path.isAbsolute(raw.root);
  const root = rootIsValid ? path.resolve(raw.root) : null;
  if (!id || !root) return null;
  if (!path.isAbsolute(root)) return null;
  let name = "";
  try {
    name = normalizeVaultName(typeof raw.name === "string" && raw.name.trim() ? raw.name : path.basename(root));
  } catch {
    name = path.basename(root) || "知识库";
    name = name.slice(0, MAX_VAULT_NAME) || "知识库";
  }
  const addedAt =
    typeof raw.addedAt === "string" && raw.addedAt && !Number.isNaN(Date.parse(raw.addedAt))
      ? raw.addedAt
      : new Date().toISOString();
  return {
    id,
    name,
    root,
    writeDirs: normalizeWriteDirs(raw.writeDirs),
    addedAt,
  };
}

/**
 * 读注册表。
 *
 * 返回 `{ vaults, corrupt, missing, legacyMigrated }`：
 * - 文件不存在 → 空表 + `missing`；
 * - JSON 坏了/形状不对 → 空表 + `corrupt`（**不覆盖原文件**；后续写注册表会先把它备份）；
 * - 读文件的其他 IO 失败也按 corrupt 处理：宁可保守地不覆盖，也不要把用户的注册表写丢。
 *
 * @param {string} registryFile
 */
async function readRegistry(registryFile) {
  let raw;
  try {
    raw = await fsp.readFile(registryFile, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { vaults: [], corrupt: false, missing: true, legacyMigrated: false };
    }
    return { vaults: [], corrupt: true, missing: false, legacyMigrated: false };
  }
  try {
    const parsed = JSON.parse(raw);
    let list = null;
    let legacyMigrated = false;
    if (Array.isArray(parsed)) {
      // 兼容最早可能出现的裸数组形态（本分支尚未发布，但读旧文件不亏）
      list = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.vaults)) {
      list = parsed.vaults;
      legacyMigrated = parsed.legacyMigrated === true;
    }
    if (!list) throw new Error("vaults 不是数组");
    const vaults = [];
    for (const item of list) {
      const meta = sanitizeMeta(item);
      if (!meta) continue;
      if (vaults.some((existing) => samePath(existing.root, meta.root))) continue;
      vaults.push(meta);
    }
    return { vaults, corrupt: false, missing: false, legacyMigrated };
  } catch {
    return { vaults: [], corrupt: true, missing: false, legacyMigrated: false };
  }
}

/**
 * 写注册表（原子写：先写同目录 tmp 再 rename）。
 *
 * 坏 JSON 的「不覆盖原文件」：写入前若发现原文件解析不了，先把它改名成
 * `vaults.json.corrupt-<时间戳>`（保留用户数据），再写新表；改名失败就拒绝写入。
 *
 * @param {string} registryFile
 * @param {Array} vaults 已规整的库列表
 * @param {{legacyMigrated?: boolean}} [extra]
 */
async function saveRegistry(registryFile, vaults, extra) {
  const file = path.resolve(registryFile);
  const dir = path.dirname(file);
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (error) {
    fail("io-error", `创建知识库注册表目录失败：${textOf(error)}`);
  }
  const existing = await readRegistry(file);
  if (existing.corrupt) {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await fsp.rename(file, backup);
    } catch (error) {
      fail("io-error", `注册表已损坏且无法备份，为避免覆盖原文件已拒绝写入：${textOf(error)}`);
    }
  }
  const payload = {
    version: 1,
    legacyMigrated: Boolean(extra && extra.legacyMigrated),
    vaults,
  };
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fsp.rename(tmp, file);
  } catch (error) {
    try {
      await fsp.unlink(tmp);
    } catch {
      /* 清理失败不改变结论：原注册表未被覆盖 */
    }
    fail("io-error", `写入知识库注册表失败：${textOf(error)}`);
  }
}

/** 新建库条目的默认值。 */
function createMeta(root, name) {
  return {
    id: crypto.randomUUID(),
    name,
    root,
    writeDirs: [...DEFAULT_WRITE_DIRS],
    addedAt: new Date().toISOString(),
  };
}

/**
 * 校验用户从系统对话框选中的目录（库根）。
 *
 * 为什么拒绝磁盘根：把 `D:\` 登记成库等于把整盘纳入索引与监听，
 * 与「知识库是用户圈定的一块目录」这个前提冲突（file-fs 也有同样的盘符根拒绝）。
 *
 * @param {unknown} candidate 系统对话框返回的路径
 * @returns {Promise<string>} 规整后的绝对路径
 */
async function validateVaultRoot(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) fail("forbidden-path", "目录路径不能为空");
  if (candidate.includes("\0")) fail("forbidden-path", "目录路径里含非法字符（NUL）");
  if (candidate.length > MAX_ROOT_CHARS) fail("forbidden-path", "目录路径过长");
  if (!path.isAbsolute(candidate)) fail("forbidden-path", "目录路径必须是绝对路径");
  const abs = path.resolve(candidate);
  if (path.parse(abs).root === abs) fail("forbidden-path", "不能把磁盘根目录作为知识库（会把整盘纳入索引）");
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch (error) {
    fail("not-found", `目录不存在或无法访问：${textOf(error)}`);
  }
  if (!stat.isDirectory()) fail("forbidden-path", "选中的不是目录");
  return abs;
}

/** 目录树排序：目录优先由调用方分组，这里只按名称自然序（中文按拼音/数字感知）。 */
const NAME_COLLATOR = new Intl.Collator("zh-Hans", { numeric: true, sensitivity: "base" });
function compareEntries(a, b) {
  const byName = NAME_COLLATOR.compare(a.name, b.name);
  if (byName !== 0) return byName;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** 文件名 → 树节点 kind（与 web 侧 EntryKind 一致）。 */
function entryKindOf(name) {
  const ext = extOf(name);
  if (ext === ".md") return "md";
  if (ext === ".canvas") return "canvas";
  if (IMAGE_EXT_SET.has(ext)) return "image";
  return "other";
}

/**
 * 组装 service（把依赖收进闭包，便于单测注入临时注册表与假 dialog/shell）。
 *
 * @param {object} [options]
 * @param {string} [options.registryFile] 注册表路径（测试注入）
 * @param {{showOpenDialog: Function}} [options.dialog] Electron dialog
 * @param {{showItemInFolder: Function, openPath?: Function}} [options.shell] Electron shell
 */
function createVaultService(options) {
  const opts = options && typeof options === "object" ? options : {};
  const registryFile = opts.registryFile ? path.resolve(opts.registryFile) : defaultRegistryFile();
  const dialog = opts.dialog;
  const shell = opts.shell;
  const activeWatchers = new Set();

  /** 注册表变更串行化：并发 pick/rename/remove 时不能丢更新。 */
  let mutationQueue = Promise.resolve();
  function mutate(fn) {
    const task = mutationQueue.then(fn);
    mutationQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** 取库条目；未登记/参数不合法统一 no-vault（渲染层按 code 出中文）。 */
  async function requireVault(vaultId) {
    if (typeof vaultId !== "string" || !vaultId.trim()) fail("no-vault", "没有指定知识库");
    if (vaultId.length > 128) fail("no-vault", "知识库标识不合法");
    const registry = await readRegistry(registryFile);
    const meta = registry.vaults.find((item) => item.id === vaultId);
    if (!meta) fail("no-vault", "知识库不存在（可能已被移除），请重新选择");
    return meta;
  }

  /**
   * 把库内相对路径夹成绝对路径，并做两道复核：
   * 1. 逐级软链检查（`assertNoSymlinkAncestor`）：目标本身与所有祖先都不能是软链；
   * 2. `fsp.realpath` 复核最近已存在祖先：即使有链路竞态，解析后的真实路径也必须在库根内。
   *
   * @param {{root: string}} meta
   * @param {string} norm 已通过 checkRel 的相对路径
   * @param {{allowMissing?: boolean}} [options]
   * @returns {Promise<{abs: string, rootReal: string}>}
   */
  async function clampPath(meta, norm, clampOptions) {
    const clampOpts = clampOptions && typeof clampOptions === "object" ? clampOptions : {};
    let rootReal;
    try {
      rootReal = await fsp.realpath(meta.root);
    } catch {
      fail("not-found", "知识库目录不存在或无法访问（可能被移动/删除），请重新选择知识库");
    }
    const abs = resolveInsideRoot(meta.root, norm);
    if (!abs) fail("forbidden-path", "路径越界（必须落在知识库目录内）");
    const linkCheck = assertNoSymlinkAncestor(meta.root, abs);
    if (!linkCheck.ok) fail("forbidden-path", linkCheck.error);
    // realpath 复核：从目标往上找最近的已存在祖先，解析后的真实路径必须仍在库根内
    let probe = abs;
    for (let guard = 0; guard < 64; guard += 1) {
      let real = null;
      try {
        real = await fsp.realpath(probe);
      } catch (error) {
        if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
          if (!clampOpts.allowMissing) fail("not-found", "文件不存在");
          const parent = path.dirname(probe);
          if (parent === probe) fail("forbidden-path", "路径越界（无法解析到知识库根内）");
          probe = parent;
          continue;
        }
        fail("io-error", `检查路径失败：${textOf(error)}`);
      }
      if (!isSameOrInsideRoot(rootReal, real)) {
        fail("forbidden-path", "路径指向知识库之外（符号链接逃逸已拒绝）");
      }
      return { abs, rootReal };
    }
    fail("forbidden-path", "路径层级过深，已拒绝");
    return null;
  }

  /** stat 包裹：不存在返回 null，其它错误转结构化失败。 */
  async function statOrNull(abs) {
    try {
      return await fsp.lstat(abs);
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
      fail("io-error", `读取文件信息失败：${textOf(error)}`);
    }
    return null;
  }

  /** 建父目录（只建库内路径；建完再复核一次真实路径，防创建过程中被换成链接）。 */
  async function ensureParent(meta, abs) {
    const dir = path.dirname(abs);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (error) {
      fail("io-error", `创建父目录失败：${textOf(error)}`);
    }
    let rootReal;
    try {
      rootReal = await fsp.realpath(meta.root);
    } catch {
      fail("not-found", "知识库目录不存在或无法访问");
    }
    let real = null;
    try {
      real = await fsp.realpath(dir);
    } catch (error) {
      fail("io-error", `复核目录失败：${textOf(error)}`);
    }
    if (!isSameOrInsideRoot(rootReal, real)) {
      fail("forbidden-path", "父目录指向知识库之外（符号链接逃逸已拒绝）");
    }
  }

  /** 原子写：同目录 tmp + rename；失败时原文件不动。 */
  async function atomicWrite(abs, text) {
    const dir = path.dirname(abs);
    const tmp = path.join(
      dir,
      `.${path.basename(abs)}.heming-tmp-${crypto.randomBytes(6).toString("hex")}`,
    );
    try {
      const handle = await fsp.open(tmp, "w");
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.rename(tmp, abs);
    } catch (error) {
      try {
        await fsp.unlink(tmp);
      } catch {
        /* tmp 残留不破坏原文件 */
      }
      fail("io-error", `写入失败（原文件未改动）：${textOf(error)}`);
    }
  }

  /** 读回写后 mtime，作为写入结果返回给编辑器当「已知版本」。 */
  async function writeResult(rel, bytes, abs) {
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch (error) {
      fail("io-error", `写入后读取文件信息失败：${textOf(error)}`);
    }
    return { rel, bytes, mtime: stat.mtime.toISOString() };
  }

  /** expectMtime 校验：文件被外部改过/删掉就拒绝覆盖（规格 §10 风险表）。 */
  async function assertMtimeUnchanged(abs, expectMtime) {
    if (typeof expectMtime !== "string" || !expectMtime) {
      fail("forbidden-path", "expectMtime 必须是 ISO 时间字符串");
    }
    const current = await statOrNull(abs);
    if (!current) fail("stale-mtime", "文件已被外部删除，未覆盖写入");
    if (current.isSymbolicLink()) fail("forbidden-path", "目标是符号链接，已拒绝");
    if (!current.isFile()) fail("io-error", "目标不是普通文件");
    if (current.mtime.toISOString() !== expectMtime) {
      fail("stale-mtime", `文件已被外部修改（当前 mtime ${current.mtime.toISOString()}），请重新加载后再保存`);
    }
  }

  /** 读取某个已存在目录（tree 的起点）；rel 为空表示库根。 */
  async function resolveDir(meta, rel) {
    if (!rel) {
      let stat;
      try {
        stat = await fsp.lstat(meta.root);
      } catch {
        fail("not-found", "知识库目录不存在或无法访问，请检查是否被移动/删除");
      }
      if (!stat.isDirectory()) fail("not-found", "知识库根不是目录");
      return { abs: path.resolve(meta.root) };
    }
    const { abs } = await clampPath(meta, rel, { allowMissing: false });
    const stat = await statOrNull(abs);
    if (!stat) fail("not-found", "目录不存在");
    if (stat.isSymbolicLink()) fail("forbidden-path", "目标是符号链接，已拒绝");
    if (!stat.isDirectory()) fail("forbidden-path", "目标不是目录");
    return { abs };
  }

  /** 递归列目录树。 */
  async function walkTree(dirAbs, prefix, level, depth, state) {
    let entries;
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch (error) {
      if (level === 1) fail("io-error", `读取目录失败：${textOf(error)}`);
      return [];
    }
    const dirs = [];
    const files = [];
    for (const entry of entries) {
      if (state.truncated) break;
      // 软链/联接一律不进树：它可能指向库外，读树时不该把库外内容当成库内容
      if (entry.isSymbolicLink()) continue;
      const name = entry.name;
      if (!name || name.startsWith(".") || IGNORED_TREE_NAMES.has(name)) continue;
      if (state.count >= MAX_TREE_NODES) {
        state.truncated = true;
        break;
      }
      const childRel = prefix ? `${prefix}/${name}` : name;
      const full = path.join(dirAbs, name);
      if (entry.isDirectory()) {
        let stat;
        try {
          stat = await fsp.lstat(full);
        } catch {
          continue;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        state.count += 1;
        const node = {
          rel: childRel,
          name,
          kind: "dir",
          size: 0,
          mtime: stat.mtime.toISOString(),
        };
        if (level < depth) node.children = await walkTree(full, childRel, level + 1, depth, state);
        dirs.push(node);
      } else if (entry.isFile()) {
        let stat;
        try {
          stat = await fsp.stat(full);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        state.count += 1;
        files.push({
          rel: childRel,
          name,
          kind: entryKindOf(name),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      }
    }
    dirs.sort(compareEntries);
    files.sort(compareEntries);
    return dirs.concat(files);
  }

  return {
    registryFile,

    /** 已登记的库列表；注册表坏 JSON 时按空表返回（不炸渲染层）。 */
    async list() {
      const registry = await readRegistry(registryFile);
      if (registry.corrupt) console.log("[heming] 知识库注册表无法解析，按空表处理（原文件保留）：", registryFile);
      return registry.vaults;
    },

    /** 取一个库的元信息（供 IPC watch 等内部使用）。 */
    async requireMeta(vaultId) {
      return requireVault(vaultId);
    },

    /**
     * 弹系统目录选择器登记新库。
     * 用户取消返回 null；对话框自身异常也按取消处理（不给渲染层抛 rejection）。
     * @param {object} [win] 主窗口（父窗口，保证对话框居中）
     */
    async pick(win) {
      if (!dialog || typeof dialog.showOpenDialog !== "function") {
        fail("io-error", "当前环境不支持目录选择（仅在桌面端可添加知识库）");
      }
      const dialogOptions = {
        title: "选择知识库目录",
        buttonLabel: "添加为知识库",
        properties: ["openDirectory", "createDirectory"],
      };
      let result;
      try {
        result = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
      } catch {
        return null;
      }
      if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) return null;
      const root = await validateVaultRoot(result.filePaths[0]);
      return mutate(async () => {
        const registry = await readRegistry(registryFile);
        const existing = registry.vaults.find((item) => samePath(item.root, root));
        if (existing) return existing;
        let baseName = path.basename(root);
        try {
          baseName = normalizeVaultName(baseName);
        } catch {
          baseName = "知识库";
        }
        const meta = createMeta(root, baseName);
        await saveRegistry(registryFile, registry.vaults.concat(meta), {
          legacyMigrated: registry.legacyMigrated,
        });
        return meta;
      });
    },

    /** 移除登记（只删列表条目，绝不删磁盘文件）。 */
    async remove(vaultId) {
      if (typeof vaultId !== "string" || !vaultId.trim()) return false;
      return mutate(async () => {
        const registry = await readRegistry(registryFile);
        const next = registry.vaults.filter((item) => item.id !== vaultId);
        if (next.length === registry.vaults.length) return false;
        await saveRegistry(registryFile, next, { legacyMigrated: registry.legacyMigrated });
        return true;
      });
    },

    /** 改库展示名（不动磁盘目录名——那是用户自己的文件夹）。 */
    async rename(vaultId, name) {
      const nextName = normalizeVaultName(name);
      return mutate(async () => {
        const registry = await readRegistry(registryFile);
        const index = registry.vaults.findIndex((item) => item.id === vaultId);
        if (index < 0) fail("no-vault", "知识库不存在（可能已被移除）");
        const next = registry.vaults.slice();
        next[index] = { ...next[index], name: nextName };
        await saveRegistry(registryFile, next, { legacyMigrated: registry.legacyMigrated });
        return next[index];
      });
    },

    /**
     * 目录树（懒加载）：`rel` 为空/缺省表示库根，任意子目录 `rel` 都只返回该子树
     * （界面大目录懒加载用）；`depth` 默认 2、上限 6；整棵树节点数受 MAX_TREE_NODES 限制。
     * 隐藏目录/文件、`node_modules`、软链一律不出现。
     */
    async tree(vaultId, treeOptions) {
      const meta = await requireVault(vaultId);
      const treeOpts = treeOptions && typeof treeOptions === "object" ? treeOptions : {};
      let rel = "";
      if (treeOpts.rel !== undefined && treeOpts.rel !== null && treeOpts.rel !== "") {
        rel = checkRel(treeOpts.rel, { forRead: true, allowDir: true });
      }
      let depth = 2;
      if (Number.isInteger(treeOpts.depth)) depth = Math.min(Math.max(treeOpts.depth, 1), MAX_TREE_DEPTH);
      const { abs } = await resolveDir(meta, rel);
      const state = { count: 0, truncated: false };
      const children = await walkTree(abs, rel, 1, depth, state);
      if (state.truncated) {
        console.log(`[heming] 知识库「${meta.name}」目录树超过 ${MAX_TREE_NODES} 个节点，已截断（请用 rel 懒加载）`);
      }
      return children;
    },

    /** 读文本；不存在返回 null（与老 wiki 桥同语义）。 */
    async read(vaultId, rel) {
      const meta = await requireVault(vaultId);
      const norm = checkRel(rel, { forRead: true });
      assertTextExt(norm);
      const { abs } = await clampPath(meta, norm, { allowMissing: true });
      const stat = await statOrNull(abs);
      if (!stat) return null;
      if (stat.isSymbolicLink()) fail("forbidden-path", "目标是符号链接，已拒绝");
      if (!stat.isFile()) fail("not-found", "目标不是普通文件");
      if (stat.size > MAX_TEXT_BYTES) {
        fail(
          "too-large",
          `文件 ${Math.round(stat.size / 1024)} KB 超过单文件上限 ${Math.round(MAX_TEXT_BYTES / 1024)} KB`,
        );
      }
      let buf;
      try {
        buf = await fsp.readFile(abs);
      } catch (error) {
        fail("io-error", `读取失败：${textOf(error)}`);
      }
      if (buf.includes(0)) fail("io-error", "这不是文本文件（检测到二进制内容）");
      let text;
      try {
        text = UTF8_DECODER.decode(buf);
      } catch {
        fail("io-error", "这不是 UTF-8 文本文件（含非法字节序列）");
      }
      return {
        vaultId: meta.id,
        rel: norm,
        text,
        mtime: stat.mtime.toISOString(),
        size: stat.size,
      };
    },

    /** 读图片，转 data URL 给渲染层 <img> 用；不存在返回 null。 */
    async readBinary(vaultId, rel) {
      const meta = await requireVault(vaultId);
      const norm = checkRel(rel, { forRead: true });
      assertImageExt(norm);
      const { abs } = await clampPath(meta, norm, { allowMissing: true });
      const stat = await statOrNull(abs);
      if (!stat) return null;
      if (stat.isSymbolicLink()) fail("forbidden-path", "目标是符号链接，已拒绝");
      if (!stat.isFile()) fail("not-found", "目标不是普通文件");
      if (stat.size > MAX_IMAGE_BYTES) {
        fail(
          "too-large",
          `图片 ${Math.round(stat.size / 1024 / 1024)} MB 超过单文件上限 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`,
        );
      }
      let buf;
      try {
        buf = await fsp.readFile(abs);
      } catch (error) {
        fail("io-error", `读取图片失败：${textOf(error)}`);
      }
      const mime = MIME_BY_EXT[extOf(norm)] || "application/octet-stream";
      return { rel: norm, mime, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
    },

    /**
     * 用户通道：库内任意可写文本路径（`expectMtime` 命中才覆盖）。
     * 父目录不存在时创建——用户点的「新建笔记」可能落在新目录里；隐藏目录已在校验阶段拒绝。
     */
    async write(vaultId, rel, text, writeOptions) {
      const meta = await requireVault(vaultId);
      const norm = checkRel(rel);
      assertTextExt(norm);
      const bytes = assertTextContent(text);
      const writeOpts = writeOptions && typeof writeOptions === "object" ? writeOptions : {};
      const { abs } = await clampPath(meta, norm, { allowMissing: true });
      if (writeOpts.expectMtime !== undefined) await assertMtimeUnchanged(abs, writeOpts.expectMtime);
      await ensureParent(meta, abs);
      const existing = await statOrNull(abs);
      if (existing && existing.isDirectory()) fail("io-error", "目标是一个目录，不能用文本写入");
      await atomicWrite(abs, text);
      return writeResult(norm, bytes, abs);
    },

    /**
     * 智能体通道：仅 `writeDirs` 内，支持 overwrite/append。
     * 为什么默认 append 也要判大小：追加是记忆写回的高频路径，
     * 不判的话「每天追加一节」最终会把单个文件撑破 2MB 上限。
     */
    async apply(request) {
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        fail("forbidden-path", "写入请求格式不合法");
      }
      const meta = await requireVault(request.vaultId);
      const norm = checkRel(request.rel);
      assertTextExt(norm);
      const mode = request.mode === undefined || request.mode === "overwrite" ? "overwrite" : request.mode;
      if (mode !== "overwrite" && mode !== "append") {
        fail("forbidden-path", "写入模式只能是 overwrite 或 append");
      }
      if (!isInsideWriteDirs(meta.writeDirs, norm)) {
        fail(
          "outside-write-dirs",
          meta.writeDirs.length > 0
            ? `智能体只能写入这些目录：${meta.writeDirs.join("、")}`
            : "这个知识库没有给智能体开放任何可写目录",
        );
      }
      const bytes = assertTextContent(request.text);
      const { abs } = await clampPath(meta, norm, { allowMissing: true });

      if (mode === "append") {
        const existing = await statOrNull(abs);
        if (existing && existing.isDirectory()) fail("io-error", "目标是一个目录，无法追加");
        if (existing && existing.size + bytes > MAX_TEXT_BYTES) {
          fail("too-large", `追加后文件会超过单文件上限 ${Math.round(MAX_TEXT_BYTES / 1024)} KB，已拒绝`);
        }
        await ensureParent(meta, abs);
        try {
          await fsp.appendFile(abs, request.text, "utf8");
        } catch (error) {
          fail("io-error", `追加写入失败：${textOf(error)}`);
        }
        return writeResult(norm, bytes, abs);
      }

      await ensureParent(meta, abs);
      const existing = await statOrNull(abs);
      if (existing && existing.isDirectory()) fail("io-error", "目标是一个目录，不能用文本写入");
      await atomicWrite(abs, request.text);
      return writeResult(norm, bytes, abs);
    },

    /** 新建文件：父目录自动创建；已存在返回失败（不静默覆盖用户文件）。 */
    async create(vaultId, rel, text) {
      const meta = await requireVault(vaultId);
      const norm = checkRel(rel);
      assertTextExt(norm);
      const body = text === undefined || text === null ? "" : text;
      const bytes = assertTextContent(body);
      const { abs } = await clampPath(meta, norm, { allowMissing: true });
      const existing = await statOrNull(abs);
      if (existing) fail("io-error", `文件已存在：${norm}`);
      await ensureParent(meta, abs);
      await atomicWrite(abs, body);
      return writeResult(norm, bytes, abs);
    },

    /**
     * 新建目录（多级 `mkdir -p`）：界面「新建文件夹」与文件树懒加载要用。
     *
     * 安全口径与写文件完全一致：`checkRel` 挡隐藏目录/`.git`/`.obsidian`/保留名/`..`，
     * `clampPath` 做 resolveInsideRoot + 逐级软链检查 + realpath 复核；建完再复核一次
     * 真实路径，防「创建过程中某一级被换成指向库外的链接」（TOCTOU 兜底）。
     *
     * 幂等：目标已是目录直接返回成功（界面连点/重试不该报错）；目标同名文件存在则失败
     * （不能把文件当目录用）。`vault:delete` 仍只删文件，不提供目录删除。
     * 返回形状与 `create` 对齐（VaultWriteResult）：目录没有内容，bytes 恒为 0。
     */
    async createDir(vaultId, rel) {
      const meta = await requireVault(vaultId);
      const norm = checkRel(rel, { allowDir: true });
      const { abs } = await clampPath(meta, norm, { allowMissing: true });
      const existing = await statOrNull(abs);
      if (existing) {
        if (existing.isSymbolicLink()) fail("forbidden-path", "目标是符号链接，已拒绝");
        if (!existing.isDirectory()) fail("io-error", `同名文件已存在，无法创建目录：${norm}`);
        return { rel: norm, bytes: 0, mtime: existing.mtime.toISOString() };
      }
      try {
        await fsp.mkdir(abs, { recursive: true });
      } catch (error) {
        fail("io-error", `创建目录失败：${textOf(error)}`);
      }
      // 建完再复核真实路径（mkdir -p 可能穿过并发被替换的中间目录）
      let rootReal;
      try {
        rootReal = await fsp.realpath(meta.root);
      } catch {
        fail("not-found", "知识库目录不存在或无法访问");
      }
      let real;
      try {
        real = await fsp.realpath(abs);
      } catch (error) {
        fail("io-error", `复核目录失败：${textOf(error)}`);
      }
      if (!isSameOrInsideRoot(rootReal, real)) {
        fail("forbidden-path", "目录指向知识库之外（符号链接逃逸已拒绝）");
      }
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch (error) {
        fail("io-error", `读取目录信息失败：${textOf(error)}`);
      }
      return { rel: norm, bytes: 0, mtime: stat.mtime.toISOString() };
    },

    /** 库内移动/改名（只对文件；不跨库——本桥只有库内相对路径，天然不跨库）。 */
    async move(vaultId, from, to) {
      const meta = await requireVault(vaultId);
      const fromNorm = checkRel(from);
      const toNorm = checkRel(to);
      if (!MOVE_EXT_SET.has(extOf(fromNorm)) || !MOVE_EXT_SET.has(extOf(toNorm))) {
        fail("forbidden-ext", `只支持移动文本或图片文件（可移动：${[...MOVE_EXT_SET].join(" ")}）`);
      }
      if (sameRel(fromNorm, toNorm)) return true;
      const source = await clampPath(meta, fromNorm, { allowMissing: false });
      const sourceStat = await statOrNull(source.abs);
      if (!sourceStat) fail("not-found", "要移动的文件不存在");
      if (sourceStat.isSymbolicLink()) fail("forbidden-path", "目标是符号链接，已拒绝");
      if (!sourceStat.isFile()) fail("io-error", "只支持移动单个文件，不支持目录");
      const target = await clampPath(meta, toNorm, { allowMissing: true });
      const targetStat = await statOrNull(target.abs);
      if (targetStat) fail("io-error", `目标已存在：${toNorm}`);
      await ensureParent(meta, target.abs);
      try {
        await fsp.rename(source.abs, target.abs);
      } catch (error) {
        fail("io-error", `移动失败：${textOf(error)}`);
      }
      return true;
    },

    /** 删除单个文件：不递归、不删目录、不碰软链。 */
    async deleteFile(vaultId, rel) {
      const meta = await requireVault(vaultId);
      const norm = checkRel(rel);
      if (!MOVE_EXT_SET.has(extOf(norm))) {
        fail("forbidden-ext", `只支持删除文本或图片文件（可删除：${[...MOVE_EXT_SET].join(" ")}）`);
      }
      const { abs } = await clampPath(meta, norm, { allowMissing: true });
      const stat = await statOrNull(abs);
      if (!stat) fail("not-found", "要删除的文件不存在");
      if (stat.isSymbolicLink()) fail("forbidden-path", "目标是符号链接，已拒绝");
      if (stat.isDirectory()) fail("io-error", "只删除单个文件，不删除目录（不递归）");
      if (!stat.isFile()) fail("io-error", "目标不是普通文件");
      try {
        await fsp.unlink(abs);
      } catch (error) {
        fail("io-error", `删除失败：${textOf(error)}`);
      }
      return true;
    },

    /** 在系统资源管理器中定位（只定位库内路径；不打开文件内容）。 */
    async reveal(vaultId, rel) {
      const meta = await requireVault(vaultId);
      const norm = checkRel(rel, { forRead: true, allowDir: true });
      const { abs } = await clampPath(meta, norm, { allowMissing: true });
      const stat = await statOrNull(abs);
      if (!stat) fail("not-found", "要定位的文件不存在");
      if (stat.isSymbolicLink()) fail("forbidden-path", "目标是符号链接，已拒绝");
      if (!shell || typeof shell.showItemInFolder !== "function") {
        fail("io-error", "当前环境不支持打开资源管理器");
      }
      if (stat.isDirectory() && typeof shell.openPath === "function") {
        const problem = await shell.openPath(abs);
        if (problem) fail("io-error", `打开目录失败：${problem}`);
        return true;
      }
      shell.showItemInFolder(abs);
      return true;
    },

    /**
     * 订阅库变化：返回取消订阅函数。
     * 去抖/批量上限在 vault-watch.js 里（见该文件头）。
     */
    async watch(vaultId, onChange) {
      const meta = await requireVault(vaultId);
      if (typeof onChange !== "function") fail("forbidden-path", "订阅回调必须是函数");
      let watcher;
      try {
        watcher = createVaultWatcher({
          root: meta.root,
          onChange: (rels) => {
            try {
              onChange(Array.isArray(rels) ? rels : []);
            } catch {
              /* 渲染层回调抛错不能污染监听器 */
            }
          },
        });
      } catch (error) {
        fail("io-error", `无法监听知识库变化：${textOf(error)}`);
      }
      activeWatchers.add(watcher);
      return () => {
        activeWatchers.delete(watcher);
        watcher.close();
      };
    },

    /** 关闭全部监听（应用退出/测试收尾用）。 */
    closeAllWatchers() {
      for (const watcher of activeWatchers) {
        try {
          watcher.close();
        } catch {
          /* 已关闭 */
        }
      }
      activeWatchers.clear();
    },

    /** 当前活跃监听数（测试/诊断用；界面不依赖它）。 */
    activeWatcherCount() {
      return activeWatchers.size;
    },

    /**
     * 首次启动迁移（规格 §9）：若 `~/Heming/wiki` 存在，自动登记为「和鸣知识库」。
     * 只做一次（注册表里记 legacyMigrated）；坏 JSON 时什么都不做，避免动用户文件。
     */
    async migrateLegacyWiki() {
      return mutate(async () => {
        const registry = await readRegistry(registryFile);
        if (registry.corrupt || registry.legacyMigrated) return null;
        const legacy = path.join(os.homedir(), "Heming", "wiki");
        let stat = null;
        try {
          stat = await fsp.stat(legacy);
        } catch {
          stat = null;
        }
        let meta = null;
        const next = registry.vaults.slice();
        if (stat && stat.isDirectory() && !next.some((item) => samePath(item.root, legacy))) {
          meta = createMeta(legacy, "和鸣知识库");
          next.push(meta);
        }
        await saveRegistry(registryFile, next, { legacyMigrated: true });
        return meta;
      });
    },
  };
}

/** 智能体写入是否落在允许目录内（Windows 上按大小写不敏感比较）。 */
function isInsideWriteDirs(writeDirs, rel) {
  if (!Array.isArray(writeDirs) || writeDirs.length === 0) return false;
  return writeDirs.some((dir) => sameRel(rel, dir) || sameRel(rel, `${dir}/`) || startsWithDir(rel, dir));
}

/** rel 是否以 `dir/` 开头（大小写口径同 sameRel）。 */
function startsWithDir(rel, dir) {
  const prefix = process.platform === "win32" ? `${dir}/`.toLowerCase() : `${dir}/`;
  const target = process.platform === "win32" ? rel.toLowerCase() : rel;
  return target.startsWith(prefix);
}

/**
 * 注册 IPC。放在模块里而不是 main.js，是为了能用假 ipcMain/dialog 单测。
 *
 * @param {object} ipcMain Electron ipcMain（生产环境传 secureIpc 门面，按主窗口来源收口）
 * @param {object} [deps]
 * @param {string} [deps.registryFile] 注册表路径（测试注入；显式传入时跳过首次迁移）
 * @param {{showOpenDialog: Function}} [deps.dialog]
 * @param {{showItemInFolder: Function, openPath?: Function}} [deps.shell]
 * @param {() => any} [deps.getMainWindow] 目录对话框的父窗口
 */
function registerVaultIpc(ipcMain, deps) {
  const options = deps && typeof deps === "object" ? deps : {};
  const service = createVaultService({
    registryFile: options.registryFile,
    dialog: options.dialog,
    shell: options.shell,
  });
  const getMainWindow = typeof options.getMainWindow === "function" ? options.getMainWindow : () => null;

  // 首次启动迁移（规格 §9）：把既有 ~/Heming/wiki 自动登记成库。
  // 显式传 registryFile（单测）时跳过，避免测试去动真实用户目录。
  // vault:list 会等它完成再返回，保证用户第一次打开知识库页就能看到「和鸣知识库」，
  // 而不是第二次刷新才出现。
  const legacyMigration = options.registryFile
    ? Promise.resolve(null)
    : service.migrateLegacyWiki().catch((error) => {
        console.log("[heming] 登记老 wiki 知识库失败：", textOf(error));
        return null;
      });

  /** key = `${webContents.id}:${vaultId}` → 取消订阅函数。 */
  const watchers = new Map();
  /**
   * 已请求取消、但 watch 的异步初始化还没结束的 key → 取消票号。
   * 用单调票号而不是布尔集合：既能判断「取消发生在本订阅开始之后」，也能让陈旧的
   * 取消记录自动失效（用户取消后再次订阅时不该被旧记录误杀）。
   */
  const pendingClose = new Map();
  let watchTicket = 0;
  /** 已经挂过 destroyed 清理的窗口 id（每个窗口只挂一次，避免重复监听）。 */
  const watchedSenders = new Set();

  function closeWatcher(key) {
    const close = watchers.get(key);
    if (!close) return;
    watchers.delete(key);
    try {
      close();
    } catch {
      /* 已关闭 */
    }
  }

  function closeSenderWatchers(senderId) {
    for (const key of [...watchers.keys()]) {
      if (key.startsWith(`${senderId}:`)) closeWatcher(key);
    }
  }

  /** 普通通道：成功包成 `{ok:true,value}`，失败包成 `{ok:false,code,message}`。 */
  const handle = (fn) => async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      return toFailureEnvelope(error);
    }
  };

  /** 需要 event 的通道（watch 要用 event.sender 定向推送）。 */
  const handleEvent = (fn) => async (event, ...args) => {
    try {
      return { ok: true, value: await fn(event, ...args) };
    } catch (error) {
      return toFailureEnvelope(error);
    }
  };

  ipcMain.handle(
    "vault:list",
    handle(async () => {
      await legacyMigration;
      return service.list();
    }),
  );
  ipcMain.handle("vault:pick", handle(() => service.pick(getMainWindow())));
  ipcMain.handle("vault:remove", handle((vaultId) => service.remove(vaultId)));
  ipcMain.handle("vault:rename", handle((vaultId, name) => service.rename(vaultId, name)));
  ipcMain.handle("vault:tree", handle((vaultId, treeOptions) => service.tree(vaultId, treeOptions)));
  ipcMain.handle("vault:read", handle((vaultId, rel) => service.read(vaultId, rel)));
  ipcMain.handle("vault:readBinary", handle((vaultId, rel) => service.readBinary(vaultId, rel)));
  ipcMain.handle("vault:write", handle((vaultId, rel, text, writeOptions) => service.write(vaultId, rel, text, writeOptions)));
  ipcMain.handle("vault:apply", handle((request) => service.apply(request)));
  ipcMain.handle("vault:create", handle((vaultId, rel, text) => service.create(vaultId, rel, text)));
  ipcMain.handle("vault:createDir", handle((vaultId, rel) => service.createDir(vaultId, rel)));
  ipcMain.handle("vault:move", handle((vaultId, from, to) => service.move(vaultId, from, to)));
  ipcMain.handle("vault:delete", handle((vaultId, rel) => service.deleteFile(vaultId, rel)));
  ipcMain.handle("vault:reveal", handle((vaultId, rel) => service.reveal(vaultId, rel)));

  ipcMain.handle(
    "vault:watch",
    handleEvent(async (event, vaultId) => {
      // 票号要在任何 await 之前取：之后到达的取消票号更大，才说明「取消发生在初始化期间」
      watchTicket += 1;
      const ticket = watchTicket;
      const meta = await service.requireMeta(vaultId);
      const sender = event && event.sender;
      if (!sender || typeof sender.send !== "function") {
        fail("io-error", "当前窗口不支持订阅知识库变化");
      }
      const senderId = String(sender.id === undefined || sender.id === null ? "unknown" : sender.id);
      const key = `${senderId}:${meta.id}`;
      closeWatcher(key);
      const close = await service.watch(meta.id, (rels) => {
        if (typeof sender.isDestroyed === "function" && sender.isDestroyed()) return;
        try {
          sender.send("vault:changed", { vaultId: meta.id, rels });
        } catch {
          /* 窗口正在关闭：忽略推送失败 */
        }
      });
      // 订阅初始化是异步的：如果用户在它完成前就点了取消（preload 的退订是立即的），
      // 这里必须把刚建好的监听器直接关掉，否则会泄漏一个永远不会被取消的 fs.watch。
      const closeTicket = pendingClose.get(key);
      pendingClose.delete(key);
      if (closeTicket !== undefined && closeTicket > ticket) {
        try {
          close();
        } catch {
          /* 已关闭 */
        }
        return false;
      }
      watchers.set(key, close);
      if (!watchedSenders.has(senderId) && typeof sender.once === "function") {
        watchedSenders.add(senderId);
        sender.once("destroyed", () => {
          watchedSenders.delete(senderId);
          closeSenderWatchers(senderId);
        });
      }
      return true;
    }),
  );

  ipcMain.handle(
    "vault:unwatch",
    handleEvent(async (event, vaultId) => {
      const sender = event && event.sender;
      const senderId = String(sender && sender.id !== undefined && sender.id !== null ? sender.id : "unknown");
      if (typeof vaultId === "string" && vaultId) {
        const key = `${senderId}:${vaultId}`;
        watchTicket += 1;
        pendingClose.set(key, watchTicket);
        // 防止「取消一个从未订阅过的库」把集合撑大：超量时丢最早的一条
        if (pendingClose.size > 128) {
          const oldest = pendingClose.keys().next();
          if (!oldest.done) pendingClose.delete(oldest.value);
        }
        closeWatcher(key);
      }
      return true;
    }),
  );

  return service;
}

module.exports = {
  createVaultService,
  registerVaultIpc,
  readRegistry,
  saveRegistry,
  normalizeWriteDirs,
  isInsideWriteDirs,
  checkRel,
  defaultRegistryFile,
  toFailureEnvelope,
  VaultError,
  DEFAULT_WRITE_DIRS,
  TEXT_EXTS,
  IMAGE_EXTS,
  MAX_TEXT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_TREE_NODES,
};
