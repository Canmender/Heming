/**
 * 上下文预算与压缩核心库入口（设计 §3）。
 * 全部逻辑本机执行：零新增 npm 依赖、不调网络、不 import React；
 * 数据只落本机 localStorage（StorageLike 抽象），损坏回退默认值。
 */
export * from "./types.js";
export * from "./tokens.js";
export * from "./budget.js";
export * from "./summary.js";
export * from "./settings.js";
export * from "./store.js";
export * from "./history.js";

import { SummaryCache } from "./store.js";

/**
 * 模块级单例：@ 触发链路共用的摘要缓存（与 memory/skills 的单例同模式）。
 * localStorage 不可用时由 memory/storage.ts 自动降级为纯内存。
 */
export const summaryCache = new SummaryCache();
