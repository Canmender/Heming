import { useEffect, useState } from "react";
import {
  countAutoRunsToday,
  describeNextCheck,
  formatStaffTime,
  isDailyDue,
  modeLabel,
  severityLabel,
  tokensToday,
  triggerLabel,
  type StaffFinding,
  type StaffRun,
} from "../lib/staff/model.js";
import { runStaffNow } from "../lib/staff/manual.js";
import { useStaffStore, type StaffSettingsPatch } from "../lib/staff/store.js";
import { useLlmStore } from "@heming/sdk";
import { useUiStore } from "@heming/sdk";
import { isModuleEffective, useModuleStore } from "@heming/sdk";
import { ConfirmDialog } from "@heming/sdk";
import { StaffIcon } from "@heming/sdk";
import { PageShell } from "@heming/sdk";
import { EmptyState } from "@heming/sdk";

/**
 * 幕僚页（d.48）：只递简报 + 一键跳转。
 *
 * 页面自己不巡检——巡检由 AppShell 的 useStaffLoop 常驻；这里只负责
 * 开关/预算/模型等设置、手动跑一次与历史简报的展示。
 */

const CARD = "rounded-xl border border-line-soft bg-[var(--surface)] p-3 shadow-card";
const INPUT =
  "rounded-md border border-line bg-[var(--surface)] px-2 py-1 text-[12px] shadow-card outline-hidden focus:border-ink";
const BTN =
  "ui-btn ui-btn-md ui-btn-ghost";
const BTN_PRIMARY =
  "ui-btn ui-btn-md ui-btn-primary";

const SEVERITY_CLASS: Record<StaffFinding["severity"], string> = {
  urgent: "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]",
  warn: "border-[var(--warn-line)] bg-[var(--warn-soft)] text-[var(--warn)]",
  info: "border-line bg-panel text-muted",
};

