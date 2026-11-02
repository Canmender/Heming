import { defineConfig } from "vitest/config";

// cacheDir 指向工作区 .tmp：默认会落到系统临时目录，沙箱/受限环境下写不了，
// vitest 会抛 unhandled error 并让退出码变成非 0（测试其实全过），根门禁因此红。
// 关于 TMPDIR/TEMP/TMP：**刻意不改**。
// WorkBuddy 的 fs 代理会随机拦截对临时目录的 writeFile，表现为
// 「测试全过但退出码非 0」的 EPERM unhandled error（与路径无关，指到工作区一样被拦）。
// 属于环境噪音，不要在这里试各种绕法。

export default defineConfig({
  cacheDir: "../../.tmp/vite/shared",
  test: {
    environment: "node",
    // vitest 5 把 clearMocks 的默认值改成了 true（每例前清空所有 mock 的调用记录）。
    // 本项目既有用例里存在「在 beforeAll / 模块顶层记录调用、在具体用例断言次数」的写法，
    // 吃新默认值等于批量改语义。这里显式关掉，保持 vitest 1.x 的原有语义。
    clearMocks: false,
  },
});
