/**
 * 设置页「卡片级」元数据（UX-E · V2）。
 *
 * 为什么需要它：设置区有 5 个分组、十几张卡，靠翻找不到。搜索要能跨分组命中
 * **卡片**（不是分组）：这里登记每张卡的 id / 标题 / 关键词 / 所属分区，
 * 设置页渲染时给卡片根节点挂 `data-settings-id`，搜索命中后据此切分组 + 滚动 + 高亮。
 *
 * 新增一张卡 = 在 `SETTINGS_CARDS` 加一行 + 卡片外层加 `data-settings-id`；
 * `registry.test.ts` 有源码守卫：两边 id 集合必须完全一致（不多不少，防死项）。
 */

export type SettingsSectionId = "profile" | "model" | "appearance" | "navigation" | "about";

/** 分区显示名：与 SettingsPage 的标签文字保持一致（搜索也匹配分区名）。 */
export const SETTINGS_SECTION_LABELS: Record<SettingsSectionId, string> = {
  profile: "个人资料",
  model: "模型",
  appearance: "外观",
  navigation: "导航",
  about: "关于",
};

export interface SettingsCardMeta {
  /** 与 `data-settings-id` 一一对应；只做稳定标识，不改文案。 */
  id: string;
  /** 卡片标题（结果面板显示「标题 · 分区」）。 */
  title: string;
  /** 同义词/旧叫法/英文词：用户可能记得的另一种说法都放这里。 */
  keywords: string[];
  /** 所属分组。 */
  section: SettingsSectionId;
}

/**
 * 全量卡片（顺序 = 设置页里的渲染顺序，结果也按这个顺序展示）。
 * 只加元数据，不搬任何设置项逻辑。
 */
export const SETTINGS_CARDS: readonly SettingsCardMeta[] = [
  {
    id: "profile",
    title: "个人资料",
    keywords: ["头像", "昵称", "名字", "账号", "上传头像", "恢复默认头像", "保存"],
    section: "profile",
  },
  {
    id: "llm-connection",
    title: "LLM 连接",
    keywords: ["模型", "连接", "api", "key", "密钥", "provider", "baseurl", "地址", "绑定", "供应商"],
    section: "model",
  },
  {
    id: "route-groups",
    title: "候选链",
    keywords: ["路由", "路由组", "候选", "failover", "备用", "切换", "用量", "参考价", "休息中"],
    section: "model",
  },
  {
    id: "key-storage",
    title: "密钥存储",
    keywords: ["安全存储", "密钥", "key", "加密", "safestorage", "本机"],
    section: "model",
  },
  {
    id: "context-budget",
    title: "上下文预算",
    keywords: ["上下文", "token", "预算", "压缩", "历史", "切分", "溢出", "精简"],
    section: "model",
  },
  {
    id: "hitl-policy",
    title: "工具调用确认",
    keywords: ["hitl", "确认", "免问", "审批", "拒绝", "规则", "危险", "工具", "放行", "档位"],
    section: "model",
  },
  {
    id: "file-edit",
    title: "文件编辑",
    keywords: ["文件", "可写根", "写入", "只读", "路径", "file_patch", "补丁", "越界", "授权"],
    section: "model",
  },
  {
    id: "storage-usage",
    title: "存储水位",
    keywords: ["存储", "配额", "空间", "localstorage", "清理", "占用", "字节"],
    section: "model",
  },
  {
    id: "theme-mode",
    title: "主题模式",
    keywords: ["主题", "暗色", "深色", "浅色", "跟随系统", "夜间", "护眼", "dark", "light", "theme", "模式"],
    section: "appearance",
  },
  {
    id: "accent-color",
    title: "主题色",
    keywords: ["主题", "主题色", "页面颜色", "颜色", "配色", "accent", "色板", "自定义颜色", "恢复默认"],
    section: "appearance",
  },
  {
    id: "nav-mode",
    title: "导航栏",
    keywords: [
      "导航",
      "导航栏",
      "侧栏",
      "侧边栏",
      "自动隐藏",
      "显示",
      "隐藏",
      "固定",
      "常显",
      "pin",
      "ctrl+b",
      "显示方式",
    ],
    section: "appearance",
  },
  {
    id: "pet",
    title: "桌宠",
    keywords: ["桌宠", "宠物", "形象", "模型路径", "打扰强度", "大小", "点击穿透", "显示"],
    section: "appearance",
  },
  {
    id: "nav-order",
    title: "导航顺序",
    keywords: ["导航", "顺序", "侧栏", "排序", "上移", "下移", "恢复默认", "alt"],
    section: "navigation",
  },
  {
    id: "update",
    title: "软件更新",
    keywords: ["更新", "升级", "版本", "下载", "安装包", "检查更新"],
    section: "about",
  },
  {
    id: "changelog",
    title: "更新日志",
    keywords: ["更新日志", "changelog", "版本记录", "历史", "改动"],
    section: "about",
  },
];

export function sectionLabelOf(section: SettingsSectionId): string {
  return SETTINGS_SECTION_LABELS[section];
}

export function settingsCardById(id: string): SettingsCardMeta | undefined {
  return SETTINGS_CARDS.find((card) => card.id === id);
}

/**
 * 跨分区匹配（纯函数，便于单测）。
 *
 * 口径：空格分词、全部命中（AND）、大小写不敏感；匹配范围 = 标题 + 关键词 + 分区名。
 * 空查询返回空数组（界面据此回到普通分区视图，不显示结果面板）。
 */
export function matchSettingsCards(query: string): SettingsCardMeta[] {
  const tokens = String(query ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return [];
  return SETTINGS_CARDS.filter((card) => {
    const haystack = [card.title, ...card.keywords, sectionLabelOf(card.section)]
      .join(" ")
      .toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/** 结果面板里的一行文案（标题 · 分区），界面与测试共用。 */
export function settingsCardLabel(card: SettingsCardMeta): string {
  return `${card.title} · ${sectionLabelOf(card.section)}`;
}
