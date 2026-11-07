// 从 vitest/config 导 defineConfig：vitest 5 起不再给 vite 的 UserConfig 补 test 字段
// （与 packages/web/vite.config.ts 同一口径）。
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * 桌宠界面插件包的独立构建。
 *
 * 产物目录是 `dist/package/files/`——直接就是插件包里的 `files/**`：
 * 主进程按 `widget://heming.pet/files/index.html` 加载它（包根另有 plugin.json）。
 *
 * ★ `base: "./"` 而不是绝对路径：插件按版本落在 `userData/plugins/heming.pet/<version>/files/`，
 *   相对 base 让资源与动态 import 的 chunk 都跟着文档 URL 走，换版本 / 换安装根都不用改配置。
 * ★ pixi 与 pixi-live2d-display 仍由 `useLive2D` 动态 import——它们只服务这个常驻小窗，
 *   不该进首屏 chunk（体量与 d.46 的论证一致）。
 */
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist/package/files",
    emptyOutDir: true,
    // 目标是 Electron 45 自带的 Chromium（与宿主同一运行时），不用为老旧浏览器降级
    target: "chrome130",
    rollupOptions: {
      input: fileURLToPath(new URL("./index.html", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // 与 web 同口径：不因 vitest 5 的 clearMocks 新默认值改变既有断言语义
    clearMocks: false,
  },
});
