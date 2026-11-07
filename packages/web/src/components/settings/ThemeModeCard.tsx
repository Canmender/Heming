import { useEffect, useState } from "react";
import { useThemeStore } from "../../store/theme.js";
import {
  getThemeMode,
  setThemeMode,
  watchThemeMode,
  type ThemeMode,
} from "../../lib/theme.js";

/**
 * 主题模式卡（d.67 T3 暗色）：浅色 / 深色 / 跟随系统 三选一。
 *
 * 与「页面颜色」卡的分工：那张卡管**填充强调色**（accent），这张卡管**整页明暗**
 * （data-theme 下的一整套 CSS 变量）。两者互不影响，可以任意组合。
 *
 * 为什么模式状态放本地 state 而不是 zustand：它是纯 UI 选择，唯一消费者就是本卡；
 * 真正的落盘与 DOM 应用都在 lib/theme.ts（启动时 main/pet 也调同一套函数，避免漂移）。
 */

const MODES: { id: ThemeMode; label: string; hint: string }[] = [
  { id: "system", label: "跟随系统", hint: "系统切深浅色时自动跟随" },
  { id: "light", label: "浅色", hint: "始终使用浅色界面" },
  { id: "dark", label: "深色", hint: "始终使用深色界面" },
];

export function ThemeModeCard() {
  const accent = useThemeStore((t) => t.accent);
  const [mode, setMode] = useState<ThemeMode>(() => getThemeMode());

  // 主题色变化时重算一次：暗色下「默认墨黑→浅色强调」的替换依赖当前 accent。
  useEffect(() => {
    watchThemeMode({ accent });
  }, [accent]);

  const choose = (next: ThemeMode) => {
    if (next === mode) return;
    setMode(next);
    setThemeMode(next);
    // 立即应用（含 system 监听器的摘旧挂新），无需刷新页面。
    watchThemeMode({ accent });
  };

  // 单选组键盘语义：←/↑ 上一个，→/↓ 下一个（与原生 radiogroup 一致）。
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = MODES.findIndex((m) => m.id === mode);
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % MODES.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = (index - 1 + MODES.length) % MODES.length;
    else return;
    event.preventDefault();
    choose(MODES[next].id);
  };

  return (
    <section
      aria-label="主题模式"
      className="max-w-full rounded-xl border border-line bg-surface p-4 shadow-card"
    >
      <div className="flex items-center gap-2">
        <span className="ui-section-title">主题模式</span>
        <span className="ui-caption">即时生效，仅本机保存</span>
      </div>
      <div className="mt-1 ui-caption">
        深色只改配色，不改变任何功能与文案；与同一页的「主题色」可自由组合。
      </div>
      <div
        role="radiogroup"
        aria-label="主题模式"
        className="mt-2 grid gap-2 sm:grid-cols-3"
        onKeyDown={onKeyDown}
      >
        {MODES.map((item) => {
          const checked = mode === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={`主题模式 ${item.label}`}
              tabIndex={checked ? 0 : -1}
              onClick={() => choose(item.id)}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                checked
                  ? "border-ink bg-subtle-2"
                  : "border-line bg-surface hover:bg-subtle"
              }`}
            >
              <span className="block ui-body-sm">{item.label}</span>
              <span className="mt-0.5 block ui-caption">{item.hint}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
