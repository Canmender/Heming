/**
 * 模块包 JSX 运行时 shim（构建期由 Vite alias 注入到 `react/jsx-runtime`）。
 *
 * 模块包不打包自己的 React：运行时从 `globalThis.__hemingHost.jsx` 取宿主那份，
 * 保证与宿主同一个 React 实例（hooks 只在宿主 React 树里有效）。
 * 宿主未初始化时抛出可读错误——这属于宿主 bug（loader 必须先 installHostSdk()）。
 */
type JsxRuntime = {
  jsx: (...args: unknown[]) => unknown;
  jsxs: (...args: unknown[]) => unknown;
  Fragment: unknown;
};

function runtime(): JsxRuntime {
  const host = (globalThis as { __hemingHost?: { jsx?: JsxRuntime } }).__hemingHost;
  if (!host || !host.jsx) {
    throw new Error("模块包加载失败：宿主 React JSX 运行时尚未初始化（先调用 installHostSdk()）");
  }
  return host.jsx;
}

export const Fragment = runtime().Fragment as never;
export const jsx = ((...args: unknown[]) => runtime().jsx(...args)) as never;
export const jsxs = ((...args: unknown[]) => runtime().jsxs(...args)) as never;
