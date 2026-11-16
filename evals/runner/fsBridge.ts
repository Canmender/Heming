/**
 * 评测用的文件桥：用 `node:fs` 实现 `FileFsBridge`。
 *
 * 为什么不复用桌面端主进程的 `file-fs.js`：那是 Electron preload 的另一侧，
 * 评测要让**真实的 `fileEdit` 工具代码**跑在 Node 里，只需要一个语义一致的桥。
 * 校验口径照抄主进程：只允许根内路径、拒绝越界/符号链接、二进制与超大文件。
 */

import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  FileFsBridge,
  FileGrepMatch,
  FileGrepResponse,
  FileGlobResponse,
  FileReadResponse,
  FileSearchFailure,
  FileWriteOp,
  FileWriteResponse,
} from "../../packages/web/src/lib/fileEdit/bridge.js";
import { MAX_PATH_CHARS } from "../../packages/web/src/lib/fileEdit/paths.js";
import type { FileRoot } from "../../packages/web/src/lib/fileEdit/paths.js";
import { MAX_IMAGE_BYTES } from "../../packages/web/src/lib/fileEdit/limits.js";
import {
  GREP_MAX_LINE_CHARS,
  GREP_MAX_MATCHES,
  GLOB_MAX_RESULTS,
  MAX_FILE_BYTES,
  SNIFF_BYTES,
} from "../../packages/web/src/lib/fileEdit/limits.js";

/** 规范化路径：绝对路径 + 正斜杠（与仓库里的存储形式一致）。 */
export function toPosix(abs: string): string {
  return path.resolve(abs).replace(/\\/g, "/");
}

/** 路径是否在某条根内（Windows 大小写不敏感）。 */
function insideRoot(root: FileRoot, abs: string): boolean {
  const base = toPosix(root.path).replace(/\/+$/, "");
  const target = toPosix(abs);
  if (process.platform === "win32") {
    const b = base.toLowerCase();
    const t = target.toLowerCase();
    return t === b || t.startsWith(`${b}/`);
  }
  return target === base || target.startsWith(`${base}/`);
}

/** 把绝对路径解析到一条根（读用任意根、写要求 write 根）。 */
function rootOfPath(roots: FileRoot[], abs: string, mode: "read" | "write"): FileRoot | null {
  return roots.find((root) => (mode === "read" || root.mode === "write") && insideRoot(root, abs)) ?? null;
}

/** 二进制嗅探：与主进程同口径（前 8KB 出现 NUL 即二进制）。 */
function looksBinary(head: Buffer): boolean {
  return head.includes(0);
}

/* ────────────────────────── 搜索：glob / grep ────────────────────────── */

/** 搜索时跳过的依赖/元数据目录（与桌面主进程同口径）。 */
const SEARCH_SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn"]);
/** 遍历上限：条目与深度都要有顶，否则一个大仓库能把评测拖成分钟级。 */
const MAX_WALK_ENTRIES = 20_000;
const MAX_WALK_DEPTH = 20;
/** 正则长度上限（与桌面 `MAX_PATTERN_CHARS` 同值）。 */
const MAX_PATTERN_CHARS = 1000;

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * glob → 正则：支持 `*` `?` `**` `{a,b}` `[abc]`；`**\/` 可匹配零层；**路径匹配大小写不敏感**。
 *
 * 桌面主进程用的是同一套子集（`file-fs.js` 的 `globToRegExp`），这里独立实现是刻意的：
 * 评测桥与主进程桥各自可被单测/用例盯住，任何一边漂了都有人发现。
 */
