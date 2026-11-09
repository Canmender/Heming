import { defineConfig } from "vitest/config";

/**
 * 测试配置：只跑 `src/` 下的测试。
 *
 * 为什么显式 exclude `dist`：`pnpm build` 会把 `*.test.ts` 也编译进 `dist/`，
 * 不排除的话 `pnpm test` 会把「编译过的旧测试」再跑一遍——旧产物里可能还引用着
 * 已经删除的模块，出现「源码全绿、dist 报模块不存在」的假失败。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "public/**"],
    environment: "node",
  },
});
