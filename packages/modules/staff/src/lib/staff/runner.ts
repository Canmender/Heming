import type { LlmProfile } from "@heming/sdk";
import { useNotificationStore } from "@heming/sdk";
import { useTokenUsageStore } from "@heming/sdk";
import { notifyDesktop } from "@heming/sdk";
import {
  agendaKey,
  buildRuleBrief,
  clipText,
  inQuietHours,
  mergeLlmBrief,
  taskKey,
  type StaffFacts,
  type StaffFinding,
  type StaffRun,
  type StaffRunMode,
  type StaffSettings,
  type StaffTrigger,
} from "./model.js";
import {
  buildFactPayload,
  callBriefModel,
  parseBriefJson,
  refsOfFacts,
  type StaffFactPayload,
} from "./llm.js";

/**
 * 一次幕僚运行（d.48）。
 *
 * 流程固定：规则简报 →（可选）一次模型总结 → 安全合并 → 落盘/通知。
 * 模型只改措辞，事实与紧急项始终有规则兜底；模型失败时写 `mode:"fallback"`，
 * 绝不把「模型坏了」伪装成「今天没事」。
 */

export interface StaffModelOutput {
  text: string;
  tokens?: number | null;
}

export type StaffCallModel = (
  payload: StaffFactPayload,
  refs: ReturnType<typeof refsOfFacts>,
  opts: { signal?: AbortSignal },
) => Promise<StaffModelOutput>;

export type StaffRecordUsage = (model: string, tokens: number | null) => void;

export type StaffPushNotification = (input: {
  kind: "staff";
  key: string;
  title: string;
  body: string;
}) => unknown;

export interface StaffRunnerDeps {
  trigger: StaffTrigger;
  settings: StaffSettings;
  facts: StaffFacts;
  now?: number;
  /** 用户绑定的模型连接；null/缺失 = 规则模式。 */
  profile?: LlmProfile | null;
  /** 今天已消耗的 token（用于每日上限判断）。 */
  tokensToday?: number;
  /** 静默时段：仍生成简报与站内通知，只是不弹系统通知。 */
  quiet?: boolean;
  callModel?: StaffCallModel;
  recordUsage?: StaffRecordUsage;
  pushNotification?: StaffPushNotification;
  notifyDesktop?: (payload: { title: string; body: string; conversationId?: string }) => boolean;
  signal?: AbortSignal;
}

export interface StaffRunOutcome {
  run: StaffRun;
  /** 本次简报覆盖到的去重键（成功落盘后写入账本）。 */
  seenPatch: { agenda: string[]; tasks: string[] };
}

let seq = 0;

function newRunId(now: number): string {
  seq += 1;
  return `staff-${now.toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 只把「真正出现在简报里」的事实记为已提醒。
 *
 * 不能按输入 facts 全量记账：规则简报有 8 条上限，被截掉的那几条若也记为已读，
 * 用户就永远收不到它们的提醒了。
 */
export function seenKeysForFindings(
  findings: StaffFinding[],
  facts: StaffFacts,
): { agenda: string[]; tasks: string[] } {
  const agendaById = new Map(facts.agenda.map((item) => [item.refId, item]));
  const taskById = new Map(facts.tasks.map((item) => [item.refId, item]));
  const agenda = new Set<string>();
  const tasks = new Set<string>();
  for (const finding of findings) {
    for (const evidence of finding.evidence) {
      if (evidence.kind === "agenda") {
        const fact = agendaById.get(evidence.refId);
        if (fact) agenda.add(agendaKey(fact));
      } else {
        const fact = taskById.get(evidence.refId);
        if (fact) tasks.add(taskKey(fact));
      }
    }
  }
  return { agenda: [...agenda], tasks: [...tasks] };
}

function safeRecordUsage(
  recorder: StaffRecordUsage,
  model: string,
  tokens: number | null,
): void {
  try {
    recorder(model, tokens);
  } catch {
    /* 用量账本写不进去不影响简报 */
  }
}

function safePush(push: StaffPushNotification, input: Parameters<StaffPushNotification>[0]): void {
  try {
    push(input);
  } catch {
    /* 通知失败不影响简报落盘 */
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") return "模型总结超时或已取消";
  const message = err instanceof Error ? err.message : String(err ?? "");
  return clipText(message || "模型总结失败", 200);
}

export async function runStaffBrief(deps: StaffRunnerDeps): Promise<StaffRunOutcome> {
  const startedAt = deps.now ?? Date.now();
  const rule = buildRuleBrief(deps.facts, deps.trigger, startedAt);
  const profile = deps.profile ?? null;
  const tokenCap = deps.settings.dailyTokenCap;
  const usedTokens = deps.tokensToday ?? 0;
  const withinTokenBudget = tokenCap === 0 || usedTokens < tokenCap;

  let mode: StaffRunMode = "rules";
  let summary = rule.summary;
  let findings = rule.findings;
  let tokens: number | null = null;
  let error: string | undefined;

  if (profile && rule.findings.length > 0 && withinTokenBudget) {
    const refs = refsOfFacts(deps.facts);
    const payload = buildFactPayload(deps.facts);
    const call: StaffCallModel =
      deps.callModel ??
      ((factPayload, refMap, opts) => callBriefModel(profile, factPayload, opts));
    try {
      const output = await call(payload, refs, { signal: deps.signal });
      tokens = typeof output.tokens === "number" ? output.tokens : null;
      const parsed = parseBriefJson(output.text, refs);
      if (!parsed) throw new Error("模型输出不是可用的简报 JSON");
      const merged = mergeLlmBrief(rule, parsed);
      summary = merged.summary;
      findings = merged.findings;
      mode = "llm";
    } catch (err) {
      mode = "fallback";
      error = describeError(err);
    }
    safeRecordUsage(
      deps.recordUsage ??
        ((model, value) => {
          const store = useTokenUsageStore.getState();
          if (typeof value === "number") store.record(model, value);
          else store.recordUnreported(model);
        }),
      profile.model,
      tokens,
    );
  }

  const run: StaffRun = {
    id: newRunId(startedAt),
    trigger: deps.trigger,
    mode,
    startedAt,
    finishedAt: deps.now ?? Date.now(),
    summary,
    findings,
    tokens,
    ...(error ? { error } : {}),
  };

  const seenPatch = seenKeysForFindings(findings, deps.facts);
  if (findings.length > 0) {
    safePush(
      deps.pushNotification ?? ((input) => useNotificationStore.getState().push(input)),
      {
        kind: "staff",
        key: `staff:${run.id}`,
        title: "幕僚简报",
        body: summary,
      },
    );
    const quiet =
      deps.quiet ?? inQuietHours(deps.settings.quietFrom, deps.settings.quietTo, startedAt);
    // 手动运行是用户主动点的，不再弹系统通知；静默时段连自动运行也不弹。
    if (deps.trigger !== "manual" && !quiet) {
      try {
        (deps.notifyDesktop ?? notifyDesktop)({
          title: "幕僚简报",
          body: "有你可能需要处理的事",
        });
      } catch {
        /* 系统通知失败不影响简报 */
      }
    }
  }

  return { run, seenPatch };
}
