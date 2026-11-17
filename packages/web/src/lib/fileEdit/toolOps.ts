/**
 * 文件工具的「新四件」执行体：`file_write` / `file_edit` / `file_glob` / `file_grep`。
 *
 * 为什么单独一个模块（而不是继续堆在 `tools.ts`）：
 * - `tools.ts` 已经有「补丁 + 读」两套流程与 600 行，再塞四个流程会变成不可读的巨函数；
 * - 这四个只依赖 `{ bridge, roots, outOfRoot }`，可以脱离工具桥单测（失败文案、截断、
 *   越界早拒都要能一条条断言）。
 *
 * 与 `tools.ts` 共用的口径（**不要**在这里另写一套）：
 * - 路径：`pickRoot` / `resolvePatchPath`（绝对路径拒绝、`..` 拒绝、只读根拒绝）；
 * - 安全：`assessPatchSafety`（只读根/越界/硬排除），真正的写盘闸仍在桌面端 `file-fs.js`；
 * - 失败文案：`failureResult` 的 `error_code` + `retry_with`/`hint` 契约。
 */

import type { FileFsBridge } from "./bridge.js";
import { adaptNewlines, detectNewlineStyle } from "./eol.js";
import {
  EDIT_MAX_NEW_CHARS,
  EDIT_MAX_OLD_CHARS,
  MAX_FILE_BYTES,
  READ_MAX_CHARS,
} from "./limits.js";
import { relFromRoot, resolveInsideRoot, utf8Bytes, type FileRoot } from "./paths.js";
import { isPatchError, pickRoot, resolvePatchPath, writeRootNames } from "./resolve.js";
import { OUT_OF_ROOT_HINT, assessPatchSafety } from "./safety.js";
import { appendFailure, failureResult } from "../toolError.js";

/** 四个执行体需要的依赖（与 `FileToolDeps` 的子集一致，便于测试直接构造）。 */
export interface FileOpsDeps {
  bridge: FileFsBridge;
  /** 当前根清单（每次调用现读，设置区改动即时生效）。 */
  roots: FileRoot[];
  /** 越界策略（缺省 ask；`reject` 只是文案更硬，不是安全边界）。 */
  outOfRoot?: () => "ask" | "reject";
}

