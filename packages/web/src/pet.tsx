import React from "react";
import { createRoot } from "react-dom/client";
import { PetWindow } from "./components/pet/PetWindow.js";
import { hydrateSecureStorage } from "./lib/secureStorage.js";

/**
 * 桌宠窗口的独立入口（`pet.html`，由 Vite 多入口产出）。
 *
 * 为什么独立入口而不是在 main.tsx 里分支：
 * main.tsx 静态 import 了整个 App，即使写 `?hemingWindow=pet` 分支，浏览器照样会下载
 * 并解析整个应用 bundle（含聊天、Markdown、KaTeX…）。桌宠是常驻窗口，为一个
 * 300×420 的小角色背上一整套应用代码不合理，所以让它走自己的入口，只带 pixi + Live2D。
 *
 * ★ 不用 React.StrictMode：它在开发模式下会把 effect 执行两遍，
 *   而 Live2D 的 effect 会创建 WebGL 上下文与模型实例——双跑等于「建了又拆再建」，
 *   表现为开发时模型闪一下、GL 上下文泄漏。生产构建虽不受影响，但开发体验也是体验。
 */
const container = document.getElementById("root");
if (container) {
  /**
   * 桌宠入口也要等安全存储预热：`usePetChat` 要读模型 Key，读不到会回退同步桥，
   * 但先预取能省掉一次跨进程往返。同样是「短帽 + 继续」——桌宠是常驻窗口，
   * 不该因为安全存储不可用而白等（内部超时是给失败兜底的）。
   *
   * 与 main.tsx 一样不用模块顶层 await：入口异步化会让 Rolldown 的切块变碎。
   * 用 `.finally()` 挂渲染，语义等价。
   */
  const HYDRATE_CAP_MS = 300;
  void Promise.race([
    hydrateSecureStorage().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, HYDRATE_CAP_MS)),
  ]).finally(() => {
    createRoot(container).render(<PetWindow />);
  });
}
