import { useMemo, useState, type ComponentType, type SVGProps } from "react";
import { useUiStore } from "../../store/ui.js";
import {
  BUILTIN_MODULES,
  MODULE_BY_ID,
  moduleStorageBytes,
  type BuiltinModule,
  type ModuleId,
} from "../../lib/modules/registry.js";
import {
  effectiveModuleIds,
  missingRequirements,
  useModuleStore,
} from "../../lib/modules/store.js";
import { AutomationIcon, InfoHubIcon, RouteIcon, StaffIcon } from "../icons.js";
import { moduleCleanupPlan } from "../../lib/modules/lifecycle.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { BTN_GHOST, BTN_GHOST_SM, HINT, Switch } from "./shared.js";

/**
 * 插件区 · 模块 Tab（d.70）：把内置能力模块按插件卡片的样子摆出来。
 *
 * 每个卡片回答四个问题：**它是什么、带了什么、依赖谁、停用会怎样**。
 * 开关只写 `heming.modules.v1`；页面/导航的过滤在 NavRail、App、命令面板各自读同一份
 * store，因此这里不需要通知任何页面刷新——zustand 订阅已经覆盖。
 *
 * 为什么没有「安装/卸载」：这三个模块的代码随应用发布，卸载等于删功能代码；
 * 「停用」才是可逆、可解释的操作。第三方能力（技能/远程 MCP/命令）仍走「插件」Tab。
 */

const MODULE_ICONS: Record<ModuleId, ComponentType<SVGProps<SVGSVGElement>>> = {
  staff: StaffIcon,
  infohub: InfoHubIcon,
  automations: AutomationIcon,
  modelroute: RouteIcon,
};

