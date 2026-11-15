/**
 * 智能体侧的文件编辑工具：`file_patch`（写）与 `file_read`（读）。
 *
 * 为什么两个工具而不是 `read/write/delete` 三个（规格 §2）：
 * - 一次 `file_patch` 可以**原子地**改多个文件（改名 = 删除 + 新增，分两次调用会出现
 *   「删成功、增失败」的中间态）；
 * - 模型只需要学一种格式；
 * - 审批只需要一次（用户看到「这次会改这 3 个文件」，而不是三次弹窗）。
 *
 * `file_read` 是补丁链路的必要条件：补丁失败 → 读原文 → 重新生成补丁，
 * 是模型自我修正的唯一现实路径（规格 §9）。
 *
 * 可见性：**桌面桥存在 且 至少有一条可写根**时才注入（产品决策，与 MCP「装完默认全关」同口径）。
 * 浏览器端与未配置时不可见——不生成任何假的「本地文件」工具。
 */

import type { ToolBridge, ToolSource } from "../agentStream.js";
import type { RiskLevel } from "../hitl/types.js";
import { kindsSummary, planPatch, type PatchIo, type ReadResult } from "./apply.js";
import { getFileBridge, type FileFsBridge } from "./bridge.js";
import { READ_MAX_CHARS, READ_MAX_LINES } from "./limits.js";
import { parsePatch } from "./parse.js";
import { fileRootsStore } from "./roots.js";
import { OUT_OF_ROOT_HINT, assessPatchSafety } from "./safety.js";
import { relFromRoot, resolveInsideRoot, type FileRoot } from "./paths.js";
import { isPatchError, pickRoot } from "./resolve.js";
import { isFileEditTool, parseToolArgs } from "./ruleTargets.js";
import type { FileChange, PatchError } from "./types.js";
import {
  appendFailure,
  contractLines,
  failureResult,
  type ToolFailure,
  type ToolFailureResult,
} from "../toolError.js";

/** 工具声明（`parameters` 直接进 OpenAI/Anthropic 的 schema）。 */
export interface FileToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  riskHint: RiskLevel;
}

const prop = (description: string) => ({ type: "string" as const, description });

/**
 * 工具清单。`file_patch` 是写、`file_read` 是读，风险由 `meta` 声明给 HITL/编排层。
 *
 * ★ 说明文字按「schema 也是每轮输入」来写（P2-T14）：每请求都带工具清单，
 * 描述里的每个字都按 token 计费，也会占据前缀缓存的头部。所以只保留
 * **模型必须照做的格式约定**，把解释性长句砍掉（格式行一个都不能省）。
 * `tools.test.ts` 有体积上限，防止以后又悄悄写胖。
 */
export const FILE_TOOLS: FileToolSpec[] = [
  {
    name: "file_patch",
    riskHint: "write",
    description:
      "锚点补丁改本机文件（可一次多个）。格式：*** Begin Patch / *** Add File: 相对路径 / " +
      "*** Update File: 相对路径（可加 *** Move to: 新路径）/ *** Delete File: 相对路径 / @@ 上下文 / " +
      "行前缀：空格=上下文、-=删、+=增 / *** End Patch。路径须根内相对；锚点不匹配则整份不写盘。",
    parameters: {
      type: "object",
      properties: {
        patch: prop("*** Begin Patch … *** End Patch 全文。"),
        root: prop("可选：根名。"),
      },
      required: ["patch"],
    },
  },
  {
    name: "file_read",
    riskHint: "read",
    description: "读本机文本文件一段（带行号），用于改前确认原文或补丁失败后重读。路径须在根内。",
    parameters: {
      type: "object",
      properties: {
        path: prop("根内相对路径。"),
        root: prop("可选：根名。"),
        offset: { type: "number", description: "起始行。" },
        limit: { type: "number", description: `行数，≤${READ_MAX_LINES}。` },
      },
      required: ["path"],
    },
  },
];

/**
 * 工具桥依赖（测试可注入假桥与假根）。
 */
export interface FileToolDeps {
  bridge: FileFsBridge;
  /** 每次调用时读当前根配置（设置区改动即时生效，不缓存）。 */
  roots: () => FileRoot[];
  /** 越界策略（缺省 ask）。 */
  outOfRoot?: () => "ask" | "reject";
  /**
   * 本轮可见的工具名（缺省两个都可见）。
   *
   * 为什么要按工具分别判断（Lead 定稿）：
   * - `file_read` 只需要「桥存在 + 任意一条根」（read 或 write）——
   *   只读根本身就有意义：让智能体读用户圈定的资料；
   * - `file_patch` 必须「桥存在 + 至少一条 **write** 根」——没有写根就写不进去，
   *   注入了只会让模型反复失败。
   */
  visibleTools?: ReadonlySet<string>;
}

