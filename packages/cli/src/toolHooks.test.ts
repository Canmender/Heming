/**
 * 工作区钩子的 CLI 侧：装载、描述、判定、以及与工具桥的接线。
 *
 * 大部分用例注入假的「进程执行」，只验逻辑（匹配、顺序、payload、文案）；
 * 另有一组真起子进程的用例，验契约本身——命令末尾追加 payload 路径、退出码 2 拒绝、
 * stdout 里的 JSON 覆盖退出码。这两类分开写，是为了让逻辑测试跑得快、契约测试不靠猜。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  CLI_HOOKS_MAX_BYTES,
  cliHookDeniedText,
  cliHooksConfigPath,
  createCliHookRunner,
  createCliPostHookRunner,
  describeCliHooks,
  loadCliHooks,
  type CliHookSet,
  type CliHookVerdict,
} from "./toolHooks.js";
import { createCliTooling } from "./tooling.js";

const TMP: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heming-cli-hooks-"));
  TMP.push(dir);
  return dir;
}

/** 在临时工作区里写一份 hooks.json（`text` 原样写入，便于测坏 JSON / BOM）。 */
function workspaceWith(text: string): string {
  const dir = tmpDir();
  mkdirSync(path.join(dir, ".heming"), { recursive: true });
  writeFileSync(path.join(dir, ".heming", "hooks.json"), text, "utf8");
  return dir;
}

/** 造一份「已解析」的钩子集，省得每个用例都先落一份文件。 */
function hookSetOf(
  hooks: Array<{ tool: string | string[]; path?: string; command: string; timeoutMs?: number; on?: "pre" | "post" }>,
  enabled = true,
): CliHookSet {
  return {
    hooks: hooks.map((rule) => ({
      tool: Array.isArray(rule.tool) ? rule.tool : [rule.tool],
      ...(rule.path !== undefined ? { path: rule.path } : {}),
      command: rule.command,
      timeoutMs: rule.timeoutMs ?? 10_000,
      phase: rule.on ?? "pre",
    })),
    source: ".heming/hooks.json",
    enabled,
  };
}

type ProcessResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

/** 记录每次调用的假进程执行器。 */
function fakeProcess(result: ProcessResult | ((command: string) => ProcessResult)) {
  const calls: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
  const run = vi.fn(async (command: string, cwd: string, timeoutMs: number) => {
    calls.push({ command, cwd, timeoutMs });
    return typeof result === "function" ? result(command) : result;
  });
  return { calls, run };
}

const ALLOW: ProcessResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

describe("cliHooksConfigPath", () => {
  it("拼在 .heming/hooks.json 上，反斜杠统一成正斜杠", () => {
    expect(cliHooksConfigPath("D:\\work\\proj")).toBe("D:/work/proj/.heming/hooks.json");
    expect(cliHooksConfigPath("D:/work/proj/")).toBe("D:/work/proj/.heming/hooks.json");
  });
});

