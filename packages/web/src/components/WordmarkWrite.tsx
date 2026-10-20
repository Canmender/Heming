import { useEffect, useRef, useState } from "react";
import { WORDMARK_STROKES, WORDMARK_VIEWBOX } from "./wordmarkGlyphs.js";

/**
 * 手写段时序（与 `packages/desktop/splash-config.js` 的 `WRITE_MS` 同源）。
 *
 * 桌面端由 splash 窗口负责这一段；**网页/预览环境没有 splash 窗口**，所以 web 层
 * 自己也要能把「一笔一笔写出 Heming」演出来 —— 否则浏览器里只剩声波揭示，
 * 用户会以为写字动画丢了（2026-10-18 用户反馈）。
 */
export const WRITE_DRAW_MS = 1250;
export const WRITE_HOLD_MS = 150;
export const WRITE_FADE_MS = 200;
/** 写完 + 停顿 + 淡出，之后才交棒声波段。 */
export const WRITE_TOTAL_MS = WRITE_DRAW_MS + WRITE_HOLD_MS + WRITE_FADE_MS;

/** 字母之间的「抬手」间隔。 */
export const LETTER_GAP_MS = 55;

export interface StrokeTiming {
  /** 该笔开始时刻（ms，相对手写段起点）。 */
  start: number;
  /** 该笔结束时刻（ms）。 */
  end: number;
  /** 该笔总长度（与 getTotalLength 同单位）。 */
  len: number;
}

/**
 * 按「笔画长度 + 字母间抬手」把总运笔时间分配到每一笔上，使笔尖速度均匀。
 *
 * 纯粹函数，便于单测（jsdom 里量不到 SVG 的真实长度，只能喂人造长度验证分配逻辑）。
 */
export function buildWriteSchedule(
  lengths: readonly number[],
  letters: readonly string[],
  totalMs: number,
  gapMs: number,
): StrokeTiming[] {
  const totalLen = lengths.reduce((a, b) => a + b, 0);
  // 长度全为 0（取不到几何信息时）退化为「等长分配」，至少让每笔都分到时间而不是除零。
  const weights = totalLen > 0 ? lengths : lengths.map(() => 1);
  const sumLen = totalLen > 0 ? totalLen : lengths.length || 1;
  let gaps = 0;
  for (let i = 1; i < letters.length; i++) {
    if (letters[i] !== letters[i - 1]) gaps += gapMs;
  }
  const drawBudget = Math.max(1, totalMs - gaps);
  const out: StrokeTiming[] = [];
  let cursor = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (i > 0 && letters[i] !== letters[i - 1]) cursor += gapMs;
    const dur = (weights[i] / sumLen) * drawBudget;
    out.push({ start: cursor, end: cursor + dur, len: lengths[i] });
    cursor += dur;
  }
  return out;
}

/** 某时刻的书写进度（0→1）：早于 start 为 0，晚于 end 为 1。 */
export function strokeProgress(t: number, timing: StrokeTiming): number {
  if (t <= timing.start) return 0;
  if (t >= timing.end) return 1;
  return (t - timing.start) / (timing.end - timing.start);
}

/**
 * 取一笔的路径长度。
 *
 * 浏览器/Electron 里 SVGPathElement 一定有 getTotalLength；但 jsdom 等无几何实现的环境
 * 没有这个方法（直接调用会抛 TypeError 把整段动画打断）。取不到时按 0 处理，
 * 由 buildWriteSchedule 的「等长退化」兜底，动画照常按时长推进。
 */
function pathLength(p: SVGPathElement): number {
  try {
    const len = typeof p.getTotalLength === "function" ? p.getTotalLength() : 0;
    return Number.isFinite(len) && len > 0 ? len : 0;
  } catch {
    return 0;
  }
}

const STROKE_LETTERS = WORDMARK_STROKES.map((s) => s.letter);

const STYLES = `
  .wordmark-write {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    pointer-events: none;
    transition: opacity ${WRITE_FADE_MS}ms ease;
  }
  .wordmark-write.fading { opacity: 0; }
  .wordmark-write svg {
    width: min(420px, 46vw); height: auto;
    fill: none;
    stroke: #1a1a1a;
    stroke-width: 3;
    stroke-linecap: round;
    stroke-linejoin: round;
    overflow: visible;
  }
`;

interface WordmarkWriteProps {
  /** 整段（运笔 + 停顿 + 淡出）播完时回调，只调用一次。 */
  onDone: () => void;
}

/**
 * 手写「Heming」：逐笔用 stroke-dashoffset 描出，速度按笔画长度均分，
 * 写完停顿 150ms 后 200ms 淡出，然后回调 onDone。
 *
 * 与 `packages/desktop/splash.html` 里那份是同一套算法（那边要求自包含，无法
 * import 本模块）；字形数据同源于 `wordmarkGlyphs.ts`，由 drift 测试守卫。
 */
export function WordmarkWrite({ onDone }: WordmarkWriteProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [fading, setFading] = useState(false);
  const onDoneRef = useRef(onDone);
  const doneRef = useRef(false);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const paths = Array.from(svgRef.current?.querySelectorAll("path") ?? []);
    if (paths.length === 0) {
      onDoneRef.current();
      return;
    }

    const lengths = paths.map(pathLength);
    const schedule = buildWriteSchedule(lengths, STROKE_LETTERS, WRITE_DRAW_MS, LETTER_GAP_MS);
    paths.forEach((p, i) => {
      p.style.strokeDasharray = String(lengths[i]);
      p.style.strokeDashoffset = String(lengths[i]);
    });

    let raf: number | null = null;
    let fadeTimer: number | null = null;
    let doneTimer: number | null = null;
    let t0: number | null = null;

    const tick = (now: number) => {
      if (t0 === null) t0 = now;
      const t = now - t0;
      for (let i = 0; i < paths.length; i++) {
        const prog = strokeProgress(t, schedule[i]);
        paths[i].style.strokeDashoffset = String(schedule[i].len * (1 - prog));
      }
      if (t < WRITE_DRAW_MS) {
        raf = requestAnimationFrame(tick);
        return;
      }
      raf = null;
      // 写完 → 停顿 → 淡出 → 交棒
      fadeTimer = window.setTimeout(() => setFading(true), WRITE_HOLD_MS);
      doneTimer = window.setTimeout(() => {
        if (doneRef.current) return;
        doneRef.current = true;
        onDoneRef.current();
      }, WRITE_HOLD_MS + WRITE_FADE_MS);
    };

    raf = requestAnimationFrame(tick);

    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      if (fadeTimer !== null) window.clearTimeout(fadeTimer);
      if (doneTimer !== null) window.clearTimeout(doneTimer);
    };
  }, []);

  return (
    <div className={`wordmark-write${fading ? " fading" : ""}`} aria-hidden="true">
      <style>{STYLES}</style>
      <svg ref={svgRef} viewBox={WORDMARK_VIEWBOX} role="img" aria-label="Heming">
        {WORDMARK_STROKES.map((s, i) => (
          <path key={i} d={s.d} />
        ))}
      </svg>
    </div>
  );
}
