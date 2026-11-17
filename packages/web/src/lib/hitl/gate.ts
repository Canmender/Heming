/**
 * HITL 闸门：整批 tool_calls → 整批裁决。
 *
 * 闸门是**纯逻辑**（不引 React、不引 store），可单测。它做三件事：
 * 1. 批内分流：策略判定为「免问」的直接放行，剩下的**一次性**交给 UI 问用户；
 * 2. 同指纹去重：模型被拒后反复重试同一个调用时，不再弹窗（直接拒）；
 * 3. 兜底：UI 抛错时按**拒绝**处理。
 *
 * **绝不执行未确认项**是这里的硬约束：UI 返回的裁决缺项 → 补成 deny；
 * UI 整个抛错 → 也补成 deny。
 *
 * ★ **兜底一律往「不执行」倒**。
 * 「闸门故障不得让整轮对话失败」= 模型总能收到一条 tool 消息，
 * **不是「工具总能执行」**——工具不执行时模型照样收到「未执行」的消息，对话继续。
 * 反过来若兜底是放行，UI 一坏就等于所有危险工具静默执行，
 * 而那恰恰是最不该放行的时刻。
 */

import type { GateOutcome, HitlBatch, HitlCall, HitlVerdict } from "./types.js";
import type { HitlPolicyStore } from "./policy.js";
import { toHitlCall, type RawToolCall } from "./classify.js";
import { rememberDecision } from "../fileEdit/remember.js";
import { currentFileRoots } from "../fileEdit/roots.js";
import type { FileRoot } from "../fileEdit/paths.js";
import {
  loadWorkspaceRules,
  matchWorkspaceRules,
  type WorkspaceRulesLoad,
} from "./workspaceRules.js";

/** 闸门的依赖（全部可注入，便于测试）。 */
export interface HitlGateDeps {
  policy: HitlPolicyStore;
  /** 把待确认项交给 UI，返回逐项裁决。 */
  ask: (batch: HitlBatch) => Promise<HitlVerdict[]>;
  /**
   * 工作区权限规则加载器（`.heming/permissions.json`）。
   *
   * 每次 `review()` 只调用一次，缺省用 `workspaceRules.ts` 的默认加载器。
   * 返回 `null` = 没有规则来源；返回 `{ ok:false }` 或抛错 = **全部拒绝**（fail-closed）。
   * 单独做成依赖是为了测试能注入固定规则，不必碰磁盘桥。
   */
  workspaceRules?: () => Promise<WorkspaceRulesLoad | null>;
}

/** 规则配置损坏时的统一拒绝文案（测试与界面都靠这句话识别 fail-closed）。 */
export const WORKSPACE_RULES_FAIL_REASON = "权限规则配置有误，已全部拒绝";

/** 整批 fail-closed：规则加载/解析失败时，本批调用一项都不执行。 */
function denyAllForRules(calls: HitlCall[], detail?: string): GateOutcome[] {
  const reason = detail ? `${WORKSPACE_RULES_FAIL_REASON}（${detail}）` : WORKSPACE_RULES_FAIL_REASON;
  return calls.map((call) => ({ kind: "deny", call, reason, cause: "rule" }));
}

/** 闸门对外只暴露一个方法。 */
export interface HitlGate {
  review(batch: HitlBatch): Promise<GateOutcome[]>;
}

/**
 * 同指纹 key：streamId + 工具名 + 参数哈希。
 *
 * 用参数哈希而不是原始参数：原始参数可能很长（含密钥），留在内存里没必要。
 */
function fingerprint(streamId: string, name: string, argsJson: string): string {
  let hash = 5381;
  for (let i = 0; i < argsJson.length; i += 1) {
    hash = ((hash << 5) + hash + argsJson.charCodeAt(i)) >>> 0;
  }
  return `${streamId}|${name}|${hash.toString(36)}`;
}

/**
 * 构造闸门。
 *
 * `ask` 注入的就是 ChatPage 里的 `hitlStore.enqueue`——闸门本身不碰 UI。
 */
