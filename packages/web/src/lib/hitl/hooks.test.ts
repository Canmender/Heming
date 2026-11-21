import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  MAX_POST_HOOK_NOTES,
  POST_HOOK_RESULT_MAX_CHARS,
  MAX_HOOK_TIMEOUT_MS,
  MAX_TOOL_HOOKS,
  buildHookPayload,
  extractToolPath,
  globToRegExp,
  hookDeniedText,
  interpretHookResult,
  interpretPostHookResult,
  matchHooks,
  matchPathGlob,
  parseHooksConfig,
  postHookNoteText,
  workspaceRelativePath,
  type ToolHookRule,
} from "./hooks.js";

const WS = "D:/工作区/heming";

function rule(overrides: Partial<ToolHookRule> = {}): ToolHookRule {
  return { phase: "pre", tool: ["file_write"], command: "node check.js", timeoutMs: 10_000, ...overrides };
}

describe("parseHooksConfig", () => {
  it("解析合法配置：字符串/数组工具名、path 可选、timeoutMs 缺省 10000", () => {
    const parsed = parseHooksConfig(
      JSON.stringify({
        hooks: [
          { match: { tool: "file_write", path: "src/**" }, command: "node scripts/check-write.js" },
          { match: { tool: ["run_command", "file_patch"] }, command: "node scripts/audit.js", timeoutMs: 15000 },
        ],
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      hooks: [
        { phase: "pre", tool: ["file_write"], path: "src/**", command: "node scripts/check-write.js", timeoutMs: DEFAULT_HOOK_TIMEOUT_MS },
        { phase: "pre", tool: ["run_command", "file_patch"], command: "node scripts/audit.js", timeoutMs: 15000 },
      ],
    });
  });

  it("空文件视为零条规则（新建但还没填不该让所有工具不可用）", () => {
    expect(parseHooksConfig("  \r\n")).toEqual({ ok: true, hooks: [] });
  });

  it("非法 JSON：报错原文可指导修改，不静默放行", () => {
    const parsed = parseHooksConfig('{ "hooks": [ }');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("不是合法 JSON");
      expect(parsed.error).toContain("JSON 不支持注释");
    }
  });

  it("结构/字段非法：每条都指出第几条、哪个字段", () => {
    const cases: [string, string][] = [
      [JSON.stringify({ hooks: {} }), "hooks 数组"],
      [JSON.stringify({ hooks: [{}] }), "第 1 条规则缺少 match"],
      [JSON.stringify({ hooks: [{ match: {}, command: "x" }] }), "第 1 条规则缺少 match.tool"],
      [JSON.stringify({ hooks: [{ match: { tool: [] }, command: "x" }] }), "match.tool 数组不能为空"],
      [JSON.stringify({ hooks: [{ match: { tool: "file_write" } }] }), "缺少 command"],
      [JSON.stringify({ hooks: [{ match: { tool: "file_write", path: " " }, command: "x" }] }), "match.path"],
      [JSON.stringify({ hooks: [{ match: { tool: "file_write" }, command: "x", timeoutMs: 0 }] }), "timeoutMs 必须是正数"],
      [
        JSON.stringify({ hooks: [{ match: { tool: "file_write" }, command: "x", timeoutMs: MAX_HOOK_TIMEOUT_MS + 1 }] }),
        `不能超过 ${MAX_HOOK_TIMEOUT_MS}`,
      ],
    ];
    for (const [text, expected] of cases) {
      const parsed = parseHooksConfig(text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(expected);
    }
  });

  it(`最多 ${MAX_TOOL_HOOKS} 条规则`, () => {
    const hooks = Array.from({ length: MAX_TOOL_HOOKS + 1 }, () => ({
      match: { tool: "file_write" },
      command: "x",
    }));
    const parsed = parseHooksConfig(JSON.stringify({ hooks }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(`最多允许 ${MAX_TOOL_HOOKS} 条`);
  });
});

describe("matchHooks / 路径 glob", () => {
  it("工具名精确匹配、数组匹配、* 匹配所有；mcp__* 不做隐式通配", () => {
    const rules = [
      rule({ tool: ["file_write"] }),
      rule({ tool: ["run_command", "file_patch"], command: "audit" }),
      rule({ tool: ["*"], command: "all" }),
      rule({ tool: ["mcp__*"], command: "prefix" }),
    ];
    expect(matchHooks(rules, { name: "file_write", arguments: "{}" }, WS).map((r) => r.command)).toEqual([
      "node check.js",
      "all",
    ]);
    expect(matchHooks(rules, { name: "mcp__github__search", arguments: "{}" }, WS).map((r) => r.command)).toEqual(["all"]);
    expect(matchHooks(rules, { name: "mcp__*", arguments: "{}" }, WS).map((r) => r.command)).toEqual([
      "all",
      "prefix",
    ]);
  });

  it("path：src/** 匹配子路径与目录本身；**/x 匹配任意深度；? 只匹配一个字符", () => {
    expect(matchPathGlob("src/**", "src/a/b.ts")).toBe(true);
    expect(matchPathGlob("src/**", "src")).toBe(true);
    expect(matchPathGlob("src/**", "srcx/a.ts")).toBe(false);
    expect(matchPathGlob("**/*.test.ts", "a/b/c.test.ts")).toBe(true);
    expect(matchPathGlob("**/*.test.ts", "c.test.ts")).toBe(true);
    expect(matchPathGlob("src/file?.ts", "src/file1.ts")).toBe(true);
    expect(matchPathGlob("src/file?.ts", "src/file12.ts")).toBe(false);
    expect(matchPathGlob("SRC/**", "src/a.ts")).toBe(true); // Windows 路径大小写不敏感
  });

  it("path：裸 ** 匹配一切相对路径，守卫钩子不会静默失效（d.412 回归）", () => {
    expect(matchPathGlob("**", "a.ts")).toBe(true);
    expect(matchPathGlob("**", "src/a.ts")).toBe(true);
    expect(matchPathGlob("**", "src/a/b.ts")).toBe(true);
    expect(matchPathGlob("**", "src")).toBe(true);
  });

  it("Windows 反斜杠与绝对路径都归一化到工作区相对路径", () => {
    expect(workspaceRelativePath("src\\a\\b.ts", WS)).toBe("src/a/b.ts");
    expect(workspaceRelativePath("D:\\工作区\\heming\\src\\a.ts", WS)).toBe("src/a.ts");
    expect(workspaceRelativePath("D:/别的目录/a.ts", WS)).toBeNull();
    expect(workspaceRelativePath("../escape.ts", WS)).toBeNull();
  });

  it("参数里没有 path/dir/file 时，path 规则不匹配；无 path 规则仍命中", () => {
    const rules = [
      rule({ tool: ["run_command"], path: "src/**" }),
      rule({ tool: ["run_command"], command: "audit" }),
    ];
    expect(matchHooks(rules, { name: "run_command", arguments: '{"command":"ls"}' }, WS).map((r) => r.command)).toEqual([
      "audit",
    ]);
  });

  it("路径参数按 path → dir → file 顺序取第一个存在的", () => {
    expect(extractToolPath('{"dir":"src","file":"a.ts"}')).toBe("src");
    expect(extractToolPath('{"file":"a.ts"}')).toBe("a.ts");
    expect(extractToolPath("not json")).toBeNull();
  });

  it("反斜杠 glob 也能命中（用户和模型都可能写 \\）", () => {
    expect(globToRegExp("src\\**").test("src/a.ts")).toBe(true);
  });
});

describe("interpretHookResult", () => {
  it("退出码 0 放行", () => {
    expect(interpretHookResult(0, "", "", false)).toEqual({ decision: "allow" });
  });

  it("退出码 2 拒绝：原因取 stdout 第一条非空行，stdout 没有才用 stderr", () => {
    expect(interpretHookResult(2, "\n  不许写 src  \n第二行", "", false)).toEqual({
      decision: "deny",
      reason: "不许写 src",
    });
    expect(interpretHookResult(2, "", "缺测试\n", false)).toEqual({
      decision: "deny",
      reason: "缺测试",
    });
  });

  it("退出码 2 没有输出：仍拒绝，并说明没有给原因", () => {
    const out = interpretHookResult(2, "", "  ", false);
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("没有给出原因");
  });

  it("原因截断到 300 字", () => {
    const out = interpretHookResult(2, "很".repeat(500), "", false);
    expect(out.decision).toBe("deny");
    expect(Array.from(out.reason ?? "").length).toBe(300);
  });

  it("其它非零退出码与信号终止都拒绝（fail-closed），并带退出码/原因", () => {
    const failed = interpretHookResult(1, "", "ENOENT: check.js", false);
    expect(failed).toMatchObject({ decision: "deny" });
    expect(failed.reason).toContain("退出码 1");
    expect(failed.reason).toContain("ENOENT");

    const killed = interpretHookResult(null, "", "", false);
    expect(killed.decision).toBe("deny");
    expect(killed.reason).toContain("信号终止");
  });

  it("超时永远拒绝：即使进程已经打出了 allow JSON 也不能当数", () => {
    const out = interpretHookResult(0, '{"decision":"allow"}', "", true);
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("超时");
  });

  it("stdout JSON 优先于退出码：allow 覆盖退出码 2，deny 覆盖退出码 0", () => {
    expect(interpretHookResult(2, '{"decision":"allow"}', "", false)).toEqual({ decision: "allow" });
    expect(interpretHookResult(0, '{"decision":"deny","reason":"缺测试"}', "", false)).toEqual({
      decision: "deny",
      reason: "缺测试",
    });
  });

  it("不是合法判定 JSON 的 stdout 忽略（打日志不会改变退出码语义）", () => {
    expect(interpretHookResult(0, "检查通过\n", "", false)).toEqual({ decision: "allow" });
    expect(interpretHookResult(0, '{"foo":1}', "", false)).toEqual({ decision: "allow" });
    expect(interpretHookResult(1, '{"decision":"maybe"}', "", false).decision).toBe("deny");
  });
});

describe("buildHookPayload / hookDeniedText", () => {
  it("payload 形状：原始参数字符串、绝对 posix 工作区、ISO 时间", () => {
    const payload = buildHookPayload({
      name: "file_write",
      arguments: '{"path":"src/a.ts","content":"x"}',
      workspace: "D:\\工作区\\heming\\",
      agentId: "a1",
      streamId: "s1",
      time: new Date("2026-11-17T08:00:00.000Z"),
    });
    expect(payload).toEqual({
      event: "PreToolUse",
      tool: { name: "file_write", arguments: '{"path":"src/a.ts","content":"x"}' },
      workspace: "D:/工作区/heming",
      agentId: "a1",
      streamId: "s1",
      time: "2026-11-17T08:00:00.000Z",
    });
  });

  it("拒绝文案：带「未修改」硬声明与命令，且明确不是用户拒绝", () => {
    const text = hookDeniedText({
      toolName: "file_write",
      command: "node scripts/check-write.js",
      ruleIndex: 2,
      reason: "src 下必须先加测试",
    });
    expect(text).toContain("未被修改");
    expect(text).toContain("不存在部分写入或中间状态");
    expect(text).toContain("node scripts/check-write.js");
    expect(text).toContain("第 2 条");
    expect(text).toContain("src 下必须先加测试");
    expect(text).toContain("这不是用户的选择");
    expect(text).not.toContain("用户拒绝了");
  });
});

describe("多 hook 顺序（纯匹配层）", () => {
  it("按配置顺序返回全部命中项（执行层据此短路）", () => {
    const rules = [
      rule({ tool: ["*"], command: "first" }),
      rule({ tool: ["file_write"], command: "second" }),
      rule({ tool: ["file_read"], command: "third" }),
    ];
    expect(matchHooks(rules, { name: "file_write", arguments: "{}" }, WS).map((r) => r.command)).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("执行后的检查（d.345）", () => {
  it("on 缺省是执行前，只有写 on: \"post\" 才算执行后", () => {
    const parsed = parseHooksConfig(
      JSON.stringify({
        hooks: [
          { match: { tool: "file_write" }, command: "node pre.js" },
          { match: { tool: "file_write" }, command: "node post.js", on: "post" },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.hooks.map((item) => item.phase)).toEqual(["pre", "post"]);
  });

  it("on 只认 pre / post，写别的值报错并点名", () => {
    const parsed = parseHooksConfig(
      JSON.stringify({ hooks: [{ match: { tool: "file_write" }, command: "node x.js", on: "after" }] }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('"post"');
    expect(parsed.error).toContain("after");
  });

  it("执行后的 payload 换成 PostToolUse，并带上刚才那次调用的结果", () => {
    const payload = buildHookPayload({
      name: "file_write",
      arguments: '{"path":"src/a.ts"}',
      workspace: WS,
      agentId: "a1",
      streamId: "s1",
      time: new Date(0),
      phase: "post",
      result: { ok: true, text: "写入成功" },
    });
    expect(payload.event).toBe("PostToolUse");
    expect(payload.result).toEqual({ ok: true, text: "写入成功" });
  });

  it("结果太长会截断，不把整篇输出塞进 payload", () => {
    const payload = buildHookPayload({
      name: "run_command",
      arguments: "{}",
      workspace: WS,
      agentId: "a1",
      streamId: "s1",
      time: new Date(0),
      phase: "post",
      result: { ok: true, text: "x".repeat(POST_HOOK_RESULT_MAX_CHARS + 50) },
    });
    expect(payload.result?.text.length).toBeLessThan(POST_HOOK_RESULT_MAX_CHARS + 40);
    expect(payload.result?.text).toContain("结果已截断");
  });

  it("interpretPostHookResult：超时 / 退出码 2 / JSON note / 静默 0 各不相同", () => {
    expect(interpretPostHookResult(null, "", "", true)).toContain("超时");
    expect(interpretPostHookResult(2, "没格式化", "", false)).toContain("工具已执行");
    expect(interpretPostHookResult(2, "没格式化", "", false)).toContain("没格式化");
    expect(interpretPostHookResult(0, '{"note":"补了一句上下文"}', "", false)).toBe("补了一句上下文");
    expect(interpretPostHookResult(0, "", "", false)).toBeNull();
    expect(interpretPostHookResult(1, "", "炸了", false)).toContain("退出码 1");
  });

  it("postHookNoteText：空数组是空串，多条按编号拼，超过上限点名还有几条没展开", () => {
    expect(postHookNoteText([])).toBe("");
    const text = postHookNoteText([
      { command: "node a.js", ruleIndex: 1, text: "第一条" },
      { command: "node b.js", ruleIndex: 2, text: "第二条" },
    ]);
    expect(text).toContain("【执行后的本机检查】");
    expect(text).toContain("不改变调用结果");
    expect(text).toContain("第 1 条「node a.js」：第一条");
    expect(text).toContain("第 2 条「node b.js」：第二条");

    const many = postHookNoteText(
      Array.from({ length: MAX_POST_HOOK_NOTES + 2 }, (_, index) => ({
        command: `node ${index}.js`,
        ruleIndex: index + 1,
        text: `说明 ${index}`,
      })),
    );
    expect(many).toContain("另有 2 条检查说明没有展开");
  });

  it("postHookNoteText：超长命令按码点截断，不劈出落单代理（会回给模型，d.412 回归）", () => {
    const text = postHookNoteText([
      { command: "x".repeat(78) + "😀" + "TAIL", ruleIndex: 1, text: "说明" },
    ]);
    const units = text.split("").map((ch) => ch.charCodeAt(0));
    const lone = units.some((c, i) =>
      (c >= 0xd800 && c <= 0xdbff)
        ? !(i + 1 < units.length && units[i + 1] >= 0xdc00 && units[i + 1] <= 0xdfff)
        : (c >= 0xdc00 && c <= 0xdfff)
          ? !(i > 0 && units[i - 1] >= 0xd800 && units[i - 1] <= 0xdbff)
          : false,
    );
    expect(lone).toBe(false);
  });
});