/**
 * 终端里的人工审批（`--ask`）：把「危险操作要不要放行」交回给人。
 *
 * 为什么需要：CLI 此前只有两个极端——不加 `--allow-danger` 就一条命令也跑不了，
 * 加了就把所有命令一次性放行。真实用法常常在中间：这次跑 `git status` 可以，
 * 跑 `rm -rf` 不行。codex 的 approval policy 就在这个位置。
 *
 * 三条设计约束：
 *
 * 1. **只有 danger 类调用会问**（命令、MCP 工具、自报 danger 的工具）。写文件仍按
 *    路径安全判定走：根内自动放行、根外一律拒绝——那条规定不因为终端里坐着一个
 *    愿意说「是」的人就放松（一次误批比一次失败贵得多）。
 * 2. **必须真的有人在**：`--ask` 在非终端（管道、CI）下直接拒绝启动，绝不把
 *    stdin 的下一行内容当成「y」——`heming run -` 的提示词就是这么被吃掉的。
 * 3. **默认拒绝**：答不上来（EOF、连续答错 3 次）一律按「不要」处理，并且
 *    之后的同类调用不再追问（否则一个批处理会在每个工具调用上卡住）。
 */

import type { Readable, Writable } from "node:stream";
import { describeCallArgs, oneLine } from "./callText.js";

/** 人给的一个回答。 */
export type ApprovalChoice =
  /** 只放行这一次。 */
  | "allow-once"
  /** 本次运行剩下的同类调用都放行。 */
  | "allow-session"
  /** 这次不要。 */
  | "deny"
  /** 停下来：后面的同类调用别再问了。 */
  | "deny-all";

/** 一次待审批的调用。 */
export interface ApprovalRequest {
  /** 工具名（`run_command` / `mcp__x__y` / 自报 danger 的工具）。 */
  tool: string;
  /** 人话名字（桥的 `meta.displayName`），缺省用工具名。 */
  displayName?: string;
  /** 参数摘要，如 `command=git status`；可为空。 */
  detail?: string;
  /**
   * 逐行预览（`--ask-writes` 用：写文件时是增删对照）。
   *
   * 和 `detail` 分开是因为形状不同：`detail` 是一行摘要，会被压成一行；预览天生多行，
   * 压成一行就没法看改了什么。最多画 `APPROVAL_PREVIEW_MAX_LINES` 行。
   */
  preview?: readonly string[];
  /**
   * 这次为什么被问：`danger`（命令 / 危险工具）还是 `write`（写文件）。
   *
   * 装配方靠它决定「本次运行都允许」的范围——放过一次写，不该顺手放过命令。
   */
  kind?: "danger" | "write";
  /** 为什么来问你（一行）。 */
  reason: string;
}

/** 审批框里最多画几行预览：这里是「扫一眼」，看全的请去 diff。 */
export const APPROVAL_PREVIEW_MAX_LINES = 20;

/** 审批函数：把人给的回答交回来。 */
export type CliApprover = (request: ApprovalRequest) => Promise<ApprovalChoice>;

/** 回答的四种写法（提示行与帮助共用一份，别两处各写一半）。 */
export const APPROVAL_ANSWER_HINTS = "[y] 允许这一次 / [a] 本次运行都允许 / [n] 不要 / [q] 停下（后面不再问）";

/**
 * 把一行输入解析成回答。
 *
 * 认中文与英文、大小写与首尾空白都不敏感；认不出来返回 `null`（调用方再问一次，
 * 而不是猜一个——把 `n` 猜成 `y` 的代价不对称）。
 */
export function parseApprovalAnswer(raw: string): ApprovalChoice | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (["y", "yes", "ok", "allow", "是", "好", "允许", "1"].includes(text)) return "allow-once";
  if (["a", "all", "always", "都允许", "全部", "本次都允许"].includes(text)) return "allow-session";
  if (["n", "no", "deny", "不要", "否", "拒绝", "2"].includes(text)) return "deny";
  if (["q", "quit", "stop", "停", "停下", "3"].includes(text)) return "deny-all";
  return null;
}

/** 审批框的全部文本（不含回答提示那行）。 */
export function describeApprovalRequest(request: ApprovalRequest): string {
  const label = request.displayName && request.displayName !== request.tool
    ? `${request.displayName}（${request.tool}）`
    : request.tool;
  const head = `[heming] 需要你确认：${label}${request.detail ? oneLine(request.detail, 120) : ""}`;
  const preview = (request.preview ?? []).slice(0, APPROVAL_PREVIEW_MAX_LINES);
  const lines = [head, ...preview.map((line) => `  ${line}`), `  ${request.reason}`, `  ${APPROVAL_ANSWER_HINTS}`];
  if ((request.preview?.length ?? 0) > preview.length) {
    lines.splice(1 + preview.length, 0, `  …（只画了前 ${preview.length} 行）`);
  }
  return lines.join("\n");
}

