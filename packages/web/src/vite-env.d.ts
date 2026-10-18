/// <reference types="vite/client" />

/**
 * 构建时注入的应用版本号（vite.config.ts define __APP_VERSION__）。
 * file:// 桌面端无法 fetch package.json，故用构建时内联。
 */
declare const __APP_VERSION__: string;
