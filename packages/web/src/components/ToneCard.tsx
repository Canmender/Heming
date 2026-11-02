/**
 * 写作能力卡：展示「去 AI 味」的内置技能与规则集概览，并提供即时检测入口。
 *
 * 为什么放在技能区：它与「写作润色」是同一主题（都是成稿处理），
 * 放设置区会让人找不到。
 *
 * 为什么**没有开关**：`tone_detect` 是单个只读工具（只算不改），
 * 与 self.* 那种带写操作、需要用户明确授权的不一样。技能本身在技能池里，
 * 用户可以像其它内置技能一样禁用它。
 */

import { useCallback, useMemo, useState } from "react";
import { detectAiTone, TONE_RULES } from "../lib/tone/detector.js";

export function ToneCard() {
  const [text, setText] = useState("");
  const [ran, setRan] = useState(false);

  const report = useMemo(() => {
    if (!ran || !text.trim()) return null;
    return detectAiTone(text);
  }, [ran, text]);

  const onDetect = useCallback(() => {
    setRan(true);
  }, []);

  return (
    <section
      aria-label="写作能力"
      className="mt-3 rounded-xl border border-line bg-white p-4 shadow-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-bold text-[#777]">写作能力 · 去 AI 味</div>
          <div className="mt-1 text-[11px] text-muted">
            按 283 万字人类/生成语料对照统计得出的 11 条规则，定位 AI 写作痕迹。
            智能体改写前先用它框定可改范围——没命中规则的句子逐字保留。
          </div>
        </div>
      </div>

      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-muted hover:text-ink">
          查看 11 条规则
        </summary>
        <ol className="mt-2 flex flex-col gap-1">
          {Object.entries(TONE_RULES).map(([id, name]) => (
            <li key={id} className="flex gap-2 text-[11px]">
              <span className="w-4 shrink-0 text-right text-[#aaa]">{id}</span>
              <span className="min-w-0 flex-1">{name}</span>
            </li>
          ))}
        </ol>
        <div className="mt-2 rounded-lg border border-line-soft bg-[#fafafa] p-2 text-[11px] text-muted">
          <div className="font-medium text-[#777]">刻意不查的（实测站不住）</div>
          <ul className="mt-1 flex flex-col gap-0.5">
            <li>比喻本身、比喻独立成段 —— 人类用得比 AI 多 2.4 倍</li>
            <li>正文里的问句、设问 —— 人类是 AI 的 17 倍</li>
            <li>句长与段长的参差 —— 实测无差别</li>
            <li>单字虚词偏少、句内同构排比、被动句、名词化、长句</li>
          </ul>
        </div>
      </details>

      <div className="mt-3 flex flex-col gap-2">
        <textarea
          aria-label="待检测文本"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setRan(false);
          }}
          rows={4}
          placeholder="粘贴一段文字，试试哪些地方命中了规则"
          className="w-full resize-y rounded-lg border border-line px-3 py-2 text-[12px] leading-relaxed outline-hidden focus:border-[#bbb]"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onDetect}
            disabled={!text.trim()}
            className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-40"
          >
            检测 AI 痕迹
          </button>
          {report && (
            <span className="text-[11px] text-muted">
              {report.hits.length === 0
                ? "未命中任何规则"
                : `命中 ${report.hits.length} 处（${report.perKilo.toFixed(1)} 处/千字）`}
            </span>
          )}
        </div>
        {report && report.hits.length > 0 && (
          <ul className="flex flex-col gap-1">
            {report.hits.slice(0, 20).map((h) => (
              <li key={`${h.index}-${h.rule}`} className="flex gap-2 text-[11px]">
                <span className="shrink-0 text-[#aaa]">
                  第{h.rule}条 · 第{h.line + 1}行
                </span>
                <span className="min-w-0 flex-1 truncate text-muted">「{h.excerpt}」</span>
              </li>
            ))}
            {report.hits.length > 20 && (
              <li className="text-[11px] text-[#aaa]">
                …… 另有 {report.hits.length - 20} 处未列出
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
