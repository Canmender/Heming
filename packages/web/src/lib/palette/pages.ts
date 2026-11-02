import type { Page } from "../../store/ui.js";

/**
 * 命令面板 · 页面跳转目录（13 个导航页）。
 *
 * 为什么单独放一份而不是从 NavRail 里 import：NavRail 的 ITEMS 里带 JSX 图标，
 * 且没有导出；命令面板需要的是「名字 + 一句描述 + Alt 快捷键」这类纯数据。
 * 代价是两处可能漂移，所以用一个测试把「13 项、页面集合与 store 的 DEFAULT_NAV_ORDER 一致、
 * 快捷键与 App 的映射一致」钉住（见 lib/palette/pages.test.ts）。
 *
 * 快捷键口径与 `App.tsx` 的 `SHORTCUT_PAGES`、`NavRail` 的 `digit` 保持一致：
 * 1 主页 / 2 团队看板 / 3 技能区 / 4 接口区 / 5 记忆区 / 6 设置区 / 8 通用智能体 / 0 插件区。
 * 没有数字键的页面（团队 / 智能体 / 幕僚 / 信息中枢 / 自动化）是后加的，不占键位。
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
  { page: "team", label: "团队", description: "成员名册与团队动向" },
  { page: "chat", label: "智能体", description: "与智能体对话，或新建一个智能体" },
  { page: "staff", label: "幕僚", description: "常驻简报：日程与任务摘要" },
  { page: "infohub", label: "信息中枢", description: "本机 QQ / 微信归档检索与日程" },
  { page: "automations", label: "自动化", description: "本机定时同步与重扫日程" },
  { page: "workspace", label: "团队看板", description: "成员任务与日程两列看板", digit: "2" },
  { page: "tasks", label: "通用智能体", description: "直接填写目标即可运行", digit: "8" },
  { page: "skills", label: "技能区", description: "技能池与技能分配", digit: "3" },
  { page: "plugins", label: "插件区", description: "声明式能力包的安装、启停与卸载", digit: "0" },
  {
    page: "interfaces",
    label: "接口区",
    description: "模型连接、MCP 服务与工具授权",
    digit: "4",
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
