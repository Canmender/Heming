"use strict";
/**
 * 文件编辑桥（桌面端主进程）：`file_patch` / `file_read` 的读盘与落盘层。
 *
 * 为什么需要它：渲染层没有 fs，而「改用户文件」是本产品里权限最大的一件事，
 * 必须在主进程留最后一道闸——即使 web 侧的路径收敛出了 bug，这里也要夹一次。
 *
 * 安全约束（渲染层是网页内容，等同不可信输入）：
 * - 每一条目标路径都必须在**用户显式添加的根**内（根清单随请求传来，来自设置区配置）；
 * - 只用 `mode=write` 的根写、任一已配置的根读；
 * - 软链一律拒绝（目标本身与所有祖先目录都查）：否则圈定的根会被一个链接绕出去；
 * - 硬链接拒绝（`nlink > 1`）：写它等于同时改了根外的另一份；
 * - NUL、超长、Windows 保留名、非普通文件一律拒绝；
 * - 单文件 / 单次总量 / 文件数上限在 web 侧判过，这里**再判一次**（不信任渲染层）。
 *
 * 搜索（`file_glob` / `file_grep`）只读，但走同一套根校验：`dir` 必须夹在某个根内、
 * 每一级祖先都要无软链；遍历不跟随软链、跳过依赖目录与版本库目录、跳过本模块自己的
 * 原子写临时文件。结果条数与遍历规模都有硬上限（见常量），超限用 `truncated` 明示，
 * 绝不静默返回半份结果。
 *
 * 读图（`file_image`）是单独一条通道 `file:image`：同样的根校验与软链校验，但上限是
 * 5MB、只认 PNG/JPEG/GIF/WebP 四种魔数，返回 base64 交给渲染层塞进视觉消息。它**不是**
 * 「读文本加个二进制开关」——那样一条读文本的调用就可能拿到 base64 大块，也不好把
 * 两类上限讲清楚。
 *
 * 写盘语义：
 * - 先写 `.<name>.heming-tmp-<rand>` 并 `fsync`，全部成功后再统一 `rename` 覆盖；
 *   中途失败只清理 tmp，**原文件不动**；
 * - 删除放在所有写入之后执行（改名 = 写新文件 + 删旧文件，绝不能先删）；
 * - 父目录默认必须已存在，不存在就拒绝——「顺便帮你建目录」会让一次拼错路径的补丁
 *   在磁盘上留下意料之外的目录树。唯一例外：渲染层显式传 `createParents: true`
 *   （只有 `file_write` 会传），此时缺失的每一段都要过「根内 + 非软链 + 非保留名」
 *   校验后才 `mkdir`，写盘失败时只回收本次新建的空目录；
 * - 内容按传入字符串原样写 UTF-8，不做行尾转换——CRLF/LF 由 web 侧按原文件保留；
 * - 写入串行排队：同一文件被两个并发请求改时，后一个在前一个完成之后才开始，
 *   最终内容必然是「某一整份」，不会出现两份内容交错。
 *
 * IPC 边界：所有通道都先校验调用来源（只接受主窗口），再校验参数形状与长度上限；
 * 路径解析只认「根 + 目标绝对路径」，渲染层不能传一个根外路径直接写盘。
 * `file:default-root` 是个例外但方向相反：它只把主进程算好的默认工作区路径**下发**给渲染层，
 * 不接受任何参数（否则等于开了任意目录探测），也不因此授予写权限。
 *
 * 红线：本模块只碰文件系统，**不引入任何网络能力**（与 crash-log / export-fs 同一条红线）。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  checkAbsoluteInside,
  isInsideRoot,
  isReservedName,
  assertNoSymlinkAncestor,
} = require("./path-guard");

/** 单文件上限（与 web 侧 `limits.ts` 同值；两侧都判，改一处必须改两处）。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 单次写入总量上限。 */
const MAX_PATCH_BYTES = 4 * 1024 * 1024;
/** 单次最多改多少个文件。 */
const MAX_FILES = 20;
/** 二进制嗅探前缀长度（与 web 侧一致）。 */
const SNIFF_BYTES = 8 * 1024;
/**
 * 单张图片上限（`file_image` 用；与 web 侧 `limits.ts` 的 `MAX_IMAGE_BYTES` 同值）。
 *
 * 为什么是 5MB：base64 之后体积再涨约 1/3，而一次工具结果里图片是**另起一条 user
 * 消息**塞进上下文的——4MB 的截图已经占掉一个不小模型窗口的十分之一。超限就明确
 * 拒绝（让模型改用 file_glob 找、或让用户压缩），不做「悄悄缩图」：缩图要引入图像
 * 库，而本模块的红线是不新增依赖。
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 图片嗅探前缀长度：webp 要看到第 12 字节才认得出。 */
const IMAGE_SNIFF_BYTES = 16;
/** 根名长度上限（设置区输入框同样限制）。 */
const MAX_ROOT_NAME = 64;

/* ───────────── 搜索（file:glob / file:grep）上限 ─────────────
 * 与 web 侧 `fileEdit/limits.ts` 同口径：两侧都判，改一处必须改两处。
 * 遍历也会被渲染层的并发调用触发，所以主进程必须有独立的硬上限，不能只信渲染层。 */
/** 单次 glob 最多返回多少条路径。 */
const MAX_GLOB_RESULTS = 200;
/** 单次 grep 最多返回多少条命中。 */
const MAX_GREP_MATCHES = 200;
/** 单条命中最多回传多少字符（超长行先截断再匹配，理由见 grepFiles）。 */
const MAX_GREP_LINE_CHARS = 2000;
/** 单次遍历最多看多少个目录项（防超大根把主进程卡住）。 */
const MAX_WALK_ENTRIES = 20000;
/** 遍历最大深度（相对于搜索目录）。 */
const MAX_WALK_DEPTH = 20;
/** glob/grep 模式串长度上限（路径上限之外单列，便于给出明确文案）。 */
const MAX_PATTERN_CHARS = 1000;
/** 整目录跳过的名字：依赖目录与版本库对「找文件 / 搜内容」没有意义，而且体量巨大。 */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".hg", ".svn"]);

