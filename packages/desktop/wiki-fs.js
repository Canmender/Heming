"use strict";
/**
 * 个人知识库的本地文件桥（卡帕西 LLM Wiki 标准落地层）。
 *
 * 为什么必须落成真实文件：标准里 Obsidian 是 IDE、LLM 是程序员、wiki 是代码库。
 * 存在 localStorage 里的话 Obsidian 打不开、LLM 也读不到，
 * 「随时换任意 agent 维护」这个核心价值直接没了。
 *
 * 目录形态（默认 `%USERPROFILE%\Heming\wiki`，可用 HEMING_WIKI_DIR 覆盖）：
 *   raw/<来源>.md         原始来源，只读——LLM 读它但绝不改它（标准里的「source of truth」）
 *   wiki/<类别>/<页面>.md LLM 生成的页面，可改；类别取自 PAGE_KINDS
 *   schema.md             维护规约（标准第三层：wiki 该长什么样、按什么流程更新）
 *   index.md              内容目录：全库页面清单 + 一句话摘要，按类别分组
 *   log.md                时间流水：追加写，每条以 `## [YYYY-MM-DD] <类型> | <标题>` 开头
 *
 * 安全约束（渲染层是网页内容，等同不可信输入）：
 * - 所有路径一律经 resolveInside() 夹在根目录内，挡住 `..` 与绝对路径；
 * - 只认白名单文件名（index.md / log.md / schema.md）、raw/*.md 与 wiki/<类别>/*.md；
 * - 不做任何目录删除（remove 只删单个文件，且必须是 .md）。
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { resolveInsideRoot } = require("./path-guard");

/** 根目录：环境变量优先，其次 %USERPROFILE%\Heming\wiki。 */
function wikiRoot() {
  const env = process.env.HEMING_WIKI_DIR && process.env.HEMING_WIKI_DIR.trim();
  return env ? path.resolve(env) : path.join(os.homedir(), "Heming", "wiki");
}

/** 标准里的四个顶层文件。 */
const ROOT_FILES = new Set(["index.md", "log.md", "schema.md"]);

/** 页面类型 → wiki/ 下的子目录（与 index.md 的分类一致）。 */
const PAGE_KINDS = new Set(["entities", "concepts", "sources", "synthesis", "notes"]);

/**
 * 把相对路径解析成根目录内的绝对路径；越界返回 null。
 *
 * ★ 判定口径已抽到 `path-guard.js`（`resolveInsideRoot`），与文件编辑桥 `file-fs.js` 共用：
 * 两处各写一份的话，补 NUL 检查/改越界判据时只改一处，另一处就成了漏洞。
 * 这里只负责把「wiki 根」传给共享函数，行为与抽取前逐字等价。
 * @param {string} rel 相对路径（形如 "wiki/concepts/foo.md"）
 */
function resolveInside(rel) {
  return resolveInsideRoot(wikiRoot(), rel);
}

/** 该相对路径是否属于允许操作的集合（白名单，见文件头）。 */
function isAllowedRel(rel) {
  if (typeof rel !== "string" || !rel) return false;
  const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (ROOT_FILES.has(norm)) return true;

  const parts = norm.split("/");
  // raw/<文件>.md 与 wiki/<类别>/<文件>.md 都是三层；raw 不分类别，故单独放行两层
  if (parts.length === 2) {
    const [dir, file] = parts;
    if (dir === "raw" && file.endsWith(".md")) return true;
  }
  if (parts.length === 3) {
    const [dir, kind, file] = parts;
    if (dir === "wiki" && PAGE_KINDS.has(kind) && file.endsWith(".md")) return true;
  }
  return false;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function writeFileSafe(rel, content) {
  const abs = resolveInside(rel);
  if (!abs || !isAllowedRel(rel)) throw new Error("forbidden path");
  await ensureDir(path.dirname(abs));
  await fsp.writeFile(abs, String(content ?? ""), "utf8");
  return { path: rel, bytes: Buffer.byteLength(String(content ?? ""), "utf8") };
}

async function readFileSafe(rel) {
  const abs = resolveInside(rel);
  if (!abs || !isAllowedRel(rel)) throw new Error("forbidden path");
  try {
    return await fsp.readFile(abs, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

async function removeFileSafe(rel) {
  const abs = resolveInside(rel);
  if (!abs || !isAllowedRel(rel)) throw new Error("forbidden path");
  // 只删文件、且必须是 .md：不做递归删除，避免误删整棵 wiki
  if (!abs.endsWith(".md")) throw new Error("only markdown files");
  await fsp.rm(abs, { force: true });
  return true;
}

/** 递归列出根目录下的所有 .md（相对路径），跳过 node_modules 之类的噪声。 */
async function listFiles() {
  const root = wikiRoot();
  const out = [];
  const walk = async (dir, prefix) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在（首次使用）视为空
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(path.join(dir, entry.name), rel);
      } else if (entry.name.endsWith(".md")) {
        out.push(rel);
      }
    }
  };
  await walk(root, "");
  out.sort();
  return out;
}

/** 追加一行到 log.md，标准要求每条以 `## [日期] 类型 | 标题` 开头（便于 grep 解析）。 */
async function appendLog(kind, title, extra) {
  const today = new Date().toISOString().slice(0, 10);
  const line = `\n## [${today}] ${kind} | ${String(title ?? "").replace(/\n/g, " ").slice(0, 120)}\n${extra ? `\n${extra}\n` : ""}`;
  const abs = resolveInside("log.md");
  if (!abs) throw new Error("forbidden path");
  await ensureDir(path.dirname(abs));
  await fsp.appendFile(abs, line, "utf8");
  return true;
}

/** 注册 IPC：主进程在 app ready 后调用一次。 */
function registerWikiIpc(ipcMain) {
  ipcMain.handle("wiki:info", async () => {
    const root = wikiRoot();
    const exists = fs.existsSync(root);
    return { root, exists };
  });

  ipcMain.handle("wiki:list", async () => listFiles());

  ipcMain.handle("wiki:read", async (_e, rel) => readFileSafe(rel));

  ipcMain.handle("wiki:write", async (_e, rel, content) => writeFileSafe(rel, content));

  ipcMain.handle("wiki:remove", async (_e, rel) => removeFileSafe(rel));

  ipcMain.handle("wiki:log", async (_e, kind, title, extra) => appendLog(kind, title, extra));
}

module.exports = { registerWikiIpc, resolveInside, isAllowedRel, wikiRoot, PAGE_KINDS, ROOT_FILES };