import { describe, it, expect } from "vitest";
import { buildShellToolBridge, buildShellToolBridgeIfAvailable, SHELL_TOOL } from "./tool.js";
import { hasJobBridge, hasJobRuntime } from "./bridge.js";
import type {
  ShellBridge,
  ShellFailure,
  ShellJobKillResponse,
  ShellJobOutputResponse,
  ShellJobStartResponse,
  ShellJobSummary,
  ShellRunResponse,
} from "./bridge.js";
import { SHELL_MAX_COMMAND_CHARS } from "./limits.js";
import type { FileRoot } from "../fileEdit/paths.js";

const ROOT: FileRoot = { name: "工作区", path: "/库/项目", mode: "write" };

function bridgeOf(result: ShellRunResponse | (() => Promise<ShellRunResponse>)): ShellBridge & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async run(request) {
      calls.push(request);
      return typeof result === "function" ? result() : result;
    },
  };
}

const ok = (stdout = "", extra: Record<string, unknown> = {}): ShellRunResponse => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: "",
  truncated: false,
  durationMs: 12,
  cwd: "/库/项目",
  ...extra,
});

async function run(bridge: ShellBridge, args: unknown, roots: FileRoot[] = [ROOT]) {
  const tool = buildShellToolBridge({ bridge, roots: () => roots });
  return tool.execute({ name: SHELL_TOOL, arguments: JSON.stringify(args) });
}

