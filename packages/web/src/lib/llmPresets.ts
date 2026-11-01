import type { LlmProvider } from "../store/llm.js";

/**
 * 常用模型服务商预设：点一下自动填好「协议 / Base URL / 模型」。
 *
 * 只做「省去手抄地址」这一件事——所有字段在表单里仍可再改，
 * 私有部署 / 代理网关直接手填 Base URL 即可，预设不限制。
 */
export interface LlmPreset {
  id: string;
  label: string;
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  /** 一句话说明，悬停提示用。 */
  note: string;
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    provider: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    note: "国内直连；deepseek-reasoner 会带思考过程",
  },
  {
    id: "moonshot",
    label: "Moonshot",
    provider: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    note: "Kimi 系列，长上下文",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    provider: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    note: "GLM 系列，开源兼容端点",
  },
  {
    id: "qwen",
    label: "通义千问",
    provider: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    note: "阿里云百炼（DashScope）兼容模式",
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    provider: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen2.5-7B-Instruct",
    note: "一站式多模型托管",
  },
  {
    id: "ollama",
    label: "Ollama 本地",
    provider: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:7b",
    note: "本机模型，Key 随便填",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    note: "Claude 官方，消息结构与 OpenAI 不同",
  },
  {
    id: "magpie",
    label: "magpie 本地网关",
    provider: "openai",
    baseUrl: "http://127.0.0.1:3425/v1",
    model: "gpt-4o",
    note: "本机自跑 magpie（github.com/yetone/magpie）时的入口：订阅账号、多 Key 轮换与额度选路交给它，和鸣这边只填它发的网关 Key。模型名照 `magpie models` 改写（写作 provider/model），路由组写作 group/<id>",
  },
];

/** 按 id 找预设；未知 id 返回 null（设置区据此忽略点击）。 */
export function findPreset(id: string): LlmPreset | null {
  return LLM_PRESETS.find((p) => p.id === id) ?? null;
}