/** 字节 → 便于扫读的「约 x KB / x MB」（0 显示「无数据」）。 */
function fmtBytes(bytes: number): string {
  if (bytes <= 0) return "无数据";
  if (bytes < 1024) return `约 ${bytes} B`;
  if (bytes < 1024 * 1024) return `约 ${(bytes / 1024).toFixed(1)} KB`;
  return `约 ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ModuleCard({ mod }: { mod: BuiltinModule }) {
  const enabledMap = useModuleStore((s) => s.enabled);
  const setEnabled = useModuleStore((s) => s.setEnabled);
  const enabled = enabledMap[mod.id];
  const missing = missingRequirements({ enabled: enabledMap }, mod.id);
  const effective = enabled && missing.length === 0;
  const setPage = useUiStore((s) => s.setPage);
  const Icon = MODULE_ICONS[mod.id];
  const cleanup = moduleCleanupPlan(mod.id);
  const [confirmingCleanup, setConfirmingCleanup] = useState(false);
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  /** tick 只用来在清理后重算占用（localStorage 不是响应式数据）。 */
  const refreshOccupancy = () => setTick((n) => n + 1);
  const occupancy = useMemo(() => moduleStorageBytes(mod), [mod, tick]);

  const contributions: string[] = [];
  if (mod.contributions.page) contributions.push("导航入口 + 页面");
  if (mod.contributions.homeCard) contributions.push("首页卡片");
  if (mod.contributions.backgroundLoop === "staff-loop") contributions.push("后台巡检（每 60 秒）");
  if (mod.contributions.backgroundLoop === "automation-scheduler")
    contributions.push("后台调度（每 15 秒）");
  if (mod.contributions.toolPrefixes?.length)
    contributions.push(`模型工具：${mod.contributions.toolPrefixes.join("、")}*`);

  return (
    <section
      role="region"
      aria-label={`模块 ${mod.name}`}
      className="rounded-xl border border-line bg-white p-4 shadow-card"
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line-soft bg-[#fafafa] text-ink">
          <Icon width={18} height={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="ui-section-title">{mod.name}</span>
            <span className="rounded-sm border border-line px-1 text-[10px] text-muted">内置</span>
            <span className="ui-micro text-muted">{mod.version}</span>
            {!effective && (
              <span className="rounded-sm bg-[#f3f0e6] px-1.5 py-0.5 text-[10px] text-[#8a6d1f]">
                {enabled ? "依赖未启用" : "已停用"}
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] leading-6 text-muted">{mod.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="ui-caption">{enabled ? "已启用" : "已停用"}</span>
          <Switch
            label={`${enabled ? "停用" : "启用"}模块 ${mod.name}`}
            checked={enabled}
            onChange={(next) => setEnabled(mod.id, next)}
          />
        </div>
      </div>

      <dl className="mt-3 grid gap-1.5 text-[11px] leading-5 sm:grid-cols-2">
        <div>
          <dt className="font-semibold text-muted">贡献</dt>
          <dd className="text-[#444]">{contributions.join(" · ") || "—"}</dd>
        </div>
        <div>
          <dt className="font-semibold text-muted">本机数据（停用不删除）</dt>
          <dd className="text-[#444]">
            {mod.storageKeys.length > 0
              ? `本机数据 ${mod.storageKeys.length} 项 · ${fmtBytes(occupancy)}`
              : "不占和鸣本机存储"}
            {mod.externalData?.length ? (
              <span className="block text-[10px] text-muted">{mod.externalData.join("；")}</span>
            ) : null}
          </dd>
        </div>
        {mod.requires?.length ? (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-muted">依赖</dt>
            <dd className={missing.length ? "text-[#8a5a00]" : "text-[#444]"}>
              需要「
              {mod.requires.map((id) => MODULE_BY_ID[id]?.name ?? id).join("、")}
              」启用
              {missing.length
                ? `（当前未满足：${missing.map((id) => MODULE_BY_ID[id]?.name ?? id).join("、")}）`
                : ""}
            </dd>
          </div>
        ) : null}
      </dl>

      <p className={`mt-2 ${HINT}`}>{mod.disableNote}</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!effective}
          onClick={() => setPage(mod.page)}
          className={BTN_GHOST + " disabled:cursor-not-allowed disabled:opacity-40"}
        >
          打开页面
        </button>
        <span className="ui-caption">
          {effective ? "状态：已生效" : enabled ? "依赖项启用后自动恢复" : "随时可重新启用"}
        </span>
        {cleanup ? (
          <button
            type="button"
            onClick={() => {
              setCleanupNotice(null);
              setConfirmingCleanup(true);
            }}
            className={`${BTN_GHOST_SM} ml-auto text-[#b42318]`}
          >
            清理本机数据
          </button>
        ) : null}
        {cleanupNotice ? (
          <span role="status" className="ui-caption text-[#8a5a00]">
            {cleanupNotice}
          </span>
        ) : null}
      </div>

      {cleanup && confirmingCleanup ? (
        <ConfirmDialog
          title={cleanup.title}
          onCancel={() => setConfirmingCleanup(false)}
          footer={
            <>
              <button
                type="button"
                className={BTN_GHOST}
                onClick={() => setConfirmingCleanup(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-md ui-btn-primary"
                onClick={() => {
                  const error = cleanup.run();
                  setCleanupNotice(error ?? "已清理本机数据");
                  setConfirmingCleanup(false);
                  refreshOccupancy();
                }}
              >
                清理
              </button>
            </>
          }
        >
          <p className="text-[13px] leading-6">{cleanup.description}</p>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-[12px] leading-5 text-muted">
            {cleanup.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-[#8a5a00]">清理不可恢复，请确认后再执行。</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

export function ModulesView({ modules = BUILTIN_MODULES }: { modules?: readonly BuiltinModule[] } = {}) {
  const reset = useModuleStore((s) => s.reset);
  const enabledMap = useModuleStore((s) => s.enabled);
  const enabledCount = effectiveModuleIds({ enabled: enabledMap }).length;
  const allEnabled = enabledCount === modules.length;
  /** 点「全部恢复启用」后给一次可见反馈（此前点了没有任何变化提示）。 */
  const [restoredNotice, setRestoredNotice] = useState("");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="max-w-[560px]">
          <p className={HINT}>
            内置模块（幕僚 / 信息中枢 / 自动化）可随时启用或停用。停用只是收起入口和后台任务，不会删数据；
            第三方能力（技能 / 远程 MCP / 命令）仍走「插件」Tab。
          </p>
          <p className="mt-1 ui-caption" role="status">
            已启用 {enabledCount}/{modules.length} 个模块
            {restoredNotice ? ` · ${restoredNotice}` : ""}
          </p>
        </div>
        <button
          type="button"
          className={BTN_GHOST}
          // 全启用时点它没有任何作用：禁用并说明，而不是留一个点了没反应的按钮
          disabled={allEnabled}
          title={allEnabled ? "全部模块都已启用" : "把停用的模块全部恢复启用（不删数据）"}
          onClick={() => {
            reset();
            setRestoredNotice("已全部恢复启用");
          }}
        >
          全部恢复启用
        </button>
      </div>
      {modules.map((mod) => (
        <ModuleCard key={mod.id} mod={mod} />
      ))}
    </div>
  );
}
