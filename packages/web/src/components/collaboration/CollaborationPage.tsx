import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SYSTEM_AGENT, SYSTEM_AGENT_ID } from "@heming/shared";
import { PageShell } from "../layout/PageShell.js";
import { Button } from "../ui/Button.js";
import { EmptyState } from "../ui/EmptyState.js";
import { getMagpieCliBridge } from "../../lib/magpieCli.js";
import { parseAgents, type LocalAgent } from "../../lib/magpieAgents.js";
import { resolveBoundProfile, type RoutedProfile } from "../../lib/llmRoute.js";
import { useLlmStore } from "../../store/llm.js";
import { createCollaborationAsk } from "../../lib/collaboration/run.js";
import { estimateTurnCount, runCollaboration } from "../../lib/collaboration/engine.js";
import { clearLastRun, loadLastRun, saveLastRun } from "../../lib/collaboration/history.js";
import type {
  CollaborationConfig,
  CollaborationMode,
  CollaborationParticipant,
  CollaborationRun,
  CollaborationTurn,
} from "../../lib/collaboration/types.js";
import { CollabTurnCard } from "./CollabTurnCard.js";

/**
 * 多智能体协作页（独立页面，d.146）。
 *
 * 上一轮重构把「多智能体协作」从聊天页摘掉后，产品只剩「和小鸣」一个内置智能体。
 * 本页把它作为**固定参与者**重新请回来，并允许并入本机已有的智能体（Claude Code /
 * Codex …，由 `magpie ls` 检测）。
 *
 * 这里有一个必须说清楚的边界：本机智能体**不会被启动成 CLI 进程**，也不读它们的
 * 会话；它们只是以自己的配置模型、通过本机已配置的网关「以声音参与」——所以本页的
 * 参与者行会同时显示「配置模型」与「命中的本机档案」，缺失时直接禁用并说明原因，
 * 不做静默降级。
 *
 * 编排逻辑在 lib/collaboration（纯逻辑）；本组件只负责：
 *   - 参与者与模型映射（内置的和小鸣走绑定，本机智能体走同名档案）；
 *   - 配置（任务 / 模式 / 轮数）与运行中止；
 *   - 回合时间线与最近一次历史的恢复。
 */

const MODES: { key: CollaborationMode; label: string; hint: string }[] = [
  {
    key: "sequential",
    label: "流水线",
    hint: "按顺序接力：方案 → 补充实现 → 评审定稿，每人只交增量。",
  },
  {
    key: "supervisor",
    label: "协调者-工作者",
    hint: "第一位拆解分工，工作者按轮执行，最后协调者汇总。",
  },
  {
    key: "debate",
    label: "评审团",
    hint: "各自独立出方案，读到他人观点后修正，最后综合成结论。",
  },
];

const MODE_LABEL: Record<CollaborationMode, string> = {
  sequential: "流水线",
  supervisor: "协调者-工作者",
  debate: "评审团",
};

const ROUND_OPTIONS = [1, 2, 3];

/** 本机智能体在协作里的参与者 id：优先用 magpie 的 agent id，稳定且可回放历史。 */
function localParticipantId(agent: LocalAgent): string {
  return `local:${agent.id ?? agent.name}`;
}

/**
 * 本机智能体的「角色说明」。
 *
 * 它进入 system 提示词（run.ts 会在后面追加 COLLAB_SYSTEM_RULES），而不是假装
 * 我们启动了那个 CLI，也不给它看本机会话——只说清楚「你以这个名字、这个模型参与」。
 */
function localRolePrompt(agent: LocalAgent): string {
  return [
    `你以「${agent.name}」的身份参与本次多智能体协作。`,
    `你没有被启动成命令行进程，也不掌握本机的私有会话；你的输出会直接交给其他参与者。`,
    `你当前使用的模型是 ${agent.model}。`,
  ].join("\n");
}

interface ParticipantRow {
  id: string;
  name: string;
  kind: "system" | "local";
  /** 展示用的模型名（本机智能体为配置里的模型名）。 */
  model: string;
  /** 实际请求使用的档案；undefined 表示不可参与。 */
  profile: RoutedProfile | undefined;
  /** 本机智能体原记录（展示附加信息用）。 */
  agent?: LocalAgent;
}

