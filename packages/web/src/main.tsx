import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { CallWindow } from "./components/CallWindow.js";
import { parseCallWindowParams } from "./lib/callWindow.js";
import "./index.css";
import "katex/dist/katex.min.css";

/**
 * 独立通话窗口（`?hemingWindow=call`）：只渲染通话面板，不挂整个 App。
 * 同源所以共用 localStorage 里的 token，WS/WebRTC 都由这个窗口自己建。
 */
const isCallWindow = parseCallWindowParams(window.location.search) !== null;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isCallWindow ? <CallWindow /> : <App />}
  </React.StrictMode>,
);
