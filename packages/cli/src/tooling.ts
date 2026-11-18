/**
 * CLI 的工具装配：文件桥、`run_command`（可选）、以及「没有人类可问」时的确定性闸门。
 *
 * 为什么单独成模块：`run`（模型跑一轮）和 `mcp serve`（别的编辑器调我们）用的是**同一套**
 * 工具与同一套安全规则。如果两边各写一份，迟早出现「CLI 里拒绝、MCP 里放行」这种缝——
 * 那不是功能差异，是把用户的文件改坏。所以闸门与桥只有一份，两个入口都从这里拿。
 *
 * 闸门的语气（fail-closed）不变：
 * - 只读工具放行；
 * - 根内文件写放行，根外/删除/改可执行脚本等「需要人确认」的写**一律拒绝**
 *   （`assessPatchSafety` 只有 `auto` 才过，`ask` 也拒绝——无人值守时自动批准一次「问」
 *   等于把 HITL 关掉）；
 * - `run_command` 交给工具桥处理：`--allow-danger` 时真跑，否则返回「未执行」；
 * - 认不出风险的调用**拒绝**。宁可让一次未知工具的调用失败，也不要把它当成只读放过去。
 */

import path from "node:path";
import type { FileRoot } from "../../../packages/web/src/lib/fileEdit/paths.js";
import { assessPatchSafety } from "../../../packages/web/src/lib/fileEdit/safety.js";
import { isFileWriteTool, targetsOfCall } from "../../../packages/web/src/lib/fileEdit/ruleTargets.js";
import { toHitlCall } from "../../../packages/web/src/lib/hitl/classify.js";
import { matchWorkspaceRules } from "../../../packages/web/src/lib/hitl/workspaceRules.js";
import type { GateOutcome } from "../../../packages/web/src/lib/hitl/types.js";
import type { ToolBridge } from "../../../packages/web/src/lib/agentStream.js";
import { SHELL_TOOL } from "../../../packages/web/src/lib/shell/tool.js";
import { createNodeFsBridge } from "../../../evals/runner/fsBridge.js";
import { createEvalToolBridge } from "../../../evals/runner/tools.js";
import type { CliWorkspaceRuleSet } from "./workspaceRules.js";
import { mcpToolName, parseMcpToolName, type McpConnection } from "./mcpClient.js";

/** 一次工具调用在闸门看来需要的最小形状（与编排层给的一致）。 */
export interface GateCall {
  id: string;
  function: { name: string; arguments: string };
}

/** 闸门签名：拿到一批调用，逐个给出 allow / deny（没有「ask」——这里没有人可问）。 */
export type ToolConfirmFn = (calls: GateCall[]) => Promise<GateOutcome[]>;

/** 工具装配的结果：根、桥、闸门三者一起给出，调用方不必自己保证它们一致。 */
export interface CliTooling {
  /** 唯一可写根（cwd），也是提示词里的工作区。 */
  roots: FileRoot[];
  toolBridge: ToolBridge;
  confirm: ToolConfirmFn;
}

/**
 * 确定性闸门（_没有人可问时，「问」必须落成一条固定规则_）。
 *
 * `metaOf` 由桥提供：工具自己声明风险等级，闸门不靠名字猜。
 *
 * `rules` 是工作区 `.heming/permissions.json` 的解析结果（Web 端闸门认的同一份文件）：
 * - `deny` 最先判，压过一切；
 * - `ask` 在这里落成拒绝——没有人可以确认；
 * - `allow` 只在 `allowActive`（`--trust-workspace`）时放宽，否则回落到下面的风险判定。
 */
