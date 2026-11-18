import { describe, expect, it, vi } from "vitest";
import type { FileFsBridge, FileWriteOp } from "../fileEdit/bridge.js";
import type { FileRoot } from "../fileEdit/paths.js";
import type { ShellBridge, ShellRunRequest, ShellRunResponse } from "../shell/bridge.js";
import { createMemoryStorage } from "../memory/storage.js";
import {
  HOOKS_ENABLED_KEY,
  createToolHookRunner,
  describeToolHooksState,
  isToolHooksEnabled,
  readHooksEnabled,
  setToolHooksEnabled,
  type ToolHookRunnerDeps,
} from "./hookRunner.js";

const WS = "D:/ws";
const ROOTS: FileRoot[] = [{ name: "ws", path: WS, mode: "write" }];
const CONFIG_PATH = `${WS}/.heming/hooks.json`;

/** 一个够用的内存文件桥：读配置、写/删 payload。 */
function fakeFileBridge(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const writes: { path: string; kind: "write" | "delete"; content?: string }[] = [];
  const bridge: FileFsBridge = {
    read: vi.fn(async ({ path }) => {
      const content = files.get(path);
      if (content === undefined) {
        return { ok: false as const, code: "not-found" as const, error: "文件不存在" };
      }
      return { ok: true as const, content, bytes: content.length };
    }),
    write: vi.fn(async ({ ops }: { roots: FileRoot[]; ops: FileWriteOp[]; createParents?: boolean }) => {
      for (const op of ops) {
        writes.push({ path: op.path, kind: op.kind, content: op.content });
        if (op.kind === "write") files.set(op.path, op.content ?? "");
        else files.delete(op.path);
      }
      return { ok: true, written: 1, deleted: 1 };
    }),
    pickRoot: vi.fn(async () => null),
  };
  return { bridge, files, writes };
}

function fakeShell(response: ShellRunResponse | (() => ShellRunResponse)) {
  const requests: ShellRunRequest[] = [];
  const bridge: ShellBridge = {
    run: vi.fn(async (request: ShellRunRequest) => {
      requests.push(request);
      return typeof response === "function" ? response() : response;
    }),
  };
  return { bridge, requests };
}

function makeDeps(overrides: Partial<ToolHookRunnerDeps> = {}): ToolHookRunnerDeps {
  return {
    getFileBridge: () => null,
    getShellBridge: () => null,
    getRoots: () => ROOTS,
    isEnabled: () => true,
    now: () => 1_700_000_000_000,
    newRunId: (() => {
      let n = 0;
      return () => `run-${++n}`;
    })(),
    ...overrides,
  };
}

const denyConfig = JSON.stringify({
  hooks: [{ match: { tool: "file_write" }, command: "node scripts/check.js" }],
});

