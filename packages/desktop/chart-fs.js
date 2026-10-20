/**
 * 图表导出桥（桌面端主进程）。
 *
 * 职责：把生成的图表 HTML 写到本机磁盘的 charts 目录，并可用系统默认程序打开。
 *
 * 安全约束（渲染层是网页内容，等同不可信输入）：
 * - 目录固定在 `~/Heming/charts`，不接受外部传入的路径；
 * - 文件名走白名单字符集（去掉路径分隔符与 Windows 非法字符）；
 * - 只写 `.html` 一个后缀，其他一律拒绝；
 * - 不允许目录穿越（文件名里若含 `..` 直接拒）。
 *
 * 与 wiki 文件桥（wiki-fs.js）分开：那个管 markdown 知识库，
 * 这个管图表产物，目录与白名单都不同，混在一起会让两边都变复杂。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { shell } = require("electron");

/** 图表产物目录名（固定，不可配置——可配置就会被当任意写入口用）。 */
const CHART_DIR = "charts";

/** charts 根目录：`~/Heming/charts`。 */
function chartsRoot() {
  return path.join(os.homedir(), "Heming", CHART_DIR);
}

/**
 * 文件名清洗：只保留安全字符。
 *
 * 之所以不是"过滤危险字符"而是"白名单"：过滤法要逐个排除 `..`、`/`、`\`、
 * Windows 保留名（CON/PRN/AUX/NUL/COM1…）等一长串规则，漏一个就是漏洞。
 * 白名单只剩「中文、字母、数字、-_.」这些真正需要的，其余一律替换。
 *
 * 截断时**保住 .html 后缀**——先切名字再接后缀，
 * 否则超长标题会被截成「xxx」没有后缀，resolveTarget 就会拒收（表现为导出静默失败）。
 */
function safeFileName(name) {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^\p{L}\p{N}\-_. ]/gu, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\-]+/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  if (cleaned.length <= 80) return cleaned;
  const ext = cleaned.toLowerCase().endsWith(".html") ? ".html" : "";
  const stem = ext ? cleaned.slice(0, cleaned.length - ext.length) : cleaned;
  return `${stem.slice(0, 80 - ext.length)}${ext}`;
}

/** 解析最终落盘路径；不合法返回 null。 */
function resolveTarget(fileName) {
  const safe = safeFileName(fileName);
  if (!safe) return null;
  if (!safe.toLowerCase().endsWith(".html")) return null;
  const root = chartsRoot();
  const full = path.join(root, safe);
  // 双保险：解析后必须仍在根目录内
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(full);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null;
  return { root, full: resolved, name: safe };
}

/** 写文件（覆盖已有同名文件）。 */
function writeChart(fileName, content) {
  const target = resolveTarget(fileName);
  if (!target) return { ok: false, error: "文件名不合法（只允许中文、字母、数字与 -_.，且须以 .html 结尾）" };
  const text = String(content ?? "");
  if (text.length > 2_000_000) return { ok: false, error: "图表内容过大" };
  try {
    fs.mkdirSync(target.root, { recursive: true });
    fs.writeFileSync(target.full, text, "utf8");
    return { ok: true, path: target.full, name: target.name };
  } catch (err) {
    return { ok: false, error: `写入失败：${err.message}` };
  }
}

/** 列出已导出的图表。 */
function listCharts() {
  const root = chartsRoot();
  try {
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root)
      .filter((f) => f.toLowerCase().endsWith(".html"))
      .map((f) => {
        const st = fs.statSync(path.join(root, f));
        return { name: f, path: path.join(root, f), size: st.size, at: st.mtime.toISOString() };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

/** 用系统默认程序打开（主要是浏览器）。 */
function openChart(fileName) {
  const target = resolveTarget(fileName);
  if (!target) return { ok: false, error: "文件名不合法" };
  try {
    if (!fs.existsSync(target.full)) return { ok: false, error: "文件不存在" };
    shell.openPath(target.full);
    return { ok: true, path: target.full };
  } catch (err) {
    return { ok: false, error: `打开失败：${err.message}` };
  }
}

/** 注册 IPC。 */
function registerChartIpc(ipcMain) {
  ipcMain.handle("chart:export", async (_e, fileName, content) => writeChart(fileName, content));
  ipcMain.handle("chart:list", async () => listCharts());
  ipcMain.handle("chart:open", async (_e, fileName) => openChart(fileName));
}

module.exports = { registerChartIpc, chartsRoot, safeFileName, resolveTarget };