export function createCliGate(input: {
  roots: () => FileRoot[];
  allowDanger: boolean;
  metaOf: (name: string) => { risk?: string } | undefined;
  rules?: CliWorkspaceRuleSet | null;
}): ToolConfirmFn {
  const rules = input.rules ?? null;
  return async (calls) =>
    calls.map((call) => {
      const hitlCall = toHitlCall(call);
      const name = call.function.name;

      /*
       * 0. 工作区规则先判。
       *    顺序与 Web 端一致：deny > ask > allow；allow 未信任时等于没有这条规则。
       *    注意这一层必须排在命令工具的「交给桥裁决」之前——仓库明确写了
       *    `{"deny":[{"tool":"run_command","command":"git push*"}]}` 时，有没有
       *    `--allow-danger` 都不该跑。
       *
       *    `allow` 在这里只放宽一件事：danger 工具不再要求 `--allow-danger`。
       *    它**不**绕过写路径的越界/删除判定——路径安全是文件桥的最后一道闸，
       *    不该被一份仓库里的 JSON 顶掉（`run_command` 本身仍然由桥是否挂载决定）。
       */
      let relaxedByRule = false;
      if (rules) {
        const verdict = matchWorkspaceRules(rules.config, hitlCall, { roots: input.roots() });
        if (verdict.verdict === "deny") {
          return {
            kind: "deny" as const,
            call: hitlCall,
            reason: `工作区权限规则拒绝：${verdict.reason ?? "命中 deny 规则"}`,
            cause: "rule" as const,
          };
        }
        if (verdict.verdict === "ask") {
          return {
            kind: "deny" as const,
            call: hitlCall,
            reason: `工作区权限规则要求先确认（${verdict.reason ?? "命中 ask 规则"}），CLI 没有人可以确认，按拒绝处理`,
            cause: "rule" as const,
          };
        }
        relaxedByRule = verdict.verdict === "allow" && rules.allowActive;
      }

      // 命令工具由桥统一裁决：挂上了（--allow-danger）就真跑，没挂就回「未执行」。
      if (name === SHELL_TOOL) return { kind: "allow" as const, call: hitlCall };

      const meta = input.metaOf(name);
      if (!meta || !meta.risk) {
        return {
          kind: "deny" as const,
          call: hitlCall,
          reason: `CLI 无法确认工具 ${name} 的风险，按拒绝处理（fail-closed）`,
          cause: "gate" as const,
        };
      }
      if (meta.risk === "read") return { kind: "allow" as const, call: hitlCall };
      if (meta.risk === "danger") {
        return input.allowDanger || relaxedByRule
          ? { kind: "allow" as const, call: hitlCall }
          : {
              kind: "deny" as const,
              call: hitlCall,
              reason: "CLI 未授权危险工具（需要 --allow-danger）",
              cause: "gate" as const,
            };
      }

      // 剩下的是写类：只有明确的文件写工具才走路径安全判定，其它写工具一律拒绝。
      if (!isFileWriteTool(name)) {
        return {
          kind: "deny" as const,
          call: hitlCall,
          reason: `CLI 不接受未声明的写工具：${name}`,
          cause: "gate" as const,
        };
      }
      const targets = targetsOfCall({ name, argsJson: call.function.arguments }, input.roots());
      if (!targets) {
        return {
          kind: "deny" as const,
          call: hitlCall,
          reason: "无法解析这次写入的目标路径，按拒绝处理",
          cause: "gate" as const,
        };
      }
      const safety = assessPatchSafety({
        targets: targets.absolute,
        deletions: targets.deletions,
        roots: input.roots(),
        outOfRoot: "reject",
      });
      if (safety.verdict === "auto") return { kind: "allow" as const, call: hitlCall };
      return {
        kind: "deny" as const,
        call: hitlCall,
        reason: safety.reason,
        cause: "gate" as const,
      };
    });
}

/**
 * 把工具参数里的绝对路径改写成「相对 cwd」的写法。
 *
 * 为什么需要：文件工具的契约是「路径一律相对根」，可**模型和 MCP 客户端都爱发绝对路径**
 * （`D:/proj/src/a.ts`）。不改写的话，一次完全合法的「写工作区内的文件」会得到
 * 「不能写绝对路径」，用户看到的是莫名其妙的失败。
 *
 * 安全上不放松：改写只做字符串换算——
 * - 落在 cwd 内 → 变成相对路径（根内，正常放行）；
 * - 落在 cwd 外 → 变成 `../...` 相对路径，照样被桥的越界检查拒绝（而且错误信息会点名越界）；
 * - 参数不是 JSON 对象、或没有路径字段 → 原样返回。
 */
