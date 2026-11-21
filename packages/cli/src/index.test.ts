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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("--ask-writes 非终端下也直接拒绝，且 --help 里有它", async () => {
    const rejected = await runCli(["run", "--ask", "--ask-writes", "改一下"]);
    expect(rejected.code).toBe(2);
    expect(rejected.stderr).toContain("--ask 需要真正的终端");

    const help = await runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--ask-writes");
    expect(help.stdout).toContain("增删对照");
  }, 30_000);
  it("--help 里有 --ask 与它的示例", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--ask");
    expect(result.stdout).toContain("需要真终端");
  }, 30_000);

  it("-o 运行失败时不覆盖已有文件（codex 的 no-overwrite-on-failure 语义）", async () => {
    const dir = tmpDir();
    const out = path.join(dir, "answer.txt");
    writeFileSync(out, "上一次的成功结果", "utf8");
    // 清掉了模型凭据 → 这次必然失败（exit 2）；失败时 -o 绝不能把半截结果写进去。
    const failed = await runCli(["exec", "-o", out, "跑一下", "--cwd", dir]);
    expect(failed.code).toBe(2);
    expect(readFileSync(out, "utf8")).toBe("上一次的成功结果");
  }, 30_000);
});

/**
 * `heming memory`（d.329）：给人一条不用模型也能管理记忆的路。
 *
 * 模型记错一条时，用户必须能看见、能删——这几条用例钉的就是「能看见」「能删干净」，
 * 以及「不调模型也能跑」。
 */