/** UTF-8 严格解码器：非法序列直接抛，用于判「这不是文本文件」。 */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * 规整渲染层传来的根清单：坏条目**逐条丢弃**，不因为一条脏数据整体失败。
 *
 * 注意这里不接受「盘符根」（`D:\`）：那等价于整盘可写，
 * 与规格 §5.1「没有 full-disk 档」的口径冲突。想写整个盘就逐个目录加。
 */
function normalizeRoots(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const name = typeof item.name === "string" ? item.name.trim().slice(0, MAX_ROOT_NAME) : "";
    const rawPath = typeof item.path === "string" ? item.path.trim() : "";
    const mode = item.mode === "read" ? "read" : item.mode === "write" ? "write" : null;
    if (!name || !rawPath || !mode) continue;
    if (rawPath.includes("\0") || rawPath.length > 300) continue;
    if (!path.isAbsolute(rawPath)) continue;
    const abs = path.resolve(rawPath);
    if (path.parse(abs).root === abs) continue; // 盘符根/文件系统根
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, path: abs, mode });
  }
  return out;
}

/**
 * 找到包含该绝对路径的根。
 *
 * **最长前缀优先**：同时配了 `D:/库` 和 `D:/库/私人` 时，后者更具体，
 * 用它的 mode 判定——否则「私人目录设为只读」会被外层可写根吞掉。
 */
function findRoot(roots, absPath) {
  let best = null;
  for (const root of roots) {
    if (!isInsideRoot(root.path, absPath)) continue;
    if (!best || root.path.length > best.path.length) best = root;
  }
  return best;
}

/** 前缀里是否有 NUL（二进制文件的可靠特征）。 */
function looksBinary(buf) {
  const head = buf.subarray(0, SNIFF_BYTES);
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === 0) return true;
  }
  return false;
}

/**
 * 读一个文件（供 `file_read` 与干跑使用）。
 *
 * @param {Array} roots 已规整的根清单
 * @param {string} absPath 绝对路径
 * @returns {Promise<object>} `{ok:true,content,bytes}` 或 `{ok:false,code,error}`
 */
async function readFile(roots, absPath) {
  if (typeof absPath !== "string" || !absPath) {
    return { ok: false, code: "invalid-path", error: "路径不能为空" };
  }
  if (absPath.includes("\0")) return { ok: false, code: "invalid-path", error: "路径里含非法字符（NUL）" };
  if (!path.isAbsolute(absPath)) return { ok: false, code: "invalid-path", error: "路径必须是绝对路径" };
  const abs = path.resolve(absPath);
  const root = findRoot(roots, abs);
  if (!root) {
    return { ok: false, code: "outside-roots", error: "目标不在任何已配置的根内（请在设置区添加根）" };
  }
  const linkCheck = assertNoSymlinkAncestor(root.path, abs);
  if (!linkCheck.ok) return { ok: false, code: "symlink", error: linkCheck.error };

  let stat;
  try {
    stat = await fsp.lstat(abs);
  } catch (e) {
    if (e && e.code === "ENOENT") return { ok: false, code: "not-found", error: "文件不存在" };
    return { ok: false, code: "io", error: `读取失败：${e && e.message ? e.message : String(e)}` };
  }
  if (stat.isSymbolicLink()) return { ok: false, code: "symlink", error: "目标是符号链接，已拒绝" };
  if (!stat.isFile()) return { ok: false, code: "not-file", error: "目标不是普通文件" };
  if (stat.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      code: "too-large",
      error: `文件 ${Math.round(stat.size / 1024)} KB 超过单文件上限 ${Math.round(MAX_FILE_BYTES / 1024)} KB`,
    };
  }

  let buf;
  try {
    buf = await fsp.readFile(abs);
  } catch (e) {
    return { ok: false, code: "io", error: `读取失败：${e && e.message ? e.message : String(e)}` };
  }
  if (looksBinary(buf)) return { ok: false, code: "binary", error: "这不是文本文件（检测到二进制内容）" };
  let content;
  try {
    content = UTF8_DECODER.decode(buf);
  } catch {
    return { ok: false, code: "binary", error: "这不是 UTF-8 文本文件（含非法字节序列）" };
  }
  return { ok: true, content, bytes: buf.length };
}

/**
 * 按文件头判断图片类型；不是这四种就返回 null。
 *
 * 为什么按魔数而不是按扩展名：用户改个后缀（`截图.png.txt`、或把 jpg 存成 png）很常见，
 * 而模型拿到「mime 说 png、其实是 jpeg」的 base64 会直接报错。扩展名只用来做提示，
 * 真正的判据在这里。只支持这四种也是刻意的：它们被主流视觉模型接受，其余（svg/bmp/tiff）
 * 要么是文本要么要转码，转码就得引依赖。
 */
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  const head = buf.subarray(0, IMAGE_SNIFF_BYTES);
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 6).toString("latin1") === "GIF87a") return "image/gif";
  if (head.subarray(0, 6).toString("latin1") === "GIF89a") return "image/gif";
  if (
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * 读一张图片（供 `file_image` 与视觉能力使用）：返回 `{ok:true,mime,bytes,base64}`。
 *
 * 与 `readFile` 是两条独立通道（不是 `binary: true` 开关）：
 * - 文本读取会拒二进制，图片读取只认这四种魔数——把两者合成一个开关，等于让
 *   「读文本」的调用方有机会拿到 base64 大块，也让「读图」可能读到任意二进制；
 * - 上限也不同（文本 2MB、图片 5MB），错误文案要能说清是哪条上限。
 *
 * 路径校验与 `readFile` 完全一致（根内、无软链祖先、目标本身不是软链、普通文件），
 * 因为「不给读图开一个更宽的口子」这件事比复用几行代码重要。
 */
async function readImage(roots, absPath) {
  if (typeof absPath !== "string" || !absPath) {
    return { ok: false, code: "invalid-path", error: "路径不能为空" };
  }
  if (absPath.includes("\0")) return { ok: false, code: "invalid-path", error: "路径里含非法字符（NUL）" };
  if (!path.isAbsolute(absPath)) return { ok: false, code: "invalid-path", error: "路径必须是绝对路径" };
  const abs = path.resolve(absPath);
  const root = findRoot(roots, abs);
  if (!root) {
    return { ok: false, code: "outside-roots", error: "目标不在任何已配置的根内（请在设置区添加根）" };
  }
  const linkCheck = assertNoSymlinkAncestor(root.path, abs);
  if (!linkCheck.ok) return { ok: false, code: "symlink", error: linkCheck.error };

  let stat;
  try {
    stat = await fsp.lstat(abs);
  } catch (e) {
    if (e && e.code === "ENOENT") return { ok: false, code: "not-found", error: "文件不存在" };
    return { ok: false, code: "io", error: `读取失败：${e && e.message ? e.message : String(e)}` };
  }
  if (stat.isSymbolicLink()) return { ok: false, code: "symlink", error: "目标是符号链接，已拒绝" };
  if (!stat.isFile()) return { ok: false, code: "not-file", error: "目标不是普通文件" };
  if (stat.size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      code: "too-large",
      error: `图片 ${Math.round(stat.size / 1024)} KB 超过单张上限 ${Math.round(MAX_IMAGE_BYTES / 1024)} KB；请让用户压缩或改看别的文件`,
    };
  }

  let buf;
  try {
    buf = await fsp.readFile(abs);
  } catch (e) {
    return { ok: false, code: "io", error: `读取失败：${e && e.message ? e.message : String(e)}` };
  }
  const mime = sniffImageMime(buf);
  if (!mime) {
    return {
      ok: false,
      code: "unsupported-image",
      error: "这不是可读的图片（只支持 PNG / JPEG / GIF / WebP，按文件头判断）；看文字请用 file_read",
    };
  }
  return { ok: true, mime, bytes: buf.length, base64: buf.toString("base64") };
}

/* ────────────────────────── 搜索：glob 语法 ────────────────────────── */

/** 构造带 `invalid-pattern` 码的错误：IPC 层按 code 回给渲染层，文案直接给用户看。 */
function invalidPattern(message) {
  const error = new Error(message);
  error.code = "invalid-pattern";
  return error;
}

/** 正则转义：glob 里这些字符有特殊含义，落到正则里要按字面量匹配。 */
function escapeRegexChar(ch) {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** 找 `{` 对应的 `}`（支持嵌套；跳过 `[...]` 里的花括号）。找不到返回 -1。 */
function findBraceClose(pattern, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按顶层逗号切 `{a,b,c}` 的分支；嵌套的 `{}`/`[]` 原样留给递归处理。 */
function splitBraceAlternatives(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "[") {
      const close = body.indexOf("]", i + 1);
      if (close === -1) break;
      i = close;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/**
 * 把 glob 子集编成正则源码。
 *
 * 支持：`*`（段内任意非斜杠）、`?`（段内单字符）、`**`（跨段；后接斜杠时可匹配零层，
 * 所以双星 + 斜杠 + `*.ts` 能命中根下的 a.ts）、`{a,b}`（并集）、`[abc]`（字符集，
 * `!`/`^` 开头取反）。不用现成库：规格要求零新依赖，而且只需要这一个子集；
 * 匹配口径跟本机文件系统一致——大小写不敏感（由 globToRegExp 加 i 标志）。
 */
function globSource(pattern) {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          // 双星后紧接分隔符：匹配「零层或多层目录」
          out += "(?:[^/]+/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) throw invalidPattern(`glob 模式里的方括号未闭合：${pattern}`);
      let body = pattern.slice(i + 1, close);
      let negated = false;
      if (body[0] === "!" || body[0] === "^") {
        negated = true;
        body = body.slice(1);
      }
      if (!body) throw invalidPattern(`glob 模式里有空的字符集：${pattern}`);
      // 保留 `-`（区间）语义；其余可能破坏字符集的字符逐个转义
      const safe = body.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\//g, "\\/");
      out += `[${negated ? "^" : ""}${safe}]`;
      i = close + 1;
      continue;
    }
    if (ch === "{") {
      const close = findBraceClose(pattern, i);
      if (close === -1) throw invalidPattern(`glob 模式里的花括号未闭合：${pattern}`);
      const alternatives = splitBraceAlternatives(pattern.slice(i + 1, close));
      if (alternatives.length < 2) {
        // 没有逗号的单个分支按字面量处理：模型偶尔这么写，报错不如照做
        out += `${escapeRegexChar("{")}${globSource(alternatives[0])}${escapeRegexChar("}")}`;
      } else {
        out += `(?:${alternatives.map((alt) => globSource(alt)).join("|")})`;
      }
      i = close + 1;
      continue;
    }
    out += escapeRegexChar(ch);
    i += 1;
  }
  return out;
}

/**
 * 编译 glob 模式。抛错时 `code === "invalid-pattern"`，调用方转成 `{ok:false}`。
 *
 * 模式必须是**相对路径**（相对搜索目录）：绝对模式既没有意义（匹配的是相对路径），
 * 也容易被误解为「可以从盘符开始找」。反斜杠统一当分隔符（Windows 用户常这么写）。
 */
function globToRegExp(pattern) {
  if (typeof pattern !== "string") throw invalidPattern("glob 模式必须是字符串");
  const raw = pattern.trim().replace(/\\/g, "/");
  if (!raw) throw invalidPattern("glob 模式不能为空");
  if (raw.includes("\0")) throw invalidPattern("glob 模式含非法字符（NUL）");
  if (raw.length > MAX_PATTERN_CHARS) {
    throw invalidPattern(`glob 模式过长（超过 ${MAX_PATTERN_CHARS} 字符）`);
  }
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw invalidPattern("glob 模式必须是根内相对路径，不能是绝对路径");
  }
  return new RegExp(`^${globSource(raw)}$`, "i");
}

/* ────────────────────────── 搜索：遍历 ────────────────────────── */

/** lstat 的静默版：失败返回 null——遍历途中「文件刚好被删 / 没权限」都按跳过处理。 */
async function lstatOrNull(abs) {
  try {
    return await fsp.lstat(abs);
  } catch {
    return null;
  }
}

/** 本模块原子写的临时文件（点开头 + `.heming-tmp-` + hex 结尾）：遍历时不能当成用户文件。 */
function isOwnTempName(name) {
  return /\.heming-tmp-[0-9a-f]+$/i.test(name);
}

/**
 * 校验搜索目录并定位它所属的根。
 *
 * 搜索的失败码只有契约里那四个（invalid-pattern / outside-roots / no-roots / io），
 * 所以「不是绝对路径」「是软链」「不是目录」统一归到 `outside-roots`：
 * 它们的共同含义都是「这个位置不配作为搜索范围」，且 web 侧类型里没有更细的码。
 *
 * @returns {Promise<object>} `{ok:true,root,dir}` 或 `{ok:false,code,error}`
 */
async function resolveSearchDir(roots, dir) {
  if (roots.length === 0) return { ok: false, code: "no-roots", error: "尚未配置任何根目录" };
  const raw = typeof dir === "string" && dir.trim() ? dir.trim() : roots[0].path;
  if (raw.includes("\0")) return { ok: false, code: "outside-roots", error: "搜索目录含非法字符（NUL）" };
  if (!path.isAbsolute(raw)) return { ok: false, code: "outside-roots", error: "搜索目录必须是绝对路径" };
  const abs = path.resolve(raw);

  // 根清单按「最长前缀」选具体的那一条；dir 恰好等于根本身也要认（findRoot 不把根算作根内）
  const absKey = abs.toLowerCase();
  let root = null;
  for (const item of roots) {
    const key = item.path.toLowerCase();
    if (key !== absKey && !isInsideRoot(item.path, abs)) continue;
    if (!root || item.path.length > root.path.length) root = item;
  }
  if (!root) return { ok: false, code: "outside-roots", error: "搜索目录不在任何已配置的根内（请在设置区添加根）" };

  const stat = await lstatOrNull(abs);
  if (!stat) return { ok: false, code: "outside-roots", error: `搜索目录不存在或不可访问：${abs}` };
  if (stat.isSymbolicLink()) {
    return { ok: false, code: "outside-roots", error: `搜索目录是符号链接，已拒绝（避免绕出根）：${abs}` };
  }
  if (!stat.isDirectory()) return { ok: false, code: "outside-roots", error: `搜索目录不是目录：${abs}` };
  // 根本身不查祖先（根路径由用户显式配置）；子目录必须逐级无软链，与读写同一条红线
  if (absKey !== path.resolve(root.path).toLowerCase()) {
    const linkCheck = assertNoSymlinkAncestor(root.path, abs);
    if (!linkCheck.ok) return { ok: false, code: "outside-roots", error: `${linkCheck.error}：${abs}` };
  }
  return { ok: true, root, dir: abs };
}

/**
 * 深度优先遍历普通文件；`onFile(fullAbs, relFromStart)` 返回 false 表示「调用方收手」。
 *
 * 不跟随软链、跳过依赖/版本库目录、包含隐藏文件；`MAX_WALK_ENTRIES`/`MAX_WALK_DEPTH`
 * 是主进程侧的防卡死上限（见文件头「搜索」段）。
 *
 * @returns {Promise<{entries:number, walkTruncated:boolean}>}
 */
async function walkFiles(startAbs, onFile) {
  let entries = 0;
  let depthLimited = false;
  const stack = [{ dir: startAbs, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    let dirents;
    try {
      dirents = await fsp.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue; // 单个子目录读不了不该让整次搜索失败：跳过它，结果由空集/truncated 表达
    }
    // 排序只为可复现（最终结果还会按契约再排序），代价很小
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      if (entries >= MAX_WALK_ENTRIES) return { entries, walkTruncated: true };
      entries += 1;
      const full = path.join(current.dir, dirent.name);
      if (dirent.isSymbolicLink()) continue;
      if (isOwnTempName(dirent.name)) continue;
      if (dirent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(dirent.name.toLowerCase())) continue;
        if (current.depth + 1 > MAX_WALK_DEPTH) {
          // 深度上限是防卡死的闸，但「没往下看」必须让调用方知道：宁可多报 truncated，
          // 也不能让模型以为「更深处的文件不存在」
          depthLimited = true;
          continue;
        }
        // readdir 的类型在 Windows 上对 junction/挂载点不总是可靠，下钻前再 lstat 一次
        const stat = await lstatOrNull(full);
        if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
        stack.push({ dir: full, depth: current.depth + 1 });
      } else if (dirent.isFile()) {
        const rel = path.relative(startAbs, full).split(path.sep).join("/");
        const keepGoing = await onFile(full, rel);
        if (keepGoing === false) return { entries, walkTruncated: depthLimited };
      }
      // 其它类型（设备/管道/未知）不参与搜索
    }
  }
  return { entries, walkTruncated: depthLimited };
}

/* ────────────────────────── 搜索：glob / grep ────────────────────────── */

/**
 * glob：在 `dir`（缺省第一个根）下按模式找文件，按契约返回**绝对路径**。
 *
 * @param {{roots?:Array, pattern?:string, dir?:string}} payload
 * @returns {Promise<object>} `{ok:true,root,paths,truncated}` 或 `{ok:false,code,error}`
 */
async function globFiles(payload) {
  const roots = normalizeRoots(payload && payload.roots);
  if (roots.length === 0) return { ok: false, code: "no-roots", error: "尚未配置任何根目录" };
  let matcher;
  try {
    matcher = globToRegExp(payload && payload.pattern);
  } catch (e) {
    return { ok: false, code: "invalid-pattern", error: e && e.message ? e.message : String(e) };
  }
  const resolved = await resolveSearchDir(roots, payload && payload.dir);
  if (!resolved.ok) return resolved;

  const rootPath = resolved.root.path;
  const matched = [];
  let hitLimit = false;
  const outcome = await walkFiles(resolved.dir, async (abs, relToDir) => {
    if (!matcher.test(relToDir)) return true;
    const stat = await lstatOrNull(abs);
    // 遍历到 lstat 之间文件可能被删/被换成软链：跳过，不把它当结果
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return true;
    const relToRoot = path.relative(rootPath, abs).split(path.sep).join("/");
    matched.push({ abs, mtimeMs: stat.mtimeMs, relToRoot });
    if (matched.length >= MAX_GLOB_RESULTS) {
      hitLimit = true;
      return false;
    }
    return true;
  });

  // 契约顺序：mtime 新的在前；同一时间戳再按根内相对路径升序，保证结果可复现
  matched.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    const x = a.relToRoot.toLowerCase();
    const y = b.relToRoot.toLowerCase();
    if (x !== y) return x < y ? -1 : 1;
    return a.relToRoot < b.relToRoot ? -1 : a.relToRoot > b.relToRoot ? 1 : 0;
  });

  return {
    ok: true,
    root: rootPath,
    paths: matched.map((m) => m.abs),
    truncated: hitLimit || outcome.walkTruncated,
  };
}

/** 静默读文本：超上限/二进制/非法 UTF-8/软链/非普通文件都返回 null（grep 直接跳过该文件）。 */
async function readTextQuiet(abs) {
  const stat = await lstatOrNull(abs);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return null;
  if (stat.size > MAX_FILE_BYTES) return null;
  let buf;
  try {
    buf = await fsp.readFile(abs);
  } catch {
    return null;
  }
  if (looksBinary(buf)) return null;
  try {
    return UTF8_DECODER.decode(buf);
  } catch {
    return null;
  }
}

/**
 * grep：在 `dir`（缺省第一个根）下逐行匹配正则；`include` 用同一套 glob 子集。
 *
 * 两个安全考量：
 * 1) 长行**先截断再匹配**：契约本来就只回传前 2000 字符，而拿 2MB 的单行去跑用户提供的
 *    正则，等于给主进程留了一个 ReDoS 入口；截断后输入规模固定。
 * 2) 正则不加任何标志：内容匹配大小写敏感，与 grep 的直觉一致（只有路径匹配不敏感）。
 *
 * @param {{roots?:Array, pattern?:string, dir?:string, include?:string}} payload
 * @returns {Promise<object>} `{ok:true,root,matches,truncated}` 或 `{ok:false,code,error}`
 */
async function grepFiles(payload) {
  const roots = normalizeRoots(payload && payload.roots);
  if (roots.length === 0) return { ok: false, code: "no-roots", error: "尚未配置任何根目录" };
  const pattern = payload && payload.pattern;
  if (typeof pattern !== "string" || !pattern) {
    return { ok: false, code: "invalid-pattern", error: "grep 的正则不能为空" };
  }
  if (pattern.includes("\0")) return { ok: false, code: "invalid-pattern", error: "grep 的正则含非法字符（NUL）" };
  if (pattern.length > MAX_PATTERN_CHARS) {
    return { ok: false, code: "invalid-pattern", error: `grep 的正则过长（超过 ${MAX_PATTERN_CHARS} 字符）` };
  }
  let matcher;
  try {
    matcher = new RegExp(pattern);
  } catch (e) {
    return {
      ok: false,
      code: "invalid-pattern",
      error: `正则表达式不合法：${e && e.message ? e.message : String(e)}`,
    };
  }
  let includeMatcher = null;
  const include = payload && payload.include;
  if (include !== undefined && include !== null && include !== "") {
    try {
      includeMatcher = globToRegExp(include);
    } catch (e) {
      return {
        ok: false,
        code: "invalid-pattern",
        error: `include 模式不合法：${e && e.message ? e.message : String(e)}`,
      };
    }
  }

  const resolved = await resolveSearchDir(roots, payload && payload.dir);
  if (!resolved.ok) return resolved;

  const matches = [];
  let hitLimit = false;
  const outcome = await walkFiles(resolved.dir, async (abs, relToDir) => {
    if (includeMatcher) {
      // include 同时按文件名与相对路径匹配：`*.ts` 看名字，`src/**` 那类看层级
      const included = includeMatcher.test(path.basename(abs)) || includeMatcher.test(relToDir);
      if (!included) return true;
    }
    const text = await readTextQuiet(abs);
    if (text === null) return true;
    const lines = text.split(/\r\n|\n|\r/);
    for (let li = 0; li < lines.length; li += 1) {
      const head = lines[li].slice(0, MAX_GREP_LINE_CHARS);
      if (!matcher.test(head)) continue;
      matches.push({ path: abs, line: li + 1, text: head });
      if (matches.length >= MAX_GREP_MATCHES) {
        hitLimit = true;
        return false;
      }
    }
    return true;
  });

  return {
    ok: true,
    root: resolved.root.path,
    matches,
    truncated: hitLimit || outcome.walkTruncated,
  };
}

/** 目标已存在时的额外检查：软链 / 非普通文件 / 硬链接。返回错误文案或 null。 */
async function inspectExistingTarget(abs) {
  let stat;
  try {
    stat = await fsp.lstat(abs);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    return `检查目标失败：${e && e.message ? e.message : String(e)}`;
  }
  if (stat.isSymbolicLink()) return "目标是符号链接，已拒绝（避免写入根外的文件）";
  if (!stat.isFile()) return "目标不是普通文件，已拒绝";
  if (stat.nlink > 1) return "目标是硬链接（nlink>1），可能同时改到根外的另一份，已拒绝";
  return null;
}