function FindingRow({ finding }: { finding: StaffFinding }) {
  const openInfohub = useUiStore((s) => s.openInfohub);
  const focusTask = useUiStore((s) => s.focusTask);
  // d.70：信息中枢停用时，「看日程」没有落点——禁用并说明，而不是点完回主页
  const infohubOn = useModuleStore((s) => isModuleEffective(s, "infohub"));

  function jump(): void {
    if (!finding.action) return;
    if (finding.action.kind === "open-task") {
      if (finding.action.targetId) focusTask(finding.action.targetId, finding.action.conversationId);
      return;
    }
    openInfohub({ tab: "agenda" });
  }

  // 任务区已并入智能体页（d.67）：按钮文案跟着宿主页叫「智能体」，点击仍走 focusTask
  const actionLabel = finding.action?.kind === "open-task" ? "去智能体" : "看日程";

  return (
    <div className="flex flex-wrap items-start gap-2 rounded-lg border border-line-soft px-2.5 py-2">
      <span
        className={`mt-0.5 shrink-0 rounded-full border px-1.5 py-0.5 ui-micro font-semibold ${SEVERITY_CLASS[finding.severity]}`}
      >
        {severityLabel(finding.severity)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium leading-5">{finding.title}</div>
        {finding.detail && (
          <div className="mt-0.5 break-words text-[11px] leading-5 text-muted">{finding.detail}</div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {finding.evidence.map((item) => (
            <span
              key={`${item.kind}:${item.refId}`}
              className="rounded-sm border border-line px-1.5 py-0.5 ui-micro text-muted"
            >
              {item.label}
            </span>
          ))}
          {finding.action && (
            <button
              type="button"
              onClick={jump}
              disabled={finding.action.kind !== "open-task" && !infohubOn}
              title={
                finding.action.kind !== "open-task" && !infohubOn
                  ? "信息中枢模块已停用：到「插件区 → 模块」启用后可查看日程"
                  : undefined
              }
              className="ml-auto text-[11px] text-ink hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
            >
              {actionLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RunItem({ run }: { run: StaffRun }) {
  const [open, setOpen] = useState(run.findings.length > 0);
  return (
    <li className="rounded-xl border border-line bg-[var(--surface)] px-4 py-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted">{formatStaffTime(run.startedAt)}</span>
        <span className="rounded-sm border border-line px-1.5 py-0.5 ui-micro text-[var(--body)]">
          {triggerLabel(run.trigger)}
        </span>
        <span
          className={`rounded-sm border px-1.5 py-0.5 ui-micro ${
            run.mode === "fallback"
              ? "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]"
              : "border-line bg-panel text-muted"
          }`}
        >
          {modeLabel(run.mode)}
        </span>
        {run.tokens != null && (
          <span className="ui-micro text-muted">{run.tokens.toLocaleString("zh-CN")} tokens</span>
        )}
        {run.findings.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto text-[10px] text-muted hover:text-ink"
          >
            {open ? "收起" : `展开 ${run.findings.length} 条`}
          </button>
        )}
      </div>
      <p className="mt-1 break-words text-[12px] leading-5">{run.summary}</p>
      {run.error && <p className="mt-0.5 text-[10px] text-[var(--danger)]">模型总结失败：{run.error}</p>}
      {open && run.findings.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {run.findings.map((finding) => (
            <FindingRow key={finding.id} finding={finding} />
          ))}
        </div>
      )}
    </li>
  );
}

function SourceToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 rounded-lg border border-line-soft px-2.5 py-2">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-[12px] font-medium">{label}</span>
        <span className="block text-[10px] leading-4 text-muted">{hint}</span>
      </span>
    </label>
  );
}

export function StaffPage() {
  const settings = useStaffStore((s) => s.settings);
  const runs = useStaffStore((s) => s.runs);
  const updateSettings = useStaffStore((s) => s.updateSettings);
  const clearRuns = useStaffStore((s) => s.clearRuns);
  const profiles = useLlmStore((s) => s.profiles);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // 状态行里的「下次检查」需要跟着时间走；页面自身不轮询数据。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const autoToday = countAutoRunsToday(runs, now);
  const usedTokens = tokensToday(runs, now);

  async function runOnce(): Promise<void> {
    setError("");
    setNotice("");
    setRunning(true);
    try {
      const result = await runStaffNow("manual");
      if (!result.ok) {
        setError(result.reason === "busy" ? "上一份简报还在生成，请稍候。" : result.error ?? "简报生成失败");
        return;
      }
      setNotice(
        result.run.findings.length === 0
          ? "简报已生成：今天没有临期事项，也没有异常任务。"
          : `简报已生成：${result.run.findings.length} 条需要留意。`,
      );
    } finally {
      setRunning(false);
    }
  }

  async function toggleEnabled(next: boolean): Promise<void> {
    setError("");
    setNotice("");
    const updated = updateSettings({ enabled: next });
    if (!next) {
      setNotice("幕僚已关闭，不再巡检。历史简报保留在本机。");
      return;
    }
    setSettingsOpen(true);
    setRunning(true);
    setFirstRun(true);
    try {
      const result = await runStaffNow(isDailyDue(updated, Date.now()) ? "daily" : "manual");
      if (!result.ok) {
        if (result.reason === "busy") {
          setNotice("已有简报在生成；这一份会自动进历史。");
          return;
        }
        setError(result.error ?? "首份简报生成失败");
        return;
      }
      setNotice("幕僚已开启，首份简报已生成。");
    } finally {
      setRunning(false);
      setFirstRun(false);
    }
  }

  function patch(patchValue: StaffSettingsPatch): void {
    updateSettings(patchValue);
  }

  return (
    <PageShell
      title="幕僚"
      subtitle="每天替你检查日程和任务，有要紧事才提醒，不会替你做操作。"
      width="readable"
      // d.72：空态要垂直居中，滚动交给内层容器（PageShell 的滚动层不是 flex，flex-1 撑不开）
      scroll={false}
      actions={
        <>
          <button
            type="button"
            onClick={() => void runOnce()}
            disabled={running}
            className={BTN_PRIMARY}
          >
            {firstRun ? "正在生成第一份简报…" : running ? "正在生成…" : "现在跑一次"}
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
            className={BTN}
          >
            {settingsOpen ? "收起设置" : "设置"}
          </button>
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 max-[1199px]:px-4">
      <div className="mx-auto flex min-h-full w-full max-w-[960px] flex-col">
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-panel px-3 py-2">
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
            settings.enabled
              ? "border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]"
              : "border-line bg-panel text-muted"
          }`}
        >
          {settings.enabled ? "已开启" : "已关闭"}
        </span>
        <span className="ui-caption">
          模式：{settings.profileId ? "模型总结 + 规则兜底" : "规则（未绑定模型）"}
        </span>
        <span className="ui-caption">下次：{describeNextCheck(settings, now)}</span>
        <span className="ui-caption ml-auto">
          今日自动 {autoToday}/{settings.dailyRunCap} 次 · token {usedTokens.toLocaleString("zh-CN")}
          {settings.dailyTokenCap > 0 ? `/${settings.dailyTokenCap.toLocaleString("zh-CN")}` : "/不限"}
        </span>
      </div>

      {(error || notice) && (
        <div
          role={error ? "alert" : "status"}
          className={`ui-alert mb-4 justify-between ${error ? "ui-alert-danger" : "ui-alert-muted"}`}
        >
          <span className="min-w-0 break-words">{error || notice}</span>
          <button
            type="button"
            onClick={() => (error ? setError("") : setNotice(""))}
            className="shrink-0 hover:underline"
          >
            关闭
          </button>
        </div>
      )}

      <div className="flex flex-1 flex-col">
        {settingsOpen && (
          <section className={`${CARD} mb-4`} aria-label="幕僚设置">
            <div className="mb-2 flex items-center gap-2">
              <div className="text-[12px] font-bold text-muted">设置</div>
              <span className="text-[10px] text-muted">改动即时生效，仅作用于本机</span>
              <label className="ml-auto flex items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  disabled={running}
                  onChange={(e) => void toggleEnabled(e.target.checked)}
                />
                <span>常驻巡检</span>
              </label>
            </div>

            <div className="grid gap-2 md:grid-cols-3">
              <SourceToggle
                label="晨报"
                hint={`每天 ${settings.dailyAt}，没有发现也会留一份记录`}
                checked={settings.sources.daily}
                onChange={(next) => patch({ sources: { daily: next } })}
              />
              <SourceToggle
                label="日程临期"
                hint="逾期或 24 小时内到期；需信息中枢已连接"
                checked={settings.sources.agenda}
                onChange={(next) => patch({ sources: { agenda: next } })}
              />
              <SourceToggle
                label="任务异常"
                hint="卡住超过 10 分钟，或最近 24 小时内失败"
                checked={settings.sources.task}
                onChange={(next) => patch({ sources: { task: next } })}
              />
            </div>

            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <label className="flex items-center gap-2 text-[12px]">
                <span className="w-[76px] shrink-0 text-muted">晨报时间</span>
                <input
                  type="time"
                  value={settings.dailyAt}
                  onChange={(e) => patch({ dailyAt: e.target.value })}
                  className={INPUT}
                />
              </label>
              <label className="flex items-center gap-2 text-[12px]">
                <span className="w-[76px] shrink-0 text-muted">静默时段</span>
                <input
                  type="time"
                  value={settings.quietFrom}
                  onChange={(e) => patch({ quietFrom: e.target.value })}
                  className={INPUT}
                />
                <span className="text-muted">–</span>
                <input
                  type="time"
                  value={settings.quietTo}
                  onChange={(e) => patch({ quietTo: e.target.value })}
                  className={INPUT}
                />
              </label>
              <label className="flex items-center gap-2 text-[12px]">
                <span className="w-[76px] shrink-0 text-muted">每日次数</span>
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={settings.dailyRunCap}
                  onChange={(e) => patch({ dailyRunCap: Number(e.target.value) })}
                  className={`${INPUT} w-[80px]`}
                />
                <span className="text-[10px] text-muted">事件触发上限，手动与晨报不计入</span>
              </label>
              <label className="flex items-center gap-2 text-[12px]">
                <span className="w-[76px] shrink-0 text-muted">每日 token</span>
                <input
                  type="number"
                  min={0}
                  step={1000}
                  value={settings.dailyTokenCap}
                  onChange={(e) => patch({ dailyTokenCap: Number(e.target.value) })}
                  className={`${INPUT} w-[110px]`}
                />
                <span className="text-[10px] text-muted">0 = 不限</span>
              </label>
              <label className="flex items-center gap-2 text-[12px] md:col-span-2">
                <span className="w-[76px] shrink-0 text-muted">模型</span>
                <select
                  value={settings.profileId ?? ""}
                  onChange={(e) => patch({ profileId: e.target.value || null })}
                  className={`${INPUT} max-w-[320px] flex-1`}
                >
                  <option value="">不绑定（只用规则）</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label}（{profile.model}）
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <p className="mt-2 text-[10px] leading-5 text-muted">
              绑定模型后，每次简报只发送日程标题、到期描述、会话名与任务标题/错误摘要；
              不发送日程详情与消息正文。模型失败会自动回退规则并保留错误记录。
            </p>

            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                disabled={runs.length === 0}
                className={BTN}
              >
                清空历史简报
              </button>
            </div>
          </section>
        )}

        {runs.length === 0 ? (
          <div className="flex flex-1 items-center justify-center py-8">
          <div className="w-full max-w-[560px] ui-card">
            <EmptyState
              icon={<StaffIcon width={22} height={22} />}
              title="还没有简报"
              desc={`开启后，每天 ${settings.dailyAt} 前后给你一份；日程临期、任务卡住时也会单独提醒。`}
              actions={
                <button
                  type="button"
                  onClick={() => void toggleEnabled(true)}
                  disabled={running || settings.enabled}
                  className="ui-btn ui-btn-md ui-btn-primary"
                >
                  {settings.enabled ? "正在等待第一份简报" : running ? "正在生成…" : "开启幕僚"}
                </button>
              }
            />
          </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-4">
            {runs.map((run) => (
              <RunItem key={run.id} run={run} />
            ))}
          </ul>
        )}
      </div>
      </div>
      </div>

      {confirmClear && (
        <ConfirmDialog
          title="清空历史简报"
          onCancel={() => setConfirmClear(false)}
          footer={
            <>
              <button type="button" className={BTN} onClick={() => setConfirmClear(false)}>
                取消
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-md ui-btn-danger"
                onClick={() => {
                  clearRuns();
                  setConfirmClear(false);
                  setNotice("历史简报已清空；去重账本保留，避免同一件事重复提醒。");
                }}
              >
                清空
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            这会删除本机保存的全部简报记录。去重账本会保留，已提醒过的日程/任务不会因此再提醒一遍。
          </p>
        </ConfirmDialog>
      )}
    </PageShell>
  );
}
