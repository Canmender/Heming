/**
 * 三层记忆核心库入口（设计 §2–§4）。
 * 全部数据只落本机 localStorage（StorageLike 抽象），不上传、不进消息、不进 SQLite。
 */
export * from "./types.js";
export * from "./storage.js";
export * from "./tokenize.js";
export * from "./extract.js";
export * from "./store.js";
export * from "./recall.js";
export * from "./format.js";
export * from "./attribution.js";
export * from "./recallLog.js";
export * from "./usage.js";
export * from "./runRecorder.js";
export * from "./agentPrefs.js";
export * from "./kb.js";
export * from "./review.js";

import { MemoryStore } from "./store.js";

/**
 * 模块级单例：@ 触发链路与记忆页共用同一份本机记忆。
 * localStorage 不可用（隐私模式/配额异常）时由 storage.ts 自动降级为纯内存。
 */
export const memoryStore = new MemoryStore();
