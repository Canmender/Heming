/**
 * 聊天气泡内的图表卡片。
 *
 * 收到含 ```chart 围栏块的消息时，把图表渲染成卡片插在正文下方，
 * 并提供「导出 HTML」与「打开」两个动作。
 *
 * 关键点：**SVG 用 innerHTML 注入**。这是刻意的取舍——
 * 图表内容全部经 `esc()` 转义（标题、轴标签、来源都来自模型输出），
 * 且 SVG 里不执行脚本（`<script>` 在 SVG 上下文不生效，`onload` 之类
 * 在 innerHTML 注入时也不执行）。渲染层不引入 dangerouslySetInnerHTML
 * 之外的任何 HTML 拼接。
 */

import { useCallback, useMemo, useState } from "react";
import { renderChart } from "../lib/charts/renderer.js";
import { exportChart, openExportedChart } from "../lib/charts/client.js";
import { chartFileName } from "../lib/charts/exportHtml.js";
import type { ChartSpec } from "../lib/charts/spec.js";

/** 图表卡片。 */
export function ChatChart({ spec }: { spec: ChartSpec }) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileName] = useState(() => chartFileName(spec));

  // 渲染失败不该让整条消息崩掉：退回一句提示
  const rendered = useMemo(() => {
    try {
      return renderChart(spec);
    } catch (err) {
      return { error: (err as Error).message } as { error: string };
    }
  }, [spec]);

  const onExport = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await exportChart(spec);
      setStatus(res.message);
    } catch (err) {
      setStatus(`导出失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [spec]);

  const onOpen = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await openExportedChart(fileName);
      setStatus(res.message);
    } catch (err) {
      setStatus(`打开失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [fileName]);

  if ("error" in rendered) {
    return (
      <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
        图表渲染失败：{rendered.error}
      </div>
    );
  }

  return (
    <figure className="mt-2 w-full min-w-0">
      <div
        className="overflow-hidden rounded-xl border border-line"
        style={{ background: rendered.background }}
      >
        <div
          className="[&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
          // SVG 内容全部经 esc() 转义，见 renderChart 的说明
          dangerouslySetInnerHTML={{ __html: rendered.svg }}
        />
      </div>
      <figcaption className="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void onExport()}
          className="rounded-md border border-line bg-white px-2 py-0.5 text-[11px] shadow-card transition-colors duration-150 hover:bg-[#fafafa] disabled:opacity-50"
        >
          导出 HTML
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onOpen()}
          className="rounded-md border border-line bg-white px-2 py-0.5 text-[11px] shadow-card transition-colors duration-150 hover:bg-[#fafafa] disabled:opacity-50"
        >
          打开
        </button>
        {status && (
          <span role="status" className="min-w-0 flex-1 truncate text-[11px] text-muted">
            {status}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