describe("createToolHookRunner：显式启用是安全边界", () => {
  it("未启用时：deny 规则也不执行、不拦截（工具照常走 HITL）", async () => {
    const file = fakeFileBridge({ [CONFIG_PATH]: denyConfig });
    const shell = fakeShell({ ok: true, exitCode: 2, stdout: "不许写", stderr: "", truncated: false, durationMs: 1, cwd: WS });
    const runner = createToolHookRunner(
      makeDeps({
        getFileBridge: () => file.bridge,
        getShellBridge: () => shell.bridge,
        isEnabled: () => false,
      }),
    );

    const verdict = await runner.run(
      { name: "file_write", arguments: '{"path":"src/a.ts"}' },
      { workspace: WS, agentId: "a1", streamId: "s1" },
    );

    expect(verdict).toEqual({ decision: "allow" });
    expect(shell.requests).toHaveLength(0);
    expect(file.writes).toHaveLength(0);
    // 未启用时连配置都不读：规则可以展示，但工具路径上不做任何额外 I/O/执行。
    expect(file.bridge.read).not.toHaveBeenCalled();
  });

  it("启用后：退出码 2 拒绝，命令末尾追加 payload 路径，payload 用完即删", async () => {
    const file = fakeFileBridge({ [CONFIG_PATH]: denyConfig });
    let payloadAtRun: string | undefined;
    const shell: { bridge: ShellBridge; requests: ShellRunRequest[] } = {
      requests: [],
      bridge: {
        run: vi.fn(async (request: ShellRunRequest): Promise<ShellRunResponse> => {
          shell.requests.push(request);
          payloadAtRun = file.files.get(`${WS}/.heming/hooks/.tmp/run-1.json`);
          return { ok: true, exitCode: 2, stdout: "\n  不许写 src  \n第二行", stderr: "", truncated: false, durationMs: 3, cwd: WS };
        }),
      },
    };
    const runner = createToolHookRunner(
      makeDeps({ getFileBridge: () => file.bridge, getShellBridge: () => shell.bridge }),
    );

    const verdict = await runner.run(
      { name: "file_write", arguments: '{"path":"src/a.ts"}' },
      { workspace: WS, agentId: "a1", streamId: "s1" },
    );

    expect(verdict).toMatchObject({ decision: "deny" });
    expect(verdict.reason).toContain("node scripts/check.js");
    expect(verdict.reason).toContain("不许写 src");
    expect(shell.requests).toHaveLength(1);
    expect(shell.requests[0]).toMatchObject({ cwd: WS, timeoutMs: 10_000 });
    expect(shell.requests[0].command).toBe(
      `node scripts/check.js "${WS}/.heming/hooks/.tmp/run-1.json"`,
    );

    const payload = JSON.parse(payloadAtRun ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: "PreToolUse",
      tool: { name: "file_write", arguments: '{"path":"src/a.ts"}' },
      workspace: WS,
      agentId: "a1",
      streamId: "s1",
    });
    // 判定结束后临时文件被删掉（内容不留在仓库里）
    expect(file.files.has(`${WS}/.heming/hooks/.tmp/run-1.json`)).toBe(false);
    expect(file.writes.map((item) => item.kind)).toEqual(["write", "delete"]);
  });

  it("启用后配置错误：fail-closed，不跑命令", async () => {
    const file = fakeFileBridge({ [CONFIG_PATH]: "{ 坏 JSON" });
    const shell = fakeShell({ ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 0, cwd: WS });
    const runner = createToolHookRunner(
      makeDeps({ getFileBridge: () => file.bridge, getShellBridge: () => shell.bridge }),
    );

    const verdict = await runner.run(
      { name: "file_write", arguments: "{}" },
      { workspace: WS, agentId: "a1", streamId: "s1" },
    );

    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toContain("hooks 配置有误");
    expect(shell.requests).toHaveLength(0);
  });

  it("多条 hook：第一条放行后继续，第二条拒绝即短路（第三条不跑）", async () => {
    const config = JSON.stringify({
      hooks: [
        { match: { tool: "*" }, command: "first.js" },
        { match: { tool: "file_write" }, command: "second.js" },
        { match: { tool: "file_write" }, command: "third.js" },
      ],
    });
    const file = fakeFileBridge({ [CONFIG_PATH]: config });
    const requests: ShellRunRequest[] = [];
    const shellBridge: ShellBridge = {
      run: vi.fn(async (request: ShellRunRequest): Promise<ShellRunResponse> => {
        requests.push(request);
        const allowed = requests.length === 1;
        return {
          ok: true,
          exitCode: allowed ? 0 : 2,
          stdout: allowed ? "" : "第二道拦下",
          stderr: "",
          truncated: false,
          durationMs: 1,
          cwd: WS,
        };
      }),
    };
    const runner = createToolHookRunner(
      makeDeps({ getFileBridge: () => file.bridge, getShellBridge: () => shellBridge }),
    );

    const verdict = await runner.run(
      { name: "file_write", arguments: "{}" },
      { workspace: WS, agentId: "a1", streamId: "s1" },
    );

    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toContain("第 2 条");
    expect(verdict.reason).toContain("second.js");
    expect(requests).toHaveLength(2);
    // 每次执行各自写/删一份 payload（run-1、run-2）
    expect(file.writes.filter((item) => item.kind === "write")).toHaveLength(2);
    expect(file.writes.filter((item) => item.kind === "delete")).toHaveLength(2);
  });

  it("命令超时/起不来：拒绝（fail-closed），文案带命令与超时", async () => {
    const file = fakeFileBridge({ [CONFIG_PATH]: denyConfig });
    const shell = fakeShell({ ok: false, code: "timeout", error: "执行超时" });
    const runner = createToolHookRunner(
      makeDeps({ getFileBridge: () => file.bridge, getShellBridge: () => shell.bridge }),
    );

    const verdict = await runner.run(
      { name: "file_write", arguments: "{}" },
      { workspace: WS, agentId: "a1", streamId: "s1" },
    );

    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toContain("node scripts/check.js");
    expect(verdict.reason).toContain("超时");
  });

  it("缺命令桥：不启用（allow），/hooks 如实说缺哪条通道", async () => {
    const file = fakeFileBridge({ [CONFIG_PATH]: denyConfig });
    const runner = createToolHookRunner(
      makeDeps({ getFileBridge: () => file.bridge, getShellBridge: () => null }),
    );

    const verdict = await runner.run(
      { name: "file_write", arguments: "{}" },
      { workspace: WS, agentId: "a1", streamId: "s1" },
    );
    expect(verdict).toEqual({ decision: "allow" });

    const state = await runner.load(WS);
    expect(state.status).toBe("unavailable");
    expect(state.missing).toContain("shell");
    expect(describeToolHooksState(state)).toContain("命令桥");
  });
});

