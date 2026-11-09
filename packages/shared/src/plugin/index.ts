/**
 * 插件体系 v5 地基（d.104）：版本兼容 / 清单解析 / 能力单元 / 市场索引。
 *
 * 这四个模块是 web / server / 脚本的**共同契约**，禁止各端各写一份：
 * - `version`：5 段版本比较与 `engines.heming`（最小宿主版本）；
 * - `manifest`：v5 清单解析（v1–v4 仍由 web 侧旧解析器负责，再 `toV5View` 投射）；
 * - `unit`：统一能力单元与贡献点（system / builtin / package / bundle 四类来源与准入表）；
 * - `market`：云端市场索引 v2 的 schema 与纯函数（过滤/选版本/比较）。
 */

export * from "./version.js";
export * from "./manifest.js";
export * from "./unit.js";
export * from "./market.js";
export * from "./widget.js";
