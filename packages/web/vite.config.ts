// 从 vitest/config 导 defineConfig：vitest 5 起不再给 vite 的 UserConfig 补 test 字段，
// 继续从 "vite" 导会让 `test` 报 TS2769「'test' does not exist in type UserConfigExport」。
// vitest 的 defineConfig 同时接受 vite 配置项（plugins/build/server 等），行为不变。
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import appPkg from "../desktop/package.json";

// 缓存落工作区 .tmp：默认写系统临时目录在沙箱下会 EPERM（见 shared/server 同理）
//
// 关于 TMPDIR/TEMP/TMP：**刻意不改**。
// WorkBuddy 的 fs 代理会拦截对临时目录的 writeFile，表现为
// 「测试全过但退出码非 0」的 EPERM unhandled error。
// 这个拦截是**随机的**（同一命令连跑三次，命中与否各不相同），
// 且与路径无关——指到工作区 .tmp/tmp 一样被拦。
// 所以它属于环境噪音，不要在这里试各种绕法；server/shared 两包同理。


/** 开发态模块包：把 packages/modules/<dir>/dist 以 /__modules__/<包 id>/* 挂到 vite dev server。
 * 生产桌面走 app:// 协议；两者路径语义一致，便于浏览器里直接验证模块包。
 *
 * 包 id 与源目录名不是一回事（首方模块目录保持短名、包 id 带 `heming.` 前缀），
 * 所以这里扫一遍 packages/modules 下每个目录的 module.json，建「包 id → 目录名」索引；
 * 没有清单的目录（本地样例）按目录名回退。 */
function moduleDirIndex(root: string): Map<string, string> {
  const index = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return index;
  }
  for (const name of names) {
    try {
      const manifestPath = resolve(root, name, "module.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { id?: unknown };
      if (typeof manifest.id === "string" && manifest.id) index.set(manifest.id, name);
    } catch {
      // 坏清单只是 dev 便利功能：忽略该项，按目录名回退即可
    }
  }
  return index;
}

function modulesDevServer() {
  const root = fileURLToPath(new URL("../modules", import.meta.url));
  return {
    name: "heming-modules-dev",
    apply: "serve" as const,
    configureServer(server: { middlewares: { use: (route: string, fn: (req: { url?: string }, res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (b?: string | Buffer) => void; }, next: () => void) => void) => void } }) {
      const dirs = moduleDirIndex(root);
      server.middlewares.use("/__modules__", (req, res, next) => {
        const url = decodeURIComponent((req.url || "").split("?")[0] || "");
        const match = /^\/([a-z0-9][a-z0-9._-]{0,63})\/(.+)$/.exec(url);
        if (!match) return next();
        const [, id, rel] = match;
        if (rel.includes("..") || rel.startsWith("/") || rel.includes("\\")) {
          res.statusCode = 400;
          res.end("bad path");
          return;
        }
        // 包 id → 源目录（内置模块目录是短名）；没有清单时按目录名回退。
        const dir = dirs.get(id) ?? id;
        const file = resolve(root, dir, "dist", rel);
        if (!existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end("module build not found");
          return;
        }
        const type = extname(file) === ".js" ? "text/javascript; charset=utf-8" : "application/octet-stream";
        res.setHeader("Content-Type", type);
        res.setHeader("Cache-Control", "no-store");
        res.end(readFileSync(file));
      });
    },
  };
}

export default defineConfig({
  cacheDir: "../../.tmp/vite/web",
  plugins: [react(), modulesDevServer()],
  define: {
    // 注入**应用**版本（5 段 d.x.y.z.w），不是 web 包自己的 version。
    // 早先这里读 `./package.json`，拿到的是 @heming/web 的版本，主页徽标因此
    // 永远显示「版本 v0.0.1」，跟设置区、CHANGELOG、安装包对不上。
    // 文件路径是构建期静态读入，不进浏览器包，也就不存在 file:// 下 fetch 不到的问题。
    __APP_VERSION__: JSON.stringify(appPkg.hemingVersion ?? appPkg.version),
  },
  server: {
    proxy: {
      // 本机可能同时跑着别的服务（8787 被占时用 HEMING_DEV_API 指到临时端口自测）
      "/api": {
        target: process.env.HEMING_DEV_API ?? "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    // 单入口（d.94：桌宠拆成界面插件，独立构建为 plugin-kit/plugins/pet-widget 的 package.tgz；
    // 主窗产物里不再有 pet 入口 / pixi / Live2D）。
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // vitest 5 把 clearMocks 的默认值改成了 true（每例前清空所有 mock 的调用记录）。
    // 本项目既有用例里存在「在 beforeAll / 模块顶层记录调用、在具体用例断言次数」的写法，
    // 吃新默认值等于批量改语义。这里显式关掉，保持 vitest 1.x 的原有语义；
    // 全仓 526 处 vi.fn 因此不需要为迁就新默认值而改。
    clearMocks: false,
    // 限制并发 worker：这台机器 32 逻辑核，vitest 默认会把 worker 开到接近核数，
    // 而 214 个 jsdom 文件同时跑时，**懒加载 chunk 的解析会被饿死**——
    // d39 的 `settleRoutedPage`（等 `page-fallback` 消失，5s 预算）与 App 的
    // 「关弹窗后 Ctrl+K 开命令面板」在满并发下会稳定超时，单跑或低并发必过。
    // 这不是产品缺陷：树莓派级 CPU 争用下，动态 import 与 React 提交都变慢。
    // 8 个 worker 给渲染线程留出余量，全量 web 用例从 ~30s 变成 ~60s，门禁因此可复现。
    maxWorkers: 8,
  },
});
