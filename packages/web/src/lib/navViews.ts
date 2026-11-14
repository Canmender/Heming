import type { Page } from "../store/ui.js";

/**
 * 导航项的第二层视图目录（2026-11-14 审计 §4-F1）。
 *
 * ★ 为什么需要这张表：全站有 20 个视图，导航轨只有 8 个入口。团队有 5 个页签、
 *   模型 4 个、插件 3 个、设置 5 个、记忆 3 个，但它们只写在各页自己的 Tab 条上——
 *   用户必须先「进去」才知道里面还有什么，导航轨本身不给任何信号。
 *   这张表把「哪个页有哪些视图」变成导航轨可读的数据，供飞出菜单渲染与 aria 描述。
 *
 * ★ 只登记**真实存在**的页签：表里的 key 必须与该页 tabs 常量逐字一致
 *   （团队 `TEAM_TABS` / 模型 `ModelPage.TABS` / 插件 `PLUGINS_TABS` /
 *   设置 `SETTINGS_TABS` / 记忆 `MEMORY_TABS`），否则飞出菜单点下去会被宿主页的
 *   白名单挡掉（各宿主页都会先校验 key 再 setTab）。
 *   那些常量是组件内的私有值，这里无法直接 import（会把整页依赖拽进导航轨），
 *   所以是"手抄一份"的已知漂移点：改页签时两处一起改。
 *
 * ★ 没有二级视图的页不硬造：
 *   - home / chat：单视图页；
 *   - vault（知识库）：图谱是右侧面板的开关（`graphOpen`），不是视图层；
 *     目录 / 页面是同一视图里的左右栏，不是可切换的页签。
 *
 * 类型用 `Partial<Record<Page, …>>` 而不是 `Record<Page, …>`：`Page` 里还有
 * 插件页 id（`plugin:<id>`）与旧模块页字符串，它们没有页内 Tab，全量 Record
 * 会逼着每个页都填一份空数组。
 */
export interface NavView {
  /** 页内 Tab 的 key（与宿主页 tabs 常量一致）。 */
  key: string;
  /** 菜单里显示的名字（与宿主页 Tab 文案一致）。 */
  label: string;
}

export const NAV_VIEWS: Partial<Record<Page, readonly NavView[]>> = {
  team: [
    { key: "workspace", label: "工作台" },
    { key: "feed", label: "动向" },
    { key: "board", label: "看板" },
    { key: "agenda", label: "团队日程" },
    { key: "usage", label: "用量" },
  ],
  model: [
    { key: "models", label: "模型" },
    { key: "agents", label: "智能体" },
    { key: "sources", label: "来源" },
    { key: "run", label: "运行" },
  ],
  plugins: [
    { key: "plugins", label: "插件" },
    { key: "skills", label: "技能" },
    { key: "mcp", label: "MCP" },
  ],
  settings: [
    { key: "profile", label: "个人资料" },
    { key: "model", label: "高级" },
    { key: "appearance", label: "外观" },
    { key: "navigation", label: "导航" },
    { key: "about", label: "关于" },
  ],
  memory: [
    { key: "agents", label: "智能体" },
    { key: "database", label: "数据库" },
    { key: "wiki", label: "个人知识库" },
  ],
};

/** 空视图表（避免每次调用都新建数组，也避免调用方拿到 undefined 再判空）。 */
const NO_VIEWS: readonly NavView[] = [];

/** 取某页的二级视图；没有则返回空数组（导航轨据此决定要不要挂飞出菜单）。 */
export function navViewsOf(page: Page): readonly NavView[] {
  return NAV_VIEWS[page] ?? NO_VIEWS;
}

/** 飞出菜单项的可访问名：「页 · 视图」，与命令面板的「模型 › 运行」同一种说法。 */
export function navViewName(pageLabel: string, view: NavView): string {
  return `${pageLabel} · ${view.label}`;
}