export function relativizeToolArgs(argsJson: string, cwd: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return argsJson;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return argsJson;

  const root = path.resolve(cwd);
  const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
  let changed = false;

  const rewrite = (value: string): string => {
    if (!ABSOLUTE.test(value)) return value;
    const abs = path.resolve(value);
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    changed = true;
    // 正好是根本身：用 "." 表示，别给一个空串。
    return rel === "" ? "." : rel;
  };

  const out: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  for (const key of ["path", "file", "target", "from", "to"]) {
    const value = out[key];
    if (typeof value === "string") out[key] = rewrite(value);
  }
  for (const key of ["paths", "files"]) {
    const value = out[key];
    if (Array.isArray(value)) {
      out[key] = value.map((item) => (typeof item === "string" ? rewrite(item) : item));
    }
  }
  // glob 模式：`D:/proj/**/*.ts` → `**/*.ts`（只剥「正好以 cwd 开头」这一种前缀）。
  for (const key of ["pattern", "glob"]) {
    const value = out[key];
    if (typeof value === "string" && ABSOLUTE.test(value)) {
      const prefix = root.replace(/\\/g, "/");
      const normalized = value.replace(/\\/g, "/");
      if (normalized === prefix) {
        out[key] = "**/*";
        changed = true;
      } else if (normalized.startsWith(`${prefix}/`)) {
        out[key] = normalized.slice(prefix.length + 1);
        changed = true;
      }
    }
  }

  return changed ? JSON.stringify(out) : argsJson;
}

/**
 * 组装一次运行（或一个 MCP 会话）要用的全部工具。
 *
 * `onWrite` 只给 `run` 用（它要把落盘路径记进 `writes` 给 `exec --json`）；MCP 没有
 * 「一份运行结果」要交，所以不传——传了也不会被调用。
 */
