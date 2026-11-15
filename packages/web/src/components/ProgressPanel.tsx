import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { useEffect, useRef, useState } from "react";
import { useConversationProgress } from "../lib/progress/useConversationProgress.js";
import { ToolTraceList, toolSummaryLabel } from "./AgentStreamBubble.js";
import { TaskIcon, XIcon } from "./icons.js";
import { FlowDiagram } from "./progress/FlowDiagram.js";
import { StepsList } from "./progress/StepsList.js";
import { PHASE_TONES } from "./progress/status.js";
import { EmptyState } from "./ui/EmptyState.js";
import { IconButton } from "./ui/IconButton.js";

/** 宽度刻度：240px 是四段内容还能读的下限（再窄流程图标签要碎成两字一行），
 *  560px 是「再宽就不像侧栏了」的上限；默认 280px 保持历来的观感。 */
const MIN_WIDTH = 240;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 280;
const WIDTH_STEP = 16;
/** localStorage 键带 `.v1`：以后如果改成「按比例存」或存偏好的展开状态，可以另起一版，
 *  而不是猜旧数据是什么格式。 */
const STORAGE_KEY = "heming.progress.width.v1";

function clampWidth(px: number, max: number): number {
  return Math.min(Math.max(Math.round(px), MIN_WIDTH), max);
}

/**
 * 视口允许的最大宽度：min(560, 视口宽的一半)。
 *
 * 为什么跟着视口收敛而不是写死 560：1024 的窄窗里 560 的侧栏会吃掉主区一半以上，
 * 会话流被压到无法阅读。上限随视口走，任何窗口下「拖到最宽」都还留得下正文。
 * 再用 Math.max(MIN_WIDTH, …) 兜底：极端窄窗里 max 不能小于 min，否则 clamp 的上下界翻转，
 * 宽度会被夹成 min 而 max 形同虚设。
 */
function viewportMaxWidth(): number {
  if (typeof window === "undefined") return MAX_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.5)));
}

/**
 * 读本地偏好：非法值一律回落默认宽度。
 *
 * 为什么不直接把 Number(raw) 交给 clamp：`Number("")` 是 0、`Number("280px")` 是 NaN，
 * 0 会被夹成 240（看起来像「用户设过」），NaN 会让 style.width 失效、面板直接塌掉。
 * 显式判 NaN 并回落 280，坏数据的表现才是「回到默认」而不是「样式坏了」。
 */
function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clampWidth(parsed, MAX_WIDTH) : DEFAULT_WIDTH;
  } catch {
    // localStorage 被禁用（隐私模式/嵌入式 webview）时面板仍然可用，只是不记忆宽度。
    return DEFAULT_WIDTH;
  }
}

function persistWidth(px: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(px));
  } catch {
    // 同 readStoredWidth：存不下就只是刷新后回默认，不打扰用户。
  }
}

