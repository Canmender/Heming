/**
 * 命令面板 · 常用动作目录（5 个）。
 *
 * 这里只放**元数据**，真正执行在 `CommandPalette` 里按 `id` 分发到既有 store
 * （`useUiStore` 切页 / 设置直达 / 意图槽）。刻意不把执行函数写在这里：
 * 纯数据便于单测「动作名可被检索到」，也让执行点集中在一处、便于断言。
 *
 * 不新增 IPC、不引依赖：五个动作全部走已有能力。
 */
export type PaletteActionId =
  | "new-task"
  | "new-agent"
  | "notifications"
  | "settings"
  | "modules"
  /**
   * d.113 第二轮：知识库四个动作。执行时统一切到知识库页并通过 `vaultIntent`
   * 投递动作（新建 / 日记 / 画布 / 设置），页面消费后执行——不在这里直接读写文件。
   */
  | "vault-new-note"
  | "vault-daily"
  | "vault-new-canvas"
  | "vault-settings";

export interface PaletteAction {
  id: PaletteActionId;
  label: string;
  /** 一句话说明会发生什么（副标题）。 */
  description: string;
  /** 供检索的额外关键词。 */
  keywords: string[];
}

export const PALETTE_ACTIONS: PaletteAction[] = [
  {
    id: "new-task",
    label: "新建任务",
    description: "去任务区直接填写目标即可运行",
    keywords: ["任务", "派活", "运行", "task"],
  },
  {
    id: "new-agent",
    label: "新建智能体",
    description: "创建并配置一个本机智能体",
    keywords: ["智能体", "助手", "agent", "新建"],
  },
  {
    id: "notifications",
    label: "打开通知中心",
    description: "查看提醒、审批与系统消息",
    keywords: ["通知", "提醒", "消息", "审批", "notification"],
  },
  {
    id: "settings",
    label: "打开设置",
    description: "模型、外观、导航与关于",
    keywords: ["设置", "偏好", "配置", "settings"],
  },
  {
    id: "modules",
    // 模块已并入插件页：这里给一个直达入口（插件 Tab），可一键安装/启停内置插件。
    label: "插件与模块",
    description: "安装、删除或启停内置插件：幕僚、信息中枢、自动化",
    keywords: ["模块", "内置模块", "模块管理", "插件", "安装", "module", "modules", "plugin"],
  },
  {
    id: "vault-new-note",
    label: "新建笔记",
    description: "在知识库里新建一篇笔记，可选模板",
    keywords: ["知识库", "笔记", "新建", "vault", "note"],
  },
  {
    id: "vault-daily",
    label: "打开今天的日记",
    description: "按日记设置打开今天那篇，没有就按模板创建",
    keywords: ["知识库", "日记", "今天", "daily", "journal", "today"],
  },
  {
    id: "vault-new-canvas",
    label: "新建画布",
    description: "在知识库里新建一个 .canvas 画布",
    keywords: ["知识库", "画布", "canvas", "新建"],
  },
  {
    id: "vault-settings",
    label: "知识库设置",
    description: "日记文件夹、日期格式与日记模板",
    keywords: ["知识库", "设置", "日记", "模板", "vault", "settings"],
  },
];

export function findPaletteAction(id: string): PaletteAction | undefined {
  return PALETTE_ACTIONS.find((a) => a.id === id);
}
