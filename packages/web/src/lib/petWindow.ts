/**
 * 桌宠窗口的地址判定（d.46）。
 *
 * 与通话窗口同源同模式：桌宠是**独立渲染进程**（Electron 下是独立 BrowserWindow），
 * 有自己的 React 根、自己的 Live2D 舞台、自己直连本机 LLM。同源意味着
 * localStorage 里的模型连接配置天然共享，不需要额外传凭证。
 *
 * 窗口由**主进程**创建（要透明穿透、位置记忆、单例），web 端只负责「我是不是桌宠窗」。
 * 所以这里没有 openXxxWindow()——那条路会把窗口控制权拆到两个地方。
 */

/** 与 packages/desktop/pet-window.js 的 PET_WINDOW_FLAG 对齐。 */
export const PET_WINDOW_FLAG = "hemingWindow";
export const PET_WINDOW_VALUE = "pet";

/** 当前地址是否属于桌宠窗口。 */
export function isPetWindow(search: string): boolean {
  if (typeof search !== "string" || !search) return false;
  try {
    const q = new URLSearchParams(search);
    return q.get(PET_WINDOW_FLAG) === PET_WINDOW_VALUE;
  } catch {
    return false;
  }
}
