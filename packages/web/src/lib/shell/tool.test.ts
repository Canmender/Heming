import { describe, it, expect, vi } from "vitest";
import { buildShellToolBridge, buildShellToolBridgeIfAvailable, SHELL_TOOL } from "./tool.js";
import type { ShellBridge, ShellRunResponse } from "./bridge.js";
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
    expect(tool.meta?.(SHELL_TOOL)).toEqual({ risk: "danger", displayName: "运行命令" });
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
