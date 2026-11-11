import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { HOST_FILES } from "./host-sdk.generated.js";

/**
 * 宿主侧「模块包 SDK」：把宿主 React/共享模块挂到 `globalThis.__hemingHost`，
 * 供已安装模块包（`packages/modules/<id>/dist/entry.js`）在运行时读取。
 *
 * 为什么用全局对象而不是 import map / 裸模块名：
 * - 模块包是**首方签名、安装后才存在**的文件，路径在构建期未知；
 * - 全局对象让模块包构建产物只依赖一个稳定的运行时契约，不依赖宿主 bundle 的导出形态；
 * - React 必须是宿主这一份（同一实例），所以这里显式转发，模块包构建时被 alias 到 shim。
 *
 * 安全：只有首方签名的模块包会被 loader 加载；这是受信任代码路径，不是沙箱。
 */

export interface HostReactApi {
  createElement: typeof React.createElement;
  useState: typeof React.useState;
  useEffect: typeof React.useEffect;
  useMemo: typeof React.useMemo;
  useCallback: typeof React.useCallback;
  useRef: typeof React.useRef;
  useReducer: typeof React.useReducer;
  useContext: typeof React.useContext;
  useLayoutEffect: typeof React.useLayoutEffect;
  useSyncExternalStore: typeof React.useSyncExternalStore;
  useDebugValue: typeof React.useDebugValue;
  useId: typeof React.useId;
  useDeferredValue: typeof React.useDeferredValue;
  startTransition: typeof React.startTransition;
}

export interface HostJsxApi {
  jsx: typeof jsx.jsx;
  jsxs: typeof jsx.jsxs;
  Fragment: typeof jsx.Fragment;
}

export interface HostSdk {
  react: HostReactApi;
  jsx: HostJsxApi;
  /** 共享模块命名空间：模块包构建期扫描出的宿主文件路径 → 模块导出。 */
  files: Record<string, unknown>;
}

declare global {
  // eslint-disable-next-line no-var
  var __hemingHost: HostSdk | undefined;
}

/** 安装（幂等）。loader 在 import 任何模块包之前必须先调用。 */
export function installHostSdk(): HostSdk {
  if (globalThis.__hemingHost) return globalThis.__hemingHost;
  const sdk: HostSdk = {
    react: {
      createElement: React.createElement,
      useState: React.useState,
      useEffect: React.useEffect,
      useMemo: React.useMemo,
      useCallback: React.useCallback,
      useRef: React.useRef,
      useReducer: React.useReducer,
      useContext: React.useContext,
      useLayoutEffect: React.useLayoutEffect,
      useSyncExternalStore: React.useSyncExternalStore,
      useDebugValue: React.useDebugValue,
      useId: React.useId,
      useDeferredValue: React.useDeferredValue,
      startTransition: React.startTransition,
    },
    jsx: { jsx: jsx.jsx, jsxs: jsx.jsxs, Fragment: jsx.Fragment },
    files: HOST_FILES,
  };
  globalThis.__hemingHost = sdk;
  return sdk;
}

export function getHostSdk(): HostSdk {
  if (!globalThis.__hemingHost) throw new Error("宿主 SDK 未初始化：先调用 installHostSdk()");
  return globalThis.__hemingHost;
}

/** 测试用：清掉全局（生产不需要）。 */
export function resetHostSdkForTests(): void {
  globalThis.__hemingHost = undefined;
}