/**
 * 校验写入目标的父目录；`createParents` 时收集需要补建的缺失目录（浅→深）。
 *
 * 为什么补建目录也要逐段走：`mkdir -p` 一行就能建出整棵树，但其中任何一段是软链，
 * 后面的写入就会被引到根外；所以先逐段 lstat，再逐级 mkdir，建完仍走原有的
 * tmp+fsync+rename——不因为目录是本工具建的，就把写盘语义降级。
 *
 * @returns {Promise<object>} `{ok:true, missing:string[]}` 或 `{ok:false, error}`
 */
async function inspectWriteParent(rootAbs, parentAbs, createParents) {
  const root = path.resolve(rootAbs);
  const parent = path.resolve(parentAbs);
  const rel = path.relative(root, parent);
  if (rel === "") return { ok: true, missing: [] }; // 目标直接在根下：根本身就是父目录
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, error: "父目录不在可写根内" };

  let current = root;
  const missing = [];
  for (const seg of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, seg);
    if (isReservedName(seg)) return { ok: false, error: `父目录名是 Windows 保留名，无法创建：${seg}` };
    const stat = await lstatOrNull(current);
    if (!stat) {
      missing.push(current);
      continue;
    }
    if (missing.length > 0) return { ok: false, error: `父目录路径中间有缺失目录，无法安全创建：${current}` };
    if (stat.isSymbolicLink()) {
      return { ok: false, error: `父目录包含符号链接，为避免绕出可写根已拒绝：${current}` };
    }
    if (!stat.isDirectory()) return { ok: false, error: `父目录路径中间存在非目录项：${current}` };
  }

  if (missing.length === 0) return { ok: true, missing: [] };
  if (!createParents) {
    // 老语义：不替用户建目录（见文件头「写盘语义」）；createParents 只由 file_write 显式开启
    return {
      ok: false,
      error: `父目录不存在或不是目录：${parentAbs}。请先在文件系统里创建目录，本工具不创建目录。`,
    };
  }
  return { ok: true, missing };
}

