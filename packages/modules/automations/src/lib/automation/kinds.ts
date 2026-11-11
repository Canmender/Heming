/**
 * 自动化动作的声明式清单（纯数据）。
 *
 * 这里只回答「有哪些动作、怎么展示、默认叫什么」，不引用 model / runner / store：
 * 模型层（校验、归一、文案）与执行层（actions.ts）都从这里取口径，页面按
 * `listKindMeta()` 渲染动作选项。新增动作时先在表里加一条，model 与页面自动跟上，
 * 执行函数在 actions.ts 里补齐即可——不再需要改六处硬编码分支。
 *
 * 数组顺序即 UI 顺序，第一项是默认动作：`normalizeDraft` 遇到历史脏 kind 时
 * 会落回它（与改造前「未知一律按 infohub.sync」的行为一致）。
 */

export const AUTOMATION_KINDS = ["infohub.sync", "infohub.agenda"] as const;

export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

export interface AutomationKindMeta {
  kind: AutomationKind;
  /** 动作名：任务卡徽标与动作下拉共用。 */
  label: string;
  /** 新建草稿的默认名称，与改造前 draftForKind 的结果逐字一致。 */
  defaultName: string;
  /** 是否展示同步参数面板（来源 / 全量 / 导出）；只有同步动作需要。 */
  hasSyncParams: boolean;
  /** 一句话说明，供编辑弹窗解释「这个动作会做什么」。 */
  summary: string;
}

export const AUTOMATION_KIND_META: readonly AutomationKindMeta[] = [
  {
    kind: "infohub.sync",
    label: "同步本机归档",
    defaultName: "同步本机归档",
    hasSyncParams: true,
    summary: "把 QQ / 微信的聊天记录同步到本机归档",
  },
  {
    kind: "infohub.agenda",
    label: "重扫日程",
    defaultName: "重扫日程",
    hasSyncParams: false,
    // 与任务卡现有说明逐字一致：页面改成查元数据后，用户看到的字不能变。
    summary: "重扫本机归档的日程表",
  },
];

/** 未知值返回 false；读盘校验靠它把历史脏 kind 丢弃，不能放宽成「兜底放行」。 */
export function isAutomationKind(value: unknown): value is AutomationKind {
  return AUTOMATION_KINDS.some((kind) => kind === value);
}

/** 只读快照：页面渲染用，调用方按 readonly 类型拿不到可变引用。 */
export function listKindMeta(): readonly AutomationKindMeta[] {
  return AUTOMATION_KIND_META;
}

/**
 * 取单个动作的元数据。
 *
 * 入参类型已收窄到 AutomationKind；运行时仍走到未知值，说明上层校验被绕过。
 * 这里直接抛错而不静默降级——把错误动作当成默认动作才是更危险的行为。
 */
export function kindMeta(kind: AutomationKind): AutomationKindMeta {
  const meta = AUTOMATION_KIND_META.find((item) => item.kind === kind);
  if (!meta) throw new Error(`未知的自动化动作：${String(kind)}`);
  return meta;
}
