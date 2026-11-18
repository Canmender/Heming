/**
 * `heming mcp serve` 的进程侧装配：校验工作目录、装工具、把 stdio 交给协议层。
 *
 * 为什么和 `mcp.ts` 分开：那个文件是**纯协议**（一条消息进、一条响应出，测试不需要起进程）；
 * 这里碰 `process.cwd()` / `process.stdin` / SIGINT，是入口才该操心的事。
 */

import { statSync } from "node:fs";
import path from "node:path";
import type { McpOptions } from "./args.js";
import { describeMcpTools, serveMcp, type McpContext } from "./mcp.js";
import { createCliTooling } from "./tooling.js";
import { describeCliWorkspaceRules, loadCliWorkspaceRules } from "./workspaceRules.js";
import { createCliHookRunner, describeCliHooks, loadCliHooks } from "./toolHooks.js";

export interface McpServeIO {
  stdin: NodeJS.ReadableStream;
  stdout: { write: (chunk: string) => unknown };
  stderr: { write: (chunk: string) => unknown };
  /** 包版本，报给客户端的 serverInfo（测试传固定值）。 */
  version: string;
  /** 进程信号注册（测试里替换成空实现，避免真的挂 SIGINT）。 */
  onSignal?: (signal: "SIGINT", handler: () => void) => void;
}

/**
 * 启动 MCP 服务。
 *
 * 退出码：0 = stdin 关闭后正常收工；2 = 用法/目录错误；130 = Ctrl+C。
 * 注意 MCP 客户端不会看退出码判断「工具调成功没有」——那在每条响应的 `isError` 里。
 */
export async function startMcpServe(options: McpOptions, io: McpServeIO): Promise<number> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  try {
    if (!statSync(cwd).isDirectory()) return fail(io, `--cwd 不是目录：${cwd}`);
  } catch {
    return fail(io, `--cwd 目录不存在：${cwd}`);
  }

  /**
   * 工作区权限规则与 `run` 共用同一份加载器：客户端那边看不见我们的 HITL，
   * 仓库里写下的 deny / ask 就是这里唯一还起作用的人工意图。规则坏了直接不启动。
   */
  const rulesLoad = await loadCliWorkspaceRules(cwd, options.trustWorkspace);
  if (rulesLoad && !rulesLoad.ok) {
    return fail(io, `工作区权限规则有问题：${rulesLoad.error}（${rulesLoad.source}）`);
  }
  const workspaceRules = rulesLoad && rulesLoad.ok ? rulesLoad.rules : null;

  /*
   * 工作区钩子：与 `run` 同一份配置、同一套判定。别的编辑器调我们的工具时，
   * 仓库里的检查更该生效——那边连「我们有没有拒绝」都只能从工具结果里看到。
   * 默认不执行，要 `--trust-hooks` 才跑。
   */
  const hooksLoad = await loadCliHooks(cwd, options.trustHooks);
  if (hooksLoad && !hooksLoad.ok && options.trustHooks) {
    return fail(io, `工作区钩子配置有问题：${hooksLoad.error}（${hooksLoad.source}）`);
  }
  const hookSet = hooksLoad && hooksLoad.ok ? hooksLoad.set : null;

  const conversationId = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const hookRunner = hookSet ? createCliHookRunner(hookSet, { cwd, streamId: conversationId }) : null;
  const tooling = createCliTooling({
    cwd,
    allowDanger: options.allowDanger,
    conversationId,
    ...(workspaceRules ? { rules: workspaceRules } : {}),
    ...(hookRunner ? { hooks: hookRunner } : {}),
    readOnly: options.readOnly === true,
  });
  const ctx: McpContext = {
    tools: tooling.toolBridge,
    confirm: tooling.confirm,
    version: io.version,
    cwd: cwd.replace(/\\/g, "/"),
    allowDanger: options.allowDanger,
    readOnly: options.readOnly === true,
  };

  // 启动信息写 stderr：stdout 是协议通道，混一行裸文本就会让客户端解析失败并断连。
  const names = describeMcpTools(ctx).map((tool) => tool.name);
  io.stderr.write(
    `[heming] mcp serve 已就绪：工作区 ${ctx.cwd}，${names.length} 个工具（${names.join("、") || "无"}）；` +
      (options.readOnly
        ? "只读模式（--read-only）：只暴露读取类工具。\n"
        : `危险工具${options.allowDanger ? "已放行（--allow-danger）" : "未放行"}。\n`),
  );
  if (workspaceRules) {
    io.stderr.write(`[heming] ${describeCliWorkspaceRules(workspaceRules)}\n`);
  }
  if (hookSet) {
    const line = describeCliHooks(hookSet);
    if (line) io.stderr.write(`[heming] ${line}\n`);
  }

  let interrupted = false;
  const onSigint = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    io.stderr.write("\n[heming] 收到 Ctrl+C，停止 mcp serve（再按一次强制退出）。\n");
    (io.stdin as unknown as { destroy?: () => void }).destroy?.();
  };
  (io.onSignal ?? ((signal, handler) => process.on(signal, handler)))("SIGINT", onSigint);

  try {
    const code = await serveMcp({
      input: io.stdin,
      output: io.stdout,
      error: (line) => io.stderr.write(line),
      ctx,
    });
    return interrupted ? 130 : code;
  } finally {
    (io.stdin as unknown as { destroy?: () => void }).destroy?.();
  }
}

function fail(io: McpServeIO, message: string): number {
  io.stderr.write(`heming: ${message}\n`);
  return 2;
}