describe("run_command 工具（d.164）", () => {
  it("暴露一件工具，风险与显示名由 meta 给出", () => {
    const tool = buildShellToolBridge({ bridge: bridgeOf(ok()), roots: () => [ROOT] });
    expect(tool.tools).toHaveLength(1);
    // 必须是 OpenAI 格式：`mergeToolBridges` / `CapabilityRegistry` 按 `spec.function.name`
    // 认领工具，塞裸定义会让 run_command 在「多 provider 合并」时静默变成「未知工具」（d.165 修）。
    const spec = tool.tools[0] as { type: string; function: { name: string; parameters: { required: string[] } } };
    expect(spec.type).toBe("function");
    expect(spec.function.name).toBe("run_command");
    expect(spec.function.parameters.required).toEqual(["command"]);
    expect(tool.meta?.(SHELL_TOOL)).toEqual({ risk: "danger", displayName: "运行命令", core: true });
    expect(tool.meta?.("file_read")).toBeUndefined();
  });

  it("执行成功：回退出码、工作目录与输出", async () => {
    const bridge = bridgeOf(ok("构建成功\n"));
    const res = await run(bridge, { command: "npm run build" });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("退出码 0");
    expect(res.text).toContain("工作目录：工作区（.）");
    expect(res.text).toContain("构建成功");
    expect(bridge.calls[0]).toMatchObject({ command: "npm run build", timeoutMs: 30000 });
  });

  it("cwd 会解析成根内绝对路径，越界 cwd 在本地就拒（不打扰用户）", async () => {
    const bridge = bridgeOf(ok());
    const res = await run(bridge, { command: "ls", cwd: "src/lib" });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("工作目录：工作区（src/lib）");
    expect((bridge.calls[0] as { cwd?: string }).cwd).toBe("/库/项目/src/lib");

    const escaped = await run(bridge, { command: "ls", cwd: "../外面" });
    expect(escaped.ok).toBe(false);
    expect(escaped.error?.error_code).toBe("path-escape");
    expect(bridge.calls).toHaveLength(1);
  });

  it("非零退出码算「执行完成但失败」：带回输出并明确要求读错误", async () => {
    const bridge = bridgeOf({ ...ok("", {}), exitCode: 1, stderr: "TS2304: 找不到名称" } as ShellRunResponse);
    const res = await run(bridge, { command: "tsc --noEmit" });
    expect(res.ok).toBe(false);
    expect(res.error?.error_code).toBe("command-failed");
    expect(res.text).toContain("TS2304");
    expect(res.text).toContain("不要原样重跑");
  });

  it("超长的命令直接拒绝，并指路「先写成脚本文件」", async () => {
    const bridge = bridgeOf(ok());
    const res = await run(bridge, { command: "a".repeat(SHELL_MAX_COMMAND_CHARS + 1) });
    expect(res.ok).toBe(false);
    expect(res.error?.error_code).toBe("invalid-command");
    expect(res.text).toContain("file_write");
    expect(bridge.calls).toHaveLength(0);
  });

  it("空命令/坏 JSON 都回可照做的错误", async () => {
    const bridge = bridgeOf(ok());
    expect((await run(bridge, { command: "   " })).error?.error_code).toBe("invalid-args");
    const tool = buildShellToolBridge({ bridge, roots: () => [ROOT] });
    const bad = await tool.execute({ name: SHELL_TOOL, arguments: "{oops" });
    expect(bad.ok).toBe(false);
    expect(bad.error?.error_code).toBe("invalid-args");
  });

  it("没有可写根 / 只读根：拒绝执行，不调用桥", async () => {
    const bridge = bridgeOf(ok());
    const noRoot = await run(bridge, { command: "ls" }, []);
    expect(noRoot.error?.error_code).toBe("no-write-root");
    const readOnly = await run(bridge, { command: "ls" }, [{ name: "资料", path: "/库/资料", mode: "read" }]);
    expect(readOnly.error?.error_code).toBe("no-write-root");
    expect(bridge.calls).toHaveLength(0);
  });

  it("超时/中止/过大都映射成稳定错误码，不给「请重试」这种坏建议", async () => {
    const timeout = await run(
      bridgeOf({ ok: false, code: "timeout", error: "命令超过 30000ms 未结束" }),
      { command: "npm test" },
    );
    expect(timeout.error?.error_code).toBe("timeout");
    expect(timeout.text).toContain("可重试：timeout_ms: 1200004".replace("1200004", "120000"));

    const aborted = await run(bridgeOf({ ok: false, code: "aborted", error: "已取消" }), { command: "ls" });
    expect(aborted.error?.error_code).toBe("aborted");
    expect(aborted.text).not.toContain("可重试");

    const big = await run(bridgeOf({ ok: false, code: "too-large", error: "输出过大" }), { command: "dir" });
    expect(big.error?.error_code).toBe("too-large");
    expect(big.text).toContain("过滤");
  });

  it("输出过长会在文本里明说被截断（模型不能以为命令没输出）", async () => {
    const long = "x".repeat(30_000);
    const res = await run(bridgeOf(ok(long)), { command: "cat big" });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("输出过长已截断");
  });

  it("timeout_ms 被夹到 [1000, 120000]", async () => {
    const bridge = bridgeOf(ok());
    await run(bridge, { command: "ls", timeout_ms: 999_999 });
    expect((bridge.calls[0] as { timeoutMs?: number }).timeoutMs).toBe(120_000);
    await run(bridge, { command: "ls", timeout_ms: 10 });
    expect((bridge.calls[1] as { timeoutMs?: number }).timeoutMs).toBe(1000);
  });

  it("没有桥时根本不提供工具（浏览器端不会出现点了没反应的按钮）", () => {
    expect(buildShellToolBridgeIfAvailable({ bridge: undefined, roots: () => [ROOT] })).toBeNull();
    const noWriteRoot = bridgeOf(ok());
    expect(buildShellToolBridgeIfAvailable({ bridge: noWriteRoot, roots: () => [] })).toBeNull();
    expect(buildShellToolBridgeIfAvailable({ bridge: noWriteRoot, roots: () => [ROOT] })).not.toBeNull();
  });

  it("未知工具名给 unknown-tool", async () => {
    const tool = buildShellToolBridge({ bridge: bridgeOf(ok()), roots: () => [ROOT] });
    const res = await tool.execute({ name: "shell_exec", arguments: "{}" });
    expect(res.error?.error_code).toBe("unknown-tool");
  });

  it("已中止的对话不会真的发命令", async () => {
    const bridge = bridgeOf(ok());
    const tool = buildShellToolBridge({ bridge, roots: () => [ROOT] });
    const controller = new AbortController();
    controller.abort();
    const res = await tool.execute(
      { name: SHELL_TOOL, arguments: JSON.stringify({ command: "ls" }) },
      { signal: controller.signal },
    );
    expect(res.error?.error_code).toBe("aborted");
    expect(bridge.calls).toHaveLength(0);
  });
});

