import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatCommand,
  getMagpieCliBridge,
  parseAccounts,
  parseProviders,
  stripAnsi,
  tailText,
} from "./magpieCli.js";

/** 模型页命令桥的纯函数（d.99）：桥探测、输出解析、展示清洗。 */

afterEach(() => {
  delete (window as unknown as { __heming_magpie?: unknown }).__heming_magpie;
  vi.unstubAllGlobals();
});

describe("getMagpieCliBridge", () => {
  it("浏览器/旧桌面端没有完整命令桥 → null", () => {
    expect(getMagpieCliBridge()).toBeNull();
    (window as unknown as { __heming_magpie?: unknown }).__heming_magpie = { cli: () => {} };
    expect(getMagpieCliBridge()).toBeNull();
  });

  it("六个方法齐全才认作命令桥", () => {
    const bridge = {
      cli: vi.fn(),
      cliStart: vi.fn(),
      cliInput: vi.fn(),
      cliKill: vi.fn(),
      openTerminal: vi.fn(),
      onCli: vi.fn(),
    };
    (window as unknown as { __heming_magpie?: unknown }).__heming_magpie = bridge;
    expect(getMagpieCliBridge()).toBe(bridge);
  });
});

describe("parseProviders", () => {
  it("按两个以上空格拆列：id/类型/主机/模型数；提示行跳过", () => {
    const raw = [
      "  mock custom  mock  127.0.0.1:39001  ● •••••••  1 models  ",
      "  deepseek preset  deepseek  api.deepseek.com  ● •••••••  6 models  ",
      "! no model list",
    ].join("\n");
    const rows = parseProviders(raw);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "mock", kind: "custom", host: "127.0.0.1:39001", models: 1 });
    expect(rows[1]).toMatchObject({ id: "deepseek", models: 6 });
  });

  it("空输出/无供应商文案返回空数组（页面显示引导）", () => {
    expect(parseProviders("")).toEqual([]);
    expect(parseProviders("no providers yet")).toEqual([]);
  });
});

describe("parseAccounts", () => {
  it("解析 accounts --json 数组，收敛 agent/名称/额度", () => {
    const rows = parseAccounts(
      JSON.stringify([
        { agent: "claude", name: "工作号", allowance: "82% used" },
        { agent: "codex", email: "me@example.com" },
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ agent: "claude", label: "工作号", allowance: "82% used" });
    expect(rows[1]).toMatchObject({ agent: "codex", label: "me@example.com" });
  });

  it("不是数组/坏 JSON → 空数组，不抛", () => {
    expect(parseAccounts("")).toEqual([]);
    expect(parseAccounts("not json")).toEqual([]);
    expect(parseAccounts("{}")).toEqual([]);
  });
});

describe("展示辅助", () => {
  it("stripAnsi 去掉颜色控制；tailText 保留尾部", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
    const long = "x".repeat(100);
    expect(tailText(long, 10)).toContain("x".repeat(10));
    expect(tailText(long, 10)).toMatch(/省略/);
  });

  it("formatCommand 仅供展示", () => {
    expect(formatCommand(["provider", "add", "deepseek", "sk-x"])).toBe(
      "magpie-core provider add deepseek sk-x",
    );
  });
});
