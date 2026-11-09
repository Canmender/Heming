import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatCommand,
  getMagpieCliBridge,
  parseAccounts,
  parseProviders,
  readProviderShow,
  stripAnsi,
  tailText,
  type MagpieCliBridge,
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

  it("命令桥方法齐全才认作可用", () => {
    const bridge = {
      cli: vi.fn(),
      cliStart: vi.fn(),
      cliBegin: vi.fn(),
      cliInput: vi.fn(),
      cliKill: vi.fn(),
      openTerminal: vi.fn(),
      backupInfo: vi.fn(),
      backupPick: vi.fn(),
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

describe("readProviderShow", () => {
  /** 按 `provider …` 的参数拼出回复；没列出的参数一律失败。 */
  const fakeBridge = (replies: Record<string, string>) =>
    ({
      cli: vi.fn(async (args: string[]) => {
        const text = replies[args.join(" ")];
        return { ok: text !== undefined, stdout: text ?? "", stderr: text ? "" : "no such provider" };
      }),
    }) as unknown as MagpieCliBridge;

  it("优先用 provider show <id>", async () => {
    const cli = fakeBridge({ "provider show zhipu": "  chat  https://open.bigmodel.cn/api/paas/v4" });
    const text = await readProviderShow(cli, "zhipu");
    expect(text).toContain("open.bigmodel.cn");
    expect(cli.cli).toHaveBeenCalledTimes(1);
  });

  it("内核没有 show 动词时退回 provider <id>", async () => {
    const cli = fakeBridge({ "provider zhipu": "  chat  https://open.bigmodel.cn/api/paas/v4" });
    const text = await readProviderShow(cli, "zhipu");
    expect(text).toContain("chat");
    expect(cli.cli).toHaveBeenCalledWith(["provider", "zhipu"]);
  });

  it("两条都失败返回空串（页面按普通地址展示）", async () => {
    expect(await readProviderShow(fakeBridge({}), "gone")).toBe("");
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