describe("取消在跑的命令（d.165）", () => {
  it("中止信号到达时，用同一次执行的 runId 调 cancel，并回 aborted", async () => {
    const cancels: string[] = [];
    let release: (r: ShellRunResponse) => void = () => {};
    const bridge: ShellBridge = {
      async run() {
        return await new Promise<ShellRunResponse>((resolve) => {
          release = resolve;
        });
      },
      async cancel(runId: string) {
        cancels.push(runId);
        // 真实桌面上 cancel 会让 run 以 aborted 收口；这里模拟同一时序
        release({ ok: false, code: "aborted", error: "渲染层已断开，命令被中止" });
        return { ok: true };
      },
    };
    const controller = new AbortController();
    const tool = buildShellToolBridge({ bridge, roots: () => [ROOT], newRunId: () => "cmd-fixed-1" });
    const pending = tool.execute({ name: SHELL_TOOL, arguments: JSON.stringify({ command: "npm test" }) }, { signal: controller.signal });
    controller.abort();
    const res = await pending;
    expect(cancels).toEqual(["cmd-fixed-1"]);
    expect(res.ok).toBe(false);
    expect(res.error?.error_code).toBe("aborted");
    expect(res.text).toContain("命令已取消");
    expect(res.text).toContain("进程树");
  });

  it("老安装包没有 cancel：命令跑完后如实说明「它其实跑完了」", async () => {
    const bridge: ShellBridge = {
      async run() {
        return ok("全部通过\n");
      },
    };
    const controller = new AbortController();
    const tool = buildShellToolBridge({ bridge, roots: () => [ROOT] });
    const pending = tool.execute({ name: SHELL_TOOL, arguments: JSON.stringify({ command: "npm test" }) }, { signal: controller.signal });
    controller.abort();
    const res = await pending;
    expect(res.ok).toBe(true);
    expect(res.text).toContain("全部通过");
    expect(res.text).toContain("不支持中途结束命令");
  });

  it("每次执行都带自己的 runId，不与其他调用共用", async () => {
    const seen: string[] = [];
    const bridge: ShellBridge = {
      async run(request) {
        seen.push(request.runId);
        return ok();
      },
    };
    const tool = buildShellToolBridge({ bridge, roots: () => [ROOT] });
    await tool.execute({ name: SHELL_TOOL, arguments: JSON.stringify({ command: "a" }) });
    await tool.execute({ name: SHELL_TOOL, arguments: JSON.stringify({ command: "b" }) });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeTruthy();
    expect(seen[1]).toBeTruthy();
    expect(seen[0]).not.toBe(seen[1]);
  });
});

// ---------------------------------------------------------------------------
// 后台作业（d.180）：run_command background:true + command_output/list/kill
// ---------------------------------------------------------------------------

interface JobBridgeOptions {
  start?: () => Promise<ShellJobStartResponse | ShellFailure>;
  jobs?: () => Promise<{ ok: true; jobs: ShellJobSummary[] } | ShellFailure>;
  jobOutput?: () => Promise<ShellJobOutputResponse | ShellFailure>;
  jobKill?: () => Promise<ShellJobKillResponse | ShellFailure>;
}

/** 带四个后台方法的「新桥」；记录每次调用，方便断言参数。 */
function jobBridgeOf(options: JobBridgeOptions = {}) {
  const calls = {
    start: [] as unknown[],
    jobs: 0,
    jobOutput: [] as unknown[],
    jobKill: [] as unknown[],
  };
  const bridge: ShellBridge = {
    async run() {
      return ok();
    },
    async start(payload) {
      calls.start.push(payload);
      if (options.start) return options.start();
      const started: ShellJobStartResponse = { ok: true, jobId: "job-1", pid: 4242, cwd: "/库/项目" };
      return started;
    },
    async jobs() {
      calls.jobs += 1;
      if (options.jobs) return options.jobs();
      return { ok: true, jobs: [] };
    },
    async jobOutput(payload) {
      calls.jobOutput.push(payload);
      if (options.jobOutput) return options.jobOutput();
      const output: ShellJobOutputResponse = {
        ok: true,
        jobId: "job-1",
        running: false,
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        droppedBytes: 0,
      };
      return output;
    },
    async jobKill(payload) {
      calls.jobKill.push(payload);
      if (options.jobKill) return options.jobKill();
      const killed: ShellJobKillResponse = { ok: true, jobId: "job-1", killed: true, alreadyFinished: false };
      return killed;
    },
  };
  return { bridge, calls };
}