describe("loadCliHooks", () => {
  it("没有配置文件 = 没有钩子（不是错误）", async () => {
    expect(await loadCliHooks(tmpDir(), true)).toBeNull();
  });

  it("有效配置：解析出规则，enabled 跟着信任开关走", async () => {
    const text = JSON.stringify({
      hooks: [{ match: { tool: "file_write", path: "generated/**" }, command: "node check.js" }],
    });
    const trusted = await loadCliHooks(workspaceWith(text), true);
    expect(trusted && trusted.ok).toBe(true);
    if (!trusted || !trusted.ok) throw new Error("unreachable");
    expect(trusted.set.enabled).toBe(true);
    expect(trusted.set.hooks).toHaveLength(1);
    expect(trusted.set.hooks[0]?.tool).toEqual(["file_write"]);

    const untrusted = await loadCliHooks(workspaceWith(text), false);
    if (!untrusted || !untrusted.ok) throw new Error("unreachable");
    expect(untrusted.set.enabled).toBe(false);
  });

  it("带 BOM 也能读（记事本 / PowerShell 5 写出来的文件）", async () => {
    const text = `\uFEFF${JSON.stringify({ hooks: [{ match: { tool: "*" }, command: "node check.js" }] })}`;
    const loaded = await loadCliHooks(workspaceWith(text), true);
    if (!loaded || !loaded.ok) throw new Error("BOM 不该让配置读不出来");
    expect(loaded.set.hooks).toHaveLength(1);
  });

  it("坏 JSON：ok 为 false 并说明是解析问题", async () => {
    const loaded = await loadCliHooks(workspaceWith('{"hooks": [}'), true);
    if (!loaded || loaded.ok) throw new Error("坏 JSON 应当返回 ok:false");
    expect(loaded.error).toMatch(/JSON/i);
    expect(loaded.source).toBe(".heming/hooks.json");
  });

  it("文件太大：直接拒绝（不让一份巨型配置拖慢每次调用）", async () => {
    const big = "x".repeat(CLI_HOOKS_MAX_BYTES + 1);
    const loaded = await loadCliHooks(workspaceWith(big), true);
    if (!loaded || loaded.ok) throw new Error("超大配置应当返回 ok:false");
    expect(loaded.error).toContain("太大");
  });

  it("同名路径是个目录：报「不是文件」", async () => {
    const dir = tmpDir();
    mkdirSync(path.join(dir, ".heming", "hooks.json"), { recursive: true });
    const loaded = await loadCliHooks(dir, true);
    if (!loaded || loaded.ok) throw new Error("目录应当返回 ok:false");
    expect(loaded.error).toContain("不是文件");
  });
});

describe("describeCliHooks", () => {
  it("可信时说明会真跑，不可信时说明要加 --trust-hooks", () => {
    const trusted = describeCliHooks(hookSetOf([{ tool: "*", command: "node a.js" }], true));
    expect(trusted).toContain("1 条");
    expect(trusted).toContain("已启用");
    expect(trusted).toContain(".heming/hooks.json");

    const untrusted = describeCliHooks(hookSetOf([{ tool: "*", command: "node a.js" }], false));
    expect(untrusted).toContain("未启用");
    expect(untrusted).toContain("--trust-hooks");
  });

  it("零条规则时只说「没有规则」，不假装已启用", () => {
    const line = describeCliHooks(hookSetOf([], true));
    expect(line).toContain("没有规则");
    expect(line).not.toContain("已启用");
  });
});

