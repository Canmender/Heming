/// <reference types="vite/client" />

/**
 * 构建时注入的应用版本号（vite.config.ts define __APP_VERSION__）。
 * file:// 桌面端无法 fetch package.json，故用构建时内联。
 */
declare const __APP_VERSION__: string;

/**
 * 桌面壳（preload.js contextBridge）暴露的桥接对象。
 * 浏览器直接访问时不存在——渲染层据此区分桌面端/浏览器端（设计 §5）。
 */
interface Window {
  heming?: {
    platform: string;
    [key: string]: unknown;
  };
}