interface Progress {
  index: number;
  total: number;
  round: number;
  agentName: string;
  role: string;
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function CollaborationPage() {
  const profiles = useLlmStore((s) => s.profiles);
  const bindings = useLlmStore((s) => s.bindings);
  const routes = useLlmStore((s) => s.routes);

  /** 挂载时只读一次历史；后续由运行结果覆盖。 */
  const [initialRun] = useState<CollaborationRun | null>(() => loadLastRun());
  const [run, setRun] = useState<CollaborationRun | null>(initialRun);
  const [restored, setRestored] = useState(initialRun !== null);
  const [task, setTask] = useState(() => initialRun?.task ?? "");
  const [mode, setMode] = useState<CollaborationMode>(() => initialRun?.mode ?? "sequential");
  const [rounds, setRounds] = useState(() => initialRun?.rounds ?? 1);
  const [selected, setSelected] = useState<string[]>(() =>
    (initialRun?.participants ?? [])
      .filter((p) => p.agentId !== SYSTEM_AGENT_ID)
      .map((p) => p.agentId),
  );

  const [localAgents, setLocalAgents] = useState<LocalAgent[]>([]);
  const [detectState, setDetectState] = useState<"loading" | "ready" | "unsupported" | "error">(
    "loading",
  );
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const orderRef = useRef(0);
  const totalRef = useRef(0);

  /**
   * 和小鸣：唯一的内置智能体，模型来自它在模型页的绑定。
   * 订阅 profiles/bindings/routes 是为了「刚绑定完回到本页」也能立即刷新。
   */
  const hemingProfile = useMemo(() => {
    void profiles;
    void bindings;
    void routes;
    return resolveBoundProfile(SYSTEM_AGENT_ID);
  }, [profiles, bindings, routes]);

  const localProfiles = useMemo(() => {
    const map = new Map<string, RoutedProfile | undefined>();
    for (const agent of localAgents) {
      map.set(
        localParticipantId(agent),
        profiles.find((profile) => profile.model === agent.model),
      );
    }
    return map;
  }, [localAgents, profiles]);

  const participants = useMemo<ParticipantRow[]>(() => {
    const rows: ParticipantRow[] = [
      {
        id: SYSTEM_AGENT_ID,
        name: SYSTEM_AGENT.name,
        kind: "system",
        model: hemingProfile?.model ?? "",
        profile: hemingProfile,
      },
    ];
    for (const agent of localAgents) {
      const id = localParticipantId(agent);
      if (!selected.includes(id)) continue;
      rows.push({
        id,
        name: agent.name,
        kind: "local",
        model: agent.model,
        profile: localProfiles.get(id),
        agent,
      });
    }
    return rows;
  }, [hemingProfile, localAgents, localProfiles, selected]);

  const canStart = useMemo(() => {
    if (running) return false;
    if (!task.trim()) return false;
    if (participants.length < 2) return false;
    return participants.every((participant) => participant.profile !== undefined);
  }, [participants, running, task]);

  const blockedReasons = useMemo(() => {
    const reasons: string[] = [];
    if (!task.trim()) reasons.push("先填写任务描述。");
    if (participants.length < 2) {
      reasons.push(`至少需要 2 位参与者（当前 ${participants.length} 位）。`);
    }
    for (const participant of participants) {
      if (participant.profile) continue;
      reasons.push(
        participant.kind === "system"
          ? `「${participant.name}」还没有绑定模型，请先在模型页为它绑定连接。`
          : `「${participant.name}」本机没有该模型的可用档案，请先在模型页添加。`,
      );
    }
    return reasons;
  }, [participants, task]);

  const reloadAgents = useCallback(async () => {
    const bridge = getMagpieCliBridge();
    if (!bridge) {
      setLocalAgents([]);
      setDetectState("unsupported");
      return;
    }
    setDetectState("loading");
    try {
      const result = await bridge.cli(["ls"]);
      setLocalAgents(parseAgents(result.stdout || ""));
      setDetectState(result.ok || result.stdout?.trim() ? "ready" : "error");
    } catch {
      setLocalAgents([]);
      setDetectState("error");
    }
  }, []);

  useEffect(() => {
    void reloadAgents();
  }, [reloadAgents]);

  // 离开页面就中止在跑的协作，不在后台空烧 token。
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const toggleLocal = (agent: LocalAgent) => {
    const id = localParticipantId(agent);
    if (!localProfiles.get(id)) return;
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const handleToken = useCallback((turnId: string, text: string) => {
    setRun((prev) =>
      prev
        ? { ...prev, turns: prev.turns.map((turn) => (turn.id === turnId ? { ...turn, text } : turn)) }
        : prev,
    );
  }, []);

  const appendTurn = useCallback((turn: CollaborationTurn) => {
    orderRef.current += 1;
    setRun((prev) => (prev ? { ...prev, turns: [...prev.turns, turn] } : prev));
    setProgress({
      index: orderRef.current,
      total: totalRef.current,
      round: turn.round,
      agentName: turn.agentName,
      role: turn.role,
    });
  }, []);

  const finishTurn = useCallback((turn: CollaborationTurn) => {
    setRun((prev) => {
      if (!prev) return prev;
      const existing = prev.turns.find((item) => item.id === turn.id);
      return {
        ...prev,
        turns: prev.turns.map((item) =>
          item.id === turn.id ? { ...turn, text: turn.text || existing?.text || "" } : item,
        ),
      };
    });
  }, []);

  const start = async () => {
    if (!canStart) return;
    const taskText = task.trim();
    const promptsSnapshot = { ...useLlmStore.getState().prompts };
    const profilesById: Record<string, RoutedProfile | undefined> = {};
    const promptsForAsk: Record<string, string> = { ...promptsSnapshot };

    const configParticipants: CollaborationParticipant[] = participants.map((participant) => {
      profilesById[participant.id] = participant.profile;
      if (participant.kind === "system") {
        const own = promptsSnapshot[SYSTEM_AGENT_ID]?.trim();
        const rolePrompt = own || `你以「${participant.name}」的身份参与本次多智能体协作。`;
        promptsForAsk[participant.id] = rolePrompt;
        return {
          agentId: participant.id,
          name: participant.name,
          systemPrompt: rolePrompt,
        };
      }
      const rolePrompt = participant.agent ? localRolePrompt(participant.agent) : "";
      promptsForAsk[participant.id] = rolePrompt;
      return {
        agentId: participant.id,
        name: participant.name,
        ...(rolePrompt ? { systemPrompt: rolePrompt } : {}),
      };
    });

    const config: CollaborationConfig = {
      mode,
      rounds,
      participants: configParticipants,
      task: taskText,
    };

    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = Date.now();
    const skeleton: CollaborationRun = {
      id: `run-${startedAt}`,
      mode,
      task: taskText,
      participants: configParticipants,
      rounds,
      turns: [],
      status: "running",
      startedAt,
    };
    orderRef.current = 0;
    totalRef.current = estimateTurnCount(config);
    setRun(skeleton);
    setRestored(false);
    setProgress(null);
    setRunning(true);

    try {
      const ask = createCollaborationAsk({
        profileFor: (agentId) => profilesById[agentId],
        prompts: promptsForAsk,
        onToken: handleToken,
      });
      const result = await runCollaboration(config, { ask }, {
        signal: controller.signal,
        onTurnStart: appendTurn,
        onTurnEnd: finishTurn,
      });
      setRun(result);
      setProgress(null);
      saveLastRun(result);
    } catch (error) {
      if (isAbort(error)) return;
      const message =
        error instanceof Error && error.message ? error.message : "协作启动失败，请重试。";
      setRun((prev) =>
        prev ? { ...prev, status: "error", error: message, endedAt: Date.now() } : prev,
      );
      setProgress(null);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const clear = () => {
    if (running) return;
    clearLastRun();
    setRun(null);
    setRestored(false);
    setProgress(null);
  };

  const statusText = (() => {
    if (running) {
      if (progress) {
        const roundPrefix = progress.round > 0 ? `第 ${progress.round} 轮 · ` : "";
        return `正在协作 · ${roundPrefix}第 ${progress.index} / ${progress.total} 个回合 · ${progress.agentName}（${progress.role}）`;
      }
      return "正在准备协作…";
    }
    if (!run) return "填写任务、选择模式与参与者后开始；协作只在本机运行。";
    if (run.status === "done") {
      const failed = run.turns.some((turn) => turn.error);
      return `已完成 · ${MODE_LABEL[run.mode]} · 共 ${run.turns.length} 个回合${failed ? "（部分失败）" : ""}`;
    }
    if (run.status === "aborted") return `已中止 · 保留 ${run.turns.length} 个已产生回合`;
    if (run.status === "error") return `已失败：${run.error ?? "未知错误"}`;
    return "正在准备协作…";
  })();

  return (
    <PageShell
      title="协作"
      subtitle="多个智能体在同一个任务上接力、协调或互评——全部在本机运行。"
      width="readable"
      bodyClassName="flex flex-col gap-4"
    >
      <section aria-labelledby="collab-task-heading" className="ui-card p-4">
        <h2 id="collab-task-heading" className="ui-section-title">
          协作任务
        </h2>
        <p className="ui-caption mt-1">
          写清目标与验收标准。参与者只会看到编排器交给它的上下文，不会共享本机会话。
        </p>

        <label htmlFor="collab-task" className="ui-micro mt-3 block">
          任务描述（必填）
        </label>
        <textarea
          id="collab-task"
          aria-label="任务描述（必填）"
          className="ui-input mt-1 min-h-[96px] w-full resize-y px-3 py-2 text-ui-sm leading-relaxed"
          placeholder="例如：为一个本地优先的笔记应用写一份 PRD，并给出评审意见。"
          value={task}
          onChange={(event) => setTask(event.target.value)}
          disabled={running}
        />

        <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div>
            <span id="collab-mode-label" className="ui-micro block">
              模式
            </span>
            <div
              role="radiogroup"
              aria-labelledby="collab-mode-label"
              className="mt-1.5 grid gap-2 sm:grid-cols-3"
            >
              {MODES.map((item) => {
                const checked = mode === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={`协作模式：${item.label}`}
                    onClick={() => setMode(item.key)}
                    disabled={running}
                    className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60 ${
                      checked ? "border-ink bg-subtle-2" : "border-line bg-surface hover:bg-subtle"
                    }`}
                  >
                    <span className="block ui-body-sm">{item.label}</span>
                    <span className="mt-0.5 block ui-caption">{item.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="sm:w-28">
            <label htmlFor="collab-rounds" className="ui-micro block">
              轮数
            </label>
            <select
              id="collab-rounds"
              aria-label="协作轮数"
              className="ui-input mt-1.5 w-full px-2 py-2 text-ui-sm"
              value={rounds}
              onChange={(event) => setRounds(Number(event.target.value))}
              disabled={running}
            >
              {ROUND_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value} 轮
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
          {running ? (
            <Button variant="danger" onClick={stop}>
              停止协作
            </Button>
          ) : (
            <Button onClick={() => void start()} disabled={!canStart}>
              开始协作
            </Button>
          )}
          <span className="ui-caption min-w-0 flex-1 leading-5">
            {running ? "可随时停止；已产生的回合会保留。" : "每位参与者使用各自的模型与 Key。"}
          </span>
        </div>

        {!running && blockedReasons.length > 0 ? (
          <ul aria-label="无法开始的原因" className="mt-2 space-y-0.5">
            {blockedReasons.map((reason) => (
              <li key={reason} className="ui-caption">
                {reason}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="collab-participants-heading" className="ui-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="collab-participants-heading" className="ui-section-title">
            参与者
          </h2>
          <span className="ui-caption">
            {participants.length} 位参与 · 至少 2 位
          </span>
        </div>

        <ul className="mt-3 space-y-2" aria-label="协作参与者">
          {participants
            .filter((participant) => participant.kind === "system")
            .map((participant) => (
              <li key={participant.id} className="flex items-start gap-3 rounded-lg bg-subtle-2 p-2.5">
                <input
                  type="checkbox"
                  checked
                  readOnly
                  disabled
                  aria-label={`「${participant.name}」（内置，固定参与）`}
                  className="mt-1"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="ui-body-sm font-medium">{participant.name}</span>
                    <span className="ui-chip">内置智能体</span>
                  </div>
                  <p className="ui-caption mt-0.5">
                    {participant.profile
                      ? `模型：${participant.model}`
                      : "还没有绑定模型，请先在模型页为它绑定连接。"}
                  </p>
                </div>
              </li>
            ))}
        </ul>

        <div className="mt-4">
          <h3 className="ui-micro">本机其他智能体</h3>
          <p className="ui-caption mt-1">
            由和鸣在本机检测。它们不会被启动成命令行进程；以自己的配置模型、经本机模型服务以「声音」参与。
            没有同名可用档案的会禁用。
          </p>

          {detectState === "loading" ? (
            <p className="ui-caption mt-2">正在检测本机智能体…</p>
          ) : null}
          {detectState === "unsupported" ? (
            <p className="ui-caption mt-2">
              浏览器预览里无法检测本机智能体；桌面端会自动列出。
            </p>
          ) : null}
          {detectState === "error" ? (
            <div className="mt-2 flex items-center gap-2">
              <p className="ui-caption">读取本机智能体失败。</p>
              <Button size="sm" variant="ghost" onClick={() => void reloadAgents()}>
                重新检测
              </Button>
            </div>
          ) : null}
          {detectState === "ready" && localAgents.length === 0 ? (
            <p className="ui-caption mt-2">
              没有检测到本机智能体。安装 Claude Code / Codex 等后，它们会出现在这里。
            </p>
          ) : null}

          {localAgents.length > 0 ? (
            <ul className="mt-2 space-y-1" aria-label="本机智能体">
              {localAgents.map((agent) => {
                const id = localParticipantId(agent);
                const profile = localProfiles.get(id);
                const checked = selected.includes(id);
                return (
                  <li key={id} className="flex items-start gap-3 rounded-lg px-2.5 py-2 hover:bg-subtle">
                    <input
                      type="checkbox"
                      id={`collab-agent-${id}`}
                      checked={checked}
                      disabled={!profile || running}
                      onChange={() => toggleLocal(agent)}
                      aria-label={`加入协作：${agent.name}`}
                      className="mt-1"
                    />
                    <label htmlFor={`collab-agent-${id}`} className="min-w-0 flex-1 cursor-pointer">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="ui-body-sm font-medium">{agent.name}</span>
                        {profile ? <span className="ui-chip">已匹配本机档案</span> : null}
                      </span>
                      <span className="ui-caption mt-0.5 block">
                        {profile
                          ? `模型：${agent.model}`
                          : `本机没有该模型的可用档案（${agent.model}）。`}
                      </span>
                      {agent.detail ? (
                        <span className="ui-micro mt-0.5 block">{agent.detail}</span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="collab-result-heading" className="ui-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="collab-result-heading" className="ui-section-title">
            协作过程
          </h2>
          {restored && run ? <span className="ui-chip">上次协作</span> : null}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={clear}
            disabled={!run || running}
          >
            清空
          </Button>
        </div>

        <p role="status" aria-live="polite" className="ui-caption mt-1 leading-5">
          {statusText}
        </p>

        {run?.error ? (
          <p role="alert" className="ui-alert ui-alert-danger mt-3">
            {run.error}
          </p>
        ) : null}

        {!run ? (
          <EmptyState
            compact
            className="mt-3"
            title="还没有协作记录"
            desc="填写上面的任务、选好参与者，然后点「开始协作」。"
          />
        ) : (
          <div className="mt-3 space-y-2">
            {run.turns.map((turn, index) => (
              <CollabTurnCard key={turn.id} turn={turn} order={index + 1} />
            ))}
            {run.status === "running" && run.turns.length === 0 ? (
              <p className="ui-caption">正在准备第一位参与者…</p>
            ) : null}
          </div>
        )}
      </section>
    </PageShell>
  );
}