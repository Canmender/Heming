/**
 * 命令面板 · 设置分区目录（5 个）。
 *
 * `tab` 必须与 `SettingsPage` 的分区 id 一致（profile / model / appearance /
 * navigation / about）——命令面板通过 `useUiStore.openSettings(tab)` 直达，
 * 对不上就会落到默认的「个人资料」。`settings.test.ts` 会钉住这 5 个 id 与顺序。
 */
export interface PaletteSettingSection {
  /** 与 SettingsPage 的分区 id 一致。 */
  tab: string;
  /** 分区显示名。 */
  label: string;
  /** 一句话说明这个分区里有什么。 */
  description: string;
  /** 供检索的额外关键词（例如「主题色」能搜到外观）。 */
  keywords: string[];
}

export const PALETTE_SETTINGS: PaletteSettingSection[] = [
  {
    tab: "profile",
    label: "个人资料",
    description: "头像、昵称与账号信息",
    keywords: ["头像", "昵称", "账号", "用户名"],
  },
  {
    tab: "model",
    label: "模型",
    description: "模型连接、API Key 与工具调用确认",
    keywords: ["模型", "连接", "key", "api", "工具确认", "hitl"],
  },
  {
    tab: "appearance",
    label: "外观",
    description: "主题色、字号与界面观感",
    keywords: ["主题", "主题色", "颜色", "字号", "深浅"],
  },
  {
    tab: "navigation",
    label: "导航",
    description: "导航顺序与显示项",
    keywords: ["导航顺序", "排序", "显示", "侧栏"],
  },
  {
    tab: "about",
    label: "关于",
    description: "版本号、更新日志与开源许可",
    keywords: ["版本", "更新日志", "changelog", "许可", "license"],
  },
];

export function findPaletteSetting(tab: string): PaletteSettingSection | undefined {
  return PALETTE_SETTINGS.find((s) => s.tab === tab);
}