/** 回滚本次补建的空目录（深→浅；只 rmdir，不删非空目录——绝不误删用户内容）。 */
async function removeCreatedDirs(dirs) {
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    try {
      await fsp.rmdir(dirs[i]);
    } catch {
      /* 非空/已被占用：留着比误删安全 */
    }
  }
}

/**
 * 批量写入/删除（两阶段：先全部 stage，再统一 rename）。
 *
 * @param {Array} roots 已规整的根清单
 * @param {Array} ops `[{kind:"write"|"delete", path, content?}]`
 * @param {boolean} [createParents] 是否允许补建缺失父目录（默认 false，老语义不变）
 */
/**
 * 写入备份（d.170）：「撤销上一次写入」的唯一依据。
 *
 * 为什么必须由主进程存：渲染层能拿到的是「写完的结果」，旧内容在 rename 那一刻就没了；
 * 要能回滚，只能在**替换之前**把旧字节另存一份。放在主进程还多一层好处——备份目录由
 * 主进程决定（`app.getPath("userData")/backups`），渲染层既不能指定也不能读路径。
 *
 * 存的是什么：**原始字节**，不是补丁、不是 diff。回滚要能一字不差地还原（包括换行符、
 * BOM），存文本再拼回去会因为平台换行差异把文件改坏。
 *
 * 保留策略：每个文件最多 `MAX_BACKUPS_PER_PATH` 份、全局最多 `MAX_BACKUPS_TOTAL` 份，
 * 超出按时间从旧到新丢。为什么要有上限：备份是用户磁盘上的常驻文件，一次写循环能产生
 * 几十份；不设上限就是悄悄吃掉几百 MB。
 */
