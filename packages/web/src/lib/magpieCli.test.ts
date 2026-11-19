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

  it("`⤷` 那行是上一家的备用链：不算新来源，链条挂在前一行上", () => {
    const raw = [
      "  deepseek  preset  deepseek  api.deepseek.com  ● •••••••  6 models  ",
      "  ⤷ openrouter/deepseek-v3 → moonshot/kimi-k2  ",
      "  moonshot  preset  moonshot  api.moonshot.cn  ● •••••••  4 models  ",
    ].join("\n");
    const rows = parseProviders(raw);
    expect(rows.map((row) => row.id)).toEqual(["deepseek", "moonshot"]);
    expect(rows[0].fallback).toEqual(["openrouter/deepseek-v3", "moonshot/kimi-k2"]);
    expect(rows[1].fallback).toEqual([]);
  });

  it("没有备用链时是空数组，不是 undefined（页面直接读 .length）", () => {
    const [row] = parseProviders("  mock custom  mock  127.0.0.1:39001  ● •••••••  1 models  ");
    expect(row.fallback).toEqual([]);
  });

  it("停用的那家：说明里的 `magpie provider on <id>` 认成 off，别家提到不算", () => {
    const raw = [
      "  deepseek  preset  deepseek  api.deepseek.com  ● •••••••  6 models  magpie provider on deepseek  ← Claude Code",
      "  moonshot  preset  moonshot  api.moonshot.cn  ● •••••••  4 models  ← Codex",
    ].join("\n");
    const rows = parseProviders(raw);
    expect(rows[0].off).toBe(true);
    expect(rows[1].off).toBe(false);
  });
});

describe("parseAccounts", () => {
  it("解析 accounts --json 的真实字段：账号、计划、在用状态、窗口额度", () => {
    const rows = parseAccounts(
      JSON.stringify([
        {
          agent: "claude",
          user: "work@example.com",
          alias: "工作号",
          plan: "Max",
          active: true,
          on: true,
          windows: [
            {
              name: "5 hours",
              used: 82,
              remaining: 18,
              resetsAt: "2026-11-18T12:30:00Z",
              display: "82% used",
            },
            { name: "week", unlimited: true },
          ],
          readAt: "2026-11-18T09:00:00Z",
        },
        { agent: "codex", user: "me@example.com", on: false, windows: [], error: "no token" },
      ]),
    );
    expect(rows).toHaveLength(2);
    // 别名优先于邮箱；plan/active/on 原样带出，页面据此画徽标与「在用」
    expect(rows[0]).toMatchObject({
      agent: "claude",
      label: "工作号",
      user: "work@example.com",
      plan: "Max",
      active: true,
      on: true,
    });
    expect(rows[0]?.windows).toHaveLength(2);
    expect(rows[0]?.windows[0]).toMatchObject({ name: "5 hours", used: 82, remaining: 18 });
    expect(rows[0]?.windows[1]?.unlimited).toBe(true);
    // 没有 active/on 的行不能被当成在用；读不到额度的原因要留着给页面显示
    expect(rows[1]).toMatchObject({ agent: "codex", label: "me@example.com", active: false, on: false, error: "no token" });
    expect(rows[1]?.windows).toEqual([]);
  });

  it("窗口只给了 remaining 时反推 used，缺字段给安全默认", () => {
    const rows = parseAccounts(
      JSON.stringify([{ agent: "codex", user: "a@b.c", windows: [{ name: "week", remaining: 40 }] }]),
    );
    expect(rows[0]?.windows[0]).toMatchObject({ used: 60, remaining: 40, unlimited: false, text: false });
    expect(rows[0]?.resets).toBeUndefined();
    expect(rows[0]?.balance).toBeUndefined();
  });

  it("三个数都没有、也没有厂商原话的窗口丢掉，只剩原话的窗口保留", () => {
    const rows = parseAccounts(
      JSON.stringify([
        {
          agent: "claude",
          user: "a@b.c",
          windows: [
            { name: "5 hours" },
            { name: "week", display: "上周已用完", text: true },
            { name: "month", unlimited: true },
          ],
        },
      ]),
    );
    expect(rows[0]?.windows.map((item) => item.name)).toEqual(["week", "month"]);
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
      "模型服务 provider add deepseek sk-x",
    );
  });
});
