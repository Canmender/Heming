/**
 * 会话进度栏「自动打开」的判据（d.245）。
 *
 * 为什么要有这层：进度栏一直是「用户自己想起右上角有个按钮才打得开」。而它最能帮上忙的时刻
 * ——**一轮已经跑了好几分钟、还在调工具**——恰恰是用户已经走神、不会主动去点按钮的时候。
 * 于是一轮跑十分钟，回来只看到「生成中」，只能猜它是不是卡了。
 *
 * 为什么**不**在「等你确认」时自动打开：那个时刻对话里已经顶着确认卡（弹窗就是入口），
 * 再自动摊开一栏属于重复打扰；确认卡本身已经说清「在等你点什么」。
 *
 * 为什么做成纯函数：这类「什么时候打扰用户」的规则最容易越写越玄。抽成纯函数后，
 * 每条规则都能在测试里逐条钉住（包括「刚关掉就不要再弹」这种体验型约束）。
 *
 * 三条硬约束：
 * 1. 已经开着就什么都不做（不要抢掉用户正在看的内容）。
 * 2. 一轮最多自动开一次（`autoOpenedThisRun`），不要每次心跳都抢镜。
 * 3. 用户手动关掉后 `PANEL_AUTO_QUIET_MS` 内不再自动开——**关掉就是关掉**，
 *    否则用户会觉得自己在和软件抢控制权。
 */

/** 跑多久算「很久」，值得主动摊开进度（45 秒：正常一轮回答通常几十秒内结束）。 */
export const PANEL_AUTO_LONG_RUN_MS = 45_000;

/** 工具调用到多少次才算「明显是多步任务」，避免一个短问答也弹栏。 */
export const PANEL_AUTO_MIN_TOOLS = 6;

/** 用户手动关掉后的安静期：这段时间内只有智能体显式调用 `panel_show` 才再打开。 */
export const PANEL_AUTO_QUIET_MS = 60_000;

/** 自动打开的原因（`agent` 是智能体自己调工具，不走本模块判定）。 */
export type PanelAutoReason = "long-run";

export interface PanelAutoInput {
  /** 面板当前是否已经打开。 */
  open: boolean;
  /** 这一轮是否已经自动开过。 */
  autoOpenedThisRun: boolean;
  /** 用户最近一次手动关闭的时间戳；没关过传 null。 */
  manualClosedAt: number | null;
  /** 当前时间（测试注入，便于构造「刚关掉」）。 */
  now: number;
  /** 这一轮已经跑了多久（毫秒）；没在跑传 0。 */
  runningMs: number;
  /** 这一轮已发生的工具调用次数。 */
  tools: number;
}

export interface PanelAutoDecision {
  open: boolean;
  reason: PanelAutoReason | null;
  /** 打开时给用户看的一句提示（关掉时不提示）。 */
  notice: string | null;
}

const NEUTRAL: PanelAutoDecision = { open: false, reason: null, notice: null };

/** 把一个毫秒数说成人话：`45 秒` / `1 分 20 秒`。 */
export function formatPanelDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
}

/**
 * 判定这一次心跳要不要自动打开进度栏。
 *
 * 唯一会主动打开的情况是「跑得久且确实在做多步活」：这类时刻用户需要知道
 * 「到哪一步了、卡没卡」，而正文里只有零星几行工具行。
 */
export function decidePanelAutoOpen(input: PanelAutoInput): PanelAutoDecision {
  if (input.open) return NEUTRAL;
  if (input.autoOpenedThisRun) return NEUTRAL;
  if (input.manualClosedAt !== null && input.now - input.manualClosedAt < PANEL_AUTO_QUIET_MS) {
    return NEUTRAL;
  }
  if (input.runningMs >= PANEL_AUTO_LONG_RUN_MS && input.tools >= PANEL_AUTO_MIN_TOOLS) {
    return {
      open: true,
      reason: "long-run",
      notice: `这一轮已经跑了 ${formatPanelDuration(input.runningMs)}、调了 ${input.tools} 次工具，已打开右侧「会话进度」栏看它做到哪一步（不用可以直接关掉）。`,
    };
  }
  return NEUTRAL;
}
