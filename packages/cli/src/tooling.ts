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
import type { LlmProfile } from "../../../packages/web/src/store/llm.js";
import type { CliWorkspaceRuleSet } from "./workspaceRules.js";
import { approvalDetail, type ApprovalChoice, type CliApprover } from "./approvals.js";
import { cliHookDeniedText, type CliHookVerdict } from "./toolHooks.js";
import { mcpToolName, parseMcpToolName, type McpConnection } from "./mcpClient.js";
import { REMEMBER_TOOL, addCliMemory, rememberResultText, rememberSpec } from "./memory.js";
import { createCliRewindJournal, type CliRewindJournal } from "./rewind.js";
import {
  SUBAGENT_READ_ONLY_TOOLS,
  SUBAGENT_TOOL,
  createSubagentRunner,
  parseSubagentArgs,
  subagentResultText,
  subagentSpec,
  type SubagentChatFn,
} from "./subagent.js";

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
  /**
   * 回退日志（d.336）：写工具动手之前抓的原文。
   *
   * 它是「这次运行改了什么」的唯一凭据，所以交给调用方收尾（`close()`）——什么时候算一轮结束
   * 只有编排层知道；抓取则由本函数做，因为只有这里同时看得到闸门、桥与相对路径换算。
   */
  rewind: CliRewindJournal;
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
  metaOf: (name: string) => { risk?: string; displayName?: string } | undefined;
  rules?: CliWorkspaceRuleSet | null;
  /**
   * 只读模式（`--read-only`）：除「自报只读」的工具外一律拒绝。
   *
   * 这是 codex 的 `--sandbox read-only` 同一个位置的东西——「先看看它想干什么」，
   * 而不是「跑起来再收拾」。它排在所有判定最前面：只读模式下没有例外，
   * 连 `--allow-danger` 也不放开命令（两个开关同时给时只读赢，入口会提示）。
   */
  readOnly?: boolean;
  /**
   * 交互式审批（`--ask`）：只有 danger 类调用会走到这里。
   *
   * 不给就是原来的确定性闸门（一律拒绝）。给的时候闸门会**等**一个人回答，
   * 这跟「无人值守时把 ask 落成拒绝」并不矛盾：这一路确实有人在终端前面。
   */
  ask?: CliApprover | null;
  /** 审批结果回调：装配方据此更新「本次运行已放行」等状态。 */
  onApproval?: (choice: ApprovalChoice) => void;
  /**
   * 「现在能不能跑危险工具」——动态版本，`--ask` 时指向装配方那份会变的状态。
   *
   * 必须做成函数：人答过「本次运行都允许」之后，闸门手里的 `allowDanger` 仍是 false，
   * 只有这份闭包知道许可已经变了。不给就退回静态的 `allowDanger`。
   */
  dangerAllowed?: () => boolean;
}): ToolConfirmFn {
  const rules = input.rules ?? null;
  const readOnly = input.readOnly === true;
  return async (calls) => {
    const outcomes: GateOutcome[] = [];
    for (const call of calls) {
      const hitlCall = toHitlCall(call);
      const name = call.function.name;

      /*
       * -1. 只读模式先判。
       *     先于工作区规则：规则是「这个仓库额外限制什么」，只读是「这次运行整体
       *     不许改动」，后者更宽、也更该被第一个说出来（模型收到的是模式原因，
       *     不会误以为是仓库规则或参数问题）。
       *     认「自报只读」而不是认工具名：桥自己声明 risk=read 的才算只读，
       *     新增工具时不会因为忘了维护白名单而被静默放行。
       */
      if (readOnly) {
        const meta = input.metaOf(name);
        if (name === SHELL_TOOL || !meta || meta.risk !== "read") {
          outcomes.push({
            kind: "deny",
            call: hitlCall,
            reason: `CLI 以只读模式运行（--read-only）：${name} 会改动文件或执行命令，这次没有执行`,
            cause: "gate",
          });
          continue;
        }
      }

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
          outcomes.push({
            kind: "deny",
            call: hitlCall,
            reason: `工作区权限规则拒绝：${verdict.reason ?? "命中 deny 规则"}`,
            cause: "rule",
          });
          continue;
        }
        if (verdict.verdict === "ask") {
          /*
           * 规则写了「先问一下」：`--ask` 下就真的问；不问的模式（含 MCP）仍然是拒绝。
           * 这条与下面 danger 的询问是两条路：回答「本次运行都允许」只表示「这个工具
           * 在这个仓库里可以动」，不会顺带放行别的危险工具——两件事的风险不同。
           */
          const ruleDetail = approvalDetail(call.function.arguments);
          const ruleDisplay = input.metaOf(name)?.displayName;
          const choice = input.ask
            ? await input.ask({
                tool: name,
                ...(ruleDisplay ? { displayName: ruleDisplay } : {}),
                ...(ruleDetail ? { detail: ruleDetail } : {}),
                reason: `工作区权限规则要求先确认（${verdict.reason ?? "命中 ask 规则"}）`,
              })
            : null;
          if (choice === "allow-once" || choice === "allow-session") {
            outcomes.push({ kind: "allow", call: hitlCall });
            continue;
          }
          if (choice) {
            outcomes.push({
              kind: "deny",
              call: hitlCall,
              reason: "你在终端里拒绝了这次调用（工作区权限规则要求确认）",
              cause: "user",
            });
            continue;
          }
          outcomes.push({
            kind: "deny",
            call: hitlCall,
            reason: `工作区权限规则要求先确认（${verdict.reason ?? "命中 ask 规则"}），CLI 没有人可以确认，按拒绝处理`,
            cause: "rule",
          });
          continue;
        }        relaxedByRule = verdict.verdict === "allow" && rules.allowActive;
      }

      const meta = input.metaOf(name);
      if (!meta || !meta.risk) {
        outcomes.push({
          kind: "deny",
          call: hitlCall,
          reason: `CLI 无法确认工具 ${name} 的风险，按拒绝处理（fail-closed）`,
          cause: "gate",
        });
        continue;
      }
      if (meta.risk === "read") {
        outcomes.push({ kind: "allow", call: hitlCall });
        continue;
      }
      if (meta.risk === "danger") {
        const dangerOpen = input.dangerAllowed ? input.dangerAllowed() : input.allowDanger;
        if (dangerOpen || relaxedByRule) {
          outcomes.push({ kind: "allow", call: hitlCall });
          continue;
        }
        /*
         * 无人可问：确定性拒绝（原来的行为）。
         * 有人可问（`--ask`）：把「要不要放行」交给终端，回答落成 allow / deny，
         * 拒绝的 cause 记 `user`——回灌文案要说「用户拒绝」，不能把人的决定
         * 说成程序判定（那会让模型去劝程序，而不是换个做法）。
         */
        if (!input.ask) {
          outcomes.push({
            kind: "deny",
            call: hitlCall,
            reason: "CLI 未授权危险工具（需要 --allow-danger）",
            cause: "gate",
          });
          continue;
        }
        const detail = approvalDetail(call.function.arguments);
        const choice = await input.ask({
          tool: name,
          ...(meta.displayName ? { displayName: meta.displayName } : {}),
          ...(detail ? { detail } : {}),
          reason: "这是在本机执行命令（或由外部服务代跑）的工具：放行之后它会真的动手。",
        });
        input.onApproval?.(choice);
        if (choice === "allow-once" || choice === "allow-session") {
          outcomes.push({ kind: "allow", call: hitlCall });
          continue;
        }
        outcomes.push({
          kind: "deny",
          call: hitlCall,
          reason: "你在终端里拒绝了这次调用",
          cause: "user",
        });
        continue;
      }

      /*
       * 记忆工具：写的是我们自己管的 `.heming/memory.json`，不是用户的源码，
       * 所以不走文件路径判定；但它仍然是「写」——只读模式在更早的分支就拒掉了。
       */
      if (name === REMEMBER_TOOL) {
        outcomes.push({ kind: "allow", call: hitlCall });
        continue;
      }

      // 剩下的是写类：只有明确的文件写工具才走路径安全判定，其它写工具一律拒绝。
      if (!isFileWriteTool(name)) {
        outcomes.push({
          kind: "deny",
          call: hitlCall,
          reason: `CLI 不接受未声明的写工具：${name}`,
          cause: "gate",
        });
        continue;
      }
      const targets = targetsOfCall({ name, argsJson: call.function.arguments }, input.roots());
      if (!targets) {
        outcomes.push({
          kind: "deny",
          call: hitlCall,
          reason: "无法解析这次写入的目标路径，按拒绝处理",
          cause: "gate",
        });
        continue;
      }
      const safety = assessPatchSafety({
        targets: targets.absolute,
        deletions: targets.deletions,
        roots: input.roots(),
        outOfRoot: "reject",
      });
      if (safety.verdict === "auto") {
        outcomes.push({ kind: "allow", call: hitlCall });
        continue;
      }
      outcomes.push({
        kind: "deny",
        call: hitlCall,
        reason: safety.reason,
        cause: "gate",
      });
    }
    return outcomes;
  };
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
  /**
   * 工作区钩子（`.heming/hooks.json`，见 `toolHooks.ts`）；`null` / 省略 = 没有要跑的检查。
   *
   * 传的是**已经装配好的判定函数**，不是规则本身：装载（读盘、剥 BOM、解析、信任开关）
   * 发生在入口，与权限规则一样在启动时一次做完，避免每个工具调用都读盘。
   */
  hooks?: ((call: { name: string; arguments: string }) => Promise<CliHookVerdict>) | null;
  /**
   * 只读模式：闸门拒掉一切可能改动的调用，桥也不挂命令工具（两道都上，
   * 因为 `--allow-danger` 与 `--read-only` 同时出现时不能让任何一条路径漏过去）。
   */
  readOnly?: boolean;
  /**
   * 交互式审批（`--ask`）：危险调用先问终端。
   *
   * 给了它就要把命令工具挂上（否则模型连 `run_command` 都看不见，问也没得问），
   * 但**执行**仍然逐次看批准状态：`allow-once` 只够这一次，`allow-session` 才长效。
   */
  ask?: CliApprover | null;
  /**
   * 工作区记忆（`.heming/memory.json`，d.329）：给 `true` 就挂 `remember` 工具。
   *
   * 不挂的时候模型硬调它会拿到「这次没开记忆」的明确回复，而不是「未知工具」——
   * 后者会让它以为名字写错、反复重试。
   */
  memory?: boolean;
  /**
   * 子代理（d.331）：给 `chat` 与 `profile` 就挂 `agent_task`。
   *
   * 只传这两个而不传工具/执行器，是因为「它能用哪些工具」必须由**本函数**决定：
   * 子代理拿到的桥是 baseBridge 过滤后的只读工具 + 同一套相对路径换算，
   * 调方想放宽也放宽不了。`null` / 省略 = 没有这个工具。
   */
  subagent?: { chat: SubagentChatFn; profile: LlmProfile } | null;
  /**
   * 回退日志（d.336）：默认开，`--no-rewind` 关掉。
   *
   * 关掉只是不抓原文；`heming rewind` 仍然能列出以前的轮次。
   */
  rewind?: boolean;
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
    // 有审批（--ask）时也要挂命令工具：否则模型看不到它，人也无从放行。
    ...((options.allowDanger || options.ask) && !options.readOnly ? { shell: true } : {}),
  });

  const onWrite = options.onWrite;

  /*
   * 回退日志：写工具动手之前抓原文（`.heming/rewind/<运行 id>.json`）。
   * 只读模式下永远抓不到东西（它写不了），所以不用特意关；`--no-rewind` 才真的关。
   */
  const rewindEnabled = options.rewind !== false;
  const rewind = createCliRewindJournal({ cwd, conversationId: options.conversationId });

  /*
   * 危险调用的批准状态（只有 `--ask` 会动它）：
   * - `sessionAllowed`：`--allow-danger` 给的全局放行，或人回答过「本次运行都允许」；
   * - `permits`：人回答「只允许这一次」攒下的一次性许可，**执行时消费**——
   *   闸门先答、桥后执行，两者的顺序由编排层保证，所以用一个计数就够；
   * - `stopped`：人回答过「停下」，之后同类调用不再打扰，直接按拒绝处理。
   */
  let sessionAllowed = options.allowDanger;
  let permits = 0;
  let stopped = false;
  const dangerAllowed = (): boolean => sessionAllowed || permits > 0;
  const consumePermit = (): void => {
    if (!sessionAllowed && permits > 0) permits -= 1;
  };
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

  /**
   * 子代理：手里只拿**只读**工具，参数照主路径一样换算成工作区相对路径。
   *
   * 为什么在这里造而不是在 run.ts：工具清单与执行器都归本函数管，
   * 让调用方自己拼一份「只读桥」迟早会漏（漏一次就是子代理能写文件）。
   */
  const readOnlyTools = baseBridge.tools.filter((tool) => {
    const name = specNameOf(tool);
    return name !== null && (SUBAGENT_READ_ONLY_TOOLS as readonly string[]).includes(name);
  });
  const runSubagent = options.subagent
    ? createSubagentRunner({
        chat: options.subagent.chat,
        profile: options.subagent.profile,
        tools: readOnlyTools,
        execute: async (call) =>
          baseBridge.execute({ ...call, arguments: relativizeToolArgs(call.arguments, cwd) }),
      })
    : null;
  const toolBridge: ToolBridge = {
    // 只读模式下连 `remember` 都不挂：列出来等于承诺能写（`run` 也做同样判断，这里是兜底）。
    tools: [      ...baseBridge.tools,
      ...(options.memory && !options.readOnly ? [rememberSpec()] : []),
      // 子代理是只读的，所以只读模式下照样挂：它不会改任何东西，却最省上下文。
      ...(runSubagent ? [subagentSpec()] : []),
      ...mcpTools,
    ],
    meta: (name) => {
      if (name === SHELL_TOOL) return { risk: "danger" as const, displayName: "在本机执行命令", core: true };
      if (name === REMEMBER_TOOL) return { risk: "write" as const, displayName: "记住这件事", core: true };
      if (name === SUBAGENT_TOOL) return { risk: "read" as const, displayName: "派子代理", core: true };
      const mcpTarget = parseMcpToolName(name);
      if (mcpTarget) {
        return { risk: "danger" as const, displayName: `MCP · ${mcpTarget.server}/${mcpTarget.tool}`, core: true };
      }
      return baseBridge.meta?.(name);
    },
    async execute(call, execOpts) {
      // 没挂命令工具时，模型仍可能「凭印象」调用它：回一条明确的未执行文案，
      // 而不是让 mergeToolBridges 回「未知工具」——后者会让模型以为是参数写错、反复重试。
      if (call.name === SHELL_TOOL && !dangerAllowed()) {
        return { text: shellDeniedText(), ok: false };
      }

      /*
       * 工作区钩子：仓库自己声明的检查，在真正动手之前跑。
       *
       * 放在闸门之后（调用方先 `confirm`、这里才执行）是有意的：被规则或风险判定拒掉的
       * 调用不该再起一个子进程去跑检查，那是白花时间。
       *
       * 参数用**模型发来的原文**（与桌面端一致）：hook 脚本常常要逐字核对参数，
       * 二次序列化会改掉字段顺序与空白。
       */
      if (options.hooks) {
        const verdict = await options.hooks({ name: call.name, arguments: call.arguments });
        if (verdict.decision === "deny") {
          return { text: cliHookDeniedText(verdict, call.name), ok: false };
        }
      }

      /*
       * 子代理：它只读，所以这里不碰审批、不碰写路径，只做参数解析与串行执行。
       * 结果里必须写清「谁查的、几轮、几次工具调用」——主对话据此判断可信度。
       */
      if (call.name === SUBAGENT_TOOL) {
        if (!runSubagent) {
          return { text: "未执行：这次运行没有开子代理。自己用 file_read / file_grep 查。", ok: false };
        }
        const parsed = parseSubagentArgs(call.arguments);
        if (!parsed.ok) return { text: parsed.error, ok: false };
        const results: Awaited<ReturnType<typeof runSubagent>>[] = [];
        for (const task of parsed.args.tasks) {
          results.push(await runSubagent(task, parsed.args.maxRounds, execOpts?.signal));
        }
        return { text: subagentResultText(results, parsed.args.tasks), ok: true };
      }
      /*
       * 记忆工具：只写 `.heming/memory.json`，不碰用户文件。
       *
       * 放在这条位置（钩子之后、文件桥之前）是有意的——仓库的钩子可以拒绝「记这条」，
       * 但它没有路径可判、也不需要根校验，套文件桥只会拿到「未知工具」。
       */
      if (call.name === REMEMBER_TOOL) {
        if (!options.memory) {
          return {
            text: "未执行：这次运行没有开启记忆（--no-memory）。告诉用户这件事没记下来，不要重试。",
            ok: false,
          };
        }
        let text = "";
        try {
          const parsed = call.arguments.trim() ? (JSON.parse(call.arguments) as unknown) : {};
          const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).text : undefined;
          if (typeof value !== "string") {
            return { text: 'remember 需要一个 text 字段（{"text":"要记下的那句话"}）。', ok: false };
          }
          text = value;
        } catch {
          return { text: "remember 的参数不是合法 JSON。", ok: false };
        }
        return rememberResultText(await addCliMemory(cwd, text));
      }

      // 命令工具放行一次就消费一次许可（`allow-session` 时不动计数）。
      if (call.name === SHELL_TOOL) consumePermit();

      // MCP 工具：参数语义由对方定义，**不改写**（不套 relativizeToolArgs）。
      const mcpTarget = parseMcpToolName(call.name);
      if (mcpTarget) {
        const connection = connections.get(mcpTarget.server);
        if (!connection) return { text: `MCP 服务 ${mcpTarget.server} 没有连上`, ok: false };
        if (!dangerAllowed()) {
          return {
            text: [
              `未执行：MCP 工具 ${call.name} 需要 --allow-danger（MCP 工具一律按危险工具处理）。`,
              "【该操作未执行，文件与系统状态未被修改】",
              "这不是重试能解决的问题：要让模型用这些工具，请用 --mcp --allow-danger 重新启动。",
            ].join("\n"),
            ok: false,
          };
        }
        consumePermit();
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
      /*
       * 写工具动手之前先留一份原文：之后再抓就来不及了（文件已经被改写）。
       * 抓不到（太大 / 二进制 / 读失败）会记成 skipped，回退时跳过并点名，不硬盖。
       */
      if (rewindEnabled && call.name !== SHELL_TOOL) {
        await rewind.note({ name: call.name, arguments: normalized.arguments });
      }
      /*
       * 命令改的东西没有原文（d.337）：跑之前之后各扫一遍工作区，记下新建 / 改过 / 删掉的范围。
       * 只有范围没有内容——新建的能删回去，改过与删掉的只能点名。
       */
      const scanBefore = rewindEnabled && call.name === SHELL_TOOL ? await rewind.beginCommand() : null;
      let result;
      try {
        result = await baseBridge.execute(normalized, execOpts);
      } finally {
        if (rewindEnabled && call.name === SHELL_TOOL) await rewind.endCommand(scanBefore);
      }
      if (result.ok && result.writes?.length && onWrite) {
        for (const file of result.writes) onWrite(file);
      }
      return result;
    },
  };

  /*
   * 审批包装：把人的回答翻译成「本次运行的批准状态」，顺序与闸门的判定一致——
   * `allow-session` 之后同一运行的后续危险调用不再打扰；`stopped` 之后连问都不问。
   */
  const ask = options.ask
    ? async (request: Parameters<CliApprover>[0]): Promise<ApprovalChoice> => {
        if (stopped) return "deny-all";
        const choice = await options.ask!(request);
        if (choice === "allow-session") sessionAllowed = true;
        else if (choice === "allow-once") permits += 1;
        else if (choice === "deny-all") stopped = true;
        return choice;
      }
    : null;

  const gate = createCliGate({
    roots: () => roots,
    allowDanger: options.allowDanger,
    metaOf: (name) => toolBridge.meta?.(name),
    rules: options.rules ?? null,
    readOnly: options.readOnly === true,
    ask,
    // 人答过「本次运行都允许」之后，闸门也要立刻知道：否则它手里那个静态的
    // `allowDanger=false` 会让它把人已经授权过的调用再问一遍。
    dangerAllowed,
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

  return { roots, toolBridge, confirm, rewind };
}

/** 从 OpenAI 风格的工具声明里取名字；不是这个形状就返回 null（不猜）。 */
function specNameOf(spec: unknown): string | null {
  if (!spec || typeof spec !== "object") return null;
  const fn = (spec as { function?: unknown }).function;
  if (!fn || typeof fn !== "object") return null;
  const name = (fn as { name?: unknown }).name;
  return typeof name === "string" && name ? name : null;
}
/** 未挂命令桥时，模型硬调 `run_command` 拿到的拒绝文案（`run` 与 MCP 共用同一条口径）。 */
export function shellDeniedText(): string {
  return [
    "未执行：CLI 未授权危险工具（需要 --allow-danger）。",
    "【该操作未执行，文件与系统状态未被修改】",
    "这不是重试能解决的问题：要跑命令必须由用户重新用 --allow-danger 启动 CLI。不要重复调用同一命令。",
  ].join("\n");
}
