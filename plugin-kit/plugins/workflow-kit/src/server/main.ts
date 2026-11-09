/**
 * 服务入口：读配置 → 建存储/运行时/调度器 → 起 HTTP（REST + MCP + 静态页）。
 *
 * 单独一个本机进程是这套插件的边界：和鸣只通过 MCP（和浏览器通过 HTTP）与它对话；
 * 它不读和鸣的数据、不写和鸣的键，停掉它等于关掉这个能力。
 */

import { loadConfig } from "./config.js";
import { createStore } from "./storage.js";
import { createRuntime } from "./runtime.js";
import { createScheduler } from "./scheduler.js";
import { createHttpServer } from "./http.js";
import { registerAllNodes } from "../nodes/index.js";
import { appVersion } from "../version.js";

const VERSION = appVersion();

async function main(): Promise<void> {
  const config = loadConfig();
  // 让节点读环境变量时拿到的就是最终配置（env 优先、其次 data/config.json）。
  // LLM / 通知节点不需要 import 服务端模块，避免「节点 → server」的反向依赖。
  process.env.WF_DATA_DIR = config.dataDir;
  if (config.llm) {
    process.env.WF_LLM_BASE_URL = config.llm.baseUrl;
    process.env.WF_LLM_API_KEY = config.llm.apiKey;
    process.env.WF_LLM_MODEL = config.llm.model;
  }
  registerAllNodes();
  const store = createStore(config.dataDir);
  const runtime = createRuntime(store, config);
  const scheduler = createScheduler(store, runtime);
  const server = createHttpServer({ store, runtime, scheduler, config, version: VERSION });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });

  const base = `http://${config.host}:${config.port}`;
  console.log("");
  console.log("  工作流引擎（独立插件）已启动");
  console.log(`  编辑器      ${base}/`);
  console.log(`  MCP 地址    ${base}/mcp`);
  console.log(`  数据目录    ${config.dataDir}`);
  console.log(`  模型连接    ${config.llm ? `${config.llm.model}（${config.llm.baseUrl}）` : "未配置（大模型节点会提示）"}`);
  console.log(`  工作流 ${store.listWorkflows().length} 条 · 执行记录 ${store.listExecutions().length} 条`);
  console.log("");
  scheduler.start();

  const shutdown = (signal: string) => {
    console.log(`\n收到 ${signal}，正在停止…`);
    scheduler.stop();
    server.close(() => process.exit(0));
    // 兜底：10 秒内没关干净就强退（本机服务，不需要等长连接收尾）
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("启动失败：", error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
