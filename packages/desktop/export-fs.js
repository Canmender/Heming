/**
 * 记忆导出文件桥（桌面端主进程）。
 *
 * 职责：把 web 端生成的记忆导出 JSON 写到本机磁盘的 exports 目录。
 *
 * 为什么单独一个桥而不复用 chart-fs/wiki-fs：三者产物不同（图表 HTML、知识库 markdown、
 * 记忆 JSON），目录与后缀白名单各不一样；混在一起会让「只接受某一种后缀」的校验
 * 变成「按目录分流」，一个分支写错就是任意写或写错地方。
 *
 * 安全约束（渲染层是网页内容，等同不可信输入）：
 * - 目录固定在 `~/Heming/exports`，不接受外部传入的路径；
 *   `HEMING_EXPORT_DIR` 只给测试/排障用（代码侧注入，渲染层传不进来）；
 * - 文件名走白名单字符集（中文、字母、数字、-_. 空格），删除路径分隔符；
 * - 只写 `.json` 与 `.md` 两个后缀（后者给团队周报用，d.269），其他一律拒绝；
 * - 文件名里出现 `..` 直接拒绝——清洗成「取最后一段」看似安全，但调用方原意就是穿越，
 *   静默改写会让人误以为写到了别处；明确失败更容易排查；
 * - Windows 保留名（CON/PRN/AUX/NUL/COM1…）即使带后缀也打不开，直接拒绝。
 *
 * 红线：本模块只碰文件系统，**不引入任何网络能力**（与 crash-log 同一条红线），
 * 测试会从源码的 require 列表结构性断言这一点。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** 导出目录名（固定，不可由渲染层配置）。 */
const EXPORT_DIR = "exports";
/** 目录覆盖环境变量：仅测试/排障使用。 */
const EXPORT_DIR_ENV = "HEMING_EXPORT_DIR";
/** 文件名上限：与 chart-fs 一致，超长标题截断但保住后缀。 */
const NAME_MAX = 80;
/**
 * 内容上限：记忆导出含三层数据，比单个图表大，但也没道理到几十 MB。
 * 超限直接报错，避免一次误操作把磁盘写满。
 */
const CONTENT_MAX = 8_000_000;

/** Windows 设备保留名（不分大小写；带任意后缀仍然保留，如 `con.json`）。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 允许的后缀（小写比较）。
 *
 * 白名单而不是「任意后缀」：这个桥的用途只有两种——记忆导出（JSON）与团队周报（Markdown）。
 * 放开后缀等于放开任意文本写盘，将来接进来一个「.bat/.ps1」就是执行面。
 */
const ALLOWED_SUFFIXES = [".json", ".md"];

/** 取受支持后缀（小写）；不是白名单后缀返回空串。 */
function suffixOf(name) {
  const lower = String(name ?? "").toLowerCase();
  for (const suffix of ALLOWED_SUFFIXES) {
    if (lower.endsWith(suffix)) return suffix;
  }
  return "";
}

/**
 * 导出根目录。默认 `~/Heming/exports`；`HEMING_EXPORT_DIR` 可覆盖。
 * 每次调用时读环境变量（而不是模块加载时缓存），测试才能在启动后指到临时目录。
 */
function exportsRoot(env) {
  const e = env || process.env;
  const override =
    e && typeof e[EXPORT_DIR_ENV] === "string" ? e[EXPORT_DIR_ENV].trim() : "";
  if (override) return path.resolve(override);
  return path.join(os.homedir(), "Heming", EXPORT_DIR);
}

/**
 * 文件名清洗：只保留安全字符（与 chart-fs 同款白名单）。
 *
 * 白名单而不是黑名单：黑名单要逐个排除分隔符、控制字符、Windows 保留名……漏一个就是漏洞。
 *
 * 截断时先切名字再接后缀：否则超长标题会被截成没有受支持后缀的残名，
 * resolveTarget 会拒收，表现为「导出失败但看不出原因」。
 */
function safeFileName(name) {
  const raw = String(name ?? "");
  // 先于清洗拒绝：`../x.json` 这类输入清洗后只剩 `x.json`，能写但语义错误。
  // 只认完整的 `..`/`.` 路径段；名字里的 `..`（如团队名「版本-v1..2」）是合法字符，
  // 不能因为子串命中就被整条导出拒掉——真正防越界靠下面的 base 取末段 + resolve 包含判断。
  if (raw.replace(/\\/g, "/").split("/").some((seg) => seg === ".." || seg === ".")) return null;
  const base = raw.split(/[\\/]/).pop() ?? "";
  let cleaned = base
    .replace(/[^\p{L}\p{N}\-_. ]/gu, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\-]+/, "");
  if (!cleaned || cleaned === ".") return null;
  if (cleaned.length > NAME_MAX) {
    const ext = suffixOf(cleaned);
    const stem = ext ? cleaned.slice(0, cleaned.length - ext.length) : cleaned;
    cleaned = `${stem.slice(0, NAME_MAX - ext.length)}${ext}`;
  }
  // 保留名判断放在截断之后：截断不会制造新的保留名，但顺序上先清洗再判断更直观。
  const ext = suffixOf(cleaned);
  const stem = ext ? cleaned.slice(0, cleaned.length - ext.length) : cleaned;
  if (WINDOWS_RESERVED.test(stem)) return null;
  return cleaned;
}

/** 解析最终落盘路径；不合法返回 null。 */
function resolveTarget(fileName, env) {
  const safe = safeFileName(fileName);
  if (!safe) return null;
  if (suffixOf(safe) === "") return null;
  const root = exportsRoot(env);
  const full = path.resolve(root, safe);
  // 双保险：清洗后已不含分隔符，这里再确认解析结果仍在根目录内。
  const resolvedRoot = path.resolve(root);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) return null;
  return { root, full, name: safe };
}

/**
 * 写导出文件（覆盖同名文件）。
 * 失败一律返回 `{ ok:false, error }`，**不抛**——IPC 边界抛异常会让渲染层拿到
 * 一个只有堆栈的 rejection，不如直接把可读原因带回界面。
 */
function writeExport(fileName, content, env) {
  const target = resolveTarget(fileName, env);
  if (!target) {
    return {
      ok: false,
      error: "文件名不合法（只允许中文、字母、数字与 -_.，须以 .json 或 .md 结尾，且不得包含 ..）",
    };
  }
  const text = String(content ?? "");
  if (text.length > CONTENT_MAX) return { ok: false, error: "导出内容过大" };
  try {
    fs.mkdirSync(target.root, { recursive: true });
    fs.writeFileSync(target.full, text, "utf8");
    return { ok: true, path: target.full, name: target.name };
  } catch (err) {
    return { ok: false, error: `写入失败：${err.message}` };
  }
}

/** 目录信息：界面上要告诉用户导出文件放在哪，以及目录是否已经存在。 */
function exportInfo(env) {
  const dir = exportsRoot(env);
  let exists = false;
  try {
    exists = fs.existsSync(dir);
  } catch {
    /* 探测失败按不存在处理，不影响真正的写入尝试 */
  }
  return { dir, exists };
}

/** 注册 IPC。 */
function registerExportIpc(ipcMain) {
  ipcMain.handle("export:write", async (_e, fileName, content) => writeExport(fileName, content));
  ipcMain.handle("export:info", async () => exportInfo());
}

module.exports = {
  registerExportIpc,
  exportsRoot,
  safeFileName,
  resolveTarget,
  writeExport,
  exportInfo,
  EXPORT_DIR_ENV,
};
