import { describeNextCheck, formatStaffTime, severityLabel, triggerLabel } from "../lib/staff/model.js";
import { useStaffStore } from "../lib/staff/store.js";
import { useUiStore } from "@heming/sdk";

/**
 * 首页「幕僚」卡（d.48）：只露出最近一份简报与入口。
 *
 * 不在这里跑简报、也不展开全部历史——真正的开关与设置都在幕僚页。
 * 浏览器端照常渲染（任务路可用；日程路需要信息中枢已连接）。
 */

const CARD = "ui-card p-3";
const LINK = "ui-link";

export function StaffHomeCard() {
  const settings = useStaffStore((s) => s.settings);
  const runs = useStaffStore((s) => s.runs);
  const setPage = useUiStore((s) => s.setPage);
  const latest = runs[0];
  const now = Date.now();

  return (
    <section className={CARD} aria-label="幕僚">
      <div className="mb-1.5 flex items-center gap-2">
        <div className="text-[12px] font-bold text-muted">幕僚</div>
        <span className="rounded-sm border border-line px-1.5 text-[10px] text-muted">
          {settings.enabled ? "常驻" : "未开启"}
        </span>
        <button type="button" className={`${LINK} ml-auto`} onClick={() => setPage("staff")}>
          {/* 这里只是跳页，不会真的开启：文案必须说「去开启」，否则点完以为已开 */}
          {settings.enabled ? "查看全部" : "去开启"}
        </button>
      </div>

      {!settings.enabled ? (
        <p className="text-[11px] leading-relaxed text-muted">
          每天检查日程和任务，有要紧事才提醒。
        </p>
      ) : !latest ? (
        <p className="text-[11px] leading-relaxed text-muted">
          还没有简报。{describeNextCheck(settings, now)}。
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
            <span>{formatStaffTime(latest.startedAt)}</span>
            <span>· {triggerLabel(latest.trigger)}</span>
            {latest.mode === "fallback" && <span className="text-[var(--danger)]">· 已回退规则</span>}
          </div>
          <p className="mt-1 break-words text-[12px] leading-5">{latest.summary}</p>
          {latest.findings.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-1">
              {latest.findings.slice(0, 3).map((finding) => (
                <button
                  key={finding.id}
                  type="button"
                  onClick={() => setPage("staff")}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[11px] hover:bg-[var(--subtle-2)]"
                >
                  <span
                    className={`shrink-0 rounded-full border px-1.5 text-[9px] ${
                      finding.severity === "urgent"
                        ? "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]"
                        : "border-line bg-panel text-muted"
                    }`}
                  >
                    {severityLabel(finding.severity)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{finding.title}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