type ToolResult = {
  text: string;
  ok: boolean;
  sources?: { id: string; title: string; detail?: string }[];
  /**
   * 工具带回的图片（只有 `file_image` 用）：`agentStream` 会把它们另起一条视觉消息
   * 交给支持读图的模型；不支持读图时写成「已省略」的说明文案。
   */
  images?: { mimeType: string; data: string }[];
  error?: { error_code: string; retry_with?: string; hint?: string };
  /** 真正落盘的文件（绝对路径），供界面做「撤回本轮改动」。 */
  writes?: string[];
};

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** 行数（末尾换行不额外算一行，与 `file_read` 的口径一致）。 */
function lineCount(content: string): number {
  if (content === "") return 0;
  const lines = content.split(/\r\n|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** 字面量出现次数（`split` 而不是正则：old_string 里可能是正则元字符）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** 读类工具的选根：显式根名（大小写不敏感）> 第一条根，读不要求 write。 */
function pickReadRoot(roots: FileRoot[], rootName?: string): FileRoot | ToolResult {
  if (roots.length === 0) {
    return failureResult("尚未配置根目录", "当前没有任何可读根；请让用户在设置区「文件编辑」添加目录，或先给会话选一个工作区。", {
      error_code: "no-roots",
      hint: "没有根目录时读类工具无法使用；不要重试",
    });
  }
  if (rootName && rootName.trim()) {
    const wanted = rootName.trim().toLowerCase();
    const hit = roots.find((root) => root.name.trim().toLowerCase() === wanted);
    if (!hit) {
      return failureResult(
        "未找到根",
        `没有名为「${rootName}」的根。可用根：${roots.map((root) => `${root.name}（${root.path}）`).join("、")}。`,
        {
          error_code: "root-unknown",
          retry_with: `用可用根名之一重试：${roots.map((root) => root.name).join("、")}`,
        },
      );
    }
    return hit;
  }
  return roots[0];
}

/** 写盘失败 → 可执行文案（保留主进程给的具体原因，别自己编）。 */
function writeFailure(error: string | undefined, rel: string): ToolResult {
  const detail = error || "未知原因";
  // d.229：目标不是 UTF-8（GBK 等）时桌面端会拒绝，这不是「写不进去」，是「不该悄悄改编码」
  if (/不是 UTF-8 编码/.test(detail)) {
    return appendFailure(`写入磁盘失败：${detail}（目标：${rel}）`, {
      error_code: "encoding-mismatch",
      retry_with: "把内容写到新文件（例如加 .utf8 后缀或换个名字），或先由用户把原文件转成 UTF-8 再改",
      hint: "桌面端拒绝覆盖非 UTF-8 文件：覆盖会把编码改成 UTF-8，按原编码读它的程序会乱码",
    });
  }
  const parent = /目录|parent|ENOENT/i.test(detail);
  return appendFailure(`写入磁盘失败：${detail}（目标：${rel}）`, {
    error_code: "write-failed",
    ...(parent
      ? { hint: "父目录不存在或不可写；file_write 会自动建目录，file_edit 要求文件已存在" }
      : { retry_with: "确认根仍可写、目标不是符号链接后重试一次；再失败就告诉用户写不进去" }),
  });
}

function searchFailure(code: string | undefined, error: string): ToolResult {
  const known = code ?? "io";
  const hint =
    known === "invalid-pattern"
      ? "通配符/正则写法不合法（括号不配对或不支持的结构）；换一个更简单的 pattern"
      : known === "outside-roots"
        ? OUT_OF_ROOT_HINT
        : known === "no-roots"
          ? "没有可读根，搜索类工具无法使用；不要重试"
          : "";
  return appendFailure(error || "搜索失败", {
    error_code: known,
    ...(known === "invalid-pattern" ? { retry_with: "把 pattern 简化成 *、**、*.ts 这类基本形式后重试" } : {}),
    ...(known === "io" ? { retry_with: "同一个调用重试一次；再失败就告诉用户搜索不了" } : {}),
    ...(hint ? { hint } : {}),
  });
}

/**
 * `file_write`：整份写入（新建 / 覆盖）。
 *
 * 与 `file_patch` 的分工（写进工具描述，但这里也要守住）：
 * - 新建文件：补丁要先有锚点上下文，`file_write` 一条就够；
 * - 整份覆盖：补丁要求逐块匹配，整份重写反而更省 token；
 * - 父目录：本工具**自动建**（`createParents: true`），补丁不建（避免手滑造出深目录）。
 */
export async function runWrite(deps: FileOpsDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const rawPath = str(args.path).trim();
  if (!rawPath) {
    return failureResult("path 为空", "path 不能为空（例如 notes/a.md）。", {
      error_code: "invalid-path",
      retry_with: "传根内相对路径，例如 notes/a.md",
    });
  }
  if (typeof args.content !== "string") {
    return failureResult("缺少 content", "file_write 需要 content 字段（字符串）；要建空文件就传空串。", {
      error_code: "invalid-args",
      retry_with: "补上 content：要写入的文件全文（UTF-8）",
    });
  }
  const content = args.content;
  if (content.includes("\u0000")) {
    return failureResult("内容含 NUL", "文本文件不能包含 NUL 字节。", {
      error_code: "invalid-args",
      hint: "检查是不是读到了二进制内容；本工具只写 UTF-8 文本",
    });
  }
  const bytes = utf8Bytes(content);
  if (bytes > MAX_FILE_BYTES) {
    return failureResult(
      "内容过大",
      `单文件上限 ${Math.floor(MAX_FILE_BYTES / 1024)}KB，本次 ${Math.ceil(bytes / 1024)}KB。`,
      {
        error_code: "file-too-large",
        hint: "拆成多个文件，或先用 file_patch 只改需要的部分",
      },
    );
  }

  const rootName = str(args.root).trim() || undefined;
  const root = pickRoot(deps.roots, rootName);
  if (isPatchError(root)) return failureResult("写入目标不可用", root.message, { error_code: root.code });
  const target = resolvePatchPath(deps.roots, root, rawPath);
  if (isPatchError(target)) return failureResult("路径不可用", target.message, { error_code: target.code });

  // 只读根 / 越界 / 硬排除（可执行文件等）——判据与补丁完全同源。
  const safety = assessPatchSafety({
    targets: [target.abs],
    deletions: 0,
    roots: deps.roots,
    ...(deps.outOfRoot ? { outOfRoot: deps.outOfRoot() } : {}),
  });
  if (safety.verdict === "reject") {
    return failureResult("写入被拒绝", safety.reason, {
      error_code: "safety-reject",
      hint: `目标不在可写根内或落在只读根。可写根：${writeRootNames(deps.roots)}`,
    });
  }

  // 先读一眼只为区分「新建」还是「覆盖」（不存在会立刻 not-found，不是额外成本）。
  const before = await deps.bridge.read({ roots: deps.roots, path: target.abs });
  // d.233：覆盖已有文件时跟随它原有的换行风格——否则改了 3 行，diff 却是整篇重写
  const fileStyle = before.ok ? detectNewlineStyle(before.content) : null;
  const adapted = adaptNewlines(content, fileStyle);
  const finalContent = adapted.text;
  const finalBytes = utf8Bytes(finalContent);
  if (finalBytes > MAX_FILE_BYTES) {
    return failureResult(
      "内容过大",
      `单文件上限 ${Math.floor(MAX_FILE_BYTES / 1024)}KB，本次 ${Math.ceil(finalBytes / 1024)}KB（按原文件换行风格对齐后）。`,
      {
        error_code: "file-too-large",
        hint: "拆成多个文件，或先用 file_patch 只改需要的部分",
      },
    );
  }
  const response = await deps.bridge.write({
    roots: deps.roots,
    ops: [{ kind: "write", path: target.abs, content: finalContent }],
    createParents: true,
  });
  if (!response.ok) return writeFailure(response.error, target.rel);

  const created = !before.ok;
  const lines = lineCount(finalContent);
  return {
    text:
      `${created ? "已创建" : "已覆盖"} ${target.rel}（根：${root.name}）：${lines} 行 / ${finalBytes} 字节。` +
      (created ? "" : "\n原内容已被整份替换（如有未读部分请重新 file_read 确认）。") +
      (adapted.converted
        ? `\n（原文件用的是 ${fileStyle === "\r\n" ? "CRLF" : "LF"} 换行，已按它写入：否则这次改动会把整份文件的行尾都改掉，diff 看不出真正改了什么。）`
        : ""),
    ok: true,
    writes: [target.abs],
    sources: [{ id: target.rel, title: target.rel, detail: root.name }],
  };
}

/**
 * `file_edit`：精确串替换（DSH `edit` 的语义）。
 *
 * 三个容易踩的坑，都在这里收口：
 * 1. **换行符**：模型抄来的 old_string 多半是 `\n`，而 Windows 文件是 `\r\n`——
 *    先按原样匹配，失败再试一次 CRLF 变体（不静默改全文的换行风格）；
 * 2. **唯一性**：默认要求只出现一次，否则拒绝并给出「加长上下文 / replace_all」两条出路；
 * 3. **不能新建**：文件不存在时明确让它换 `file_write`，别让它反复重试。
 */
export async function runEdit(deps: FileOpsDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const rawPath = str(args.path).trim();
  if (!rawPath) {
    return failureResult("path 为空", "path 不能为空（例如 notes/a.md）。", {
      error_code: "invalid-path",
      retry_with: "传根内相对路径，例如 notes/a.md",
    });
  }
  if (typeof args.old_string !== "string" || args.old_string === "") {
    return failureResult("old_string 为空", "old_string 必须是要被替换的原文（不能是空串）。", {
      error_code: "invalid-args",
      retry_with: "先 file_read 拿到原文，把要替换的那段逐字复制到 old_string",
    });
  }
  if (typeof args.new_string !== "string") {
    return failureResult("缺少 new_string", "new_string 是替换后的文本；要删除这段就传空串。", {
      error_code: "invalid-args",
      retry_with: "补上 new_string（可为空串）",
    });
  }
  const oldRaw = args.old_string;
  const newText = args.new_string;
  const replaceAll = args.replace_all === true;
  if (oldRaw.length > EDIT_MAX_OLD_CHARS) {
    return failureResult("old_string 过长", `old_string 上限 ${EDIT_MAX_OLD_CHARS} 字符。`, {
      error_code: "invalid-args",
      hint: "只圈住要改的最小片段；大改动用 file_write 整份覆盖",
    });
  }
  if (newText.length > EDIT_MAX_NEW_CHARS) {
    return failureResult("new_string 过长", `new_string 上限 ${EDIT_MAX_NEW_CHARS} 字符。`, {
      error_code: "file-too-large",
      hint: "改成分多次替换，或用 file_write 整份写入",
    });
  }

  const rootName = str(args.root).trim() || undefined;
  const root = pickRoot(deps.roots, rootName);
  if (isPatchError(root)) return failureResult("写入目标不可用", root.message, { error_code: root.code });
  const target = resolvePatchPath(deps.roots, root, rawPath);
  if (isPatchError(target)) return failureResult("路径不可用", target.message, { error_code: target.code });

  const safety = assessPatchSafety({
    targets: [target.abs],
    deletions: 0,
    roots: deps.roots,
    ...(deps.outOfRoot ? { outOfRoot: deps.outOfRoot() } : {}),
  });
  if (safety.verdict === "reject") {
    return failureResult("写入被拒绝", safety.reason, {
      error_code: "safety-reject",
      hint: `目标不在可写根内或落在只读根。可写根：${writeRootNames(deps.roots)}`,
    });
  }

  const current = await deps.bridge.read({ roots: deps.roots, path: target.abs });
  if (!current.ok) {
    const code = current.code ?? "io";
    return appendFailure(`${current.error || "读取失败"}（${target.rel}）`, {
      error_code: code,
      ...(code === "not-found"
        ? { hint: "文件不存在；新建文件请用 file_write，本工具只改已有文件" }
        : code === "binary"
          ? { hint: "这是二进制文件，不能按文本编辑" }
          : code === "too-large"
            ? { hint: "文件超过单文件上限，改用 file_patch 只改局部" }
            : { retry_with: "同一个 file_edit 重试一次；再失败就告诉用户改不了" }),
    });
  }

  let oldText = oldRaw;
  let count = countOccurrences(current.content, oldText);
  if (count === 0 && current.content.includes("\r\n")) {
    const crlf = oldRaw.replace(/\r?\n/g, "\r\n");
    if (crlf !== oldRaw) {
      const crlfCount = countOccurrences(current.content, crlf);
      if (crlfCount > 0) {
        oldText = crlf;
        count = crlfCount;
      }
    }
  }
  if (count === 0) {
    return failureResult("没有找到原文", `old_string 在 ${target.rel} 里不存在（逐字匹配失败）。`, {
      error_code: "match-failed",
      retry_with: "先 file_read 读到原文，含缩进与空行逐字复制 old_string 再试；或用 file_write 整份覆盖",
    });
  }
  if (count > 1 && !replaceAll) {
    return failureResult(
      "原文出现多次",
      `old_string 在 ${target.rel} 里出现 ${count} 次，默认必须唯一。`,
      {
        error_code: "match-failed",
        retry_with: "把 old_string 扩大上下文使其唯一；确实要全改就传 replace_all=true",
      },
    );
  }

  // d.233：插入的多行文本要跟随原文件的换行风格，否则会写出「半份 CRLF、半份 LF」的混合行尾
  const fileStyle = detectNewlineStyle(current.content);
  const adapted = adaptNewlines(newText, fileStyle);
  const insert = adapted.text;
  const next = replaceAll
    ? current.content.split(oldText).join(insert)
    : current.content.replace(oldText, () => insert);
  const nextBytes = utf8Bytes(next);
  if (nextBytes > MAX_FILE_BYTES) {
    return failureResult("改后文件过大", `结果 ${Math.ceil(nextBytes / 1024)}KB，超过 ${Math.floor(MAX_FILE_BYTES / 1024)}KB 上限。`, {
      error_code: "file-too-large",
      hint: "把改动拆小，或改用 file_patch 只改局部",
    });
  }

  const response = await deps.bridge.write({
    roots: deps.roots,
    ops: [{ kind: "write", path: target.abs, content: next }],
  });
  if (!response.ok) return writeFailure(response.error, target.rel);

  return {
    text:
      `已在 ${target.rel}（根：${root.name}）替换 ${count} 处` +
      `${replaceAll ? "（replace_all）" : ""}；文件现为 ${lineCount(next)} 行 / ${nextBytes} 字节。` +
      (adapted.converted
        ? `\n（原文件用的是 ${fileStyle === "\r\n" ? "CRLF" : "LF"} 换行，新写入的行已按它对齐，避免出现混合行尾。）`
        : ""),
    ok: true,
    writes: [target.abs],
    sources: [{ id: target.rel, title: target.rel, detail: root.name }],
  };
}

/** 搜索结果正文的字符预算（与 `file_read` 同一上限，避免一次吐回一座山）。 */
function clipBody(parts: string[]): { body: string; clipped: boolean } {
  const joined = parts.join("\n");
  if (joined.length <= READ_MAX_CHARS) return { body: joined, clipped: false };
  return { body: joined.slice(0, READ_MAX_CHARS), clipped: true };
}

/** `file_glob`：按通配符找文件（只列文件、不列目录）。 */
export async function runGlob(deps: FileOpsDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = str(args.pattern).trim();
  if (!pattern) {
    return failureResult("pattern 为空", "请给通配符，例如 **/*.ts 或 src/**。", {
      error_code: "invalid-pattern",
      retry_with: "传一个通配符 pattern，例如 **/*.md",
    });
  }
  if (typeof deps.bridge.glob !== "function") {
    return failureResult("搜索不可用", "当前桌面端版本不支持 file_glob。", {
      error_code: "bridge-missing",
      hint: "让用户升级和鸣桌面端；或改用 file_read 直接读已知路径",
    });
  }
  const rootName = str(args.root).trim() || undefined;
  const root = pickReadRoot(deps.roots, rootName);
  if ("ok" in root) return root;

  const rawDir = str(args.path).trim();
  const dir = rawDir ? resolveInsideRoot(root.path, rawDir) : root.path;
  if (!dir) {
    return failureResult("目录不可用", `path 必须是根「${root.name}」（${root.path}）内的相对目录：${rawDir}`, {
      error_code: "path-escape",
      retry_with: "把 path 改成根内相对目录（如 src/components），或省略它表示整根",
    });
  }

  const response = await deps.bridge.glob({ roots: deps.roots, pattern, dir });
  if (!response.ok) return searchFailure(response.code, response.error);

  const rels = response.paths
    .map((abs) => relFromRoot(root.path, abs))
    .filter((rel): rel is string => !!rel);
  const header = [
    `根：${root.name}`,
    `模式：${pattern}${rawDir ? `（目录：${rawDir}）` : ""}`,
    `命中 ${rels.length} 个文件${response.truncated ? "（已达上限，结果不完整，请缩小范围或换更精确的 pattern）" : ""}`,
    // d.231：默认不进依赖/版本库/构建产物目录，但「被跳过」不等于「不存在」，要说明白
    ...(response.skipped && response.skipped.length > 0
      ? [`（已跳过这些目录：${response.skipped.join("、")}——依赖、版本库与构建产物通常不是答案；要搜里面就把 path 指到那个目录）`]
      : []),
  ];
  if (rels.length === 0) {
    return {
      text: [...header, "", "没有匹配的文件：检查 pattern 写法（`**/*.ts` 与 `*.ts` 含义不同），或换 file_read 直接读已知路径。"].join("\n"),
      ok: true,
    };
  }
  const clipped = clipBody(rels);
  return {
    text: [
      ...header,
      clipped.clipped ? `（清单过长，已截断到 ${READ_MAX_CHARS} 字符；请缩小 path/pattern）` : "",
      "",
      clipped.body,
    ]
      .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
      .join("\n"),
    ok: true,
    sources: rels.slice(0, 8).map((rel) => ({ id: rel, title: rel, detail: root.name })),
  };
}

/** `file_grep`：按正则搜文件内容，返回「相对路径:行号: 内容」。 */
export async function runGrep(deps: FileOpsDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = str(args.pattern).trim();
  if (!pattern) {
    return failureResult("pattern 为空", "请给要搜的正则，例如 TODO|FIXME。", {
      error_code: "invalid-pattern",
      retry_with: "传一个正则 pattern，例如 /TODO|FIXME/ 的内容部分",
    });
  }
  if (typeof deps.bridge.grep !== "function") {
    return failureResult("搜索不可用", "当前桌面端版本不支持 file_grep。", {
      error_code: "bridge-missing",
      hint: "让用户升级和鸣桌面端；或改用 file_read 直接读已知路径",
    });
  }
  const rootName = str(args.root).trim() || undefined;
  const root = pickReadRoot(deps.roots, rootName);
  if ("ok" in root) return root;

  const rawDir = str(args.path).trim();
  const dir = rawDir ? resolveInsideRoot(root.path, rawDir) : root.path;
  if (!dir) {
    return failureResult("目录不可用", `path 必须是根「${root.name}」（${root.path}）内的相对目录：${rawDir}`, {
      error_code: "path-escape",
      retry_with: "把 path 改成根内相对目录（如 src/components），或省略它表示整根",
    });
  }
  const include = str(args.include).trim() || undefined;

  const response = await deps.bridge.grep({
    roots: deps.roots,
    pattern,
    dir,
    ...(include ? { include } : {}),
  });
  if (!response.ok) return searchFailure(response.code, response.error);

  const hits = response.matches
    .map((match) => ({ rel: relFromRoot(root.path, match.path), line: match.line, text: match.text }))
    .filter((hit): hit is { rel: string; line: number; text: string } => !!hit.rel)
    .sort((a, b) => (a.rel === b.rel ? a.line - b.line : a.rel.localeCompare(b.rel)));
  const files = new Set(hits.map((hit) => hit.rel)).size;
  const header = [
    `根：${root.name}`,
    `正则：${pattern}${include ? `（include：${include}）` : ""}${rawDir ? `（目录：${rawDir}）` : ""}`,
    `命中 ${hits.length} 处，涉及 ${files} 个文件${response.truncated ? "（已达上限，结果不完整，请缩小范围）" : ""}`,
    // d.231：同 glob
    ...(response.skipped && response.skipped.length > 0
      ? [`（已跳过这些目录：${response.skipped.join("、")}——依赖、版本库与构建产物通常不是答案；要搜里面就把 path 指到那个目录）`]
      : []),
    // d.232：还有多少文件根本没被打开（太大/像二进制/编码认不出/读不了）
    ...(response.skippedFiles && response.skippedFiles.total > 0
      ? [
          (() => {
            const s = response.skippedFiles!;
            const parts: string[] = [];
            if (s.tooLarge > 0) parts.push(`${s.tooLarge} 个超过 2MB`);
            if (s.binary > 0) parts.push(`${s.binary} 个像二进制`);
            if (s.undecodable > 0) parts.push(`${s.undecodable} 个编码认不出`);
            if (s.other > 0) parts.push(`${s.other} 个读不了`);
            const where = s.sample.length > 0 ? `——例如 ${s.sample.join("、")}；` : "；";
            return `（另有 ${s.total} 个文件没能搜：${parts.join("、")}${where}要搜它们就把 path/include 缩到那个目录，或直接 file_read）`;
          })(),
        ]
      : []),
  ];
  if (hits.length === 0) {
    return {
      text: [...header, "", "没有匹配内容：换更短的关键词或去掉 include 再试。"].join("\n"),
      ok: true,
    };
  }
  const clipped = clipBody(hits.map((hit) => `${hit.rel}:${hit.line}: ${hit.text}`));
  return {
    text: [...header, clipped.clipped ? `（结果过长，已截断到 ${READ_MAX_CHARS} 字符；请缩小 path/include）` : "", "", clipped.body]
      .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
      .join("\n"),
    ok: true,
    sources: [...new Set(hits.map((hit) => hit.rel))].slice(0, 8).map((rel) => ({ id: rel, title: rel, detail: root.name })),
  };
}

/**
 * `file_image`：读一张根内图片，交回 base64 与真实 mime（由视觉消息层塞进上下文）。
 *
 * 为什么值得单开一个工具：用户说「看这张截图哪里不对」「照这个设计稿改样式」时，
 * 智能体此前只能让用户自己描述——读文本会把图片判成二进制拒绝，视觉附件又只覆盖
 * 用户**自己上传**的图。有了它，工作区里的截图/设计稿/图表都能自己打开看。
 *
 * 三条边界：
 * - 只读、只认四种格式（PNG/JPEG/GIF/WebP，按主进程魔数判断），不做转码（不引依赖）；
 * - 路径与 `file_read` 用同一道闸（根内相对、拒绝绝对与 `..`、只读根可读）；
 * - 结果文本只给「文件、类型、体积」这些可核对的元信息，**不复述图里内容**——
 *   图会由视觉消息原样交给模型，文本再描述一遍只会诱导它凭空编造细节。
 */
export async function runImage(deps: FileOpsDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const rawPath = str(args.path).trim();
  if (!rawPath) {
    return failureResult("path 为空", "path 不能为空（例如 screenshots/home.png）。", {
      error_code: "invalid-path",
      retry_with: "传根内相对路径，例如 screenshots/home.png",
    });
  }
  if (typeof deps.bridge.image !== "function") {
    return failureResult("读图不可用", "当前桌面端版本不支持 file_image。", {
      error_code: "bridge-missing",
      hint: "让用户升级和鸣桌面端；或用 file_glob 找到文件路径后请用户自己看",
    });
  }
  const rootName = str(args.root).trim() || undefined;
  const root = pickReadRoot(deps.roots, rootName);
  if ("ok" in root) return root;

  const abs = resolveInsideRoot(root.path, rawPath);
  if (!abs) {
    return failureResult("路径不可用", `path 必须是根「${root.name}」（${root.path}）内的相对路径：${rawPath}`, {
      error_code: "path-escape",
      retry_with: "把 path 改成根内相对路径（如 screenshots/home.png），不要用绝对路径或 ..",
    });
  }

  const response = await deps.bridge.image({ roots: deps.roots, path: abs });
  if (!response.ok) {
    const code = response.code ?? "io";
    const hint =
      code === "unsupported-image"
        ? "这不是可读图片（只支持 PNG/JPEG/GIF/WebP）；看文字内容请用 file_read"
        : code === "too-large"
          ? "图片超过单张 5MB 上限；请用户压缩，或改看同目录里别的文件"
          : code === "not-found"
            ? "文件不存在：先用 file_glob 找准确路径（注意扩展名大小写）"
            : code === "outside-roots"
              ? OUT_OF_ROOT_HINT
              : code === "symlink"
                ? "目标或其父目录是符号链接，已拒绝；请换一个真实路径"
                : "";
    return appendFailure(response.error || "读取图片失败", {
      error_code: code,
      ...(code === "io" ? { retry_with: "同一个调用重试一次；再失败就告诉用户图片读不了" } : {}),
      ...(hint ? { hint } : {}),
    });
  }

  const rel = relFromRoot(root.path, abs) ?? rawPath;
  const kb = Math.max(1, Math.round(response.bytes / 1024));
  return {
    text: [
      `已读取图片 ${rel}（根：${root.name}）：${response.mime}，${kb} KB。`,
      "图片已附在下面的消息里，请直接看图回答，不要凭文件名猜测内容。",
    ].join("\n"),
    ok: true,
    images: [{ mimeType: response.mime, data: response.base64 }],
  };
}

/**
 * `file_undo`：把某个文件回滚到「上一次写之前」的内容（d.170）。
 *
 * 为什么需要它：d.153 给了智能体写文件的能力，但一旦改错（覆盖错文件、补丁贴到错误位置、
 * 删了不该删的文件），它和用户都只能靠记忆手工恢复。现代编码智能体（opencode / Claude Code）
 * 都把"能撤回"当作写能力的一部分——没有退回键的编辑器，没人敢在上面改重要文件。
 *
 * 主进程在**每次覆盖/删除之前**已经留了原始字节备份（`userData/backups`），这里只负责：
 * 解析路径 → 校验在可写根内 → 调 `bridge.undo` → 把"恢复到哪一刻"如实报给模型。
 *
 * 三条边界：
 * - 一份备份只能用一次：撤销成功后同一文件再撤销会回 `no-backup`（否则撤销/重做会来回横跳，
 *   用户看不出当前是哪个版本）；
 * - 撤销本身是一次写：必须落在**可写根**内，只读根一律拒绝；
 * - 不猜"该恢复到哪一版"：永远恢复最新一份，要更早就得连着撤销。
 */
export async function runUndo(deps: FileOpsDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const rawPath = str(args.path).trim();
  if (!rawPath) {
    return failureResult("path 为空", "path 不能为空（例如 src/config.md）。", {
      error_code: "invalid-path",
      retry_with: "传根内相对路径，例如 src/config.md",
    });
  }
  if (typeof deps.bridge.undo !== "function") {
    return failureResult("撤销不可用", "当前桌面端版本不支持 file_undo。", {
      error_code: "bridge-missing",
      hint: "让用户升级和鸣桌面端；或者用 file_write 直接覆盖成正确内容",
    });
  }
  const rootName = str(args.root).trim() || undefined;
  const root = pickRoot(deps.roots, rootName);
  if (isPatchError(root)) return failureResult("撤销目标不可用", root.message, { error_code: root.code });

  const target = resolvePatchPath(deps.roots, root, rawPath);
  if (isPatchError(target)) return failureResult("路径不可用", target.message, { error_code: target.code });
  const abs = target.abs;

  const response = await deps.bridge.undo({ roots: deps.roots, path: abs });
  if (!response.ok) {
    const code = response.code ?? "io";
    const hint =
      code === "no-backup"
        ? "这个文件没有可撤销的备份（新建的文件没有旧版本，或备份已被用掉）；不要重试，直接告诉用户当前状态"
        : code === "outside-roots" || code === "no-write-root"
          ? OUT_OF_ROOT_HINT
          : code === "symlink"
            ? "目标或其父目录是符号链接，已拒绝；请换一个真实路径"
            : code === "no-backup-dir"
              ? "桌面端没有启用写入备份，撤销能力不可用；请用户升级或手动恢复"
              : "";
    return appendFailure(response.error || "撤销失败", {
      error_code: code === "no-backup" ? "no-backup" : code,
      ...(code === "io" ? { retry_with: "同一个调用重试一次；再失败就停下来告诉用户" } : {}),
      ...(hint ? { hint } : {}),
    });
  }

  const rel = relFromRoot(root.path, abs) ?? rawPath;
  const restoredAt = new Date(response.restoredFrom);
  const when = Number.isNaN(restoredAt.getTime())
    ? response.restoredFrom
    : restoredAt.toLocaleString("zh-CN", { hour12: false });
  const bytes = response.bytes;
  return {
    text: [
      `已把 ${rel}（根：${root.name}）回滚到 ${when} 时的版本：${bytes} 字节。`,
      "这份备份已经用掉：同一文件再撤销会提示没有更早的备份。回滚后请用 file_read 复核内容。",
    ].join("\n"),
    ok: true,
    writes: [abs],
    sources: [{ id: rel, title: rel, detail: root.name }],
  };
}
