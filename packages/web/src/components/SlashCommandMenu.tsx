import type { SlashCommand } from "../lib/agentRuntime/slashCommands.js";

/**
 * 输入框上方的命令面板（d.184）。
 *
 * 只负责「显示 + 点选」；键盘（↑↓ / Enter / Esc）由输入框统一处理，
 * 否则两处各拦一次 keydown，会出现「面板选了 A、输入框又提交了 B」。
 */
export function SlashCommandMenu({
  items,
  activeIndex,
  onPick,
}: {
  items: readonly SlashCommand[];
  activeIndex: number;
  onPick: (command: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="px-chat-gutter pb-1">
      <ul
        role="listbox"
        aria-label="可用命令"
        className="overflow-hidden rounded-md border border-line bg-surface shadow-sm"
      >
        {items.map((item, index) => {
          const active = index === Math.min(activeIndex, items.length - 1);
          return (
            <li
              key={item.command}
              role="option"
              aria-selected={active}
              className={`flex cursor-pointer items-baseline gap-2 px-2 py-1.5 ${active ? "bg-subtle-2" : ""}`}
              // onMouseDown 而不是 onClick：click 之前输入框会先失焦，某些浏览器会先提交表单。
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(item.command);
              }}
            >
              <code className="shrink-0 font-mono text-ui-md text-ink">{item.command}</code>
              <span className="min-w-0 flex-1 truncate text-ui-md text-ink">{item.title}</span>
              <span className="hidden shrink-0 text-ui-md text-muted sm:inline">{item.hint}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
