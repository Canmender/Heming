import type { ProgressPhase, ProgressStep, ProgressStepStatus } from "../../lib/progress/model.js";

/**
 * 进度面板的「状态 → 视觉/文案」映射（d.147.4.88）。
 *
 * 为什么单独一层：顶部阶段徽标、动态流程图、任务步骤列表三处都要按同一套状态上色，
 * 各自写一份迟早会漂移（「步骤列表说完成是绿、流程图说完成是蓝」这种自相矛盾
 * 在窄面板里格外刺眼）。这里只放纯数据与纯函数、不放 JSX：状态图形（对勾/感叹号/叉）
 * 由 tsx 组件内联，因为 `components/icons.tsx` 是共享文件，本轮不允许改。
 *
 * 颜色只是**辅助**：每个状态都同时给一个文字标签（进行中/完成/失败…），
 * 色弱用户与灰度截图靠文字也能读——纯色块单靠颜色区分不满足 WCAG 1.4.1。
 */
export interface StepTone {
  /** 状态词：读屏与色弱用户的文字兜底，同时充当流程图节点/步骤行的次要信息。 */
  label: string;
  /** 14px 状态点/徽标的外观（底色 + 描边；running 额外带呼吸动效）。 */
  dot: string;
  /** 状态词的文字色（与工具轨迹里同名状态同色，避免同一工具两处两种颜色）。 */
  text: string;
}

export const STEP_TONES: Record<ProgressStepStatus, StepTone> = {
  // 进行中：全站「正在发生」的强调色，且只在允许动效时呼吸——减弱动效的用户
  // 看到静止的强调色也已足够表达「还在跑」，不需要替他把动画关掉的开关。
  running: {
    label: "进行中",
    dot: "border-accent bg-accent motion-safe:animate-pulse",
    text: "text-accent",
  },
  ok: { label: "完成", dot: "border-success-line bg-success-soft text-success", text: "text-success" },
  error: { label: "失败", dot: "border-danger-line bg-danger-soft text-danger", text: "text-danger" },
  // 拒绝不是失败：工具的权限被用户否决，语义上更接近「需要你知道」，用 warn。
  denied: { label: "已拒绝", dot: "border-warn-line bg-warn-soft text-warn", text: "text-warn" },
  // 等待用户：warn 是「卡在你这儿」的既有语义色；圆点用虚线边，
  // 与下面「虚线连接线」一起表达这条路还没走完。
  waiting: {
    label: "等待确认",
    dot: "border-warn-line border-dashed bg-warn-soft",
    text: "text-warn",
  },
};

export interface PhaseTone {
  /** 徽标文字（比 headline 短一档，避免与标题重复读同一句话）。 */
  label: string;
  badge: string;
}

/**
 * 阶段徽标配色：只有 acting（此刻正在做事）用实心强调色，
 * 其余都用浅底 + 描边——徽标在 280px 栏里不该抢走 headline 的注意力。
 */
export const PHASE_TONES: Record<ProgressPhase, PhaseTone> = {
  idle: { label: "未开始", badge: "border-line-soft bg-subtle-2 text-muted" },
  thinking: { label: "思考中", badge: "border-info-line bg-info-soft text-info" },
  acting: { label: "执行中", badge: "border-accent bg-accent text-accent-on" },
  waiting: { label: "等待确认", badge: "border-warn-line bg-warn-soft text-warn" },
  done: { label: "已完成", badge: "border-success-line bg-success-soft text-success" },
  error: { label: "已中断", badge: "border-danger-line bg-danger-soft text-danger" },
};

/**
 * 毫秒 → 人话：120ms / 1.2s / 1m5s。
 *
 * 与 `AgentStreamBubble.tsx` 里工具耗时的分档一致；那里是模块私有函数，
 * 为复用它去导出会无端扩大那个文件的公开面，所以这里保留一份同规则的实现。
 */
export function formatDuration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 1000) return `${v}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  const m = Math.floor(v / 60_000);
  const s = Math.round((v % 60_000) / 1000);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

/**
 * 这一步的耗时；拿不到首尾时间就不编一个「0ms」出来（会误导成「瞬间完成」）。
 *
 * 只认 `startedAt + endedAt` 同时存在：进行中的步骤没有终点，计时会随渲染抖动，
 * 由状态词「进行中」表达即可。
 */
export function stepDuration(step: ProgressStep): string | null {
  if (step.startedAt === undefined || step.endedAt === undefined) return null;
  return formatDuration(step.endedAt - step.startedAt);
}

/**
 * 节点下方连接线的样式。
 *
 * 为什么分实线/虚线而不是统一描边：竖线是这张图唯一的「时间方向」提示——
 * 已经落定（ok/error/denied）的那段是走过的路，用实线；running 还在跑、
 * waiting 卡在用户确认，这两段都还没走完，用虚线；waiting 叠 warn 色，
 * 让「卡住的位置」在轨迹上一眼可辨。
 *
 * 统一用 `border-l` 而不是 `w-px bg-*`：只有 border 能画 dashed。
 */
export function connectorClass(status: ProgressStepStatus): string {
  if (status === "waiting") return "border-l border-dashed border-warn-line";
  if (status === "running") return "border-l border-dashed border-line-strong";
  return "border-l border-line-strong";
}