/** 工具可见性判据（唯一实现，provider 与测试共用）。 */
export function visibleFileTools(roots: FileRoot[]): Set<string> {
  const visible = new Set<string>();
  if (roots.length > 0) visible.add("file_read");
  if (roots.some((root) => root.mode === "write")) visible.add("file_patch");
  return visible;
}

/**
 * 构造工具桥（不判断可见性）。
 *
 * 可见性由 `buildFileToolBridgeIfAvailable` + `visibleFileTools` 决定。
 */
export function buildFileToolBridge(deps: FileToolDeps): ToolBridge {
  const visible = deps.visibleTools ?? new Set(FILE_TOOLS.map((spec) => spec.name));
  const specs = FILE_TOOLS.filter((spec) => visible.has(spec.name));
  /** 干跑用的读盘适配：把桌面桥的返回映射成本模块的 `ReadResult`。 */
  const ioFor = (roots: FileRoot[]): PatchIo => ({
    read: async (abs: string): Promise<ReadResult> => {
      const result = await deps.bridge.read({ roots, path: abs });
      if (result.ok) return { ok: true, content: result.content, bytes: result.bytes };
      const code =
        result.code === "not-found"
          ? "not-found"
          : result.code === "binary"
            ? "binary"
            : result.code === "too-large"
              ? "too-large"
              : "io";
      return { ok: false, code, error: result.error || "读取失败" };
    },
  });

  return {
    tools: specs.map((spec) => ({
      type: "function" as const,
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    })),
    meta: (name) => {
      const spec = specs.find((s) => s.name === name);
      return spec ? { risk: spec.riskHint } : undefined;
    },
    execute: async (call) => {
      const args = parseToolArgs(call.arguments);
      const roots = deps.roots();
      try {
        // 先认名字再看可见性：未知工具必须回 unknown-tool，不能误报成「没有根」。
        if (call.name !== "file_patch" && call.name !== "file_read") {
          return failureResult("未知工具", call.name, {
            error_code: "unknown-tool",
            hint: "只支持 file_read / file_patch；不要臆造工具名",
          });
        }
        if (!visible.has(call.name)) {
          return call.name === "file_patch"
            ? failureResult(
                "file_patch 当前不可用",
                "还没有可写根。目标不在可写根内；如需写入，请先在「设置 → 文件编辑」添加该目录为写根。",
                {
                  error_code: "no-write-root",
                  hint: "没有可写根时 file_patch 不会成功；读文件用 file_read，写盘要先让用户加根",
                },
              )
            : failureResult("工具当前不可用", `${call.name}：还没有配置任何根目录。`, {
                error_code: "no-roots",
                hint: "没有配置根目录，文件工具无法使用；不要重试",
              });
        }
        if (call.name === "file_patch") return await runPatch(args, roots);
        if (call.name === "file_read") return await runRead(args, roots);
        return failureResult("未知工具", call.name, {
          error_code: "unknown-tool",
          hint: "只支持 file_read / file_patch",
        });
      } catch (e) {
        // 永不抛：工具失败不该让整轮对话崩掉（与 wiki/chart 工具同口径）
        return appendFailure(`文件操作失败：${e instanceof Error ? e.message : String(e)}`, {
          error_code: "io",
          retry_with: "同一个调用重试一次；再失败就换做法或告诉用户",
        });
      }
    },
  };

  /** `file_patch` 的执行：解析 → 干跑 → 安全判定 → 一次性写盘。 */
  async function runPatch(
    args: Record<string, unknown>,
    roots: FileRoot[],
  ): Promise<{ text: string; ok: boolean; error?: ToolFailure }> {
    if (roots.length === 0) {
      return failureResult("尚未配置可写根", OUT_OF_ROOT_HINT, {
        error_code: "no-roots",
        hint: "没有可写根时 file_patch 不会成功；先让用户在设置里添加写根",
      });
    }
    const patchText = typeof args.patch === "string" ? args.patch : "";
    if (!patchText.trim()) {
      return failureResult(
        "补丁为空",
        "请提供以 `*** Begin Patch` 开始、`*** End Patch` 结束的补丁文本。",
        {
          error_code: "empty-patch",
          retry_with: "按 *** Begin Patch / *** End Patch 结构重写补丁，至少包含一处 @@ 变更",
        },
      );
    }
    const rootName = typeof args.root === "string" ? args.root : undefined;

    const parsed = parsePatch(patchText);
    if (!parsed.ok) return patchFailure(parsed.error);

    const planned = await planPatch(parsed.plan, {
      roots,
      ...(rootName ? { rootName } : {}),
      patchText,
      io: ioFor(roots),
    });
    if (!planned.ok) return patchFailure(planned.error);

    // 安全判定：只读根 / 越界直接拒绝；其余由 HITL 决定问不问。
    // ★ 写盘层（桌面端）无论如何都只写可写根内，这里是「早拒绝 + 明确文案」。
    const safety = assessPatchSafety({
      targets: planned.targets,
      deletions: planned.changes.filter((c) => c.kind === "D").length,
      roots,
      ...(deps.outOfRoot ? { outOfRoot: deps.outOfRoot() } : {}),
    });
    if (safety.verdict === "reject") {
      return failureResult("写入被拒绝", safety.reason, {
        error_code: "safety-reject",
        hint: "目标不在可写根内或落在只读根；换根内相对路径，或让用户把该根改为可写",
      });
    }

    const writes: { kind: "write"; path: string; content: string }[] = [];
    const deletes: { kind: "delete"; path: string }[] = [];
    for (const change of planned.changes) {
      if (change.kind === "D") deletes.push({ kind: "delete", path: change.abs });
      else writes.push({ kind: "write", path: change.abs, content: change.newText ?? "" });
    }
    const response = await deps.bridge.write({ roots, ops: [...writes, ...deletes] });
    if (!response.ok) {
      const detail = (response.results ?? [])
        .filter((r) => !r.ok)
        .map((r) => `- ${r.path}：${r.error ?? "失败"}`)
        .join("\n");
      return {
        text:
          `写入磁盘失败：${response.error ?? "未知原因"}` +
          (detail ? `\n${detail}` : "") +
          "\n请先确认可写根与目录是否存在，再重试。",
        ok: false,
      };
    }

    return { text: successText(planned.changes, planned.notes), ok: true };
  }

  /** `file_read` 的执行：解析根 → 读盘 → 按行区间切片。 */
  async function runRead(
    args: Record<string, unknown>,
    roots: FileRoot[],
  ): Promise<{ text: string; ok: boolean; sources?: ToolSource[]; error?: ToolFailure }> {
    if (roots.length === 0) {
      return failureResult("尚未配置根目录", "请让用户在设置区「文件编辑」里添加一个根。", {
        error_code: "no-roots",
        hint: "没有根目录时 file_read 无法使用；不要重试",
      });
    }
    const rawPath = typeof args.path === "string" ? args.path.trim() : "";
    if (!rawPath) {
      return failureResult("path 为空", "path 不能为空（例如 notes/a.md）。", {
        error_code: "invalid-path",
        retry_with: "传根内相对路径，例如 notes/a.md",
      });
    }

    const rootName = typeof args.root === "string" ? args.root : undefined;
    const root = rootName
      ? roots.find((r) => r.name.trim().toLowerCase() === rootName.trim().toLowerCase())
      : roots[0];
    if (!root) {
      return failureResult(
        "未找到根",
        `没有名为「${rootName ?? ""}」的根。可用根：${roots.map((r) => `${r.name}（${r.path}）`).join("、")}。`,
        {
          error_code: "root-unknown",
          retry_with: `用可用根名之一重试：${roots.map((r) => r.name).join("、")}`,
        },
      );
    }
    const abs = resolveInsideRoot(root.path, rawPath);
    if (!abs) {
      // 首行保持历史文案不变（题集 sec-005 与老断言都按它匹配），契约行追加在后面。
      return appendFailure(
        `路径不合法或越界：${rawPath}。file_read 只接受根「${root.name}」（${root.path}）内的相对路径，` +
          "不能包含 `..` 或是绝对路径。",
        {
          error_code: "path-escape",
          retry_with: "把 path 改成根内相对路径（不带盘符、不以 / 开头、不含 ..）",
        },
      );
    }

    const result = await deps.bridge.read({ roots, path: abs });
    if (!result.ok) {
      const code = result.code ?? "io";
      const hint =
        code === "not-found"
          ? "文件不存在。请先用根内相对路径确认；如果是新建文件，请直接用 file_patch 的 `*** Add File`。"
          : code === "binary"
            ? "这不是文本文件，本工具只处理 UTF-8 文本。"
            : code === "too-large"
              ? "文件超过单文件上限，无法整份读取。"
              : "";
      return appendFailure(`${result.error || "读取失败"}${hint ? `\n${hint}` : ""}`, {
        error_code: code,
        ...(code === "not-found" ? { retry_with: "先用根内相对路径确认拼写；新建文件用 file_patch 的 *** Add File" } : {}),
        ...(code === "binary" ? { hint: "不是 UTF-8 文本，不能按文本读；换别的文件" } : {}),
        ...(code === "io" ? { retry_with: "同一个 file_read 重试一次；再失败就告诉用户读不了" } : {}),
      });
    }

    const rel = relFromRoot(root.path, abs) ?? rawPath;
    const lines = result.content.split(/\r\n|\n/);
    // 末行是换行产生的空串，不算一行内容
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

    const offsetRaw = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.floor(args.offset) : 1;
    const offset = Math.min(Math.max(1, offsetRaw), Math.max(1, lines.length));
    const limitRaw = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : READ_MAX_LINES;
    const limit = Math.min(READ_MAX_LINES, Math.max(1, limitRaw));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    let body = slice.join("\n");
    let clipped = false;
    if (body.length > READ_MAX_CHARS) {
      body = body.slice(0, READ_MAX_CHARS);
      clipped = true;
    }
    const end = offset - 1 + slice.length;
    const header = [
      `路径：${rel}（根：${root.name}）`,
      `共 ${lines.length} 行，本次显示第 ${offset}–${Math.max(offset, end)} 行`,
      clipped ? `（内容过长，已截断到 ${READ_MAX_CHARS} 字符；请用 offset/limit 分段读取）` : "",
    ].filter(Boolean);
    return {
      text: `${header.join("\n")}\n\n${body}`,
      ok: true,
      sources: [{ id: rel, title: rel, detail: root.name }],
    };
  }

  /** 成功的工具结果：A/M/D 清单（这也是审计里「文件清单」的来源）。 */
  function successText(changes: FileChange[], notes: string[]): string {
    const marks = changes.map((change) => {
      const tag = change.kind;
      const extra = change.movedFrom ? `（由 ${change.movedFrom} 改名）` : "";
      return `${tag}  ${change.rel}${extra}`;
    });
    return [
      `${kindsSummary(changes)}，已写入磁盘：`,
      ...marks,
      ...(notes.length ? ["提示：", ...notes.map((n) => `- ${n}`)] : []),
    ].join("\n");
  }
}

