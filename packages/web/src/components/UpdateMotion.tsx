import type { CSSProperties } from "react";

/**
 * 更新过程中的动效层（纯装饰 + 进度条本体，不含任何更新逻辑）。
 *
 * 语言与自绘安装器保持一致：墨点、发丝线、真实百分比、朱砂印章。
 * 这里的百分比全部来自主进程推送的真实字节数——不做「假进度」，
 * 拿不到总量时数字照旧显示，但没有可算的比例。
 *
 * 朱砂色用字面量 #a63d2e，与 packages/setup 的印章同色；web 的 token 表里
 * 没有「朱砂」这一档，为了一处点缀去扩充全局调色板不值得。
 */

export type MotionPhase = "checking" | "downloading" | "downloaded" | "installing";

/** 下载中波浪的墨点数量：比启动动画的 24 少一些，卡内空间有限。 */
export const MOTION_WAVE_DOTS = 18;

/** 点「重启并安装」后的落章时长；reduced-motion 下缩短到一帧就够。 */
export const INSTALL_LEAD_MS = 800;
const INSTALL_LEAD_REDUCED_MS = 160;

const SEAL_COLOR = "#a63d2e";

const STYLES = `
  .update-motion { margin-top: 8px; }
  .update-motion[data-phase="checking"] { padding: 8px 0 2px; }

  .um-dots { display: flex; gap: 5px; align-items: center; height: 12px; }
  .um-dots span {
    width: 4px; height: 4px; border-radius: 50%;
    background: var(--ink); opacity: 0.25;
    animation: um-pulse 1.05s ease-in-out infinite;
  }
  .um-dots span:nth-child(2) { animation-delay: 0.16s; }
  .um-dots span:nth-child(3) { animation-delay: 0.32s; }
  @keyframes um-pulse {
    0%, 100% { opacity: 0.2; transform: translateY(0); }
    40% { opacity: 1; transform: translateY(-2px); }
  }

  .um-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
  .um-wave { display: flex; align-items: center; gap: 3px; height: 22px; }
  .um-wave i {
    width: 3px; height: 3px; border-radius: 50%;
    background: var(--ink); opacity: 0.55;
    animation: um-bob 1.15s ease-in-out infinite;
    animation-delay: calc(var(--i) * 55ms);
  }
  @keyframes um-bob {
    0%, 100% { transform: translateY(0); opacity: 0.35; }
    45% { transform: translateY(-5px); opacity: 1; }
  }

  .um-percent {
    display: flex; align-items: baseline; gap: 1px;
    font-variant-numeric: tabular-nums; line-height: 1;
  }
  .um-percent strong { font-size: 26px; font-weight: 300; letter-spacing: -0.02em; }
  .um-percent em { font-style: normal; font-size: 11px; color: var(--muted); }

  .um-track {
    position: relative; height: 2px; margin-top: 9px;
    background: var(--subtle-4);
  }
  .um-fill {
    height: 100%; background: var(--ink);
    transition: width 200ms linear;
  }
  /* 笔尖：进度线头上的朱砂点，和安装器的「落点」是同一个意象 */
  .um-tip {
    position: absolute; top: 50%; width: 5px; height: 5px; margin: -2.5px 0 0 -2.5px;
    border-radius: 50%; background: ${SEAL_COLOR};
    transition: left 200ms linear;
  }
  .um-note { margin-top: 6px; }

  .um-seal {
    display: inline-flex; align-items: center; justify-content: center;
    width: 34px; height: 34px; margin-top: 10px;
    background: ${SEAL_COLOR}; color: #f5f2ea;
    font-size: 18px; font-weight: 600; line-height: 1;
    transform-origin: 50% 55%;
  }
  .um-seal.stamped { animation: um-stamp 520ms cubic-bezier(0.18, 0.9, 0.24, 1.2) both; }
  @keyframes um-stamp {
    0% { transform: rotate(-12deg) scale(1.9); opacity: 0; }
    55% { opacity: 1; }
    100% { transform: rotate(-8deg) scale(1); opacity: 1; }
  }

  .um-installing { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .um-installing .um-seal { margin-top: 0; }
  .um-installing p { font-size: 12px; color: var(--muted); }

  @media (prefers-reduced-motion: reduce) {
    .um-dots span, .um-wave i { animation: none; opacity: 0.8; }
    .um-seal.stamped { animation: none; transform: rotate(-8deg); }
    .um-fill, .um-tip { transition: none; }
  }
`;

/** 运行环境是否要求减少动效；matchMedia 缺失（jsdom）时按「不作要求」处理。 */
export function reducedMotion(): boolean {
  try {
    return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch {
    return false;
  }
}

/** 「重启并安装」前留给印章的时长。 */
export function installLeadMs(): number {
  return reducedMotion() ? INSTALL_LEAD_REDUCED_MS : INSTALL_LEAD_MS;
}

interface UpdateMotionProps {
  phase: MotionPhase;
  /** 下载百分比（真实字节比例，0–100）；只有 downloading 用得到。 */
  percent?: number;
  /** 进度文字（已下载 X%（A / B · 速度）），由调用方按同一套格式化规则生成。 */
  note?: string;
}

export function UpdateMotion({ phase, percent = 0, note }: UpdateMotionProps) {
  const safePercent = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const rounded = Math.round(safePercent);

  return (
    <div className="update-motion" data-phase={phase} data-testid={`update-motion-${phase}`}>
      <style>{STYLES}</style>

      {phase === "checking" && (
        <div className="um-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      )}

      {phase === "downloading" && (
        <>
          <div className="um-head">
            <div className="um-wave" aria-hidden="true">
              {Array.from({ length: MOTION_WAVE_DOTS }, (_, i) => (
                <i key={i} style={{ "--i": String(i) } as CSSProperties} />
              ))}
            </div>
            <div className="um-percent" aria-hidden="true">
              <strong>{rounded}</strong>
              <em>%</em>
            </div>
          </div>
          {/* role/aria 与改造前完全一致：读屏用户拿到的仍是真实百分比 */}
          <div
            role="progressbar"
            aria-label="更新下载进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={rounded}
            className="um-track"
          >
            <div className="um-fill" style={{ width: `${safePercent}%` }} />
            {safePercent > 1 && safePercent < 100 && (
              <span className="um-tip" style={{ left: `${safePercent}%` }} aria-hidden="true" />
            )}
          </div>
          {note && <div className="um-note ui-micro tabular-nums">{note}</div>}
        </>
      )}

      {phase === "downloaded" && (
        <div className="um-seal stamped" aria-hidden="true">
          和
        </div>
      )}

      {phase === "installing" && (
        <div className="um-installing" role="status">
          <div className="um-seal stamped" aria-hidden="true">
            和
          </div>
          {/* 和按钮文案错开：文案重复时读屏会把同一句话念两遍 */}
          <p>更新已就绪，正在重启…</p>
        </div>
      )}
    </div>
  );
}
