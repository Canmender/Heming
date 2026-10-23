/**
 * 导出文件落盘（web 侧，d.35）。
 *
 * 两条路径，优先级固定：
 * 1. 桌面端有 `window.__heming_exports` 桥 → 交给主进程写到 `~/Heming/exports`，
 *    返回真实路径；用户会被告知「文件在哪」，所以写失败必须抛错，**不能静默回退下载**
 *    （否则界面说成功、文件却在浏览器的下载目录里，等于撒谎）。
 * 2. 无桥（浏览器降级路径）→ Blob + 临时 `<a download>` 触发下载。
 *
 * 红线：两条路径都只碰本机，**绝不发起网络请求**（测试断言 fetch 未被调用）。
 */

export interface ExportFileResult {
  /** desktop = 主进程落盘；download = 浏览器下载。 */
  via: "desktop" | "download";
  /** 仅 desktop：文件落盘的绝对路径。 */
  path?: string;
}

/** 主进程桥的返回（与 desktop/export-fs.js 的 writeExport 对齐）。 */
interface DesktopWriteResult {
  ok: boolean;
  path?: string;
  name?: string;
  error?: string;
}

interface DesktopExportBridge {
  write: (fileName: string, content: string) => Promise<DesktopWriteResult>;
}

/** 桌面端是否有导出桥；界面据此决定按钮文案（导出到文件 / 下载 JSON）。 */
export function hasDesktopExportBridge(): boolean {
  return typeof window !== "undefined" && !!window.__heming_exports;
}

function desktopBridge(): DesktopExportBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.__heming_exports;
}

/**
 * 保存导出内容。
 *
 * @param fileName 建议以 .json 结尾（桌面桥只接受这一种后缀）
 * @param content 已序列化的完整文件内容
 * @throws 桌面桥写失败（返回 ok:false 或 IPC 异常）时抛错，由调用方给用户提示
 */
export async function saveExportFile(fileName: string, content: string): Promise<ExportFileResult> {
  const bridge = desktopBridge();
  if (bridge) {
    let result: DesktopWriteResult;
    try {
      result = await bridge.write(fileName, content);
    } catch (err) {
      throw new Error(`写入导出文件失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!result || !result.ok) {
      throw new Error(result?.error || "写入导出文件失败");
    }
    return { via: "desktop", path: result.path };
  }

  // 浏览器降级：Blob 只在内存里，不经过任何服务端。
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    // 无论点击是否抛错都从 DOM 摘掉，避免留下隐形节点
    anchor.remove();
  }
  // 延迟回收：部分浏览器在 click 之后才异步读取 blob，立刻 revoke 会得到空文件。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { via: "download" };
}
