/**
 * `file_patch` 补丁协议解析（规格 §3）。
 *
 * 设计取舍：解析器**不碰磁盘、不判路径是否在根内**——它只回答「这段文本是否符合协议」。
 * 路径越界、文件是否存在、大小上限都在干跑层（`apply.ts`）判定，
 * 因为那些判断需要根配置与文件系统。分层的好处是：解析器的 20+ 个用例全是纯字符串比较。
 *
 * 为什么严格：模型混入上下文行、漏 `+`、把 `Move to` 写在 `@@` 后面……
 * 这些错误如果被宽容掉，最终表现是「补丁看起来成功了但文件不对」，
 * 比直接报错难排查得多。所以宁可在这里判错并给出精确到行的文案。
 */

import { MAX_HUNK_LINES } from "./limits.js";
import { MAX_PATH_CHARS } from "./paths.js";
import type { FileOp, Hunk, ParseResult, PatchError, PatchLine, UpdateOp } from "./types.js";

/**
 * 协议标记行（`*** ` 开头）。
 *
 * 名字只认 ASCII 单词（`Add File` / `Move to` / `End of File` …）：
 * 这样「新增内容里恰好有一行以 `*** 加粗 ***` 开头」不会被误判成指令——
 * 中文标记名不在白名单里，会落回内容行。代价是内容里以 `*** ` 开头的
 * 英文 Markdown 行仍会被当成标记（协议本身没有转义机制，属已知边界）。
 */
const MARKER = /^\*\*\* ([A-Za-z]+(?: [A-Za-z]+)*)(?:\s*:\s*|\s+)?(.*)$/;

interface MarkerHit {
  /** 标记名（`Begin Patch` / `Add File` / `Move to` …）。 */
  name: string;
  /** 标记后的内容（路径或说明文字）。 */
  rest: string;
}

function parseMarker(line: string): MarkerHit | null {
  if (!line.startsWith("*** ")) return null;
  const m = MARKER.exec(line);
  if (!m) return null;
  return { name: m[1].trim(), rest: m[2].trim() };
}

function fail(code: PatchError["code"], message: string, extra?: Partial<PatchError>): ParseResult {
  return { ok: false, error: { code, message, ...extra } };
}

/** 路径的基本合法性（NUL / 空 / 超长）；是否在根内不在这里判。 */
function cleanPath(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.includes("\u0000")) return null;
  if (value.length > MAX_PATH_CHARS) return null;
  return value;
}

/** 空白行（协议里的空行只能当分隔符，不能当内容）。 */
function isBlank(line: string): boolean {
  return line.trim() === "";
}

/**
 * 解析一段补丁文本。
 *
 * 永不抛异常：模型写错格式是常态，调用方按 `ok:false` 走失败文案。
 */
