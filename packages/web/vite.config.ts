import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import appPkg from "../desktop/package.json";

// 缓存落工作区 .tmp：默认写系统临时目录在沙箱下会 EPERM（见 shared/server 同理）
//
// 关于 TMPDIR/TEMP/TMP：**刻意不改**。
// WorkBuddy 的 fs 代理会拦截对临时目录的 writeFile，表现为
// 「测试全过但退出码非 0」的 EPERM unhandled error。
// 这个拦截是**随机的**（同一命令连跑三次，命中与否各不相同），
// 且与路径无关——指到工作区 .tmp/tmp 一样被拦。
// 所以它属于环境噪音，不要在这里试各种绕法；server/shared 两包同理。

export default defineConfig({
  cacheDir: "../../.tmp/vite/web",
  plugins: [react()],
  define: {
    // 注入**应用**版本（5 段 d.x.y.z.w），不是 web 包自己的 version。
    // 早先这里读 `./package.json`，拿到的是 @heming/web 的版本，主页徽标因此
    // 永远显示「版本 v0.0.1」，跟设置区、CHANGELOG、安装包对不上。
    // 文件路径是构建期静态读入，不进浏览器包，也就不存在 file:// 下 fetch 不到的问题。
    __APP_VERSION__: JSON.stringify(appPkg.hemingVersion ?? appPkg.version),
  },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true, ws: true },
    },
  },
  build: {
    rollupOptions: {
      // 两个入口：主应用与桌宠。桌宠独立成页，才能不把整个应用 bundle 拖进
      // 那个常驻的 300×420 透明窗口（见 src/pet.tsx 顶部注释）。
      input: {
        main: resolve(__dirname, "index.html"),
        pet: resolve(__dirname, "pet.html"),
      },
    },
  },
  test: { environment: "jsdom", globals: true, setupFiles: ["./src/test-setup.ts"] },
});
