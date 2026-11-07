import React from "react";
import { createRoot } from "react-dom/client";
import { PetWindow } from "./components/pet/PetWindow.js";

/**
 * 桌宠小组件的入口（插件包 `files/index.html`，由 `pnpm --filter @heming/pet-widget build` 产出）。
 *
 * d.97 之前它是本体 web 的第二个 Vite 入口（`pet.html`）；现在整个包跑在宿主的
 * 独立 origin `widget://heming.pet/files/index.html` 下：
 * - **没有宿主 localStorage**（不同 origin），偏好/主题/事件全部经 `window.__heming_widget`；
 * - **没有 Node、没有密钥桥**（preload 是最小桥，见规格 §3.4 / §6）；
 * - 仍然只带 pixi + Live2D（动态 import），不为这个常驻小窗加载主应用代码。
 *
 * ★ 不用 React.StrictMode：它在开发模式下会把 effect 执行两遍，而 Live2D 的 effect
 *   会创建 WebGL 上下文与模型实例——双跑等于「建了又拆再建」，表现为开发时模型闪一下、
 *   GL 上下文泄漏。生产构建虽不受影响，但开发体验也是体验。
 */
const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<PetWindow />);
}
