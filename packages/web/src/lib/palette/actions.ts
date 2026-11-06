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
  | "modules";

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
    // d.74：模块是 d.70 新概念，但此前命令面板搜「模块」一条结果都没有——
    // 用户知道有这个能力，却只能去插件区里再找 Tab。这里给一个直达入口。
    label: "模块管理",
    description: "启用 / 停用幕僚、信息中枢、自动化",
    keywords: ["模块", "内置模块", "模块管理", "module", "modules"],
  },
];

export function findPaletteAction(id: string): PaletteAction | undefined {
  return PALETTE_ACTIONS.find((a) => a.id === id);
}