const MAX_BACKUPS_PER_PATH = 10;
const MAX_BACKUPS_TOTAL = 200;
const BACKUP_INDEX_FILE = "index.json";

function backupKey(absPath) {
  // Windows 路径大小写不敏感：同一个文件用两种大小写写进来，必须落到同一条记录上
  return absPath.replace(/\\/g, "/").toLowerCase();
}

async function readBackupIndex(dir) {
  try {
    const raw = await fsp.readFile(path.join(dir, BACKUP_INDEX_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

async function writeBackupIndex(dir, index) {
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, BACKUP_INDEX_FILE);
  const tmp = path.join(dir, `.index.heming-tmp-${crypto.randomBytes(4).toString("hex")}`);
  const handle = await fsp.open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(index), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, target);
}

/** 把 index 里超出上限的条目剪掉，并删掉对应备份文件（失败只留下孤儿文件，不影响索引正确性） */
async function pruneBackups(dir, index) {
  const flat = [];
  for (const [key, entries] of Object.entries(index)) {
    if (!Array.isArray(entries)) {
      delete index[key];
      continue;
    }
    entries.forEach((entry, i) => flat.push({ key, i, entry }));
  }
  flat.sort((a, b) => String(a.entry.at).localeCompare(String(b.entry.at)));
  const dropped = flat.slice(0, Math.max(0, flat.length - MAX_BACKUPS_TOTAL));
  for (const item of dropped) {
    try {
      await fsp.unlink(path.join(dir, item.entry.file));
    } catch {
      /* 文件已不在：索引照样要清掉 */
    }
  }
  const droppedKeys = new Set(dropped.map((d) => d.key + "::" + d.entry.file));
  for (const [key, entries] of Object.entries(index)) {
    const kept = entries.filter((e) => !droppedKeys.has(key + "::" + e.file));
    if (kept.length) index[key] = kept;
    else delete index[key];
  }
}

/**
 * 备份一份旧内容。返回 `{ at, file }`；备份写失败返回 null（**不阻塞写入**：
 * 备份是「额外的安全网」，不能因为磁盘配额满了就让用户改不了文件）。
 */
async function createBackup(dir, absPath, bytes) {
  if (!dir || !bytes || bytes.length === 0) return null;
  try {
    await fsp.mkdir(dir, { recursive: true });
    const index = await readBackupIndex(dir);
    const key = backupKey(absPath);
    const at = new Date().toISOString();
    const file = `${Date.now().toString(36)}-${crypto.createHash("sha1").update(key).digest("hex").slice(0, 12)}.bak`;
    await fsp.writeFile(path.join(dir, file), bytes);
    const entries = Array.isArray(index[key]) ? index[key] : [];
    entries.push({ file, at, bytes: bytes.length, path: absPath });
    index[key] = entries.slice(-MAX_BACKUPS_PER_PATH);
    await pruneBackups(dir, index);
    await writeBackupIndex(dir, index);
    return { at, file };
  } catch {
    return null;
  }
}

/**
 * 撤销上一次写入：把最新一份备份写回目标文件。
 *
 * 语义选择（写清楚，免得模型/用户误解）：
 * - **一份备份只能用一次**：写回后该条记录被消费掉，再撤销会回「没有可撤销的备份」。
 *   为什么不保留：保留就成了「撤销↔重做」的开关，模型连点两次会来回横跳，用户完全
 *   看不出现状是哪个版本。
 * - 回滚本身也是一次写：同样经过写根/根内/软链/保留名四道检查，不因为「是恢复」就绕过。
 */
async function undoWrite(roots, absPath, dir) {
  const writeRoots = roots.filter((r) => r.mode === "write");
  if (writeRoots.length === 0) {
    return { ok: false, code: "no-write-root", error: "尚未配置可写根（mode=write），无法撤销" };
  }
  if (!dir) return { ok: false, code: "no-backup-dir", error: "桌面端未启用写入备份，无法撤销" };
  const root = findRoot(roots, absPath);
  if (!root) return { ok: false, code: "outside-roots", error: `目标不在任何已配置的根内：${absPath}` };
  if (root.mode !== "write") {
    return { ok: false, code: "outside-roots", error: `目标位于只读根「${root.name}」，写入被拒绝：${absPath}` };
  }
  const checked = checkAbsoluteInside(absPath, root.path);
  if (!checked.ok) return { ok: false, code: "outside-roots", error: checked.error };
  const linkCheck = assertNoSymlinkAncestor(root.path, checked.abs);
  if (!linkCheck.ok) return { ok: false, code: "symlink", error: linkCheck.error };
  if (isReservedName(path.basename(checked.abs))) {
    return { ok: false, code: "io", error: `文件名是 Windows 保留名，无法写入：${path.basename(checked.abs)}` };
  }

  const index = await readBackupIndex(dir);
  const key = backupKey(checked.abs);
  const entries = Array.isArray(index[key]) ? index[key] : [];
  const last = entries[entries.length - 1];
  if (!last) {
    return { ok: false, code: "no-backup", error: `没有「${checked.abs}」的可撤销备份` };
  }
  let bytes;
  try {
    bytes = await fsp.readFile(path.join(dir, last.file));
  } catch (e) {
    return { ok: false, code: "no-backup", error: `备份文件读不出来：${e && e.message ? e.message : String(e)}` };
  }

  const targetDir = path.dirname(checked.abs);
  const tmp = path.join(targetDir, `.${path.basename(checked.abs)}.heming-tmp-${crypto.randomBytes(6).toString("hex")}`);
  try {
    const handle = await fsp.open(tmp, "w");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmp, checked.abs);
  } catch (e) {
    try {
      await fsp.unlink(tmp);
    } catch {
      /* 临时文件清理失败不影响「原文件未被改动」这个结论 */
    }
    return { ok: false, code: "io", error: `回滚失败（文件保持原样）：${e && e.message ? e.message : String(e)}` };
  }

  entries.pop();
  if (entries.length) index[key] = entries;
  else delete index[key];
  try {
    await writeBackupIndex(dir, index);
  } catch {
    /* 索引写不回去：备份文件已经用掉，最坏结果是这条记录留着、下次撤销失败报错 */
  }
  return { ok: true, path: checked.abs, restoredFrom: last.at, bytes: bytes.length };
}


/**
 * 列出可回滚的最近改动（d.171，设置区「最近改动」用）。
 *
 * 口径：
 * - 只列**可写根内**的文件——列表里的每一行都要真的能点「回滚」，列出只读根是骗人；
 * - 每个文件只列最新一份备份（更早的靠「连续回滚」拿；列表不是版本历史浏览器）；
 * - 按时间倒序、最多 `MAX_BACKUP_LIST = 50` 条：这是给人看的列表，不是审计日志。
 */
async function listBackups(roots, dir) {
  if (!dir) return { ok: true, items: [] };
  const writeRoots = roots.filter((r) => r.mode === "write");
  if (writeRoots.length === 0) return { ok: true, items: [] };
  const index = await readBackupIndex(dir);
  const items = [];
  for (const [key, entries] of Object.entries(index)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const latest = entries[entries.length - 1];
    // 老条目（d.170 之前写的）没有 path 字段：用归一化 key 反推近似路径，仍按根判定
    const absPath = typeof latest.path === "string" && latest.path ? latest.path : key;
    const root = findRoot(roots, absPath);
    if (!root || root.mode !== "write") continue;
    items.push({ path: absPath, at: latest.at, bytes: latest.bytes });
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { ok: true, items: items.slice(0, MAX_BACKUP_LIST) };
}

const MAX_BACKUP_LIST = 50;

async function writeBatch(roots, ops, createParents = false, backupDir = null) {
  const writeRoots = roots.filter((r) => r.mode === "write");
  if (writeRoots.length === 0) {
    return { ok: false, error: "尚未配置可写根（mode=write），无法写入" };
  }
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, error: "没有要写入的变更" };
  if (ops.length > MAX_FILES) return { ok: false, error: `单次最多修改 ${MAX_FILES} 个文件` };

  const plan = [];
  let totalBytes = 0;
  for (const op of ops) {
    if (!op || typeof op !== "object") return { ok: false, error: "变更项格式不合法" };
    const kind = op.kind === "write" ? "write" : op.kind === "delete" ? "delete" : null;
    if (!kind) return { ok: false, error: "变更项类型只能是 write 或 delete" };
    if (typeof op.path !== "string" || !op.path) return { ok: false, error: "变更项缺少目标路径" };
    const root = findRoot(roots, op.path);
    if (!root) return { ok: false, error: `目标不在任何已配置的根内：${op.path}` };
    if (root.mode !== "write") {
      return { ok: false, error: `目标位于只读根「${root.name}」，写入被拒绝：${op.path}` };
    }
    const checked = checkAbsoluteInside(op.path, root.path);
    if (!checked.ok) return { ok: false, error: `${checked.error}：${op.path}` };
    const linkCheck = assertNoSymlinkAncestor(root.path, checked.abs);
    if (!linkCheck.ok) return { ok: false, error: `${linkCheck.error}：${op.path}` };
    if (isReservedName(path.basename(checked.abs))) {
      return { ok: false, error: `文件名是 Windows 保留名，无法写入：${path.basename(checked.abs)}` };
    }

    if (kind === "write") {
      if (typeof op.content !== "string") return { ok: false, error: "写入内容必须是字符串" };
      if (op.content.includes("\0")) return { ok: false, error: "写入内容含 NUL，拒绝写入二进制内容" };
      const bytes = Buffer.byteLength(op.content, "utf8");
      if (bytes > MAX_FILE_BYTES) {
        return { ok: false, error: `${op.path} 内容约 ${Math.round(bytes / 1024)} KB，超过单文件上限` };
      }
      totalBytes += bytes;
      if (totalBytes > MAX_PATCH_BYTES) return { ok: false, error: "单次补丁总量超过上限" };
      // 父目录：默认必须已存在；createParents=true（file_write 显式要求）才允许补建，逐段校验见函数注释
      const parentCheck = await inspectWriteParent(root.path, path.dirname(checked.abs), createParents);
      if (!parentCheck.ok) return { ok: false, error: parentCheck.error };
      plan.push({ kind, abs: checked.abs, root, content: op.content, missingDirs: parentCheck.missing });
    } else {
      plan.push({ kind, abs: checked.abs, root, missingDirs: [] });
    }
  }

  // 已存在目标的前置检查（软链/硬链/非普通文件；删除的目标必须存在）
  for (const item of plan) {
    const problem = await inspectExistingTarget(item.abs);
    if (problem) return { ok: false, error: `${problem}：${item.abs}` };
    if (item.kind === "delete" && problem === null) {
      const exists = fs.existsSync(item.abs);
      if (!exists) return { ok: false, error: `要删除的文件不存在：${item.abs}` };
    }
  }

  const writes = plan.filter((p) => p.kind === "write");
  const deletes = plan.filter((p) => p.kind === "delete");

  // 阶段 0：补建缺失父目录（仅 createParents；目录清单已在上面逐段校验过）
  const createdDirs = [];
  if (createParents) {
    const seen = new Set();
    try {
      for (const item of writes) {
        for (const dir of item.missingDirs) {
          const key = dir.toLowerCase();
          if (seen.has(key)) continue;
          // 逐级 mkdir（非 recursive）：每一级都经过 inspectWriteParent 的校验
          await fsp.mkdir(dir);
          seen.add(key);
          createdDirs.push(dir);
        }
      }
    } catch (e) {
      await removeCreatedDirs(createdDirs);
      return { ok: false, error: `创建父目录失败：${e && e.message ? e.message : String(e)}` };
    }
  }

  // 阶段 1：全部写到同目录 tmp 并 fsync（原文件在这阶段完全不动）
  const staged = [];
  try {
    for (const item of writes) {
      const dir = path.dirname(item.abs);
      const tmp = path.join(
        dir,
        `.${path.basename(item.abs)}.heming-tmp-${crypto.randomBytes(6).toString("hex")}`,
      );
      const handle = await fsp.open(tmp, "w");
      try {
        await handle.writeFile(item.content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      staged.push({ item, tmp });
    }
  } catch (e) {
    // 清理已 stage 的 tmp：原文件一个字节都没动
    for (const s of staged) {
      try {
        await fsp.unlink(s.tmp);
      } catch {
        /* 清理失败不影响结论：tmp 文件残留不会破坏原文件 */
      }
    }
    // 本次才建出来的空目录也一并收回：失败不应在磁盘上留下半棵树（rename 之前才回滚）
    await removeCreatedDirs(createdDirs);
    return { ok: false, error: `写入失败（原文件未改动）：${e && e.message ? e.message : String(e)}` };
  }

  // 阶段 1.5：替换/删除之前，把旧内容留一份备份（d.170）。
  // 放在 stage 之后：写入既然已经能落盘，才值得占一份备份；stage 失败时原文件没动，
  // 也不需要备份（否则磁盘上会堆一堆「什么都没改」的快照）。
  const backups = [];
  if (backupDir) {
    for (const item of plan) {
      try {
        const st = await fsp.lstat(item.abs);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
        const old = await fsp.readFile(item.abs);
        const saved = await createBackup(backupDir, item.abs, old);
        if (saved) backups.push({ path: item.abs, at: saved.at });
      } catch {
        /* 目标还不存在（新建文件）或读不出来：没有旧版本可备份，这是正常情况 */
      }
    }
  }

  // 阶段 2：统一 rename 覆盖（同目录 rename 在 NTFS 上是原子的）
  const results = [];
  for (const s of staged) {
    try {
      await fsp.rename(s.tmp, s.item.abs);
      results.push({ path: s.item.abs, ok: true });
    } catch (e) {
      try {
        await fsp.unlink(s.tmp);
      } catch {
        /* 同上 */
      }
      results.push({ path: s.item.abs, ok: false, error: `替换失败：${e && e.message ? e.message : String(e)}` });
    }
  }

  // 阶段 3：删除（改名语义下这一步必须在写入成功之后）
  for (const item of deletes) {
    try {
      await fsp.unlink(item.abs);
      results.push({ path: item.abs, ok: true });
    } catch (e) {
      results.push({ path: item.abs, ok: false, error: `删除失败：${e && e.message ? e.message : String(e)}` });
    }
  }

  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    results,
    written: writes.length,
    deleted: deletes.length,
    ...(backups.length ? { backups } : {}),
    ...(failed.length ? { error: `${failed.length} 个文件未能完成（其余已写入）` } : {}),
  };
}

/**
 * 注册 IPC。放在模块里而不是 main.js，是为了能用假 ipcMain/dialog 单测。
 *
 * 每个通道第一步都校验**调用来源**（只接受主窗口的 webContents）：
 * 桌宠窗口、未来的其它渲染进程都不能通过这里改用户的文件。
 * 未注入校验函数时按「拒绝」处理（fail-closed）——忘了接线是安全问题，不能被默认放行掩盖。
 *
 * @param {object} ipcMain
 * @param {object} deps
 * @param {{showOpenDialog: Function}} deps.dialog
 * @param {() => any} [deps.getMainWindow]
 * @param {(event: any) => boolean} [deps.isTrustedSender]
 * @param {string} [deps.defaultRootDir] 默认工作区绝对路径（main.js 传，桌面端固定目录）
 */
function registerFileIpc(ipcMain, deps) {
  const dialog = deps && deps.dialog;
  const getMainWindow = deps && deps.getMainWindow;
  const isTrustedSender = (deps && deps.isTrustedSender) || (() => false);
  // 写入备份目录（main.js 传 userData/backups）。不传就退化成「没有撤销能力」，不影响读写。
  const backupDir = (deps && deps.backupDir) || null;

  const untrusted = { ok: false, code: "untrusted-sender", error: "未授权的调用来源" };

  /**
   * 文件 IO 串行队列：写入与搜索共用同一条队列。
   *
   * 搜索为什么也要排：批量写会先落一堆 `.heming-tmp-*` 再统一 rename，遍历若在中间态
   * 跑就会看见「不算数的文件」；排在同一条线上，搜索看到的永远是稳定态。
   */
  let ioQueue = Promise.resolve();
  const enqueue = (task) => {
    const run = ioQueue.then(() => task());
    // 队列自身不能被一次失败卡死：catch 掉再继续排下一次
    ioQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  ipcMain.handle("file:read", async (event, payload) => {
    if (!isTrustedSender(event)) return untrusted;
    try {
      const roots = normalizeRoots(payload && payload.roots);
      if (roots.length === 0) return { ok: false, code: "no-roots", error: "尚未配置任何根目录" };
      return await readFile(roots, payload && payload.path);
    } catch (e) {
      return { ok: false, code: "io", error: `读取失败：${e && e.message ? e.message : String(e)}` };
    }
  });

  ipcMain.handle("file:image", async (event, payload) => {
    if (!isTrustedSender(event)) return untrusted;
    try {
      const roots = normalizeRoots(payload && payload.roots);
      if (roots.length === 0) return { ok: false, code: "no-roots", error: "尚未配置任何根目录" };
      return await readImage(roots, payload && payload.path);
    } catch (e) {
      return { ok: false, code: "io", error: `读取失败：${e && e.message ? e.message : String(e)}` };
    }
  });

  ipcMain.handle("file:write", async (event, payload) => {
    if (!isTrustedSender(event)) return untrusted;
    const roots = normalizeRoots(payload && payload.roots);
    const ops = payload && payload.ops;
    // 只认显式的 true：缺省/其它值一律按老语义（不建目录），不给渲染层「传错就放宽」的机会
    const createParents = Boolean(payload && payload.createParents === true);
    try {
      return await enqueue(() => writeBatch(roots, ops, createParents, backupDir));
    } catch (e) {
      return { ok: false, error: `写入失败：${e && e.message ? e.message : String(e)}` };
    }
  });

  // 撤销上一次写入（d.170）：写回最新一份备份。走同一条 IO 队列——它也是一次写。
  ipcMain.handle("file:undo", async (event, payload) => {
    if (!isTrustedSender(event)) return untrusted;
    try {
      const roots = normalizeRoots(payload && payload.roots);
      if (roots.length === 0) return { ok: false, code: "no-roots", error: "尚未配置任何根目录" };
      return await enqueue(() => undoWrite(roots, payload && payload.path, backupDir));
    } catch (e) {
      return { ok: false, error: `撤销失败：${e && e.message ? e.message : String(e)}` };
    }
  });

  // 最近改动列表（d.171）：设置区展示「可回滚的改动」用，只读、不排队。
  ipcMain.handle("file:backups", async (event, payload) => {
    if (!isTrustedSender(event)) return untrusted;
    try {
      const roots = normalizeRoots(payload && payload.roots);
      if (roots.length === 0) return { ok: false, code: "no-roots", error: "尚未配置任何根目录" };
      return await listBackups(roots, backupDir);
    } catch (e) {
      return { ok: false, error: `读取最近改动失败：${e && e.message ? e.message : String(e)}` };
    }
  });

  ipcMain.handle("file:glob", async (event, payload) => {
    if (!isTrustedSender(event)) return untrusted;
    try {
      return await enqueue(() => globFiles(payload || {}));
    } catch (e) {
      return { ok: false, code: "io", error: `搜索失败：${e && e.message ? e.message : String(e)}` };
    }
  });

  ipcMain.handle("file:grep", async (event, payload) => {
    if (!isTrustedSender(event)) return untrusted;
    try {
      return await enqueue(() => grepFiles(payload || {}));
    } catch (e) {
      return { ok: false, code: "io", error: `搜索失败：${e && e.message ? e.message : String(e)}` };
    }
  });

  // 未分组会话没有用户显式选的根，但同样需要文件能力：主进程只下发**自己算好的**
  // 默认工作区路径，不接受渲染层传任何路径参数（否则等于开了任意目录探测）。
  // 目录不存在时顺手补建（recursive 幂等）；建不出来也只回错误，不抛。
  //
  // 为什么是 `ipcMain.on` + `event.returnValue` 而不是 `handle`：preload 在**加载时**
  // 用 `sendSync` 问一次这个路径（文件工具要在首帧就知道默认工作区）。`sendSync` 只认
  // 同步监听者——用 `handle` 注册会让渲染进程永远等不到返回，**整个窗口加载不出来**
  // （d.166 的桌面桥冒烟就是这么炸出来的）。所以这里必须同步：mkdirSync + returnValue。
  ipcMain.on("file:default-root", (event) => {
    if (!isTrustedSender(event)) {
      event.returnValue = untrusted;
      return;
    }
    const dir = deps && deps.defaultRootDir;
    if (typeof dir !== "string" || !dir || !path.isAbsolute(dir)) {
      event.returnValue = { ok: false, error: "主进程未配置默认工作区目录" };
      return;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      event.returnValue = { ok: true, path: dir };
    } catch (e) {
      event.returnValue = { ok: false, error: `创建默认工作区失败：${e && e.message ? e.message : String(e)}` };
    }
  });

  ipcMain.handle("file:pick-root", async (event) => {
    if (!isTrustedSender(event)) return null;
    if (!dialog || typeof dialog.showOpenDialog !== "function") return null;
    const options = {
      title: "选择可写目录",
      properties: ["openDirectory", "createDirectory"],
    };
    const win = typeof getMainWindow === "function" ? getMainWindow() : null;
    let result;
    try {
      result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    } catch {
      return null;
    }
    if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });
}

module.exports = {
  registerFileIpc,
  normalizeRoots,
  findRoot,
  readFile,
  readImage,
  sniffImageMime,
  writeBatch,
  undoWrite,
  listBackups,
  createBackup,
  readBackupIndex,
  looksBinary,
  globToRegExp,
  globFiles,
  grepFiles,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_BACKUPS_PER_PATH,
  MAX_BACKUPS_TOTAL,
  MAX_PATCH_BYTES,
  MAX_FILES,
  MAX_GLOB_RESULTS,
  MAX_GREP_MATCHES,
  MAX_GREP_LINE_CHARS,
  MAX_WALK_ENTRIES,
  MAX_WALK_DEPTH,
  MAX_PATTERN_CHARS,
};
