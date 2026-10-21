/**
 * 自我修改（self-modification）入口。
 *
 * 用户 2026-10-20 要求：为功能留接口，让内置智能体可以修改技能、记忆、MCP 等内容，
 * 辅助自身优化。对应两条通道：
 * - `tools.ts`：会话内工具（self.*），模型按需调用、即时生效；
 * - `guards.ts`：护栏（敏感信息、单轮上限、变更留痕、开关），两条通道共用判据。
 */
export * from "./guards.js";
export * from "./snapshots.js";
export * from "./tools.js";