export function parsePatch(text: string): ParseResult {
  const source = typeof text === "string" ? text : "";
  if (!source.trim()) {
    return fail("invalid-patch", "补丁为空。请以 `*** Begin Patch` 开始、`*** End Patch` 结束。");
  }
  // 统一行尾再切行：模型可能给 CRLF，协议解析不该被行尾影响。
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  // 去掉首尾空行：粘贴时常带前后空行，这不影响语义。
  while (lines.length && isBlank(lines[0])) lines.shift();
  while (lines.length && isBlank(lines[lines.length - 1])) lines.pop();
  if (lines.length === 0) {
    return fail("invalid-patch", "补丁为空。请以 `*** Begin Patch` 开始、`*** End Patch` 结束。");
  }
  if (parseMarker(lines[0])?.name !== "Begin Patch") {
    return fail("invalid-patch", "补丁首行必须是 `*** Begin Patch`。");
  }
  if (parseMarker(lines[lines.length - 1])?.name !== "End Patch") {
    return fail("invalid-patch", "补丁末行必须是 `*** End Patch`。");
  }

  const note = parseMarker(lines[0])?.rest ?? "";
  const ops: FileOp[] = [];
  /** 已出现的目标路径（含 `Move to`）：同一份补丁里重复出现必然是模型写错了。 */
  const seenPaths = new Set<string>();

  const pushPath = (path: string): boolean => {
    const key = path.replace(/\\/g, "/").toLowerCase();
    if (seenPaths.has(key)) return false;
    seenPaths.add(key);
    return true;
  };

  let i = 1;
  const last = lines.length - 1;
  while (i < last) {
    // 块之间的空行是分隔符（上面已说明内容行的空行判错），这里统一跳过。
    if (isBlank(lines[i])) {
      i += 1;
      continue;
    }
    const marker = parseMarker(lines[i]);
    if (!marker) {
      return fail(
        "invalid-patch",
        `第 ${i + 1} 行不属于任何指令：补丁内容必须写在 \`*** Add File\` / \`*** Update File\` / \`*** Delete File\` 之下。`,
      );
    }

    if (marker.name === "End Patch" || marker.name === "Begin Patch") {
      return fail("invalid-patch", `第 ${i + 1} 行出现了只允许出现在首尾的标记 \`*** ${marker.name}\`。`);
    }
    if (marker.name === "Move to" || marker.name === "End of File") {
      return fail(
        "invalid-patch",
        `第 ${i + 1} 行：\`*** ${marker.name}\` 只能出现在 \`*** Update File\` 之下。`,
      );
    }

    if (marker.name === "Add File") {
      const path = cleanPath(marker.rest);
      if (!path) return fail("path-invalid", `第 ${i + 1} 行的 Add File 路径不合法（空、含 NUL 或过长）。`);
      if (!pushPath(path)) return fail("invalid-patch", `同一份补丁里重复操作了 ${path}，请合并成一次。`, { path });
      i += 1;
      const body: string[] = [];
      while (i < last && !parseMarker(lines[i])) {
        const line = lines[i];
        if (line.startsWith("+")) {
          body.push(line.slice(1));
        } else if (isBlank(line)) {
          // 空行只允许作为块之间的分隔符：下一条必须是标记，否则就是漏了 `+` 的内容行。
          if (!parseMarker(lines[i + 1] ?? "")) {
            return fail("invalid-patch", `Add File: ${path} 的第 ${body.length + 1} 行缺少 \`+\` 前缀。`, { path });
          }
          break;
        } else {          return fail(
            "invalid-patch",
            `Add File: ${path} 的第 ${body.length + 1} 行必须以 \`+\` 开头（新增文件的每一行都要 \`+\`）。`,
            { path },
          );
        }
        i += 1;
      }
      ops.push({ kind: "add", path, lines: body });
      continue;
    }

    if (marker.name === "Delete File") {
      const path = cleanPath(marker.rest);
      if (!path) return fail("path-invalid", `第 ${i + 1} 行的 Delete File 路径不合法（空、含 NUL 或过长）。`);
      if (!pushPath(path)) return fail("invalid-patch", `同一份补丁里重复操作了 ${path}，请合并成一次。`, { path });
      ops.push({ kind: "delete", path });
      i += 1;
      // Delete 后面直到下一个标记之前不允许有任何内容行（空行是分隔符，跳过）。
      while (i < last && isBlank(lines[i])) i += 1;
      if (i < last && !parseMarker(lines[i])) {
        return fail("invalid-patch", `Delete File: ${path} 之后不该再有内容行。`, { path });
      }
      continue;
    }

    if (marker.name === "Update File") {
      const path = cleanPath(marker.rest);
      if (!path) return fail("path-invalid", `第 ${i + 1} 行的 Update File 路径不合法（空、含 NUL 或过长）。`);
      if (!pushPath(path)) return fail("invalid-patch", `同一份补丁里重复操作了 ${path}，请合并成一次。`, { path });
      i += 1;

      let moveTo: string | undefined;
      const moveHint = i < last ? parseMarker(lines[i]) : null;
      if (moveHint?.name === "Move to") {
        const target = cleanPath(moveHint.rest);
        if (!target) return fail("path-invalid", `Update File: ${path} 的 Move to 目标路径不合法。`, { path });
        if (!pushPath(target)) {
          return fail("invalid-patch", `同一份补丁里重复操作了 ${target}，请合并成一次。`, { path: target });
        }
        moveTo = target;
        i += 1;
      }

      const hunks: Hunk[] = [];
      let current: Hunk | null = null;
      while (i < last) {
        const line = lines[i];
        const inner = parseMarker(line);
        if (inner) {
          // 文件级标记（下一个 Add/Update/Delete 或 End Patch）结束当前 Update
          if (inner.name === "End of File") {
            if (!current) {
              return fail("invalid-patch", `Update File: ${path} 的 \`*** End of File\` 出现在任何 \`@@\` 块之前。`, { path });
            }
            current.atEof = true;
            i += 1;
            continue;
          }
          if (inner.name === "Move to") {
            return fail(
              "invalid-patch",
              `Update File: ${path} 的 \`*** Move to\` 必须紧跟在 Update File 之后、第一个 \`@@\` 之前。`,
              { path },
            );
          }
          break;
        }
        if (line.startsWith("@@")) {
          const header = line.slice(2).trim();
          current = { header, lines: [], atEof: false };
          hunks.push(current);
          i += 1;
          continue;
        }
        if (isBlank(line)) {
          // 空行只允许作为块间分隔：下一条必须是标记或新的 @@，否则就是漏了前缀的内容行。
          const next = lines[i + 1] ?? "";
          if (parseMarker(next) || next.startsWith("@@")) {
            i += 1;
            continue;
          }
          return fail(
            "invalid-patch",
            `Update File: ${path} 中存在缺少前缀的空行（上下文行要写一个空格前缀）。`,
            { path },
          );
        }
        if (!current) {
          return fail(
            "invalid-patch",
            `Update File: ${path} 的内容行必须放在 \`@@\` 块里（先写一个 \`@@ <上下文>\`）。`,
            { path },
          );
        }
        const head = line[0];
        if (head !== " " && head !== "+" && head !== "-") {
          return fail(
            "invalid-patch",
            `Update File: ${path} 的第 ${current.lines.length + 1} 行必须以上下文（空格）、\`+\` 或 \`-\` 开头。`,
            { path },
          );
        }
        const kind = head === " " ? "context" : head === "+" ? "add" : "del";
        current.lines.push({ kind, text: line.slice(1) });
        if (current.lines.length > MAX_HUNK_LINES) {
          return fail(
            "hunk-too-large",
            `Update File: ${path} 的第 ${hunks.length} 个 \`@@\` 块超过 ${MAX_HUNK_LINES} 行。请拆成多个 \`@@\` 块或多次调用。`,
            { path, hunkIndex: hunks.length },
          );
        }
        i += 1;
      }

      if (hunks.length === 0) {
        return fail(
          "invalid-patch",
          `Update File: ${path} 没有任何 \`@@\` 变更块，不会做任何修改。`,
          { path },
        );
      }
      const update: UpdateOp = { kind: "update", path, hunks, ...(moveTo ? { moveTo } : {}) };
      ops.push(update);
      continue;
    }

    return fail("invalid-patch", `第 ${i + 1} 行：不认识的指令 \`*** ${marker.name}\`。`);
  }

  if (ops.length === 0) {
    return { ok: false, error: { code: "empty-patch", message: "No files were modified" } };
  }
  return { ok: true, plan: { ops, note } };
}