export function createHitlGate(deps: HitlGateDeps): HitlGate {
  const { policy, ask } = deps;
  /** 本轮已拒绝过的调用指纹（模型重试同一次调用时不再弹窗）。 */
  const denied = new Set<string>();
  /** 指纹所属的流（换一轮就清空——上一轮拒过不代表这一轮也拒）。 */
  let deniedStreamId = "";

  return {
    async review(batch: HitlBatch): Promise<GateOutcome[]> {
      const current = policy.get();
      // 换流即清空去重表：去重只在「同一轮内」有意义。
      if (batch.streamId !== deniedStreamId) {
        denied.clear();
        deniedStreamId = batch.streamId;
      }

      /*
       * 工作区规则**整批只取一次**：逐条各读一遍盘既慢又可能在半批之内读到两个版本。
       * 默认加载器自带 5 秒缓存；注入版（测试）可以同步返回。
       *
       * ★ 两条 fail-closed 路径：
       * - 加载器抛错（IPC 断了、实现有 bug）；
       * - 有文件但解析失败（`ok:false`）。
       * 这两种情况下本批**全部拒绝**——「不确定规则是什么」时，
       * 唯一安全的方向是不执行，而不是退回「没有规则」。
       */
      const loadRules = deps.workspaceRules ?? loadWorkspaceRules;
      let rulesLoad: WorkspaceRulesLoad | null = null;
      let rulesError: string | null = null;
      try {
        rulesLoad = await loadRules();
      } catch (e) {
        rulesError = e instanceof Error ? e.message : String(e);
      }
      if (rulesError !== null) return denyAllForRules(batch.calls, rulesError);
      if (rulesLoad && !rulesLoad.ok) return denyAllForRules(batch.calls, rulesLoad.error);

      const rulesConfig = rulesLoad ? rulesLoad.config : null;
      /*
       * allow 规则是否生效：`.heming/permissions.json` 来自仓库，
       * 未信任的工作区里 allow 一律回落成 ask（deny / ask 不受影响，它们是收紧方向）。
       * 否则克隆一个陌生仓库就等于接受它写的 `{"allow":[{"tool":"*"}]}`。
       */
      const allowActive = rulesLoad?.ok === true ? rulesLoad.allowActive : false;
      // 根口径与文件工具 / 策略层共用 `currentFileRoots()`；读失败按「没有根」，
      // 此时绝对路径一律算越界（不匹配 path 规则），偏安全的方向。
      let roots: FileRoot[] = [];
      if (rulesConfig) {
        try {
          roots = currentFileRoots();
        } catch {
          roots = [];
        }
      }

      /** 输出与输入等长同序：调用方按下标对齐。 */
      const outcomes: (GateOutcome | null)[] = batch.calls.map(() => null);
      /** 需要问用户的项。 */
      const pending: { index: number; call: HitlCall }[] = [];
      /** 已自动放行的只读项（交给 UI 折叠展示）。 */
      const auto: HitlCall[] = [];

      batch.calls.forEach((call, index) => {
        const fp = fingerprint(batch.streamId, call.name, call.argsJson);
        // 工作区规则与「记住的规则」都要看：deny 是跨来源的最高优先级。
        const ws = rulesConfig ? matchWorkspaceRules(rulesConfig, call, { roots }) : null;
        // 落盘的记忆规则优先于档位：显式拒绝最高优先级，其次显式允许。
        // `ruleFor` 内部已保证 allow 不覆盖 danger（危险操作始终会问）。
        const rule = policy.ruleFor(call, batch.agentId);
        /*
         * 1. 工作区 deny：压过「记住的允许」、会话授权与档位。
         *    团队规范写在仓库里，成员本地的记住操作不能把它顶掉。
         */
        if (ws?.verdict === "deny") {
          outcomes[index] = {
            kind: "deny",
            call,
            reason: ws.reason ? `工作区权限规则拒绝：${ws.reason}` : "工作区权限规则拒绝",
            cause: "rule",
          };
          denied.add(fp);
          return;
        }
        // 2. 记住的 deny 同样压过工作区的 allow——「deny 永远优先」是跨来源的。
        if (rule === "deny") {
          outcomes[index] = {
            kind: "deny",
            call,
            reason: "命中此前记住的拒绝规则",
            cause: "rule",
          };
          denied.add(fp);
          return;
        }
        /*
         * 3. 工作区 ask：**强制询问**，放在「记忆允许 / 策略免问」之前。
         *    这是规则里最容易被误解的一条——ask 的语义是「团队要求每次确认」，
         *    不是「在策略基础上再多问一层」；策略本来会免问的调用也必须停下来。
         */
        if (ws?.verdict === "ask") {
          pending.push({ index, call });
          return;
        }
        /*
         * 4. 工作区 allow：自动放行。
         *    - danger 的 allow 已在 `matchWorkspaceRules` 里要求 `allowDanger: true`；
         *    - 工作区未被信任时，allow 回落为 ask（团队规范来自仓库，不能自动放宽权限）。
         */
        if (ws?.verdict === "allow") {
          if (!allowActive) {
            pending.push({ index, call });
            return;
          }
          auto.push(call);
          outcomes[index] = { kind: "allow", call };
          return;
        }
        if (rule === "allow") {
          auto.push(call);
          outcomes[index] = { kind: "allow", call };
          return;
        }
        const verdict = policy.allowed(call, current, batch.agentId);
        if (verdict === "pass") {
          auto.push(call);
          outcomes[index] = { kind: "allow", call };
          return;
        }
        // 同指纹已拒过：不再打扰用户，直接拒。
        if (denied.has(fp)) {
          outcomes[index] = {
            kind: "deny",
            call,
            reason: "本轮已拒绝过相同调用",
            cause: "user",
          };
          return;
        }
        pending.push({ index, call });
      });

      if (pending.length === 0) {
        // 兜底：**拿不到明确裁决的项一律按拒绝**。
        // 与下面「没被明确确认的项绝不执行」是同一条口径——
        // 任何「不确定」都往「不执行」的方向倒，绝不往「执行」倒。
        return outcomes.map((o, i) =>
          o ?? {
            kind: "deny",
            call: batch.calls[i],
            reason: "未收到确认结果",
            cause: "gate",
          },
        );
      }

      let verdicts: HitlVerdict[] = [];
      /** 本批是否因 UI 异常而被迫补 deny——回灌文案要据此区分「用户拒绝」。 */
      let gateFailed = false;
      try {
        verdicts = await ask({
          streamId: batch.streamId,
          conversationId: batch.conversationId,
          agentId: batch.agentId,
          agentName: batch.agentName,
          calls: pending.map((p) => p.call),
          auto,
        });
      } catch (e) {
        // 闸门故障**不得让整轮对话失败**——但「不失败」指的是
        // 「模型总能收到一条 tool 消息」，**不是「工具总能执行」**。
        //
        // 所以这里按**拒绝**处理：工具不执行 → 模型收到一条「未执行」的 tool 消息
        // → 对话继续 ✓ 整轮不崩 ✓ 且危险操作没被执行 ✓
        //
        // ★ 兜底方向的选择比索引正确性更关键：
        // 兜底是 deny 时，下标写错只会导致「误拒」，用户立刻发现并报告；
        // 兜底是 allow 时下标写错就是「误放行」，**静默且不可见**。
        // 而 UI 恰恰是在这种「坏了」的时刻最不该让危险操作裸奔。
        console.warn("HITL 确认失败，按拒绝处理", e);
        gateFailed = true;
        verdicts = pending.map((p) => ({
          callId: p.call.id,
          decision: "deny" as const,
          reason: "确认流程异常，本次调用未执行",
        }));
      }

      // 按 callId 对齐裁决：UI 返回的顺序/条数不可信，缺项一律补 deny。
      const byCallId = new Map<string, HitlVerdict>();
      for (const v of verdicts) {
        if (v && typeof v.callId === "string") byCallId.set(v.callId, v);
      }

      for (const { index, call } of pending) {
        const v = byCallId.get(call.id);
        if (!v) {
          // 没被明确确认的项绝不执行。缺项来自 UI 返回不完整，按闸门异常处理。
          outcomes[index] = {
            kind: "deny",
            call,
            reason: "未收到确认结果",
            cause: "gate",
          };
          denied.add(fingerprint(batch.streamId, call.name, call.argsJson));
          continue;
        }
        if (v.decision === "deny") {
          outcomes[index] = {
            kind: "deny",
            call,
            ...(v.reason ? { reason: v.reason } : {}),
            cause: gateFailed ? "gate" : "user",
          };
          denied.add(fingerprint(batch.streamId, call.name, call.argsJson));
          // UI 异常时 v.remember 没有意义（不是用户点的），不得落规则。
          if (v.remember && !gateFailed) {
            /*
             * 走 `rememberDecision` 而不是直接 `rememberRule`：
             * 文件工具（file_patch）的规则必须是**按目录归纳的前缀**，
             * 绝不能退化成「整个工具放行」（规格 §7 红线）。其它工具的行为与改前一致。
             */
            rememberDecision(policy, call, "deny", {
              id: batch.agentId,
              name: batch.agentName,
            });
          }
          continue;
        }
        if (v.decision === "allow-session") {
          // 本会话授权：记进内存（进程退出即失效，绝不落盘）。
          policy.grant(batch.agentId, call.name, current.scope);
        }
        // 「记住允许」只对 read/write 生效；danger 由 ruleFor 拒绝，故这里不落盘。
        if (v.remember && !gateFailed && call.risk !== "danger") {
          rememberDecision(policy, call, "allow", {
            id: batch.agentId,
            name: batch.agentName,
          });
        }
        outcomes[index] = { kind: "allow", call };
      }

      // 兜底：**拿不到明确裁决的项一律按拒绝**。
      // 与上面「没被明确确认的项绝不执行」是同一条口径——
      // 任何「不确定」都往「不执行」的方向倒，绝不往「执行」倒。
      return outcomes.map((o, i) =>
        o ?? {
          kind: "deny",
          call: batch.calls[i],
          reason: "未收到确认结果",
          cause: "gate",
        },
      );
    },
  };
}

/**
 * 把模型的 tool_call 列表 + 上下文转成闸门批次。
 *
 * `metaOf` 来自工具桥：只有**作者显式声明的 `risk`** 参与判定；
 * MCP 的 `annotations`（含 `readOnlyHint`）**不参与**——规范明言它是 untrusted hint，
 * 服务端自述「我是只读的」不能作为放行依据。
 * 缺省时按安全默认（未知工具一律 write）。
 */
export function toHitlBatch(
  calls: RawToolCall[],
  ctx: { agentId: string; agentName: string; streamId: string; conversationId: string },
  metaOf?: (name: string) => { risk?: "read" | "write" | "danger"; displayName?: string } | undefined,
): HitlBatch {
  return {
    streamId: ctx.streamId,
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    agentName: ctx.agentName,
    calls: calls.map((call) => toHitlCall(call, metaOf?.(call.function.name))),
  };
}
