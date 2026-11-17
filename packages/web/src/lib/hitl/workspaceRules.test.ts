/**
 * 工作区权限规则的解析 / 匹配 / 加载测试。
 *
 * 覆盖的契约（改动前先读 `workspaceRules.ts` 文件头）：
 * - 结构错误 → fail-closed（`ok:false`）；单条非法 → 丢弃并计数；
 * - deny > ask > allow；danger 的 allow 需要 `allowDanger`；
 * - path glob 相对工作区根、反斜杠归一化、越界不匹配 path 规则；
 * - command glob 只对 run_command 生效、大小写不敏感；
 * - 加载器：无桥/无根/无文件/读失败 → null；有文件但坏 → ok:false；5 秒缓存、换根失效。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MAX_WORKSPACE_RULES,
  WORKSPACE_RULES_CACHE_MS,
  WORKSPACE_RULES_TRUST_KEY,
  clearWorkspaceRulesCache,
  isWorkspaceRulesTrusted,
  loadWorkspaceRules,
  matchWorkspaceRules,
  parseWorkspaceRules,
  setWorkspaceRulesTrusted,
  workspaceRulesPath,
  type WorkspaceRulesConfig,
} from "./workspaceRules.js";
import type { HitlCall, RiskLevel } from "./types.js";
import type { FileRoot } from "../fileEdit/paths.js";
import { fileRootsStore, setActiveWorkspace } from "../fileEdit/roots.js";

const ROOT: FileRoot = { name: "工作区", path: "D:/项目", mode: "write" };

function makeCall(
  name: string,
  args: Record<string, unknown> = {},
  risk: RiskLevel = "write",
): HitlCall {
  return {
    id: "c1",
    name,
    argsJson: JSON.stringify(args),
    displayName: name,
    risk,
    summary: "",
    source: "unknown",
  };
}

/** 解析成功并返回配置；失败直接让用例红。 */
function parseOk(text: string): { config: WorkspaceRulesConfig; invalid: number } {
  const parsed = parseWorkspaceRules(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return { config: parsed.config, invalid: parsed.invalid };
}

function match(
  config: WorkspaceRulesConfig,
  call: HitlCall,
  roots: FileRoot[] = [ROOT],
): ReturnType<typeof matchWorkspaceRules> {
  return matchWorkspaceRules(config, call, { roots });
}

describe("parseWorkspaceRules", () => {
  it("解析合法配置：三个分区、command、allowDanger", () => {
    const { config, invalid } = parseOk(
      JSON.stringify({
        allow: [
          { tool: "file_write", path: "src/**" },
          { tool: "run_command", command: "pnpm *", allowDanger: true },
        ],
        deny: [
          { tool: "file_write", path: ".git/**" },
          { tool: "run_command", command: "*curl*" },
        ],
        ask: [{ tool: "file_write", path: "**/*.lock" }],
      }),
    );
    expect(invalid).toBe(0);
    expect(config.deny).toHaveLength(2);
    expect(config.ask).toHaveLength(1);
    expect(config.allow).toHaveLength(2);
    expect(config.allow[1]).toEqual({
      tool: "run_command",
      command: "pnpm *",
      allowDanger: true,
    });
    expect(config.denyAll).toBeUndefined();
  });

  it("非法条目逐条丢弃并计数，不影响合法条目", () => {
    const { config, invalid } = parseOk(
      JSON.stringify({
        allow: [
          { tool: "file_write", path: "src/**" },
          { tool: "" },
          { tool: 42 },
          { path: "src/**" }, // 没有 tool
          { tool: "file_write", path: "/etc/**" }, // 绝对路径
          { tool: "file_write", path: "../secret/**" }, // 越界
          { tool: "run_command", allowDanger: "yes" }, // 类型错
          { tool: "run_*cmd" }, // 中间的 * 不支持
          "not-an-object",
        ],
      }),
    );
    expect(config.allow).toEqual([{ tool: "file_write", path: "src/**" }]);
    expect(invalid).toBe(8);
  });

  it("结构错误一律 ok:false（调用方会 fail-closed）", () => {
    expect(parseWorkspaceRules("{").ok).toBe(false);
    expect(parseWorkspaceRules("[]").ok).toBe(false);
    expect(parseWorkspaceRules("null").ok).toBe(false);
    expect(parseWorkspaceRules('{"allow":{}}').ok).toBe(false);
    expect(parseWorkspaceRules('{"denyAll":"true"}').ok).toBe(false);
  });

  it("denyAll 是合法紧急开关；非布尔值则整份配置非法", () => {
    const { config } = parseOk('{"denyAll":true}');
    expect(config.denyAll).toBe(true);
    expect(match(config, makeCall("anything")).verdict).toBe("deny");

    const parsed = parseWorkspaceRules('{"denyAll":"yes"}');
    expect(parsed.ok).toBe(false);
  });

  it("超过 200 条时截断并计数；deny/ask 先占额度（保护性规则不会被 allow 挤掉）", () => {
    const allow = Array.from({ length: MAX_WORKSPACE_RULES + 50 }, (_, i) => ({
      tool: `tool_${i}`,
      path: `src/${i}/**`,
    }));
    const { config, invalid } = parseOk(
      JSON.stringify({ allow, deny: [{ tool: "file_write", path: ".git/**" }] }),
    );
    expect(config.deny).toHaveLength(1);
    expect(config.allow).toHaveLength(MAX_WORKSPACE_RULES - 1);
    expect(invalid).toBe(51);
  });
});

describe("matchWorkspaceRules：工具名", () => {
  it("精确工具名只命中同名工具", () => {
    const { config } = parseOk('{"deny":[{"tool":"file_write"}]}');
    expect(match(config, makeCall("file_write")).verdict).toBe("deny");
    expect(match(config, makeCall("file_read")).verdict).toBeNull();
  });

  it("`*` 命中所有工具（deny 是工具级止损，不依赖路径）", () => {
    const { config } = parseOk('{"deny":[{"tool":"*"}]}');
    expect(match(config, makeCall("whatever", {}, "read")).verdict).toBe("deny");
    expect(match(config, makeCall("run_command", { command: "rm -rf /" }, "danger")).verdict).toBe(
      "deny",
    );
  });

  it("前缀通配 `mcp__*` 只按前缀匹配，不做正则", () => {
    const { config } = parseOk('{"ask":[{"tool":"mcp__*"}]}');
    expect(match(config, makeCall("mcp__github__create_issue")).verdict).toBe("ask");
    expect(match(config, makeCall("file_read")).verdict).toBeNull();
  });

  it("精确名不误伤同前缀的更长工具名", () => {
    const { config } = parseOk('{"deny":[{"tool":"mcp__foo"}]}');
    expect(match(config, makeCall("mcp__foo")).verdict).toBe("deny");
    expect(match(config, makeCall("mcp__foobar")).verdict).toBeNull();
  });
});

describe("matchWorkspaceRules：path glob", () => {
  it("`**` 跨目录匹配；大小写不敏感（Windows 口径）", () => {
    const { config } = parseOk('{"deny":[{"tool":"file_write","path":".git/**"}]}');
    expect(match(config, makeCall("file_write", { path: ".git/config" })).verdict).toBe("deny");
    expect(match(config, makeCall("file_write", { path: ".GIT/HEAD" })).verdict).toBe("deny");
    expect(match(config, makeCall("file_write", { path: "src/.git/config" })).verdict).toBeNull();
  });

  it("规则与调用里的反斜杠都归一化成正斜杠", () => {
    const { config } = parseOk(JSON.stringify({ deny: [{ tool: "file_write", path: "src\\**" }] }));
    expect(match(config, makeCall("file_write", { path: "src\\lib\\a.ts" })).verdict).toBe("deny");
  });

  it("`**/*.lock` 匹配任意层级，不匹配后缀更长的文件", () => {
    const { config } = parseOk('{"ask":[{"tool":"file_write","path":"**/*.lock"}]}');
    expect(match(config, makeCall("file_write", { path: "pnpm.lock" })).verdict).toBe("ask");
    expect(match(config, makeCall("file_write", { path: "a/b/c/d.lock" })).verdict).toBe("ask");
    expect(match(config, makeCall("file_write", { path: "a/b/c.lock.txt" })).verdict).toBeNull();
  });

  it("绝对路径先按根算相对路径；根内命中，根外不命中", () => {
    const { config } = parseOk('{"deny":[{"tool":"file_write","path":"src/**"}]}');
    expect(match(config, makeCall("file_write", { path: "D:/项目/src/a.ts" })).verdict).toBe("deny");
    // 越界路径不算匹配 path 规则
    expect(match(config, makeCall("file_write", { path: "C:/其他/src/a.ts" })).verdict).toBeNull();
  });

  it("越界路径不匹配 path 规则，但 deny 的 `tool:\"*\"` 仍然命中", () => {
    const { config } = parseOk('{"deny":[{"tool":"*","path":"src/**"},{"tool":"*"}]}');
    expect(match(config, makeCall("file_write", { path: "../src/a.ts" })).verdict).toBe("deny");
  });

  it("参数里的 path / dir / file 都会参与匹配", () => {
    const { config } = parseOk('{"ask":[{"tool":"*","path":"docs/**"}]}');
    expect(match(config, makeCall("file_grep", { dir: "docs/sub" })).verdict).toBe("ask");
    expect(match(config, makeCall("file_read", { file: "docs/a.md" })).verdict).toBe("ask");
    expect(match(config, makeCall("file_read", { path: "docs/a.md" })).verdict).toBe("ask");
  });
});

describe("matchWorkspaceRules：command glob", () => {
  it("只对 run_command 生效，大小写不敏感", () => {
    const { config } = parseOk('{"deny":[{"tool":"run_command","command":"pnpm *"}]}');
    expect(
      match(config, makeCall("run_command", { command: "PNPM test" }, "danger")).verdict,
    ).toBe("deny");
    // 其它工具即使有同名参数也不该被误伤
    const anyTool = parseOk('{"deny":[{"tool":"*","command":"*curl*"}]}').config;
    expect(match(anyTool, makeCall("file_read", { command: "curl x" })).verdict).toBeNull();
    expect(match(anyTool, makeCall("run_command", { command: "curl -s url" }, "danger")).verdict).toBe(
      "deny",
    );
  });

  it("path 与 command 同时写时两者都要命中", () => {
    const { config } = parseOk(
      '{"deny":[{"tool":"run_command","path":"src/**","command":"*curl*"}]}',
    );
    expect(
      match(config, makeCall("run_command", { command: "curl x" }, "danger")).verdict,
    ).toBeNull();
    expect(
      match(config, makeCall("run_command", { path: "src/a", command: "curl x" }, "danger")).verdict,
    ).toBe("deny");
  });
});

describe("matchWorkspaceRules：优先级与 danger", () => {
  it("deny > ask > allow", () => {
    const all = parseOk(
      JSON.stringify({
        deny: [{ tool: "file_write", path: "src/**" }],
        ask: [{ tool: "file_write", path: "src/**" }],
        allow: [{ tool: "file_write", path: "src/**" }],
      }),
    ).config;
    expect(match(all, makeCall("file_write", { path: "src/a.ts" })).verdict).toBe("deny");

    const askAllow = parseOk(
      JSON.stringify({
        ask: [{ tool: "file_write", path: "src/**" }],
        allow: [{ tool: "file_write", path: "src/**" }],
      }),
    ).config;
    expect(match(askAllow, makeCall("file_write", { path: "src/a.ts" })).verdict).toBe("ask");

    const allowOnly = parseOk(
      '{"allow":[{"tool":"file_write","path":"src/**"}]}',
    ).config;
    expect(match(allowOnly, makeCall("file_write", { path: "src/a.ts" })).verdict).toBe("allow");
  });

  it("danger 的 allow 默认不生效，显式 allowDanger 才生效", () => {
    const command = makeCall("run_command", { command: "pnpm test" }, "danger");

    const plain = parseOk(
      '{"allow":[{"tool":"run_command","command":"pnpm *"}]}',
    ).config;
    expect(match(plain, command).verdict).toBeNull();

    const explicit = parseOk(
      '{"allow":[{"tool":"run_command","command":"pnpm *","allowDanger":true}]}',
    ).config;
    expect(match(explicit, command).verdict).toBe("allow");
  });

  it("普通 allow 之后仍会继续找带 allowDanger 的规则", () => {
    const { config } = parseOk(
      JSON.stringify({
        allow: [
          { tool: "run_command", command: "pnpm *" },
          { tool: "run_command", command: "pnpm *", allowDanger: true },
        ],
      }),
    );
    expect(match(config, makeCall("run_command", { command: "pnpm test" }, "danger")).verdict).toBe(
      "allow",
    );
  });
});

describe("loadWorkspaceRules（默认加载器）", () => {
  const ROOT_PATH = "D:/项目/和鸣";
  let now = 1_000_000;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  type ReadBridge = (payload: { roots: FileRoot[]; path: string }) => Promise<unknown>;

  function installBridge(read: ReadBridge): void {
    (window as unknown as { __heming_files?: unknown }).__heming_files = {
      read,
      write: async () => ({ ok: true }),
    };
  }

  function removeBridge(): void {
    delete (window as unknown as { __heming_files?: unknown }).__heming_files;
  }

  beforeEach(() => {
    clearWorkspaceRulesCache();
    fileRootsStore.clear();
    setActiveWorkspace(undefined);
    window.localStorage.removeItem(WORKSPACE_RULES_TRUST_KEY);
    removeBridge();
    now = 1_000_000;
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    removeBridge();
    setActiveWorkspace(undefined);
    fileRootsStore.clear();
    window.localStorage.removeItem(WORKSPACE_RULES_TRUST_KEY);
    clearWorkspaceRulesCache();
  });

  it("没有桥 / 没有写根 → null（没有规则，不是全部拒绝）", async () => {
    expect(await loadWorkspaceRules()).toBeNull();

    const read = vi.fn(async () => ({ ok: false as const, code: "not-found" as const, error: "无" }));
    installBridge(read);
    expect(await loadWorkspaceRules()).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("文件不存在 / 读取失败 → null", async () => {
    fileRootsStore.add({ path: ROOT_PATH, mode: "write" });
    installBridge(async () => ({ ok: false as const, code: "not-found" as const, error: "没有" }));
    expect(await loadWorkspaceRules()).toBeNull();

    clearWorkspaceRulesCache();
    installBridge(async () => {
      throw new Error("IPC 断了");
    });
    expect(await loadWorkspaceRules()).toBeNull();
  });

  it("读到合法文件 → ok:true（非法条目计数带上）", async () => {
    fileRootsStore.add({ path: ROOT_PATH, mode: "write" });
    const read = vi.fn(
      async (_payload: { roots: FileRoot[]; path: string }) => ({
        ok: true as const,
        content: JSON.stringify({
          deny: [{ tool: "file_write", path: ".git/**" }],
          allow: [{ tool: "" }],
        }),
        bytes: 10,
      }),
    );
    installBridge(read);

    const load = await loadWorkspaceRules();
    expect(load?.ok).toBe(true);
    if (!load?.ok) throw new Error("应当解析成功");
    expect(load.invalid).toBe(1);
    expect(load.config.deny).toHaveLength(1);
    expect(load.source).toBe(`${ROOT_PATH}/.heming/permissions.json`);
    // 默认未信任：deny/ask 可用，allow 不生效
    expect(load.trusted).toBe(false);
    expect(load.allowActive).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toMatchObject({
      path: `${ROOT_PATH}/.heming/permissions.json`,
    });
  });

  it("信任标记按根归一化存储；信任后 allowActive=true，缓存立即失效", async () => {
    fileRootsStore.add({ path: ROOT_PATH, mode: "write" });
    const read = vi.fn(
      async (_payload: { roots: FileRoot[]; path: string }) => ({
        ok: true as const,
        content: JSON.stringify({ allow: [{ tool: "file_write" }] }),
        bytes: 5,
      }),
    );
    installBridge(read);

    const before = await loadWorkspaceRules();
    expect(before?.ok && before.trusted).toBe(false);

    // 反斜杠 / 尾斜杠 / 大小写不同，仍指向同一个工作区
    setWorkspaceRulesTrusted("d:\\项目\\和鸣\\", true);
    expect(isWorkspaceRulesTrusted(`D:\\项目\\和鸣`)).toBe(true);
    expect(isWorkspaceRulesTrusted(ROOT_PATH)).toBe(true);

    const after = await loadWorkspaceRules();
    expect(after?.ok && after.trusted).toBe(true);
    expect(after?.ok && after.allowActive).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);

    setWorkspaceRulesTrusted(ROOT_PATH, false);
    expect(isWorkspaceRulesTrusted(ROOT_PATH)).toBe(false);
    const again = await loadWorkspaceRules();
    expect(again?.ok && again.allowActive).toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("信任表损坏 → 按未信任处理（安全默认）", () => {
    window.localStorage.setItem(WORKSPACE_RULES_TRUST_KEY, "{ 不是 JSON");
    expect(isWorkspaceRulesTrusted(ROOT_PATH)).toBe(false);
  });

  it("有文件但内容坏了 → ok:false（闸门据此全部拒绝）", async () => {
    fileRootsStore.add({ path: ROOT_PATH, mode: "write" });
    installBridge(async () => ({ ok: true as const, content: "{ 不是 JSON", bytes: 8 }));

    const load = await loadWorkspaceRules();
    expect(load?.ok).toBe(false);
    if (!load || load.ok) throw new Error("应当解析失败");
    expect(load.error).toContain("JSON 解析失败");
    expect(load.source).toContain(".heming/permissions.json");
  });

  it("5 秒缓存：同一根内不重复读盘，过期后重读", async () => {
    fileRootsStore.add({ path: ROOT_PATH, mode: "write" });
    const read = vi.fn(async () => ({
      ok: false as const,
      code: "not-found" as const,
      error: "没有",
    }));
    installBridge(read);

    await loadWorkspaceRules();
    await loadWorkspaceRules();
    expect(read).toHaveBeenCalledTimes(1);

    now += WORKSPACE_RULES_CACHE_MS + 1;
    await loadWorkspaceRules();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("换写根即失效（按根失效）", async () => {
    const read = vi.fn(
      async (_payload: { roots: FileRoot[]; path: string }) => ({
        ok: false as const,
        code: "not-found" as const,
        error: "没有",
      }),
    );
    installBridge(read);

    fileRootsStore.add({ path: "D:/A", mode: "write" });
    await loadWorkspaceRules();
    fileRootsStore.clear();
    fileRootsStore.add({ path: "D:/B", mode: "write" });
    await loadWorkspaceRules();

    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0][0]).toMatchObject({ path: "D:/A/.heming/permissions.json" });
    expect(read.mock.calls[1][0]).toMatchObject({ path: "D:/B/.heming/permissions.json" });
  });

  it("workspaceRulesPath 只拼正斜杠且不重复斜杠", () => {
    expect(workspaceRulesPath({ name: "x", path: "D:/项目/", mode: "write" })).toBe(
      "D:/项目/.heming/permissions.json",
    );
  });
});