describe.skipIf(tsx === null)("heming memory 子命令", () => {
  it("add → list → forget 全流程，且不需要模型凭据", async () => {
    const dir = tmpDir();

    const added = await runCli(["memory", "add", "以后都用中文回答", "--cwd", dir]);
    expect(added.code).toBe(0);
    expect(added.stderr).toContain("记下了");

    const listed = await runCli(["memory", "--cwd", dir]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("以后都用中文回答");

    const forgotten = await runCli(["memory", "forget", "1", "--cwd", dir]);
    expect(forgotten.code).toBe(0);
    expect(forgotten.stderr).toContain("删掉了");

    const after = await runCli(["memory", "--cwd", dir]);
    expect(after.code).toBe(0);
    expect(after.stderr).toContain("空的");
  }, 60_000);

  it("没有记忆时说一句人话，而不是报错", async () => {
    const dir = tmpDir();
    const listed = await runCli(["memory", "--cwd", dir]);
    expect(listed.code).toBe(0);
    expect(listed.stderr).toContain("还没有记过");
  }, 30_000);

  it("memory --json：stdout 只有一个 JSON 数组，能直接 JSON.parse", async () => {
    const dir = tmpDir();
    await runCli(["memory", "add", "记住这句", "--cwd", dir]);
    const listed = await runCli(["memory", "--json", "--cwd", dir]);
    expect(listed.code).toBe(0);
    const parsed = JSON.parse(listed.stdout) as { text: string }[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((entry) => entry.text === "记住这句")).toBe(true);
    expect(listed.stdout).not.toContain("工作区记忆");
  }, 30_000);

  it("记忆文件坏了：明确报错（exit 1），不静默当成空表", async () => {
    const dir = tmpDir();
    mkdirSync(path.join(dir, ".heming"), { recursive: true });
    writeFileSync(path.join(dir, ".heming", "memory.json"), "{ 这不是 JSON", "utf8");
    const listed = await runCli(["memory", "--cwd", dir]);
    expect(listed.code).toBe(1);
    expect(listed.stderr).toContain("读不出来");
  }, 30_000);

  it("--help 里有 heming memory 与 --no-memory", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("heming memory");
    expect(result.stdout).toContain("--no-memory");
  }, 30_000);

  it("--help 里能看见子代理与关掉它的开关（d.331）", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("agent_task");
    expect(result.stdout).toContain("--no-subagent");
  }, 30_000);
  it("commands 列出工作区里的自定义命令，--json 给脚本用（d.333）", async () => {
    const dir = tmpDir();
    mkdirSync(path.join(dir, ".heming", "commands"), { recursive: true });
    writeFileSync(
      path.join(dir, ".heming", "commands", "review.md"),
      "# 安全审查\n> 只挑能被利用的问题\n\n按威胁模型逐条过入口。\n",
      "utf8",
    );

    const listed = await runCli(["commands", "--cwd", dir]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("/review");
    expect(listed.stdout).toContain("安全审查");
    expect(listed.stdout).toContain(".heming/commands/review.md");

    const json = await runCli(["commands", "--json", "--cwd", dir]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout) as { command: string; title: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.command).toBe("/review");
    expect(parsed[0]?.title).toBe("安全审查");
  }, 30_000);

  it("`run /没定义的名字` 直接报错并列出可用的，不把那一行发给模型（d.333）", async () => {
    const dir = tmpDir();
    mkdirSync(path.join(dir, ".heming", "commands"), { recursive: true });
    writeFileSync(
      path.join(dir, ".heming", "commands", "review.md"),
      "# 安全审查\n\n按威胁模型逐条过入口。\n",
      "utf8",
    );

    const result = await runCli(["run", "--cwd", dir, "/reviwe"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("工作区里没有这个命令：/reviwe");
    expect(result.stderr).toContain("/review");
    // 没有凭据也会先卡在命令解析上：说明它根本没走到调模型那一步。
    expect(result.stderr).not.toContain("缺少模型");
  }, 30_000);

  it("rewind 列出记录，并按轮数把文件退回去（d.336）", async () => {
    const dir = tmpDir();
    mkdirSync(path.join(dir, ".heming", "rewind"), { recursive: true });
    writeFileSync(path.join(dir, "a.ts"), "现在的内容\n", "utf8");
    writeFileSync(path.join(dir, "gone.ts"), "我不该在\n", "utf8");
    // 手工造一轮存档：这里验证的是「读 + 退」，抓取由 tooling 的用例负责。
    writeFileSync(
      path.join(dir, ".heming", "rewind", "20261118100000-0000.json"),
      `${JSON.stringify(
        {
          version: 1,
          id: "20261118100000-0000",
          at: "2026-11-18T10:00:00.000Z",
          files: [
            { path: "a.ts", before: "原来的内容\n" },
            { path: "gone.ts", before: null },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const listed = await runCli(["rewind", "--cwd", dir]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("共 1 轮");
    expect(listed.stdout).toContain("a.ts");

    const applied = await runCli(["rewind", "1", "--cwd", dir]);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain("已退回 1 轮：还原 1 个文件、删掉 1 个当时还不存在的文件");
    expect(applied.stdout).toContain("run_command");
    expect(readFileSync(path.join(dir, "a.ts"), "utf8")).toBe("原来的内容\n");
    expect(existsSync(path.join(dir, "gone.ts"))).toBe(false);

    // 退过之后记录被删掉：再退一次会明确说没有可退的轮次。
    const again = await runCli(["rewind", "1", "--cwd", dir]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("没有 1 轮可退");
  }, 30_000);

  it("--help 里有 heming rewind 与 --no-rewind", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("heming rewind");
    expect(result.stdout).toContain("--no-rewind");
    expect(result.stdout).toContain(".heming/rewind/");
  }, 30_000);

  it("rewind 帮助文案与实际口径一致：命令新建的文件会删、改过内容的退不回（d.412.4.216）", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    // rewind.ts 的实现能抓命令新建的文件并删掉（describeCliRewindResult:520），
    // 帮助别再说「run_command 抓不到 / 命令退不回去」这种自相矛盾的话。
    expect(result.stdout).toContain("命令新建的文件");
    expect(result.stdout).not.toContain("命令退不回去");
    expect(result.stdout).not.toContain("run_command 改的东西抓不到");
  }, 30_000);
});