/**
 * 每个补丁错误码对应的**可执行出路**（P2-T9 契约）。
 *
 * 规则：越界/只读/桥不可用这类「重试也白搭」的失败只给 `hint`，绝不给 `retry_with`——
 * 否则模型会原样再撞一次，白烧一轮 token（这是 P0 题集里最常见的坏重试）。
 */
export function patchFailureOf(error: PatchError): ToolFailure {
  switch (error.code) {
    case "invalid-patch":
      return {
        error_code: error.code,
        retry_with:
          "按 `*** Update File: <根内相对路径>` / `@@` / `-旧行` / `+新行` 的结构重写，整份补丁以 `*** End Patch` 收尾",
      };
    case "empty-patch":
      return { error_code: error.code, retry_with: "至少写一个 `@@` 变更块；只有 Begin/End 的空补丁没有意义" };
    case "too-many-files":
      return { error_code: error.code, retry_with: "拆成多次补丁提交，每次不超过 20 个文件" };
    case "patch-too-large":
      return { error_code: error.code, retry_with: "拆成多次更小的补丁（总量 ≤4MB、单块 ≤200 行）" };
    case "file-too-large":
      return {
        error_code: error.code,
        retry_with: "先 file_read 分段读出要改的那一段，再只改必需的小段；单文件不超过 2MB",
      };
    case "hunk-too-large":
      return { error_code: error.code, retry_with: "把变更块拆小，每块不超过 200 行" };
    case "path-invalid":
      return {
        error_code: error.code,
        retry_with: "把路径改成根内相对路径：不带盘符、不以 `/` 开头、不含 `..`",
      };
    case "path-escape":
      return {
        error_code: error.code,
        retry_with: "把路径改成根内相对路径：不带盘符、不以 `/` 开头、不含 `..`",
      };
    case "root-unknown":
      return {
        error_code: error.code,
        hint: "`root` 要用可写根的根名；不确定时省略 root，让工具用第一条可写根",
      };
    case "root-readonly":
      return { error_code: error.code, hint: "这条根是只读的；改到可写根，或让用户把它改成可写根" };
    case "file-not-found":
      return {
        error_code: error.code,
        retry_with: "新建文件用 `*** Add File: <路径>`；修改已有文件先 file_read 确认路径拼写",
      };
    case "file-exists":
      return {
        error_code: error.code,
        retry_with: "目标已存在：改用 `*** Update File: <路径>`（`Add File` 只能新建）",
      };
    case "binary-file":
      return { error_code: error.code, hint: "这不是 UTF-8 文本，不能用文本补丁修改；换别的文件" };
    case "match-failed":
      return {
        error_code: error.code,
        retry_with: "先 file_read 读出该文件当前内容，再按实际原文重写 `@@` 锚点；不要凭记忆改",
      };
    case "write-failed":
      return {
        error_code: error.code,
        retry_with: "同一个补丁重试一次；再失败就检查目标是否被占用或只读，并告诉用户",
      };
    case "bridge-missing":
      return { error_code: error.code, hint: "桌面文件桥不可用（不在桌面端或桥未连接）；不要重试" };
    default:
      return { error_code: error.code, hint: "按上面的说明调整后，只重试一次" };
  }
}