/** 统计一份计划里被操作的文件数（含改名目标）。 */
export function countTargets(ops: FileOp[]): number {
  let n = 0;
  for (const op of ops) {
    n += 1;
    if (op.kind === "update" && op.moveTo) n += 1;
  }
  return n;
}

/** 计划里所有「原始路径」（不含改名目标）。 */
export function sourcePaths(ops: FileOp[]): string[] {
  return ops.map((op) => op.path);
}

/** 计划里所有「目标路径」（含改名目标）。 */
export function allPaths(ops: FileOp[]): string[] {
  const out: string[] = [];
  for (const op of ops) {
    out.push(op.path);
    if (op.kind === "update" && op.moveTo) out.push(op.moveTo);
  }
  return out;
}

/** 计划里是否有删除语义（Delete 文件，或改名 = 删旧 + 增新）。 */
export function hasDeleteIntent(ops: FileOp[]): boolean {
  return ops.some((op) => op.kind === "delete" || (op.kind === "update" && Boolean(op.moveTo)));
}

/** 一个 hunk 的「原文行」（上下文 + 删除），用于匹配与报错时的锚点展示。 */
export function hunkOldLines(hunk: Hunk): string[] {
  return hunk.lines.filter((l: PatchLine) => l.kind !== "add").map((l) => l.text);
}

/** 一个 hunk 的「新文行」（上下文 + 新增）。 */
export function hunkNewLines(hunk: Hunk): string[] {
  return hunk.lines.filter((l: PatchLine) => l.kind !== "del").map((l) => l.text);
}
