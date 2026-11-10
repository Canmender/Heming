/**
 * 模块包构建配置（由 `scripts/build-web-module.mjs` 调用，MODULE_ID 环境变量指定模块）。
 *
 * 关键约束：
 * - root 指向 `packages/modules/<id>`，产物只含模块自身代码；
 * - `react` / `react/jsx-runtime` alias 到 sdk shim（运行时读 `globalThis.__hemingHost`），
 *   构建产物里**不得出现 React 本体**——这是模块与宿主共享 hooks 实例的前提；
 * - ESM 单文件输出，便于宿主 `import()` 与安装端按 path 提供。
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const moduleId = process.env.MODULE_ID;
if (!moduleId) throw new Error("缺少 MODULE_ID（由 scripts/build-web-module.mjs 注入）");

const moduleRoot = fileURLToPath(new URL(`../modules/${moduleId}`, import.meta.url));
const sdkRoot = fileURLToPath(new URL("../modules/sdk", import.meta.url));

export default defineConfig({
  root: moduleRoot,
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^react\/jsx-runtime$/, replacement: `${sdkRoot}/jsx-runtime.ts` },
      { find: /^react$/, replacement: `${sdkRoot}/react.ts` },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    minify: false,
    lib: {
      entry: `${moduleRoot}/src/index.tsx`,
      formats: ["es"],
      fileName: () => "entry.js",
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify("module-build"),
  },
});
