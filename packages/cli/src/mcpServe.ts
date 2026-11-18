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
import { collectCliMcpCatalog, describeCliMcpCatalog, readWorkspaceResource } from "./mcpCatalog.js";
import { createMcpCatalogWatcher } from "./mcpWatch.js";
import { describeCliWorkspaceRules, loadCliWorkspaceRules } from "./workspaceRules.js";
import { createCliHookRunner, createCliPostHookRunner, describeCliHooks, loadCliHooks } from "./toolHooks.js";

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
  const postHookRunner = hookSet ? createCliPostHookRunner(hookSet, { cwd, streamId: conversationId }) : null;
  const tooling = createCliTooling({
    cwd,
    allowDanger: options.allowDanger,
    conversationId,
    ...(workspaceRules ? { rules: workspaceRules } : {}),
    ...(hookRunner ? { hooks: hookRunner } : {}),
    ...(postHookRunner ? { postHooks: postHookRunner } : {}),
    readOnly: options.readOnly === true,
  });
  const ctx: McpContext = {
    tools: tooling.toolBridge,
    confirm: tooling.confirm,
    version: io.version,
    cwd: cwd.replace(/\\/g, "/"),
    allowDanger: options.allowDanger,
    readOnly: options.readOnly === true,
    // 每次 prompts/list / resources/list 现读：中途改了命令文件，下一轮就能看到。
    catalog: () => collectCliMcpCatalog({ cwd }),
    /*
     * 资源模板（d.342）：`heming://workspace/{path}` —— 客户端把 path 换成本工作区的
     * 相对路径就能读任意文本文件。越界、二进制、超大都在 readWorkspaceResource 里判，
     * 只读，与 --read-only 无关（读本来就不受只读模式影响）。
     */
    readResource: (uri) => readWorkspaceResource({ cwd, uri }),
  };

  /*
   * 资源订阅（d.327）：客户端 `resources/subscribe` 之后，工作区里的 AGENTS.md 或命令文件
   * 一变，就推一条 `notifications/resources/updated`。写 stdout 的回调放在这里，
   * 因为只有这一层知道「协议通道是哪个流」。
   */
  ctx.notify = (message) => {
    io.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const signatureOf = async (): Promise<string> => {
    try {
      const catalog = await collectCliMcpCatalog({ cwd });
      return [
        ...catalog.prompts.map((entry) => `p:${entry.name}`),
        ...catalog.resources.map((entry) => `r:${entry.uri}`),
      ].join("|");
    } catch {
      return "";
    }
  };
  // 清单本身变了（新增/删掉命令文件）才通知刷新；内容改了由 resources/updated 负责。
  let listSignature = await signatureOf();
  const watcher = createMcpCatalogWatcher({
    cwd: ctx.cwd,
    onUpdated: (uri) => {
      ctx.notify?.({ method: "notifications/resources/updated", params: { uri } });
    },
    onListChanged: () => {
      void (async () => {
        const next = await signatureOf();
        if (next === listSignature) return;
        listSignature = next;
        ctx.notify?.({ method: "notifications/resources/list_changed", params: {} });
        ctx.notify?.({ method: "notifications/prompts/list_changed", params: {} });
      })().catch(() => {
        // 推送失败不该影响服务：下一条 list 请求照样是新的。
      });
    },
  });
  ctx.subscriptions = watcher;

  // 启动信息写 stderr：stdout 是协议通道，混一行裸文本就会让客户端解析失败并断连。
  const names = describeMcpTools(ctx).map((tool) => tool.name);
  io.stderr.write(
    `[heming] mcp serve 已就绪：工作区 ${ctx.cwd}，${names.length} 个工具（${names.join("、") || "无"}）；` +
      (options.readOnly
        ? "只读模式（--read-only）：只暴露读取类工具。\n"
        : `危险工具${options.allowDanger ? "已放行（--allow-danger）" : "未放行"}。\n`),
  );
  // 工作区里的提示词与资源（命令文件、AGENTS.md 一族、三份配置）：统计一行，便于用户确认接上了。
  try {
    const catalog = await collectCliMcpCatalog({ cwd });
    const line = describeCliMcpCatalog(catalog);
    if (line) io.stderr.write(`[heming] ${line}\n`);
  } catch {
    // 采集失败就当没有：不阻断服务启动。
  }
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
    watcher.close();
    (io.stdin as unknown as { destroy?: () => void }).destroy?.();
  }
}

function fail(io: McpServeIO, message: string): number {
  io.stderr.write(`heming: ${message}\n`);
  return 2;
}
