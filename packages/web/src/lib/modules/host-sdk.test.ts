import { describe, it, expect, afterEach } from "vitest";
import {
  getHostSdk,
  installHostSdk,
  resetHostSdkForTests,
} from "./host-sdk.js";

afterEach(() => {
  resetHostSdkForTests();
});

describe("host-sdk（模块包与宿主共享 React 的入口）", () => {
  it("installHostSdk：幂等，React/JSX 是宿主这一份", () => {
    const first = installHostSdk();
    const second = installHostSdk();
    expect(second).toBe(first);
    expect(typeof first.react.useState).toBe("function");
    expect(typeof first.react.createElement).toBe("function");
    expect(typeof first.jsx.jsx).toBe("function");
    expect(first.files).toEqual({});
  });

  it("未初始化时 getHostSdk 抛可读错误", () => {
    expect(() => getHostSdk()).toThrow(/先调用 installHostSdk/);
  });
});
