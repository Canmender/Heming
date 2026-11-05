import type { Page } from "../../store/ui.js";

/**
 * 命令面板 · 页面跳转目录（d.67 合并后的 9 个宿主页）。
 *
 * 为什么单独放一份而不是从 NavRail 里 import：NavRail 的 ITEMS 里带 JSX 图标，
 * 且没有导出；命令面板需要的是「名字 + 一句描述 + Alt 快捷键」这类纯数据。
 * 代价是两处可能漂移，所以用一个测试把「9 项、页面集合与 store 的 DEFAULT_NAV_ORDER 一致、
 * 快捷键与 App 的映射一致」钉住（见 lib/palette/palette.test.ts）。
 *
 * 快捷键口径与 `App.tsx` 的 `SHORTCUT_PAGES`、`NavRail` 的 `digit` 保持一致：
 * 1 主页 / 2 团队 / 5 记忆区 / 6 设置区 / 8 智能体 / 0 插件区。
 * 没有数字键的页面（幕僚 / 信息中枢 / 自动化）是后加的，不占键位；
 * 原 3 技能区 / 4 接口区随合并取消，两个键位空着不用。
 */
export interface PalettePage {
  page: Page;
  /** 导航轨上的显示名（与 NavRail 一致）。 */
  label: string;
  /** 一句话说清这页能干什么，供检索与副标题用。 */
  description: string;
  /** Alt+数字 快捷键；没有则不显示。 */
  digit?: string;
}

export const PALETTE_PAGES: PalettePage[] = [
  { page: "home", label: "主页", description: "统计、最近动向与今日概览", digit: "1" },
  { page: "chat", label: "智能体", description: "与智能体对话，或新建/运行一个任务", digit: "8" },
  { page: "team", label: "团队", description: "成员名册、动向流与团队看板", digit: "2" },
  { page: "staff", label: "幕僚", description: "常驻简报：日程与任务摘要" },
  { page: "infohub", label: "信息中枢", description: "本机 QQ / 微信归档检索与日程" },
  { page: "automations", label: "自动化", description: "本机定时同步与重扫日程" },
  {
    page: "plugins",
    label: "插件区",
    description: "能力中心：插件包、技能池、工具与 MCP 服务",
    digit: "0",
  },
  { page: "memory", label: "记忆区", description: "三层记忆与本机数据", digit: "5" },
  {
    page: "settings",
    label: "设置区",
    description: "个人资料、模型、外观、导航与关于",
    digit: "6",
  },
];

/** 按 page 查目录项；找不到返回 undefined（旧链接/坏数据时安全跳过）。 */
export function findPalettePage(page: string): PalettePage | undefined {
  return PALETTE_PAGES.find((p) => p.page === page);
}

/** 快捷键展示文案（供面板右侧与 aria 描述复用）。 */
export function shortcutLabel(digit?: string): string | null {
  return digit ? `Alt+${digit}` : null;
}
