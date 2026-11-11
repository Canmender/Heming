import type { WebModuleEntry } from "./webModules.js";

/**
 * 云端插件（模块包）安装/卸载（d.133）。
 *
 * 网页不下载、不解包：只把 id@version 交给主进程，由 `module-installer.js` 从更新源
 * 下载官方签名包并交给 module-store 验签落盘。浏览器开发态没有桥，安装只改本地开关
 * （vite 中间件直接提供本地构建产物），所以这里返回 no-op。
 *
 * 注意：这里的「模块」是历史内部叫法，用户界面统一叫**插件**。
 */

function bridge() {
  return typeof window !== "undefined" ? window.__heming_modules : undefined;
}

/** 当前环境是否有「下载安装插件」能力（桌面端）。 */
export function moduleInstallSupported(): boolean {
  return typeof bridge()?.install === "function";
}

/** 下载并安装一个插件包；浏览器开发态直接返回（本地构建已在 vite 中间件里）。 */
export async function installPluginPackage(id: string, version: string): Promise<void> {
  const target = bridge();
  if (!target?.install) return;
  const normalized = String(version || "").trim().replace(/^v/i, "");
  if (!normalized) throw new Error(`插件「${id}」缺少可下载的版本号`);
  await target.install(id, normalized);
}

/** 卸载插件包（只删安装记录/文件，不删业务数据）。 */
export async function removePluginPackage(id: string): Promise<void> {
  const target = bridge();
  if (!target?.remove) return;
  await target.remove(id);
}

export type { WebModuleEntry };