describe("createCliHookRunner", () => {
  it("没启用或没有规则时返回 null（调用方据此完全跳过）", () => {
    expect(createCliHookRunner(hookSetOf([{ tool: "*", command: "x" }], false), { cwd: tmpDir(), streamId: "s" })).toBeNull();
    expect(createCliHookRunner(hookSetOf([], true), { cwd: tmpDir(), streamId: "s" })).toBeNull();
  });

  it("没命中的调用：放行，而且不起进程", async () => {
    const dir = tmpDir();
    const fake = fakeProcess(ALLOW);
    const run = createCliHookRunner(hookSetOf([{ tool: "file_write", path: "generated/**", command: "node check.js" }]), {
      cwd: dir,
      streamId: "s",
      runtime: { runProcess: fake.run as never },
    });
    const verdict = await run!({ name: "file_write", arguments: JSON.stringify({ path: "src/a.ts" }) });
    expect(verdict.decision).toBe("allow");
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("命中且退出码 2：拒绝，并带上第几条规则与命令原文", async () => {
    const dir = tmpDir();
    const fake = fakeProcess({ exitCode: 2, stdout: "generated 不许手改\n", stderr: "", timedOut: false });
    const run = createCliHookRunner(
      hookSetOf([
        { tool: "file_read", command: "node ok.js" },
        { tool: "file_write", path: "generated/**", command: "node check.js" },
      ]),
      { cwd: dir, streamId: "s", runtime: { runProcess: fake.run as never } },
    );
    const verdict = await run!({ name: "file_write", arguments: JSON.stringify({ path: "generated/a.ts" }) });
    expect(verdict.decision).toBe("deny");
    expect(verdict.ruleIndex).toBe(2);
    expect(verdict.command).toBe("node check.js");
    expect(verdict.reason).toBe("generated 不许手改");
  });

  it("stdout 里的 JSON 决定放行时，退出码非 0 也放行", async () => {
    const dir = tmpDir();
    const fake = fakeProcess({ exitCode: 7, stdout: '{"decision":"allow"}', stderr: "warn", timedOut: false });
    const run = createCliHookRunner(hookSetOf([{ tool: "*", command: "node check.js" }]), {
      cwd: dir,
      streamId: "s",
      runtime: { runProcess: fake.run as never },
    });
    expect((await run!({ name: "file_write", arguments: "{}" })).decision).toBe("allow");
  });

  it("超时一律拒绝（就算进程前面打了 allow）", async () => {
    const dir = tmpDir();
    const fake = fakeProcess({ exitCode: 0, stdout: '{"decision":"allow"}', stderr: "", timedOut: true });
    const run = createCliHookRunner(hookSetOf([{ tool: "*", command: "node slow.js" }]), {
      cwd: dir,
      streamId: "s",
      runtime: { runProcess: fake.run as never },
    });
    const verdict = await run!({ name: "file_write", arguments: "{}" });
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toContain("超时");
  });

  it("payload 里是模型发来的参数原文，跑完把临时文件删掉", async () => {
    const dir = tmpDir();
    const rawArgs = '{ "path" : "generated/a.ts", "content": "x" }';
    const captured: Array<{ payload: unknown; command: string }> = [];
    const fake = fakeProcess((command) => {
      // 命令是 `<配置里的命令> "<payload 绝对路径>"`，末段就是 payload。
      const payloadPath = command.slice(command.indexOf('"') + 1, -1);
      captured.push({ payload: JSON.parse(readFileSync(payloadPath, "utf8")), command });
      return ALLOW;
    });
    const run = createCliHookRunner(hookSetOf([{ tool: "file_write", command: "node check.js" }]), {
      cwd: dir,
      streamId: "stream-1",
      agentId: "cli",
      runtime: { runProcess: fake.run as never },
    });
    const verdict = await run!({ name: "file_write", arguments: rawArgs });
    expect(verdict.decision).toBe("allow");
    expect(captured).toHaveLength(1);
    const payload = captured[0]!.payload as {
      event: string;
      tool: { name: string; arguments: string };
      workspace: string;
      streamId: string;
      agentId: string;
    };
    expect(payload.event).toBe("PreToolUse");
    expect(payload.tool.name).toBe("file_write");
    // 原文不二次序列化：空白与字段顺序都要留着，hook 脚本才敢逐字核对。
    expect(payload.tool.arguments).toBe(rawArgs);
    expect(payload.workspace).toBe(dir.replace(/\\/g, "/"));
    expect(payload.streamId).toBe("stream-1");
    expect(payload.agentId).toBe("cli");
    expect(captured[0]!.command.endsWith('"')).toBe(true);
    // 临时文件不该留在工作区里。
    const tmpRel = path.join(dir, ".heming", "hooks", ".tmp");
    const leftovers = existsSync(tmpRel) ? readdirSync(tmpRel) : [];
    expect(leftovers).toEqual([]);
  });

  it("第一条拒绝就停：后面的规则不再执行", async () => {
    const dir = tmpDir();
    const fake = fakeProcess({ exitCode: 2, stdout: "第一条说不行", stderr: "", timedOut: false });
    const run = createCliHookRunner(
      hookSetOf([
        { tool: "*", command: "node first.js" },
        { tool: "*", command: "node second.js" },
      ]),
      { cwd: dir, streamId: "s", runtime: { runProcess: fake.run as never } },
    );
    await run!({ name: "file_write", arguments: "{}" });
    expect(fake.run).toHaveBeenCalledTimes(1);
  });

  it("真起一个子进程：命令拿得到 payload 路径，退出码 2 带原因拒绝", async () => {
    const dir = tmpDir();
    mkdirSync(path.join(dir, ".heming"), { recursive: true });
    // 脚本读 argv[2]（payload 路径），path 落在 generated/ 下就以退出码 2 拒绝。
    writeFileSync(
      path.join(dir, ".heming", "check.mjs"),
      [
        "import { readFileSync } from 'node:fs';",
        "const payload = JSON.parse(readFileSync(process.argv[2], 'utf8'));",
        "const args = JSON.parse(payload.tool.arguments || '{}');",
        "if (String(args.path || '').startsWith('generated/')) {",
        "  console.log('generated 目录不许手改');",
        "  process.exit(2);",
        "}",
        "console.log(JSON.stringify({ decision: 'allow' }));",
      ].join("\n"),
      "utf8",
    );
    const text = JSON.stringify({
      hooks: [
        {
          match: { tool: "file_write", path: "generated/**" },
          command: `"${process.execPath}" .heming/check.mjs`,
          timeoutMs: 15_000,
        },
      ],
    });
    writeFileSync(path.join(dir, ".heming", "hooks.json"), text, "utf8");
    const reloaded = await loadCliHooks(dir, true);
    if (!reloaded || !reloaded.ok) throw new Error("配置该读得出来");

    const run = createCliHookRunner(reloaded.set, { cwd: dir, streamId: "s" });
    const denied = await run!({ name: "file_write", arguments: JSON.stringify({ path: "generated/a.ts" }) });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("generated 目录不许手改");

    const allowed = await run!({ name: "file_write", arguments: JSON.stringify({ path: "src/a.ts" }) });
    expect(allowed.decision).toBe("allow");
  }, 30_000);

  it("被拒绝时的文案说清「未修改」「不是用户的选择」", () => {
    const text = cliHookDeniedText(
      { decision: "deny", reason: "没通过检查", ruleIndex: 1, command: "node check.js" },
      "file_write",
    );
    expect(text).toContain("hooks 拒绝");
    expect(text).toContain("file_write");
    expect(text).toContain("【该操作未执行，文件与系统状态未被修改】");
    expect(text).toContain("不是用户的选择");
    expect(text).toContain("node check.js");
    expect(text).toContain("没通过检查");
  });
});

describe("工具桥里的钩子（createCliTooling）", () => {
  it("被钩子拒绝时工具不执行，磁盘没有变化", async () => {
    const dir = tmpDir();
    const verdict: CliHookVerdict = { decision: "deny", reason: "挡一下", ruleIndex: 1, command: "node check.js" };
    const tooling = createCliTooling({
      cwd: dir,
      allowDanger: false,
      conversationId: "conv-hooks",
      hooks: async () => verdict,
    });
    const result = await tooling.toolBridge.execute(
      { name: "file_write", arguments: JSON.stringify({ path: "a.txt", content: "hello" }) },
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain("hooks 拒绝");
    expect(result.text).toContain("挡一下");
    expect(existsSync(path.join(dir, "a.txt"))).toBe(false);
  });

  it("钩子放行时工具照常执行，writes 照常回报", async () => {
    const dir = tmpDir();
    const tooling = createCliTooling({
      cwd: dir,
      allowDanger: false,
      conversationId: "conv-hooks",
      hooks: async () => ({ decision: "allow" }),
    });
    const result = await tooling.toolBridge.execute(
      { name: "file_write", arguments: JSON.stringify({ path: "a.txt", content: "hello" }) },
      {},
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("hello");
    expect(result.writes?.length).toBe(1);
  });

  it("钩子看到的是模型发来的原文参数（没有被相对化改写）", async () => {
    const dir = tmpDir();
    const seen: string[] = [];
    const tooling = createCliTooling({
      cwd: dir,
      allowDanger: false,
      conversationId: "conv-hooks",
      hooks: async (call) => {
        seen.push(call.arguments);
        return { decision: "allow" };
      },
    });
    const abs = `${dir.replace(/\\/g, "/")}/b.txt`;
    await tooling.toolBridge.execute(
      { name: "file_write", arguments: JSON.stringify({ path: abs, content: "x" }) },
      {},
    );
    expect(seen[0]).toContain(abs);
    expect(existsSync(path.join(dir, "b.txt"))).toBe(true);
  });
});
describe("执行后的检查（d.345）", () => {
  const ctx = (dir: string) => ({ cwd: dir, streamId: "s1" });

  it("没有 on: post 的规则时返回 null，调用方完全跳过", () => {
    const dir = tmpDir();
    const set = hookSetOf([{ tool: "file_write", command: "node pre.js" }]);
    expect(createCliPostHookRunner(set, ctx(dir))).toBeNull();
  });

  it("没启用（没有 --trust-hooks）时也不建执行后检查", () => {
    const dir = tmpDir();
    const set = hookSetOf([{ tool: "file_write", command: "node post.js", on: "post" }], false);
    expect(createCliPostHookRunner(set, ctx(dir))).toBeNull();
  });

  it("跑执行后规则：退出码 2 变成说明，带命令与序号，不改变调用结果", async () => {
    const dir = tmpDir();
    const set = hookSetOf([
      { tool: "file_write", command: "node pre.js" },
      { tool: "file_write", command: "node post.js", on: "post" },
    ]);
    const run = fakeProcess({ exitCode: 2, stdout: "改完没跑格式化", stderr: "", timedOut: false });
    const runner = createCliPostHookRunner(set, { ...ctx(dir), runtime: { runProcess: run.run } });
    expect(runner).not.toBeNull();

    const notes = await runner!({ name: "file_write", arguments: '{"path":"a.ts"}' }, { ok: true, text: "写入成功" });

    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ command: "node post.js", ruleIndex: 2 });
    expect(notes[0]!.text).toContain("工具已执行");
    expect(notes[0]!.text).toContain("改完没跑格式化");
    expect(run.calls).toHaveLength(1);
  });

  it("执行前规则不会在 runPost 里被重跑", async () => {
    const dir = tmpDir();
    const set = hookSetOf([{ tool: "file_write", command: "node pre.js" }]);
    const run = fakeProcess({ exitCode: 2, stdout: "不该跑", stderr: "", timedOut: false });
    // 上面那个用例已证明没有 post 规则会返回 null；这里手工绕开守卫，验匹配层也不串。
    const runner = createCliPostHookRunner({ ...set, hooks: [...set.hooks, { phase: "post" as const, tool: ["file_read"], command: "node other.js", timeoutMs: 10_000 }] }, { ...ctx(dir), runtime: { runProcess: run.run } });
    expect(await runner!({ name: "file_write", arguments: "{}" }, { ok: true, text: "ok" })).toEqual([]);
    expect(run.calls).toHaveLength(0);
  });
});

describe("工具桥里的执行后检查（d.345）", () => {
  it("说明附在结果后面，结果本身的 ok 不变", async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "a.txt"), "内容", "utf8");
    const tooling = createCliTooling({
      cwd: dir,
      allowDanger: false,
      conversationId: "post-hook-test",
      postHooks: async () => [{ command: "node post.js", ruleIndex: 1, text: "检查说：没格式化" }],
      rewind: false,
    });

    const result = await tooling.toolBridge.execute({ name: "file_read", arguments: JSON.stringify({ path: "a.txt" }) });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("内容");
    expect(result.text).toContain("【执行后的本机检查】");
    expect(result.text).toContain("检查说：没格式化");
  });

  it("执行后检查自己抛错时，调用结果原样返回（不能把成功报成失败）", async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "a.txt"), "内容", "utf8");
    const tooling = createCliTooling({
      cwd: dir,
      allowDanger: false,
      conversationId: "post-hook-test",
      postHooks: async () => {
        throw new Error("检查脚本炸了");
      },
      rewind: false,
    });

    const result = await tooling.toolBridge.execute({ name: "file_read", arguments: JSON.stringify({ path: "a.txt" }) });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("内容");
    expect(result.text).not.toContain("检查脚本炸了");
  });
});