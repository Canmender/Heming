import type { ComponentType } from "react";
import { installHostSdk } from "./host-sdk.js";

/**
 * 宿主加载式模块包（d.131）：已安装的首方模块包在运行时 `import()` 进主窗口，
 * 与宿主共享同一棵 React 树 / stores。
 *
 * 加载地址：
 * - 开发（vite）：`/__modules__/<id>/entry.js`（由 vite 插件从 `packages/modules/<id>/dist` 提供）；
 * - 桌面安装版：`app://heming/modules/<id>/<version>/files/web/entry.js`（app-protocol 只读路由，
 *   只服务已安装且验签过的模块目录）；
 * - 测试/特殊环境：可用 `globalThis.__HEMING_MODULE_BASE` 覆盖 base（仍拼 `/<id>/entry.js`）。
 *
 * 任何一项校验失败都不渲染空壳：调用方（runtime）回退内置实现或显示「模块加载失败」。
 */

export interface WebModuleManifest {
  id: string;
  version: string;
}

export interface WebModuleEntry {
  manifest: WebModuleManifest;
  /** page id → React 组件（与 module registry 的 page 对齐）。 */
  pages?: Record<string, ComponentType>;
  /** 登录后常驻的后台组件（宿主按生效状态渲染 <Background active={...}/>；未安装/停用即卸载）。 */
  background?: Record<string, ComponentType<{ active: boolean }>>;
  /** 首页卡片组件（宿主按槽位渲染）。 */
  homeCards?: Record<string, ComponentType>;
  /** 设置卡：{ id, title, Component }[]。 */
  settings?: Array<{ id: string; title: string; Component: ComponentType }>;
  /** 工具 provider（能力注册表用；模块自己实现工具桥）。 */
  toolProviders?: unknown[];
}

const cache = new Map<string, Promise<WebModuleEntry>>();

export function webModuleBaseUrl(): string {
  const override = (globalThis as { __HEMING_MODULE_BASE?: unknown }).__HEMING_MODULE_BASE;
  if (typeof override === "string" && override.trim()) return override.trim().replace(/\/+$/, "");
  // vite dev 走中间件；生产桌面走 app:// 路由（由 module-store 提供版本路径）
  if (import.meta.env?.DEV) return "/__modules__";
  return "app://heming/modules";
}

interface InstalledWebModule {
  id: string;
  version: string;
  name?: string;
  entry: string;
}

declare global {
  interface Window {
    /** 桌面 preload 注入（d.131）；浏览器/测试没有。 */
    __heming_modules?: { webList: () => Promise<InstalledWebModule[]> };
  }
}

/**
 * 解析模块入口 URL：
 * - 桌面安装版：问主进程要已安装清单，拼 app://heming/modules/<id>/<version>/<entry>
 *   （app:// 协议层会再校验「已安装 + 路径夹取」）；
 * - 浏览器 dev：`/__modules__/<id>/entry.js`（vite 中间件从 packages/modules/<id>/dist 提供）；
 * - 其它环境没有模块包来源，直接报未安装（不静默回退到内置实现——迁移完成后本体不再有实现）。
 */
export async function resolveWebModuleEntryUrl(id: string): Promise<string> {
  const bridge = typeof window !== "undefined" ? window.__heming_modules : undefined;
  if (bridge?.webList) {
    const list = await bridge.webList();
    const record = list.find((item) => item && item.id === id);
    if (!record || typeof record.entry !== "string" || !record.version) {
      throw new Error(`模块「${id}」未安装或没有 web 入口`);
    }
    const entry = record.entry.replace(/^\/+/, "");
    return `app://heming/modules/${encodeURIComponent(id)}/${encodeURIComponent(record.version)}/${entry}`;
  }
  if (import.meta.env?.DEV) return webModuleEntryUrl(id);
  throw new Error(`模块「${id}」不可用：当前环境没有模块包来源`);
}

export function webModuleEntryUrl(id: string): string {
  return `${webModuleBaseUrl()}/${encodeURIComponent(id)}/entry.js`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 校验模块包导出形状；不合格抛中文错误（调用方捕获后降级/显示原因）。 */
export function assertWebModule(id: string, mod: unknown): WebModuleEntry {
  if (!isObject(mod)) throw new Error(`模块 ${id} 的 entry.js 没有导出对象`);
  const manifest = isObject(mod.manifest) ? mod.manifest : null;
  if (!manifest || typeof manifest.id !== "string" || typeof manifest.version !== "string") {
    throw new Error(`模块 ${id} 缺少合法 manifest（id/version）`);
  }
  if (manifest.id !== id) throw new Error(`模块 ${id} 的 manifest.id 是 ${String(manifest.id)}，与安装 id 不一致`);
  const pages = mod.pages;
  if (!isObject(pages) || Object.keys(pages).length === 0) {
    throw new Error(`模块 ${id} 没有导出任何页面`);
  }
  for (const [pageId, component] of Object.entries(pages)) {
    if (typeof component !== "function") throw new Error(`模块 ${id} 的页面 ${pageId} 不是 React 组件`);
  }
  return mod as unknown as WebModuleEntry;
}

/** 加载并缓存模块；失败不缓存（下次重试）。 */
export function loadWebModule(id: string): Promise<WebModuleEntry> {
  const existing = cache.get(id);
  if (existing) return existing;
  const task = (async () => {
    installHostSdk();
    const url = await resolveWebModuleEntryUrl(id);
    const mod = (await import(/* @vite-ignore */ url)) as unknown;
    return assertWebModule(id, mod);
  })().catch((err) => {
    cache.delete(id);
    throw err;
  });
  cache.set(id, task);
  return task;
}

/** 测试用：清缓存。 */
export function resetWebModuleCacheForTests(): void {
  cache.clear();
}