/** 视口宽度是「外部状态」：窗口变窄时要重新收敛上限，用 resize 订阅而不是只在首帧算一次。 */
function useViewportMaxWidth(): number {
  const [max, setMax] = useState<number>(viewportMaxWidth);
  useEffect(() => {
    const sync = () => setMax(viewportMaxWidth());
    sync(); // 首帧后补算一次：读数发生在窗口尺寸稳定前时，这里把它校正过来
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
  return max;
}

/**
 * 右侧「会话进度」面板（d.147.4.88）：把这一轮的三件事摊开——走到哪一步（阶段与进度条）、
 * 顺序长什么样（动态流程图）、具体做了什么（任务步骤 + 工具调用）。
 *
 * 为什么四块按这个顺序：顶部是「一句话结论 + 百分比」（扫一眼就够），中间流程图回答
 * 「卡在哪、还剩几步」，下面两块才是逐条细节。反过来（先列工具）就变成日志面板，
 * 用户在会话里其实先想知道「还要等多久」。
 *
 * 为什么数据由 props 传入会话 id、而不是订阅 activeConversationId：面板只挂在 ChatPage
 * 内，由右上角按钮开合，切页/换会话时随组件卸载；自己读全局 store 会在卸载边界上
 * 多一份「面板看到的会话」与「页面正在看的会话」不一致的可能。
 *
 * 为什么宽度走内联 style 而不是 Tailwind 类：可拖拽宽度的取值是连续量，动态类名
 * （`w-[${px}px]`）会被 Tailwind 的静态提取漏掉、生产构建里直接失效；内联 style 没有这个问题。
 */
export function ProgressPanel({
  conversationId,
  onClose,
}: {
  conversationId: string | null;
  onClose: () => void;
}) {
  const progress = useConversationProgress(conversationId);
  const phaseTone = PHASE_TONES[progress.phase];
  const { done, total } = progress.progress;
  const toolCount = progress.tools.length;
  const toolSummary = toolSummaryLabel(progress.tools);

  const maxWidth = useViewportMaxWidth();
  const [width, setWidth] = useState<number>(readStoredWidth);
  // widthRef 是「当前宽度」的同步镜像：拖拽的 pointermove 监听器注册在 window 的 effect 里，
  // 闭包拿不到最新 state，靠它才不会按下后第一帧就跳回初始值。
  const widthRef = useRef(width);
  const maxRef = useRef(maxWidth);
  useEffect(() => {
    maxRef.current = maxWidth;
  }, [maxWidth]);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  // 渲染用「实际宽度」：偏好可能超过当前视口能容忍的上限（宽窗拖到 560 再缩窗），
  // 这时只收敛显示值、不覆盖用户偏好——窗口再拉宽时宽度会自动回到 560。
  const effectiveWidth = clampWidth(width, maxWidth);

  /** 应用一次宽度变更：夹到当前区间、同步镜像、写回状态。返回最终值便于调用方落盘。 */
  const applyWidth = (next: number): number => {
    const clamped = clampWidth(next, maxRef.current);
    widthRef.current = clamped;
    setWidth(clamped);
    return clamped;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 只响应主键：中键/右键不该开始拖拽。`typeof` 判断是为了容错——合成事件/无 PointerEvent
    // 的环境里 button 可能是 undefined，那种情况按「主键」处理，不能因此让拖拽完全失灵。
    if (typeof event.button === "number" && event.button !== 0) return;
    event.preventDefault(); // 阻止浏览器默认的「按下即开始选区」，否则整页文字会被拖蓝
    // preventDefault 会连焦点一起拦掉，这里补一次 focus：点完手柄直接按 ←/→ 应该就能调。
    event.currentTarget.focus({ preventScroll: true });
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: effectiveWidth };
    // pointer capture 让指针移出手柄（甚至移出窗口）后事件仍回到这条手柄。
    // jsdom / 老浏览器没有该 API，判一下再调，免得拖拽在非浏览器环境一按就抛错。
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setDragging(true);
  };

  // 拖拽的 move/up 挂在 window 上：指针一旦离开手柄，元素自身的监听就收不到了。
  // 计算只依赖 dragRef 里的起始值（startWidth + 位移），重复触发也不会累积误差。
  useEffect(() => {
    if (!dragging) return;
    const bodyStyle = document.body.style;
    const previousCursor = bodyStyle.cursor;
    const previousUserSelect = bodyStyle.userSelect;
    // 拖拽期间光标停在正文上也保持 col-resize，并禁止选中：否则拖快一点会顺手把对话选中。
    bodyStyle.cursor = "col-resize";
    bodyStyle.userSelect = "none";

    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      // 手柄在面板左缘：指针左移（clientX 变小）意味着面板变宽，所以位移取反后叠加。
      applyWidth(drag.startWidth + (drag.startX - event.clientX));
    };
    const end = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      setDragging(false);
      // 松手才落盘：拖拽过程中每帧写 localStorage 既没有意义，也让同步 API 卡住动画。
      persistWidth(widthRef.current);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      bodyStyle.cursor = previousCursor;
      bodyStyle.userSelect = previousUserSelect;
    };
  }, [dragging]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // 手柄在面板左缘：← 把分隔条往左推 = 面板变宽，与鼠标拖拽方向一致；→ 反之。
    // Home/End 一步到最窄/最宽，省得按十几次。
    const base = Math.min(widthRef.current, maxRef.current);
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = base + WIDTH_STEP;
        break;
      case "ArrowRight":
        next = base - WIDTH_STEP;
        break;
      case "Home":
        next = MIN_WIDTH;
        break;
      case "End":
        next = maxRef.current;
        break;
      default:
        return;
    }
    event.preventDefault(); // 否则 ←/→ 会把页面滚走、Home/End 会跳到文档首尾
    // 键盘没有「松手」这个时机，每次调整即落盘。
    persistWidth(applyWidth(next));
  };

  return (
    <aside
      aria-label="会话进度"
      style={{ width: effectiveWidth }}
      className="relative flex shrink-0 flex-col border-l border-line-soft bg-subtle"
    >
      {/*
        调宽手柄：8px 宽的透明带正好压在左边界上（-left-1 + w-2），
        中间用 ::after 画 1px 竖线，悬停/聚焦/拖拽时变成强调色——这样既不抢视觉，
        又有足够宽的抓取区（真正的 1px 线很难点中）。
      */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整会话进度栏宽度"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={effectiveWidth}
        tabIndex={0}
        data-testid="progress-resize-handle"
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        className={`absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none select-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors after:duration-fast focus-visible:outline-2 focus-visible:outline-ink hover:after:bg-accent focus-visible:after:bg-accent ${
          dragging ? "after:bg-accent" : ""
        }`}
      />
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-soft px-3">
        <h2 className="ui-section-title min-w-0 flex-1 truncate">会话进度</h2>
        <IconButton label="关闭会话进度" icon={<XIcon />} onClick={onClose} />
      </div>
      {/* 滚动只发生在面板内部：页面级滚动属于会话流，侧栏撑高整页会让用户滚丢消息。 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {progress.hasData ? (
          <div className="flex flex-col gap-4 p-3">
            <Section title="本轮进度">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-ui-xs ${phaseTone.badge}`}
                >
                  {phaseTone.label}
                </span>
                {/* headline 用 medium 字重：它是这一段唯一的一句话结论，比计数小字重要一档。 */}
                <p
                  className="min-w-0 flex-1 break-words text-ui-sm font-medium text-ink"
                  data-testid="progress-headline"
                >
                  {progress.headline}
                </p>
              </div>
              {/* total 为 0 时画进度条会是一条永远 0% 的空槽，像坏了；不如不画。 */}
              {total > 0 ? (
                <div
                  role="progressbar"
                  aria-label="本轮步骤进度"
                  aria-valuemin={0}
                  aria-valuemax={total}
                  aria-valuenow={done}
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-subtle-3"
                >
                  <div
                    className="h-full rounded-full bg-success transition-all duration-base motion-reduce:transition-none"
                    style={{ width: `${Math.round((done / total) * 100)}%` }}
                  />
                </div>
              ) : null}
              {/* 计数只列非零项：一行「工具 0 次」纯占位置；没有工具就整行不渲染。 */}
              {toolCount > 0 ? (
                <p className="mt-1.5 text-ui-xs leading-4 text-muted" data-testid="progress-counts">
                  工具 {toolCount} 次{toolSummary ? ` · ${toolSummary}` : ""}
                </p>
              ) : null}
              {/* 待确认要能被读屏即时播报（role=status），且给出去哪儿继续的下一步说明。 */}
              {progress.pendingConfirms > 0 ? (
                <div
                  role="status"
                  className="mt-2 rounded-lg border border-warn-line bg-warn-soft px-2.5 py-2"
                >
                  <p className="text-ui-sm font-medium text-warn">
                    等待你确认 {progress.pendingConfirms} 项工具调用
                  </p>
                  <p className="mt-0.5 text-ui-xs leading-4 text-warn">
                    在对话里允许或拒绝后，这里会继续
                  </p>
                </div>
              ) : null}
            </Section>

            <Section title="动态流程图">
              <FlowDiagram steps={progress.steps} phase={progress.phase} />
            </Section>

            <Section title="任务步骤">
              <StepsList steps={progress.steps} />
            </Section>

            {/* 没有工具调用时整段不出现：空标题比没有更让人以为「还没加载出来」。 */}
            {toolCount > 0 ? (
              <Section title="工具调用">
                <ToolTraceList tools={progress.tools} />
              </Section>
            ) : null}
          </div>
        ) : (
          <div className="flex min-h-full items-center justify-center p-4">
            <EmptyState
              titleAs="h2"
              title="这一轮还没有进度"
              desc="发送一条消息后，任务步骤、工具调用和流程图会出现在这里。"
              icon={<TaskIcon />}
              className="max-w-[240px]"
            />
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * 段落壳：固定 h3 层级与间距，避免四个 section 各写一遍还写歪。
 *
 * 注意 h3 的类名用 `ui-micro`（12px/500 muted）——小标题在 280px 侧栏里要弱于内容，
 * 否则四行标题会和正文抢注意力；但语义层级必须真实存在（h2 栏头 → h3 段落），
 * 设计审计会按 DOM 层级检查，用 span 冒充层级过不了。
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="ui-micro mb-2">{title}</h3>
      {children}
    </section>
  );
}