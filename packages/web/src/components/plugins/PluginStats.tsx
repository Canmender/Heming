import type { CapabilityStats } from "./viewModel.js";
import { Stat } from "../ui/Stat.js";

/**
 * 头部能力概览（d.64 · T2；2026-11 审计 F5 重排）。
 *
 * 数值全部来自真实数据源（插件存储、技能池、能力目录、MCP 注册表），
 * 组件只负责展示，不在这里重新计数——口径统一由 `viewModel.describeCapabilityStats` 负责。
 *
 * 版式约定：标题与说明同一行，四个数字格各两行（数值+标签 / 构成），可访问名仍是「统计 <标签>」；
 * 概览标题只是 h2，页面级 h1 仍由 PageShell 独占。
 *
 * 审计 F5 记录：原版是「44px 图标砖 + 14px 标题 + 徽标 + 两行说明 + 四张 66px 统计卡」，
 * 在 tablist 之前吃掉约 300px 首屏，插件列表要滚动才看得见第一行；
 * 且标题 14px 与卡片标题同大、四个装饰图标对「有多少能力」这件事没有信息贡献。
 * 现在压成「标题一句话 + 一行四格」，首屏还给列表。
 */
const CARDS: {
  key: string;
  label: string;
  hint: (stats: CapabilityStats) => string;
  value: (stats: CapabilityStats) => string;
}[] = [
  {
    key: "plugins",
    label: "插件",
    // d.77：系统插件恒为 1，装多少插件都不影响它。原先显示「1 + 0」看不出谁是系统、
    // 谁是已装；现在总数给一个可比较的值，构成写在下方的说明行里。
    hint: (stats) => `系统 ${stats.system} · 已装 ${stats.plugins}`,
    value: (stats) => String(stats.system + stats.plugins),
  },
  {
    key: "skills",
    label: "技能",
    hint: () => "全部可用技能",
    value: (stats) => String(stats.skills),
  },
  {
    key: "tools",
    label: "工具",
    hint: () => "目录内可调用工具",
    value: (stats) => String(stats.tools),
  },
  {
    key: "mcpServers",
    label: "MCP 服务",
    hint: () => "已登记的服务",
    value: (stats) => String(stats.mcpServers),
  },
];

export function PluginStats({ stats }: { stats: CapabilityStats }) {
  return (
    <section aria-label="能力统计" className="mb-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 className="ui-block-title">能力中枢</h2>
        <p className="ui-caption">
          装一个插件，就能同时带入它的技能、工具与命令；能力只在本机生效。
        </p>
      </div>

      <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {CARDS.map((card) => (
          <li key={card.key} aria-label={`统计 ${card.label}`} className="min-w-0">
            <Stat
              label={card.label}
              value={card.value(stats)}
              hint={card.hint(stats)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}