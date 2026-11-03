import type { CapabilityStats } from "./viewModel.js";

/**
 * 头部四个统计卡（d.64 · T2）：已装插件 / 技能 / 工具 / MCP 服务。
 *
 * 数值全部来自真实数据源（插件存储、技能池、能力目录、MCP 注册表），
 * 组件只负责展示，不在这里重新计数——口径统一由 `viewModel.describeCapabilityStats` 负责。
 */
const CARDS: { key: keyof CapabilityStats; label: string; hint: string }[] = [
  { key: "plugins", label: "已装插件", hint: "本机安装的能力包" },
  { key: "skills", label: "技能", hint: "全部可用技能" },
  { key: "tools", label: "工具", hint: "目录内可调用工具" },
  { key: "mcpServers", label: "MCP 服务", hint: "已登记的服务" },
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
          <div className="mt-1 text-[18px] font-semibold leading-6 ui-numeric">{stats[card.key]}</div>
          <div className="ui-micro">{card.hint}</div>
        </div>
      ))}
    </section>
  );
}