async function callTool(
  bridge: ShellBridge,
  name: string,
  args: unknown,
  roots: FileRoot[] = [ROOT],
) {
  const tool = buildShellToolBridge({ bridge, roots: () => roots });
  return tool.execute({ name, arguments: JSON.stringify(args) });
}

function jobSummary(overrides: Partial<ShellJobSummary> = {}): ShellJobSummary {
  return {
    id: "job-1",
    command: "npm run build",
    cwd: "/库/项目",
    running: true,
    exitCode: null,
    startedAt: 1_000,
    finishedAt: null,
    bytes: 0,
    dropped: 0,
    ...overrides,
  };
}

describe("后台作业（d.180）", () => {
  it("有后台通道时暴露四件工具，风险与显示名由 meta 给出", () => {
    const { bridge } = jobBridgeOf();
    const tool = buildShellToolBridge({ bridge, roots: () => [ROOT] });
    const names = tool.tools.map((spec) => (spec as { function: { name: string } }).function.name);
    expect(names).toEqual(["run_command", "command_output", "command_list", "command_kill"]);
    expect(tool.meta?.("command_output")).toEqual({ risk: "read", displayName: "读取后台输出", core: true });
    expect(tool.meta?.("command_list")).toEqual({ risk: "read", displayName: "列出后台命令", core: true });
    expect(tool.meta?.("command_kill")).toEqual({ risk: "write", displayName: "停止后台命令", core: true });
  });

  it("background:true 立刻起作业并回 jobId，不进前台 run()", async () => {
    const { bridge, calls } = jobBridgeOf();
    const res = await callTool(bridge, SHELL_TOOL, { command: "npm run build", background: true });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("已在后台启动：jobId=job-1");
    expect(res.text).toContain("工作目录 工作区（.）");
    expect(res.text).toContain("command_output");
    expect(res.text).toContain("command_kill");
    expect(res.text).toContain("最多 30000ms");
    // 必须带绝对工作目录与 runId（主进程不接受「没给 cwd」）
    expect(calls.start[0]).toMatchObject({ command: "npm run build", cwd: "/库/项目" });
    expect((calls.start[0] as { runId?: string }).runId).toBeTruthy();
    expect(calls.jobOutput).toHaveLength(0);
    // d.182：把 jobId 作为结构化字段交给编排层，界面据此盯作业，而不是从文案里抠
    expect(res.jobs).toEqual(["job-1"]);
  });

  it("老桥（无后台通道）只注入 run_command，background:true 报 bridge-missing", async () => {
    const oldBridge = bridgeOf(ok());
    const tool = buildShellToolBridge({ bridge: oldBridge, roots: () => [ROOT] });
    expect(tool.tools).toHaveLength(1);
    const res = await callTool(oldBridge, SHELL_TOOL, { command: "npm run build", background: true });
    expect(res.ok).toBe(false);
    expect(res.error?.error_code).toBe("bridge-missing");
    expect(res.text).toContain("当前桌面端版本不支持后台命令");
    expect(oldBridge.calls).toHaveLength(0);
  });

  it("老桥上调 command_output / command_list / command_kill 也是 bridge-missing", async () => {
    const oldBridge = bridgeOf(ok());
    for (const name of ["command_output", "command_list", "command_kill"]) {
      const res = await callTool(oldBridge, name, { job_id: "job-1" });
      expect(res.error?.error_code).toBe("bridge-missing");
    }
  });

  it("command_output：运行中显示状态与两段输出，并把 wait_ms 传给桥", async () => {
    const { bridge, calls } = jobBridgeOf({
      jobOutput: async () => ({
        ok: true,
        jobId: "job-1",
        running: true,
        exitCode: null,
        stdout: "building...\n",
        stderr: "warn: x\n",
        truncated: false,
        droppedBytes: 0,
      }),
    });
    const res = await callTool(bridge, "command_output", { job_id: "job-1", wait_ms: 5_000 });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("作业 job-1：运行中");
    expect(res.text).toContain("--- stdout ---\nbuilding...");
    expect(res.text).toContain("--- stderr ---\nwarn: x");
    expect(res.text).toContain("再次读取只返回新增输出");
    expect(calls.jobOutput[0]).toEqual({ jobId: "job-1", waitMs: 5_000 });
  });

  it("command_output：已结束带退出码；wait_ms 被夹到 0..30000", async () => {
    const { bridge, calls } = jobBridgeOf({
      jobOutput: async () => ({
        ok: true,
        jobId: "job-2",
        running: false,
        exitCode: 7,
        stdout: "",
        stderr: "",
        truncated: false,
        droppedBytes: 0,
      }),
    });
    const res = await callTool(bridge, "command_output", { job_id: "job-2", wait_ms: 999_999 });
    expect(res.text).toContain("已结束（退出码 7）");
    expect(calls.jobOutput[0]).toMatchObject({ jobId: "job-2", waitMs: 30_000 });
  });

  it("command_output：没有新增输出时两段都明确写「（无新增输出）」", async () => {
    const { bridge } = jobBridgeOf();
    const res = await callTool(bridge, "command_output", { job_id: "job-1" });
    expect(res.text.match(/（无新增输出）/g)).toHaveLength(2);
  });

  it("command_output：截断与丢弃都要在文本里说清数量", async () => {
    const { bridge } = jobBridgeOf({
      jobOutput: async () => ({
        ok: true,
        jobId: "job-1",
        running: true,
        exitCode: null,
        stdout: "tail\n",
        stderr: "",
        truncated: true,
        droppedBytes: 12_345,
      }),
    });
    const res = await callTool(bridge, "command_output", { job_id: "job-1" });
    expect(res.text).toContain("（输出超过 512KB 上限，早期内容已被丢弃）");
    expect(res.text).toContain("（已丢弃 12345 字节早期输出）");
  });

  it("command_list：空列表与有作业两种文案", async () => {
    const empty = await callTool(jobBridgeOf().bridge, "command_list", {});
    expect(empty.text).toBe("当前没有后台作业。");

    const { bridge } = jobBridgeOf({
      jobs: async () => ({
        ok: true,
        jobs: [
          jobSummary({ id: "job-a", command: "npm run build", running: true }),
          jobSummary({
            id: "job-b",
            command: "npm test",
            running: false,
            exitCode: 0,
            startedAt: 1_000,
            finishedAt: 66_000,
          }),
          jobSummary({
            id: "job-c",
            command: "npm run dev\nwith-newline",
            running: false,
            exitCode: null,
            startedAt: 1_000,
            finishedAt: 3_000,
          }),
        ],
      }),
    });
    const res = await callTool(bridge, "command_list", {});
    expect(res.text).toContain("后台作业 3 个：");
    expect(res.text).toContain("- job-a 运行中");
    expect(res.text).toContain("- job-b 已结束(0) 1m05s — npm test");
    expect(res.text).toContain("- job-c 已停止 2.0s — npm run dev with-newline");
  });

  it("command_list：超长命令压成一行并截到 80 字", async () => {
    const long = `echo ${"x".repeat(120)}`;
    const { bridge } = jobBridgeOf({
      jobs: async () => ({ ok: true, jobs: [jobSummary({ id: "job-long", command: long })] }),
    });
    const res = await callTool(bridge, "command_list", {});
    const line = res.text.split("\n")[1];
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(140);
  });

  it("command_kill：已请求停止与已经结束两种文案", async () => {
    const stopping = await callTool(jobBridgeOf().bridge, "command_kill", { job_id: "job-1" });
    expect(stopping.text).toBe("已请求停止作业 job-1，进程树会在停止后清理。");

    const { bridge } = jobBridgeOf({
      jobKill: async () => ({ ok: true, jobId: "job-1", killed: false, alreadyFinished: true }),
    });
    const finished = await callTool(bridge, "command_kill", { job_id: "job-1" });
    expect(finished.text).toBe("作业 job-1 已经结束，无需停止。");
  });

  it("job_id 必填：读/停都回 invalid-args 且不调桥", async () => {
    const { bridge, calls } = jobBridgeOf();
    for (const name of ["command_output", "command_kill"]) {
      const res = await callTool(bridge, name, {});
      expect(res.error?.error_code).toBe("invalid-args");
      expect(res.text).toContain("command_list");
    }
    expect(calls.jobOutput).toHaveLength(0);
    expect(calls.jobKill).toHaveLength(0);
  });

  it("unknown-job 映射成稳定错误码，并指路 command_list", async () => {
    const { bridge } = jobBridgeOf({
      jobOutput: async () => ({ ok: false, code: "unknown-job", error: "作业已清理" }),
    });
    const res = await callTool(bridge, "command_output", { job_id: "job-gone" });
    expect(res.ok).toBe(false);
    expect(res.error?.error_code).toBe("unknown-job");
    expect(res.text).toContain("command_list");
  });

  it("现行桌面端没有独立 start：三通道 + run 即可用，background:true 走 run 的 background 分支", async () => {
    const calls = { run: [] as unknown[] };
    const bridge: ShellBridge = {
      async run(request) {
        calls.run.push(request);
        // 现行 preload 把 background:true 透传给 shell:run，主进程回的就是启动响应。
        return { ok: true, jobId: "job-run-bg", pid: 7, cwd: "/库/项目" } as unknown as ShellRunResponse;
      },
      async jobs() {
        return { ok: true, jobs: [] };
      },
      async jobOutput() {
        return {
          ok: true,
          jobId: "job-1",
          running: false,
          exitCode: 0,
          stdout: "",
          stderr: "",
          truncated: false,
          droppedBytes: 0,
        };
      },
      async jobKill() {
        return { ok: true, jobId: "job-1", killed: true, alreadyFinished: false };
      },
    };
    // 契约 §4 字面的「四方法」是 false（桌面端没有 start），但运行时可用性必须是 true，
    // 否则新桌面端会被当成老桥、四个工具全部不注入。
    expect(hasJobBridge(bridge)).toBe(false);
    expect(hasJobRuntime(bridge)).toBe(true);

    const tool = buildShellToolBridge({ bridge, roots: () => [ROOT] });
    expect(tool.tools).toHaveLength(4);
    const res = await tool.execute({
      name: SHELL_TOOL,
      arguments: JSON.stringify({ command: "npm run build", background: true }),
    });
    expect(res.text).toContain("已在后台启动：jobId=job-run-bg");
    expect(calls.run[0]).toMatchObject({ command: "npm run build", cwd: "/库/项目", background: true });
    expect((calls.run[0] as { runId?: string }).runId).toBeTruthy();
  });

  it("半升级桥（缺 jobOutput）按老桥降级，不假装能起作业", async () => {
    let started = 0;
    const bridge: ShellBridge = {
      async run() {
        return ok();
      },
      async start() {
        started += 1;
        return { ok: true, jobId: "job-half", cwd: "/库/项目" };
      },
      async jobs() {
        return { ok: true, jobs: [] };
      },
      async jobKill() {
        return { ok: true, jobId: "job-1", killed: true, alreadyFinished: false };
      },
    };
    expect(hasJobRuntime(bridge)).toBe(false);
    const tool = buildShellToolBridge({ bridge, roots: () => [ROOT] });
    expect(tool.tools).toHaveLength(1);
    const res = await tool.execute({
      name: SHELL_TOOL,
      arguments: JSON.stringify({ command: "npm run build", background: true }),
    });
    expect(res.error?.error_code).toBe("bridge-missing");
    expect(started).toBe(0);
  });
});