/** 终端审批器：`ask` 提问、`close` 收尾（交给入口在结束前调用）。 */
export interface TerminalApprover {
  ask: CliApprover;
  close: () => void;
}

/**
 * 造一个终端审批器。
 *
 * 读 stdin 用「排队 + 等待者」而不是 `readline.question`：`question` 要求 `terminal: true`
 * 才能自己回显，而我们要把提示写到 stderr（stdout 可能是 `--output-format stream-json`
 * 的协议通道），所以由自己管队列更省事，也能在同一进程里被测试按行喂。
 */
export function createTerminalApprover(options: {
  input: Readable;
  /** 提示写到哪儿（传 stderr）。 */
  output: Writable;
  /** 答错几次后按拒绝处理（默认 3）。 */
  maxRetries?: number;
}): TerminalApprover {
  const maxRetries = Math.max(1, options.maxRetries ?? 3);

  // readline 按需求值：没有危险调用时不必挂监听（也就不会吃掉 stdin 的下一行）。
  type ReadlineHandle = {
    close: () => void;
    next: () => Promise<string | null>;
  };
  let handle: ReadlineHandle | null = null;

  const ensureHandle = async (): Promise<ReadlineHandle> => {
    if (handle) return handle;
    // 动态 import 让本模块在不需要审批时零成本（与 `mcp.ts` 里 readline 的用法一致）。
    const mod = await import("node:readline");
    const rl = mod.createInterface({ input: options.input, crlfDelay: Infinity, terminal: false });
    const queue: string[] = [];
    const waiters: ((line: string | null) => void)[] = [];
    let closed = false;
    rl.on("line", (line: string) => {
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queue.push(line);
    });
    rl.on("close", () => {
      closed = true;
      while (waiters.length > 0) waiters.shift()?.(null);
    });
    handle = {
      close: () => {
        rl.close();
      },
      next: () =>
        new Promise<string | null>((resolve) => {
          const queued = queue.shift();
          if (queued !== undefined) return resolve(queued);
          if (closed) return resolve(null);
          waiters.push(resolve);
        }),
    };
    return handle;
  };

  let stopped = false;

  const ask: CliApprover = async (request) => {
    // 已经回答过「停下」：不再打扰，直接拒绝（入口的闸门也会记住这件事）。
    if (stopped) return "deny";

    const reader = await ensureHandle();
    options.output.write(`${describeApprovalRequest(request)}\n`);

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      options.output.write("> ");
      const line = await reader.next();
      if (line === null) {
        options.output.write(`\n[heming] 没有读到回答（stdin 已关闭）：按「不要」处理，后面的同类调用不再问。\n`);
        stopped = true;
        return "deny-all";
      }
      const choice = parseApprovalAnswer(line);
      if (choice) {
        if (choice === "deny-all") stopped = true;
        return choice;
      }
      options.output.write(`[heming] 没看懂「${oneLine(line, 20)}」。${APPROVAL_ANSWER_HINTS}\n`);
    }

    options.output.write(`[heming] 连续 ${maxRetries} 次没答对：按「不要」处理，后面的同类调用不再问。\n`);
    stopped = true;
    return "deny-all";
  };

  return {
    ask,
    close: () => {
      handle?.close();
      handle = null;
    },
  };
}

/**
 * 造一个「照单回答」的审批器：给测试与 `--ask` 的脚本化替身用。
 *
 * 它把每个请求按顺序摊开交给 `answers`，用完就按拒绝处理——不会无限放行。
 */
export function createScriptedApprover(
  answers: readonly ApprovalChoice[],
): CliApprover & { requests: ApprovalRequest[] } {
  const requests: ApprovalRequest[] = [];
  const queue = [...answers];
  const approver = (async (request: ApprovalRequest) => {
    requests.push(request);
    return queue.shift() ?? "deny";
  }) as CliApprover & { requests: ApprovalRequest[] };
  approver.requests = requests;
  return approver;
}


/** 参数摘要（审批框里那一行）：从模型的原始参数里挑字段。 */
export function approvalDetail(argsJson: string): string {
  return describeCallArgs(argsJson);
}