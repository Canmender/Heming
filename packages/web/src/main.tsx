import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { hydrateSecureStorage } from "./lib/secureStorage.js";
import "./index.css";
import "katex/dist/katex.min.css";

/**
 * 安全存储预热：把三个低频键（llmConfigs / mcp.servers / e2e.identity）预取进内存缓存，
 * 之后渲染层的同步读取命中缓存、零 IPC。
 *
 * 为什么是「短帽 + 继续」而不是直接 await：
 * - hydrate 内部自带超时兜底，但那是给**失败**用的；安全存储不可用时直接 await
 *   等于每次启动白等数秒——启动回归，用户第一时间就能感觉到。
 * - 所以外面套一层 300ms 帽：绝大多数机器在这之内完成预取；超时就先渲染，
 *   读取走现有同步桥兜底（Electron 45 上完全可用），晚到的 hydrate 结果由 store 侧补。
 * - fire-and-forget 的语义不变：失败静默，绝不影响启动。
 *
 * 为什么不用模块顶层 `await`：入口一旦变成 async 模块，Rolldown 不再把首屏依赖
 * 合并进入口 chunk，实测会碎成 20+ 个预载块、gzip 反而更大。这里用 `.finally()`
 * 挂渲染，语义等价（等 race 落定再渲染），但入口保持同步模块、切块正常。
 */
const HYDRATE_CAP_MS = 300;
const root = document.getElementById("root")!;
void Promise.race([
  hydrateSecureStorage().catch(() => undefined),
  new Promise<void>((resolve) => setTimeout(resolve, HYDRATE_CAP_MS)),
]).finally(() => {
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
