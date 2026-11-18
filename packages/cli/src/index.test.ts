/**
 * CLI 入口的进程级回归（d.309）。
 *
 * 这里只钉两件「单测钉不住」的事：
 * - `--mcp` 连上之后如果中途因为「没配模型」之类提前退出，进程必须**马上结束**：
 *   MCP 子进程挂在 stdio 管道上，连接不关掉的话 Node 会一直等，终端就挂住了；
 * - `--help` 里能看见这条新路（能力边界改了口径，别让帮助文本落回旧说法）。
 *
 * 需要真的拉起进程，所以用仓库里已装好的 tsx 转译 `src/index.ts`；找不到 tsx 时跳过。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "index.ts");

/** 仓库根下的 tsx（优先包内，其次仓库根）。 */
function findTsx(): string | null {
  const candidates = [
    path.join(here, "..", "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(here, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return path.resolve(candidate);
  }
  return null;
}

const tsx = findTsx();
const TMP: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heming-cli-index-"));
  TMP.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** 跑一次 CLI：显式清掉模型凭据，避免这台机器上已配置的 Key 让分支走偏。 */
function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsx ?? "", entry, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HEMING_API_KEY: "", OPENAI_API_KEY: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr, durationMs: Date.now() - startedAt }));
  });
}

describe.skipIf(tsx === null)("CLI 入口的进程级行为", () => {
  it("--mcp 连上后提前失败，进程也要立刻退出（不留挂住的子进程）", async () => {
    const dir = tmpDir();
    mkdirSync(path.join(dir, ".heming"), { recursive: true });
    const server = path.join(dir, "server.mjs");
    writeFileSync(
      server,
      [
        'import readline from "node:readline";',
        'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
        'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
        'rl.on("line", (line) => {',
        "  let message; try { message = JSON.parse(line); } catch { return; }",
        "  if (message.id === undefined) return;",
        '  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "demo", version: "1.0.0" } } });',
        '  if (message.method === "tools/list") return send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo" }] } });',
        "});",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(dir, ".heming", "mcp.json"),
      JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [server] } } }),
      "utf8",
    );

    const result = await runCli(["run", "--cwd", dir, "--mcp", "试一下"]);
    expect(result.stderr).toContain("MCP 已连上 demo");
    expect(result.code).toBe(2);
    // 挂住的话这里会一直等到 vitest 的超时：给一个宽但明确的界。
    expect(result.durationMs).toBeLessThan(30_000);
  }, 40_000);

  it("--help 说明反方向的作用（--mcp），不再是「不接 MCP」", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--mcp");
    expect(result.stdout).toContain(".heming/mcp.json");
    expect(result.stdout).toContain("--trust-workspace");
  }, 30_000);

  /**
   * `--ask` 的底线：没有真终端就不启动。
   *
   * 这里 stdin 是 `ignore`（不是 TTY），正是「管道 / CI / 重定向」那种情形。如果实现
   * 退化成「默认拒绝但照跑」，模型会一遍遍被拒；更糟的是有人把下一行 stdin 当成 `y`。
   */
  it("--ask 在非终端下直接拒绝启动（exit 2）并说明为什么", async () => {
    const result = await runCli(["run", "--ask", "跑一下测试"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--ask 需要真正的终端");
    expect(result.durationMs).toBeLessThan(30_000);
  }, 30_000);

  it("--help 里有 --ask 与它的示例", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--ask");
    expect(result.stdout).toContain("需要真终端");
  }, 30_000);
});