function globToRegExp(glob: string): RegExp {
  const source = glob.replace(/\\/g, "/").trim();
  if (!source) throw new Error("glob 模式不能为空");
  if (source.length > MAX_PATH_CHARS) throw new Error(`glob 模式过长（超过 ${MAX_PATH_CHARS} 字符）`);
  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "*") {
      if (source[i + 1] === "*") {
        i += 1;
        if (source[i + 1] === "/") {
          i += 1;
          out += "(?:[^/]*/)*";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const close = source.indexOf("}", i + 1);
      if (close < 0) throw new Error("glob 模式里的 { 没有闭合");
      const group = source.slice(i + 1, close);
      if (!group) throw new Error("glob 模式里有空的 {}");
      out += `(?:${group.split(",").map(escapeRegExp).join("|")})`;
      i = close;
    } else if (ch === "[") {
      const close = source.indexOf("]", i + 1);
      if (close < 0) throw new Error("glob 模式里的 [ 没有闭合");
      const set = source.slice(i + 1, close);
      if (!set) throw new Error("glob 模式里有空的 []");
      out += `[${set.replace(/\\/g, "\\\\")}]`;
      i = close;
    } else {
      out += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${out}$`, "i");
}

/** 在 `dir` 下逐个普通文件回调；跳过软链与依赖目录，条目/深度都有上限。 */
async function walkSearchFiles(
  dir: string,
  onFile: (abs: string, relToDir: string) => Promise<boolean> | boolean,
): Promise<{ truncated: boolean }> {
  let visited = 0;
  let truncated = false;
  const stack: { abs: string; depth: number }[] = [{ abs: dir, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) return { truncated: true };
      const abs = path.join(current.abs, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
        if (current.depth + 1 > MAX_WALK_DEPTH) {
          truncated = true;
          continue;
        }
        stack.push({ abs, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(dir, abs).replace(/\\/g, "/");
      const keepGoing = await onFile(abs, rel);
      if (!keepGoing) return { truncated };
    }
  }
  return { truncated };
}

/** 解析搜索目录：缺省第一条根；必须落在某条根内（搜索是读操作，只读根也算）。 */
function searchDirOf(
  roots: FileRoot[],
  dir?: string,
): { ok: true; dir: string; root: FileRoot } | { ok: false; failure: FileSearchFailure } {
  if (roots.length === 0) return { ok: false, failure: { ok: false, code: "no-roots", error: "尚未配置任何根目录" } };
  const base = dir ? toPosix(dir) : toPosix(roots[0].path);
  const root = roots.find((candidate) => insideRoot(candidate, base));
  if (!root) {
    return { ok: false, failure: { ok: false, code: "outside-roots", error: `搜索目录不在任何已配置的根内：${base}` } };
  }
  return { ok: true, dir: base, root };
}

/** 读文本做搜索：二进制/超大/软链/非普通文件返回 null（直接跳过该文件）。 */
async function readTextForSearch(abs: string): Promise<string | null> {
  try {
    const info = await lstat(abs);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    if (info.size > MAX_FILE_BYTES) return null;
    const bytes = await readFile(abs);
    if (looksBinary(bytes.subarray(0, SNIFF_BYTES))) return null;
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

export interface NodeFsBridgeOptions {
  /** 只读兜底：为 true 时任何 write op 都拒绝（默认 false）。 */
  readOnly?: boolean;
}

/**
 * 按魔数判断图片类型（与桌面 `file-fs.js` 的 `sniffImageMime` 同口径）。
 *
 * 为什么不复用扩展名：评测要能验证「把 txt 改名成 .png 会被拒」这条红线，
 * 用扩展名判断就永远测不出这个分支。
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const head = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    const riff = Buffer.from(bytes.subarray(0, 4)).toString("ascii");
    const webp = Buffer.from(bytes.subarray(8, 12)).toString("ascii");
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  return null;
}

/** 构造一个真实的 node:fs 文件桥。 */
export function createNodeFsBridge(options: NodeFsBridgeOptions = {}): FileFsBridge {
  return {
    async read({ roots, path: rawPath }: { roots: FileRoot[]; path: string }): Promise<FileReadResponse> {
      const abs = toPosix(rawPath);
      if (!roots.some((root) => insideRoot(root, abs))) {
        return { ok: false, code: "outside-roots", error: `路径不在任何已配置的根内：${rawPath}` };
      }
      try {
        const info = await stat(abs);
        if (!info.isFile()) return { ok: false, code: "not-file", error: `不是普通文件：${rawPath}` };
        if (info.size > MAX_FILE_BYTES) {
          return { ok: false, code: "too-large", error: `文件超过 ${MAX_FILE_BYTES} 字节上限：${rawPath}` };
        }
        const bytes = await readFile(abs);
        if (looksBinary(bytes.subarray(0, SNIFF_BYTES))) {
          return { ok: false, code: "binary", error: `二进制文件不可读：${rawPath}` };
        }
        const content = bytes.toString("utf8");
        return { ok: true, content, bytes: bytes.byteLength };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return { ok: false, code: "not-found", error: `文件不存在：${rawPath}` };
        if (code === "EACCES" || code === "EPERM") return { ok: false, code: "io", error: `没有读取权限：${rawPath}` };
        return { ok: false, code: "io", error: `读取失败：${rawPath}（${code ?? "unknown"}）` };
      }
    },

    async write({ roots, ops }: { roots: FileRoot[]; ops: FileWriteOp[] }): Promise<FileWriteResponse> {
      const results: { path: string; ok: boolean; error?: string }[] = [];
      let written = 0;
      let deleted = 0;
      for (const op of ops) {
        const abs = toPosix(op.path);
        if (options.readOnly) {
          results.push({ path: op.path, ok: false, error: "评测桥处于只读模式" });
          continue;
        }
        if (!rootOfPath(roots, abs, "write")) {
          results.push({ path: op.path, ok: false, error: `不在任何可写根内：${op.path}` });
          continue;
        }
        try {
          if (op.kind === "delete") {
            await unlink(abs);
            deleted += 1;
            results.push({ path: op.path, ok: true });
          } else {
            await mkdir(path.dirname(abs), { recursive: true });
            await writeFile(abs, op.content ?? "", "utf8");
            written += 1;
            results.push({ path: op.path, ok: true });
          }
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          results.push({ path: op.path, ok: false, error: `写入失败（${code ?? "unknown"}）：${op.path}` });
        }
      }
      const ok = results.every((r) => r.ok);
      return { ok, results, written, deleted, ...(ok ? {} : { error: "部分写入失败" }) };
    },

    async pickRoot(): Promise<string | null> {
      return null;
    },

    async image({ roots, path: rawPath }: { roots: FileRoot[]; path: string }) {
      const abs = toPosix(rawPath);
      if (!roots.some((root) => insideRoot(root, abs))) {
        return { ok: false as const, code: "outside-roots" as const, error: `路径不在任何已配置的根内：${rawPath}` };
      }
      try {
        const info = await stat(abs);
        if (!info.isFile()) return { ok: false as const, code: "not-file" as const, error: `不是普通文件：${rawPath}` };
        if (info.size > MAX_IMAGE_BYTES) {
          return { ok: false as const, code: "too-large" as const, error: `图片超过 ${MAX_IMAGE_BYTES} 字节上限：${rawPath}` };
        }
        const bytes = await readFile(abs);
        const mime = sniffImageMime(bytes);
        if (!mime) return { ok: false as const, code: "unsupported-image" as const, error: `不是 PNG/JPEG/GIF/WebP 图片：${rawPath}` };
        return { ok: true as const, mime, bytes: bytes.byteLength, base64: bytes.toString("base64") };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return { ok: false as const, code: "not-found" as const, error: `文件不存在：${rawPath}` };
        if (code === "EACCES" || code === "EPERM") return { ok: false as const, code: "io" as const, error: `没有读取权限：${rawPath}` };
        return { ok: false as const, code: "io" as const, error: `读取失败：${rawPath}（${code ?? "unknown"}）` };
      }
    },

    async glob({ roots, pattern, dir }: { roots: FileRoot[]; pattern: string; dir?: string }): Promise<FileGlobResponse> {
      const resolved = searchDirOf(roots, dir);
      if (!resolved.ok) return resolved.failure;
      let matcher: RegExp;
      try {
        matcher = globToRegExp(pattern);
      } catch (e) {
        return { ok: false, code: "invalid-pattern", error: e instanceof Error ? e.message : String(e) };
      }
      const paths: string[] = [];
      let hitLimit = false;
      const walk = await walkSearchFiles(resolved.dir, (abs, rel) => {
        if (!matcher.test(rel)) return true;
        paths.push(abs.replace(/\\/g, "/"));
        if (paths.length >= GLOB_MAX_RESULTS) {
          hitLimit = true;
          return false;
        }
        return true;
      });
      return { ok: true, root: resolved.root.path, paths, truncated: hitLimit || walk.truncated };
    },

    async grep({
      roots,
      pattern,
      dir,
      include,
    }: {
      roots: FileRoot[];
      pattern: string;
      dir?: string;
      include?: string;
    }): Promise<FileGrepResponse> {
      if (typeof pattern !== "string" || !pattern) {
        return { ok: false, code: "invalid-pattern", error: "grep 的正则不能为空" };
      }
      if (pattern.includes("\0")) {
        return { ok: false, code: "invalid-pattern", error: "grep 的正则含非法字符（NUL）" };
      }
      if (pattern.length > MAX_PATTERN_CHARS) {
        return { ok: false, code: "invalid-pattern", error: `grep 的正则过长（超过 ${MAX_PATTERN_CHARS} 字符）` };
      }
      const resolved = searchDirOf(roots, dir);
      if (!resolved.ok) return resolved.failure;
      let matcher: RegExp;
      let includeMatcher: RegExp | null = null;
      try {
        matcher = new RegExp(pattern);
        includeMatcher = include ? globToRegExp(include) : null;
      } catch (e) {
        return { ok: false, code: "invalid-pattern", error: e instanceof Error ? e.message : String(e) };
      }
      const matches: FileGrepMatch[] = [];
      let hitLimit = false;
      const walk = await walkSearchFiles(resolved.dir, async (abs, rel) => {
        if (includeMatcher && !includeMatcher.test(rel)) return true;
        const text = await readTextForSearch(abs);
        if (text === null) return true;
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          // 长行先截断再匹配：与桌面端同口径，避免拿 2MB 单行喂正则（ReDoS 入口）。
          const probe = line.length > GREP_MAX_LINE_CHARS ? line.slice(0, GREP_MAX_LINE_CHARS) : line;
          if (!matcher.test(probe)) continue;
          matches.push({ path: abs.replace(/\\/g, "/"), line: index + 1, text: probe });
          if (matches.length >= GREP_MAX_MATCHES) {
            hitLimit = true;
            return false;
          }
        }
        return true;
      });
      return { ok: true, root: resolved.root.path, matches, truncated: hitLimit || walk.truncated };
    },
  };
}

/** 检查路径是否存在（fixture/no_side_effect 判定用，不抛）。 */
export async function pathExists(abs: string): Promise<boolean> {
  try {
    await access(abs, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
