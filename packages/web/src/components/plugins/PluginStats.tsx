import type { ComponentType, SVGProps } from "react";
import { PackageIcon, RouteIcon, SkillsIcon, SparkIcon, TaskIcon } from "../icons.js";
import type { CapabilityStats } from "./viewModel.js";

/**
 * 头部能力概览（d.64 · T2；2026-11 UI/UX 轮改为能力中枢 hero）。
 *
 * 数值全部来自真实数据源（插件存储、技能池、能力目录、MCP 注册表），
 * 组件只负责展示，不在这里重新计数——口径统一由 `viewModel.describeCapabilityStats` 负责。
 *
 * 版式约定：每个统计格先数值、再标签、最后说明，可访问名仍是「统计 <标签>」；
 * 概览标题只是 h2，页面级 h1 仍由 PageShell 独占。
 */
const CARDS: {
  key: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  hint: (stats: CapabilityStats) => string;
  value: (stats: CapabilityStats) => string;
}[] = [
  {
    key: "plugins",
    label: "插件",
    icon: PackageIcon,
    // d.77：系统插件恒为 1，装多少插件都不影响它。原先显示「1 + 0」看不出谁是系统、
    // 谁是已装；现在总数给一个可比较的值，构成写在下方的说明行里。
    hint: (stats) => `系统 ${stats.system} · 已装 ${stats.plugins}`,
    value: (stats) => String(stats.system + stats.plugins),
  },
  {
    key: "skills",
    label: "技能",
    icon: SkillsIcon,
    hint: () => "全部可用技能",
    value: (stats) => String(stats.skills),
  },
  {
    key: "tools",
    label: "工具",
    icon: TaskIcon,
    hint: () => "目录内可调用工具",
    value: (stats) => String(stats.tools),
  },
  {
    key: "mcpServers",
    label: "MCP 服务",
    icon: RouteIcon,
    hint: () => "已登记的服务",
    value: (stats) => String(stats.mcpServers),
  },
];

export function PluginStats({ stats }: { stats: CapabilityStats }) {
  return (
    <section aria-label="能力统计" className="plugin-hero plugin-rise mb-4">
      <div className="relative z-10 flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="plugin-icon-tile h-11 w-11" aria-hidden="true">
            <SparkIcon width={20} height={20} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[14px] font-bold leading-5 text-ink">能力中枢</h2>
              <span className="ui-micro rounded-full border border-line-soft bg-[var(--subtle-2)] px-2 py-0.5">
                本机管理
              </span>
            </div>
            <p className="mt-0.5 ui-caption">
              系统 {stats.system} · 已装插件 {stats.plugins} · {stats.skills} 个技能 ·{" "}
              {stats.tools} 个工具 · {stats.mcpServers} 台 MCP 服务
            </p>
          </div>
          <span className="ml-auto hidden items-center gap-1.5 ui-micro sm:inline-flex">
            <span className="plugin-dot" aria-hidden="true" />
            能力只在本机生效
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.key}
                aria-label={`统计 ${card.label}`}
                className="flex items-start gap-2.5 rounded-xl border border-line-soft bg-[var(--surface)] px-3 py-2.5 transition-colors hover:border-line"
              >
                <span className="mt-0.5 text-muted" aria-hidden="true">
                  <Icon width={14} height={14} />
                </span>
                <div className="min-w-0">
                  <div className="text-[20px] font-semibold leading-6 ui-numeric">
                    {card.value(stats)}
                  </div>
                  <div className="ui-caption">{card.label}</div>
                  <div className="ui-micro">{card.hint(stats)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