/** 补丁失败的结构化结果：文本与 `formatPatchError` 完全一致，另带契约字段。 */
export function patchFailure(error: PatchError): ToolFailureResult {
  return { text: formatPatchError(error), ok: false, error: patchFailureOf(error) };
}

/** 失败文案（规格 §9：按原因分流，给出下一步建议，绝不只说 "patch failed"）。 */
export function formatPatchError(error: PatchError): string {
  const head: Record<string, string> = {
    "invalid-patch": "补丁格式不合法",
    "empty-patch": "补丁没有产生任何修改",
    "too-many-files": "单次修改文件过多",
    "patch-too-large": "补丁过大",
    "file-too-large": "文件过大",
    "hunk-too-large": "变更块过大",
    "path-invalid": "路径不合法",
    "path-escape": "路径越界",
    "root-unknown": "未找到可写根",
    "root-readonly": "目标是只读根",
    "file-not-found": "文件不存在",
    "file-exists": "目标已存在",
    "binary-file": "不是文本文件",
    "match-failed": "锚点匹配失败",
    "write-failed": "写入失败",
    "bridge-missing": "桌面文件桥不可用",
  };
  const title = head[error.code] ?? "补丁失败";
  const lines = [`${title}（${error.code}）：${error.message}`];
  if (error.hunkIndex) lines.push(`出错的块：第 ${error.hunkIndex} 个 \`@@\``);
  if (error.expected?.length) {
    lines.push(`期望的锚点开头：${error.expected.map((l) => `「${l}」`).join("、")}`);
  }
  // 路径类失败必须给出「出路」，否则模型只会换个写法重试或干脆放弃。
  if (error.code === "path-escape" || error.code === "path-invalid" || error.code === "root-unknown") {
    lines.push(OUT_OF_ROOT_HINT);
  }
  // P2-T9：契约行（可重试 / 提示）排在最终结论之前，结论永远是最后一句。
  lines.push(...contractLines(patchFailureOf(error)));
  lines.push("整份补丁未写入任何文件。");
  return lines.join("\n");
}

/**
 * 按当前环境构造工具桥；不可用时返回 null（注册表据此跳过该提供者）。
 *
 * 可见性判据（Lead 定稿）：
 * - 桌面桥存在是前提；
 * - `file_read`：任意一条根（read 或 write）即可见——只读根也有意义（读用户圈定的资料）；
 * - `file_patch`：至少一条 **write** 根才可见——没有写根注入了也只会反复失败。
 *
 * 两者都不可见时返回 null（浏览器端 / 未配置根时一个工具都不给）。
 */
export function buildFileToolBridgeIfAvailable(deps?: Partial<FileToolDeps>): ToolBridge | null {
  const bridge = deps?.bridge ?? getFileBridge();
  if (!bridge) return null;
  const rootsOf = deps?.roots ?? (() => fileRootsStore.roots());
  const visible = visibleFileTools(rootsOf());
  if (visible.size === 0) return null;
  return buildFileToolBridge({
    bridge,
    roots: rootsOf,
    visibleTools: visible,
    ...(deps?.outOfRoot ? { outOfRoot: deps.outOfRoot } : {}),
  });
}

/** 供 HITL/确认卡判断「这条调用是否需要文件工具的特殊处理」。 */
export { isFileEditTool };
