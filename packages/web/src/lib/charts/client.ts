/**
 * 图表导出的客户端封装。
 *
 * 两条路径：
 * - 桌面端：走 preload 暴露的 `__heming_chart` 桥，写到 `~/Heming/charts`；
 * - 浏览器端：没有桥，降级为浏览器下载（存到用户自己的下载目录）。
 *
 * 浏览器端不是"功能缺失"，而是环境限制——网页版本来就没有本机文件系统。
 * 界面上要明确告诉用户文件去哪了，不能让人以为导出失败了。
 */

import { chartFileName, exportChartHtml } from "./exportHtml.js";
import type { ChartSpec } from "./spec.js";

/** 桌面端桥的形状（与 preload 暴露的一致）。 */
interface ChartBridge {
  export: (fileName: string, content: string) => Promise<{ ok: boolean; path?: string; name?: string; error?: string }>;
  list: () => Promise<{ name: string; path: string; size: number; at: string }[]>;
  open: (fileName: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
}

function bridge(): ChartBridge | null {
  const g = globalThis as unknown as { __heming_chart?: ChartBridge };
  return g.__heming_chart ?? null;
}

/** 桌面端是否有落盘能力。 */
export function canExportToDisk(): boolean {
  return bridge() !== null;
}

export interface ExportResult {
  ok: boolean;
  /** 桌面端是绝对路径；浏览器端是文件名。 */
  location: string;
  /** 给用户看的一句话。 */
  message: string;
}

/**
 * 导出图表。
 *
 * @param spec 图表规范
 * @param title 可选：覆盖默认文件名
 */
export async function exportChart(spec: ChartSpec, title?: string): Promise<ExportResult> {
  const html = exportChartHtml(spec, { title });
  const fileName = chartFileName(spec);
  const b = bridge();

  if (b) {
    const res = await b.export(fileName, html);
    if (!res.ok) {
      return { ok: false, location: "", message: res.error ?? "导出失败" };
    }
    return {
      ok: true,
      location: res.path ?? "",
      message: `已保存到 ${res.path}`,
    };
  }

  // 浏览器端：触发下载
  try {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 会让部分浏览器来不及开始下载，延后释放
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return {
      ok: true,
      location: fileName,
      message: `已下载 ${fileName}（浏览器下载目录）`,
    };
  } catch (err) {
    return { ok: false, location: "", message: `导出失败：${(err as Error).message}` };
  }
}

/** 打开已导出的图表（仅桌面端）。 */
export async function openExportedChart(fileName: string): Promise<ExportResult> {
  const b = bridge();
  if (!b) {
    return { ok: false, location: "", message: "网页版无法直接打开本机文件" };
  }
  const res = await b.open(fileName);
  if (!res.ok) return { ok: false, location: "", message: res.error ?? "打开失败" };
  return { ok: true, location: res.path ?? "", message: "已在默认程序中打开" };
}

/** 列出已导出的图表（仅桌面端）。 */
export async function listExportedCharts(): Promise<{ name: string; path: string; size: number; at: string }[]> {
  const b = bridge();
  if (!b) return [];
  try {
    return await b.list();
  } catch {
    return [];
  }
}