export function createCliTooling(options: {
  cwd: string;
  allowDanger: boolean;
  conversationId: string;
  onWrite?: (file: string) => void;
  /** 工作区权限规则（`.heming/permissions.json`）；`null` / 省略 = 没有规则。 */
  rules?: CliWorkspaceRuleSet | null;
  /**
   * 已连上的 MCP 服务（`--mcp` 时由入口连接，见 `mcpClient.ts`）。
   *
   * 它们的工具一律按 **danger** 处理：真正的操作发生在对方进程里，我们的闸门管不到，
   * 只能靠「要不要放行 danger」这一道总闸（也就是还需要 `--allow-danger` 才真的跑）。
   */
  mcp?: readonly McpConnection[];
}): CliTooling {
  const cwd = path.resolve(options.cwd).replace(/\\/g, "/");
  const roots: FileRoot[] = [{ path: cwd, mode: "write", name: "work" }];

  // 真实 fs 桥：与评测用的同一份 Node 实现（根内校验、符号链接拒绝、二进制嗅探都在）。
  const fsBridge = createNodeFsBridge();
  const baseBridge = createEvalToolBridge({
    bridge: fsBridge,
    roots: () => roots,
    // 写根外直接拒绝（不设「问一下」——这里没有人可问）。
    outOfRoot: () => "reject",
    // 任务清单按本次运行独立：CLI 不在两次调用之间保存会话，清单串味只会误导模型。
    conversationId: options.conversationId,
    // 只有显式 --allow-danger 才挂命令工具（它同时意味着闸门放行 danger）。
    ...(options.allowDanger ? { shell: true } : {}),
  });

  const onWrite = options.onWrite;
  const mcp = options.mcp ?? [];
  const mcpTools: unknown[] = [];
  const connections = new Map<string, McpConnection>();
  for (const connection of mcp) {
    connections.set(connection.server, connection);
    for (const tool of connection.tools) {
      mcpTools.push({
        type: "function",
        function: {
          name: mcpToolName(connection.server, tool.name),
          description: `MCP · ${connection.server} / ${tool.name}${tool.description ? `：${tool.description}` : ""}`,
          // 对方给的 schema 原样转发；没给就用宽松的 object（别假装知道参数长什么样）。
          parameters: tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: true },
        },
      });
    }
  }

  const toolBridge: ToolBridge = {
    tools: [...baseBridge.tools, ...mcpTools],
    meta: (name) => {
      if (name === SHELL_TOOL) return { risk: "danger" as const, displayName: "在本机执行命令", core: true };
      const mcpTarget = parseMcpToolName(name);
      if (mcpTarget) {
        return { risk: "danger" as const, displayName: `MCP · ${mcpTarget.server}/${mcpTarget.tool}`, core: true };
      }
      return baseBridge.meta?.(name);
    },
    async execute(call, execOpts) {
      // 没挂命令工具时，模型仍可能「凭印象」调用它：回一条明确的未执行文案，
      // 而不是让 mergeToolBridges 回「未知工具」——后者会让模型以为是参数写错、反复重试。
      if (call.name === SHELL_TOOL && !options.allowDanger) {
        return { text: shellDeniedText(), ok: false };
      }

      // MCP 工具：参数语义由对方定义，**不改写**（不套 relativizeToolArgs）。
      const mcpTarget = parseMcpToolName(call.name);
      if (mcpTarget) {
        const connection = connections.get(mcpTarget.server);
        if (!connection) return { text: `MCP 服务 ${mcpTarget.server} 没有连上`, ok: false };
        if (!options.allowDanger) {
          return {
            text: [
              `未执行：MCP 工具 ${call.name} 需要 --allow-danger（MCP 工具一律按危险工具处理）。`,
              "【该操作未执行，文件与系统状态未被修改】",
              "这不是重试能解决的问题：要让模型用这些工具，请用 --mcp --allow-danger 重新启动。",
            ].join("\n"),
            ok: false,
          };
        }
        let args: unknown;
        try {
          args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
        } catch {
          return { text: `MCP 工具 ${call.name} 的参数不是合法 JSON`, ok: false };
        }
        try {
          const result = await connection.callTool(mcpTarget.tool, args);
          return { text: result.text, ok: !result.isError };
        } catch (error) {
          return {
            text: `MCP 调用失败（${mcpTarget.server}/${mcpTarget.tool}）：${error instanceof Error ? error.message : String(error)}`,
            ok: false,
          };
        }
      }

      const normalized =
        call.name === SHELL_TOOL
          ? call
          : { ...call, arguments: relativizeToolArgs(call.arguments, cwd) };
      const result = await baseBridge.execute(normalized, execOpts);
      if (result.ok && result.writes?.length && onWrite) {
        for (const file of result.writes) onWrite(file);
      }
      return result;
    },
  };

  const gate = createCliGate({
    roots: () => roots,
    allowDanger: options.allowDanger,
    metaOf: (name) => toolBridge.meta?.(name),
    rules: options.rules ?? null,
  });

  /**
   * 闸门看到的参数与桥看到的参数必须是**同一份**，否则会出现「闸门按绝对路径判越界拒绝、
   * 桥按相对路径写成功」这类不一致。所以两处都先过 `relativizeToolArgs`。
   */
  const confirm: ToolConfirmFn = async (calls) =>
    gate(
      calls.map((call) =>
        call.function.name === SHELL_TOOL || parseMcpToolName(call.function.name)
          ? call
          : { ...call, function: { ...call.function, arguments: relativizeToolArgs(call.function.arguments, cwd) } },
      ),
    );

  return { roots, toolBridge, confirm };
}

/** 未挂命令桥时，模型硬调 `run_command` 拿到的拒绝文案（`run` 与 MCP 共用同一条口径）。 */
export function shellDeniedText(): string {
  return [
    "未执行：CLI 未授权危险工具（需要 --allow-danger）。",
    "【该操作未执行，文件与系统状态未被修改】",
    "这不是重试能解决的问题：要跑命令必须由用户重新用 --allow-danger 启动 CLI。不要重复调用同一命令。",
  ].join("\n");
}
