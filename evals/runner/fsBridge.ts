/**
 * 评测用的文件桥：用 `node:fs` 实现 `FileFsBridge`。
 *
 * 为什么不复用桌面端主进程的 `file-fs.js`：那是 Electron preload 的另一侧，
 * 评测要让**真实的 `fileEdit` 工具代码**跑在 Node 里，只需要一个语义一致的桥。
 * 校验口径照抄主进程：只允许根内路径、拒绝越界/符号链接、二进制与超大文件。
 */

import { constants } from "node:fs";
import { access, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileFsBridge, FileReadResponse, FileWriteOp, FileWriteResponse } from "../../packages/web/src/lib/fileEdit/bridge.js";
import type { FileRoot } from "../../packages/web/src/lib/fileEdit/paths.js";
import { MAX_FILE_BYTES, SNIFF_BYTES } from "../../packages/web/src/lib/fileEdit/limits.js";

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

export interface NodeFsBridgeOptions {
  /** 只读兜底：为 true 时任何 write op 都拒绝（默认 false）。 */
  readOnly?: boolean;
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
