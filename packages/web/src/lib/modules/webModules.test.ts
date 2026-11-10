import { describe, it, expect, afterEach } from "vitest";
import {
  assertWebModule,
  resetWebModuleCacheForTests,
  webModuleBaseUrl,
  webModuleEntryUrl,
} from "./webModules.js";
import { resetHostSdkForTests } from "./host-sdk.js";

const page = () => null;

afterEach(() => {
  resetWebModuleCacheForTests();
  resetHostSdkForTests();
  delete (globalThis as { __HEMING_MODULE_BASE?: unknown }).__HEMING_MODULE_BASE;
});

describe("模块包 loader 契约（d.131）", () => {
  it("开发态默认 base 是 /__modules__，可用全局覆盖", () => {
    expect(webModuleBaseUrl()).toBe("/__modules__");
    (globalThis as { __HEMING_MODULE_BASE?: string }).__HEMING_MODULE_BASE = "app://heming/modules/";
    expect(webModuleBaseUrl()).toBe("app://heming/modules");
    expect(webModuleEntryUrl("staff")).toBe("app://heming/modules/staff/entry.js");
  });

  it("entry URL 对 id 编码，避免路径注入", () => {
    expect(webModuleEntryUrl("../evil")).toContain("..%2Fevil");
  });

  it("assertWebModule：合法导出通过（页面组件 + manifest id 一致）", () => {
    const mod = assertWebModule("staff", {
      manifest: { id: "staff", version: "1.0.0" },
      pages: { staff: page },
    });
    expect(mod.manifest.id).toBe("staff");
    expect(mod.pages?.staff).toBe(page);
  });

  it("assertWebModule：缺 manifest / id 不一致 / 无页面都拒绝", () => {
    expect(() => assertWebModule("staff", { pages: { staff: page } })).toThrow(/manifest/);
    expect(() => assertWebModule("staff", { manifest: { id: "other", version: "1" }, pages: { staff: page } })).toThrow(
      /不一致/,
    );
    expect(() => assertWebModule("staff", { manifest: { id: "staff", version: "1" }, pages: {} })).toThrow(/页面/);
    expect(() =>
      assertWebModule("staff", { manifest: { id: "staff", version: "1" }, pages: { staff: "x" } }),
    ).toThrow(/不是 React 组件/);
  });
});