describe("启用开关（localStorage）", () => {
  it("按工作区根记、大小写不敏感；off 移除；损坏的存储当未启用", () => {
    const storage = createMemoryStorage();
    expect(isToolHooksEnabled("D:/Work/Repo", storage)).toBe(false);

    expect(setToolHooksEnabled("D:/Work/Repo/", true, storage)).toBe(true);
    expect(isToolHooksEnabled("d:/work/repo", storage)).toBe(true);
    expect(readHooksEnabled(storage)).toEqual({ "d:/work/repo": true });
    // 别的仓库不受影响
    expect(isToolHooksEnabled("D:/other", storage)).toBe(false);

    expect(setToolHooksEnabled("D:/Work/Repo", false, storage)).toBe(true);
    expect(isToolHooksEnabled("D:/Work/Repo", storage)).toBe(false);

    storage.setItem(HOOKS_ENABLED_KEY, "坏 JSON");
    expect(isToolHooksEnabled("D:/Work/Repo", storage)).toBe(false);
  });

  it("没有存储时不假装启用成功", () => {
    expect(setToolHooksEnabled("D:/ws", true, null)).toBe(false);
    expect(isToolHooksEnabled("D:/ws", null)).toBe(false);
  });
});

describe("describeToolHooksState", () => {
  it("未启用也列出规则，并明确说只展示不执行", async () => {
    const file = fakeFileBridge({ [CONFIG_PATH]: denyConfig });
    const runner = createToolHookRunner(
      makeDeps({
        getFileBridge: () => file.bridge,
        getShellBridge: () => fakeShell({ ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 0, cwd: WS }).bridge,
        isEnabled: () => false,
      }),
    );
    const text = describeToolHooksState(await runner.load(WS));
    expect(text).toContain("未启用");
    expect(text).toContain("不执行任何 hook");
    expect(text).toContain("node scripts/check.js");
    expect(text).toContain("/hooks on");
    expect(text).toContain("允许本工区的钩子脚本在你的机器上执行");
  });
});

describe("执行后的检查：runPost（d.345）", () => {
  const postConfig = JSON.stringify({
    hooks: [{ match: { tool: "file_write" }, command: "node scripts/post.js", on: "post" }],
  });
  const ctx = { workspace: WS, agentId: "a1", streamId: "s1" };
  const writeCall = { name: "file_write", arguments: '{"path":"src/a.ts"}' };

  it("工具跑完之后才跑，退出码 2 变成说明而不是拒绝", async () => {
    const file = fakeFileBridge({ [CONFIG_PATH]: postConfig });
    const shell = fakeShell({
      ok: true,
      exitCode: 2,
      stdout: "生成的代码没格式化",
      stderr: "",
      truncated: false,
      durationMs: 2,
      cwd: WS,
    });
    const runner = createToolHookRunner(
      makeDeps({ getFileBridge: () => file.bridge, getShellBridge: () => shell.bridge }),
    );

    const notes = await runner.runPost(writeCall, { ok: true, text: "写入成功" }, ctx);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ command: "node scripts/post.js", ruleIndex: 1 });
    expect(notes[0]!.text).toContain("工具已执行");
    expect(notes[0]!.text).toContain("生成的代码没格式化");
    expect(shell.requests).toHaveLength(1);
    // payload 里带的是「刚才那次调用的结果」，检查脚本据此判断要不要提示。
    const payload = JSON.parse(file.writes[0]!.content ?? "{}") as Record<string, unknown>;
    expect(payload.event).toBe("PostToolUse");
    expect(payload.result).toEqual({ ok: true, text: "写入成功" });
  });

  it("没启用时一次都不跑（连配置都不读）", async () => {
    const file = fakeFileBridge({ [CONFIG_PATH]: postConfig });
    const shell = fakeShell({ ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1, cwd: WS });
    const runner = createToolHookRunner(
      makeDeps({ getFileBridge: () => file.bridge, getShellBridge: () => shell.bridge, isEnabled: () => false }),
    );

    expect(await runner.runPost(writeCall, { ok: true, text: "ok" }, ctx)).toEqual([]);
    expect(shell.requests).toHaveLength(0);
    expect(file.bridge.read).not.toHaveBeenCalled();
  });

  it("只有执行前规则时，runPost 什么都不做（两档互不串）", async () => {
    const file = fakeFileBridge({ [CONFIG_PATH]: denyConfig });
    const shell = fakeShell({ ok: true, exitCode: 2, stdout: "不该跑", stderr: "", truncated: false, durationMs: 1, cwd: WS });
    const runner = createToolHookRunner(
      makeDeps({ getFileBridge: () => file.bridge, getShellBridge: () => shell.bridge }),
    );

    expect(await runner.runPost(writeCall, { ok: true, text: "ok" }, ctx)).toEqual([]);
    expect(shell.requests).toHaveLength(0);
  });
});