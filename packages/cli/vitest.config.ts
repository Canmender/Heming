import { defineConfig } from "vitest/config";

// 与 packages/server/vitest.config.ts 同口径：
// - cacheDir 指到工作区 .tmp（默认系统临时目录在受限沙箱里写不了，会让「测试全过但退出码非 0」）；
// - clearMocks 保持 1.x 语义（vitest 5 默认 true，本仓既有写法依赖旧的 false）。
export default defineConfig({
  cacheDir: "../../.tmp/vite/cli",
  test: {
    environment: "node",
    clearMocks: false,
  },
});
