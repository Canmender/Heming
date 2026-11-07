import type { CapabilityStats } from "./viewModel.js";

/**
 * 头部四个统计卡（d.64 · T2）：已装插件 / 技能 / 工具 / MCP 服务。
 *
 * 数值全部来自真实数据源（插件存储、技能池、能力目录、MCP 注册表），
 * 组件只负责展示，不在这里重新计数——口径统一由 `viewModel.describeCapabilityStats` 负责。
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
  { key: "skills", label: "技能", hint: () => "全部可用技能", value: (stats) => String(stats.skills) },
  { key: "tools", label: "工具", hint: () => "目录内可调用工具", value: (stats) => String(stats.tools) },
  {
    key: "mcpServers",
    label: "MCP 服务",
    hint: () => "已登记的服务",
    value: (stats) => String(stats.mcpServers),
  },
];

export function PluginStats({ stats }: { stats: CapabilityStats }) {
  return (
    <section aria-label="能力统计" className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
      {CARDS.map((card) => (
        <div
          key={card.key}
          className="rounded-xl border border-line bg-white p-4 shadow-card"
          aria-label={`统计 ${card.label}`}
        >
          <div className="ui-caption">{card.label}</div>
          <div className="mt-1 text-[18px] font-semibold leading-6 ui-numeric">
            {card.value(stats)}
          </div>
          <div className="ui-micro">{card.hint(stats)}</div>
        </div>
      ))}
    </section>
  );
}
