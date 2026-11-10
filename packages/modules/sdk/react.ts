/**
 * 模块包 React shim（构建期由 Vite alias 注入到 `react`）。
 *
 * 只导出模块实际会用的 hooks/API；每加一项都要在宿主 `lib/modules/host-sdk.ts`
 * 里有对应实现（两边都是手写，保持最小面）。模块包不得自带 React。
 */
type HostReact = Record<string, unknown> & {
  createElement: (...args: unknown[]) => unknown;
  useState: (...args: unknown[]) => unknown;
  useEffect: (...args: unknown[]) => unknown;
  useMemo: (...args: unknown[]) => unknown;
  useCallback: (...args: unknown[]) => unknown;
  useRef: (...args: unknown[]) => unknown;
  startTransition: (...args: unknown[]) => unknown;
};

function hostReact(): HostReact {
  const host = (globalThis as { __hemingHost?: { react?: HostReact } }).__hemingHost;
  if (!host || !host.react) {
    throw new Error("模块包加载失败：宿主 React 尚未初始化（先调用 installHostSdk()）");
  }
  return host.react;
}

export const createElement = ((...args: unknown[]) => hostReact().createElement(...args)) as never;
export const useState = ((...args: unknown[]) => hostReact().useState(...args)) as never;
export const useEffect = ((...args: unknown[]) => hostReact().useEffect(...args)) as never;
export const useMemo = ((...args: unknown[]) => hostReact().useMemo(...args)) as never;
export const useCallback = ((...args: unknown[]) => hostReact().useCallback(...args)) as never;
export const useRef = ((...args: unknown[]) => hostReact().useRef(...args)) as never;
export const startTransition = ((...args: unknown[]) => hostReact().startTransition(...args)) as never;
export default hostReact;
