/**
 * 运行配置：环境变量优先，其次 `data/config.json`，最后默认值。
 *
 * 为什么要配置文件 + 环境变量两层：本机服务由用户自己启动，环境变量适合临时试；
 * 长期设置（端口、模型连接）写进 data/config.json 更省事。两层都只读本机，
 * 不联网、不上报。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface LlmConfig {
  /** OpenAI 兼容地址（不含 /chat/completions），例如 https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface WorkflowConfig {
  host: "127.0.0.1";
  port: number;
  dataDir: string;
  llm?: LlmConfig;
  /** 单次执行上限（毫秒）；与引擎的 maxExecutionMs 语义一致。 */
  maxExecutionMs: number;
  /** 项目根（public/ 与 plugin/ 所在目录）。 */
  rootDir: string;
}

/** 项目根：dist/server/config.js → 上两级。 */
export function projectRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return resolve(here, "..", "..", "..");
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // 配置坏了不能让服务起不来：回落默认值，用户可删 data/config.json 重来。
    return {};
  }
}

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 读配置（不抛错；坏值回落默认）。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkflowConfig {
  const rootDir = projectRoot();
  const dataDir = resolve(env.WF_DATA_DIR || join(rootDir, "data"));
  const file = readJsonFile(join(dataDir, "config.json"));

  const llmRaw = (file.llm ?? {}) as Record<string, unknown>;
  const baseUrl = String(env.WF_LLM_BASE_URL ?? llmRaw.baseUrl ?? "").trim();
  const apiKey = String(env.WF_LLM_API_KEY ?? llmRaw.apiKey ?? "").trim();
  const model = String(env.WF_LLM_MODEL ?? llmRaw.model ?? "").trim();
  const llm: LlmConfig | undefined =
    baseUrl && model ? { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model } : undefined;

  return {
    host: "127.0.0.1",
    port: positiveInt(env.WF_PORT ?? file.port, 8777),
    dataDir,
    llm,
    maxExecutionMs: positiveInt(env.WF_MAX_EXECUTION_MS ?? file.maxExecutionMs, 10 * 60 * 1000),
    rootDir,
  };
}

/** 可公开给前端的配置（**不含 apiKey**）。 */
export function publicConfig(config: WorkflowConfig): {
  llm: { configured: boolean; baseUrl?: string; model?: string };
  mcpUrl: string;
} {
  return {
    llm: config.llm
      ? { configured: true, baseUrl: config.llm.baseUrl, model: config.llm.model }
      : { configured: false },
    mcpUrl: `http://${config.host}:${config.port}/mcp`,
  };
}
