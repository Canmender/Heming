import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { outcomeExitCode, startAgentRun, type StreamChatFn } from "./run.js";
import type { CliEvent } from "./events.js";
import type { LlmProfile } from "../../../packages/web/src/store/llm.js";

/** 测试用的假模型档案：不会发出任何网络请求（chat 全部注入）。 */
const profile: LlmProfile = {
  id: "cli-test",
  label: "CLI 测试",
  provider: "openai",
  apiKey: "sk-test-offline",
  model: "test-offline",
  temperature: 0,
};

interface ScriptTurn {
  text?: string;
  tool_calls?: { name: string; arguments: Record<string, unknown> }[];
}

/**
 * 极简脚本化 chat：按序消费回合，行为与 evals/runner/stream.ts 同一思路。
 *
 * 不搭 HTTP 假网关：注入 `streamChat` 才能确定地验「编排层有没有把工具调起来、
 * 结果有没有回到模型」，也没有端口/超时/SSE 拼包这些与 CLI 无关的变量。
 */
function createScriptedChat(turns: ScriptTurn[]): StreamChatFn {
  let cursor = 0;
  return async (_profile, _messages, opts) => {
    const turn = turns[cursor] ?? { text: "" };
    cursor += 1;
    const calls = (turn.tool_calls ?? []).map((call, index) => ({
      id: `call_${cursor}_${index}`,
      type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));

    if (turn.text) opts.onDelta(turn.text);
    if (calls.length > 0) opts.onToolCalls?.(calls);
    opts.onUsage?.({ inputTokens: 900, outputTokens: 120, totalTokens: 1020 });
    opts.onFinish?.(calls.length > 0 ? "tool_calls" : "stop");
    return turn.text ?? "";
  };
}

const sandboxes: string[] = [];

async function makeSandbox(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "heming-cli-test-"));
  sandboxes.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of sandboxes) {
    // Windows 上刚结束的子进程可能还攥着目录句柄：带重试删除，删不掉就留现场。
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
});

describe("startAgentRun", () => {
  it("模型先 file_read 再给结论：结果带文件内容，toolCalls 记录 file_read，退出码 0", async () => {
    const dir = await makeSandbox();
    await writeFile(path.join(dir, "a.txt"), "你好 CLI", "utf8");

    const chat = createScriptedChat([
      { tool_calls: [{ name: "file_read", arguments: { path: "a.txt" } }] },
      { text: "文件内容是：你好 CLI" },
    ]);

    let streamed = "";
    const outcome = await startAgentRun({
      prompt: "读一下 a.txt 告诉我内容",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
      onStdout: (chunk) => {
        streamed += chunk;
      },
    }).done;

    expect(outcome.json.ok).toBe(true);
    expect(outcome.json.error).toBeUndefined();
    expect(outcome.json.text).toContain("你好 CLI");
    expect(outcome.json.rounds).toBe(2);
    expect(outcome.json.toolCalls).toHaveLength(1);
    expect(outcome.json.toolCalls[0]).toMatchObject({ name: "file_read", ok: true, denied: false });
    expect(outcome.json.toolCalls[0]?.text).toContain("你好 CLI");
    expect(outcome.json.writes).toEqual([]);
    expect(outcome.json.usage.input).toBe(1800);
    expect(outcome.json.usage.output).toBe(240);
    // 最终回答通过 onStdout 流出（run 模式 stdout 只放答案）。
    expect(streamed).toContain("文件内容是：你好 CLI");
    expect(outcomeExitCode(outcome)).toBe(0);
  });

  it("未给 --allow-danger 时 run_command 返回「未执行」，且命令真的没有跑", async () => {
    const dir = await makeSandbox();
    const marker = path.join(dir, "marker.txt");

    // 只有真的执行了才会创建 marker；断言它不存在，就是「没有真跑」的可观测证据。
    const command = `node -e "require('node:fs').writeFileSync('marker.txt','ran')"`;
    const chat = createScriptedChat([
      { tool_calls: [{ name: "run_command", arguments: { command } }] },
      { text: "命令未获授权，我没有执行。" },
    ]);

    const outcome = await startAgentRun({
      prompt: "跑一条命令",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
    }).done;

    const call = outcome.json.toolCalls[0];
    expect(call).toMatchObject({ name: "run_command", ok: false, denied: true });
    expect(call?.text).toContain("未执行");
    expect(call?.text).toContain("CLI 未授权危险工具");
    await expect(access(marker)).rejects.toBeTruthy();
    // 工具被拒不等于整轮失败：模型收到了「未执行」，并给出了最终回答。
    expect(outcome.json.ok).toBe(true);
    expect(outcome.json.writes).toEqual([]);
    expect(outcomeExitCode(outcome)).toBe(0);
  });

  it("onEvent 会按顺序报出 round / tool_start / tool_end（stream-json 的数据源）", async () => {
    const dir = await makeSandbox();
    await writeFile(path.join(dir, "a.txt"), "事件流", "utf8");

    const chat = createScriptedChat([
      { tool_calls: [{ name: "file_read", arguments: { path: "a.txt" } }] },
      { text: "读到了" },
    ]);

    const events: CliEvent[] = [];
    const outcome = await startAgentRun({
      prompt: "读 a.txt",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
      onEvent: (event) => events.push(event),
    }).done;

    expect(outcome.json.ok).toBe(true);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("round");
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    const start = events.find((event) => event.type === "tool_start");
    // 参数是摘要而不是整份参数：写文件时不能把正文倒进事件流。
    expect(start).toMatchObject({ type: "tool_start", name: "file_read", args: "path=a.txt" });
    const end = events.find((event) => event.type === "tool_end");
    expect(end).toMatchObject({ type: "tool_end", name: "file_read", ok: true, denied: false });
  });

  it("撞 --max-rounds 时 ok 仍为真，但 stopReason 明确写 max-rounds（CI 不必自己推断）", async () => {
    const dir = await makeSandbox();
    // 每轮都要调工具：第 2 轮就会被上限收口。
    const chat = createScriptedChat([
      { tool_calls: [{ name: "file_glob", arguments: { pattern: "*.txt" } }] },
      { tool_calls: [{ name: "file_glob", arguments: { pattern: "*.txt" } }] },
      { text: "到此为止" },
    ]);

    const outcome = await startAgentRun({
      prompt: "一直找文件",
      cwd: dir,
      profile,
      allowDanger: false,
      maxRounds: 1,
      streamChat: chat,
    }).done;

    expect(outcome.capHit).toBe(true);
    expect(outcome.json.ok).toBe(true);
    expect(outcome.json.stopReason).toBe("max-rounds");
    expect(outcomeExitCode(outcome)).toBe(0);
  });

  it("正常答完时 stopReason 是 ok", async () => {
    const dir = await makeSandbox();
    const outcome = await startAgentRun({
      prompt: "只说一句话",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: createScriptedChat([{ text: "一句话" }]),
    }).done;
    expect(outcome.json).toMatchObject({ ok: true, stopReason: "ok" });
  });

  it("传入 history 时，上一轮问答在同一份 messages 里（--continue/--resume 的数据通路）", async () => {
    const dir = await makeSandbox();
    const seen: { role: string; content: string }[][] = [];
    const chat: StreamChatFn = async (_profile, messages, opts) => {
      seen.push(messages.map((message) => ({ role: message.role, content: message.content })));
      opts.onFinish?.("stop");
      return "按上次的结论继续做完了";
    };
    const outcome = await startAgentRun({
      prompt: "继续",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
      history: [
        { role: "user", content: "把登录改成扫码" },
        { role: "assistant", content: "改好了" },
      ],
      sessionId: "20261118-144230-ab12",
    }).done;

    expect(outcome.json.ok).toBe(true);
    expect(outcome.json.sessionId).toBe("20261118-144230-ab12");
    const messages = seen[0] ?? [];
    expect(messages.some((m) => m.role === "user" && m.content === "把登录改成扫码")).toBe(true);
    expect(messages.some((m) => m.role === "assistant" && m.content === "改好了")).toBe(true);
    // 本轮提问在最后：历史在前、当前在后，模型才知道「继续」是在接着什么。
    expect(messages.at(-1)?.content).toBe("继续");
  });

  it("不传 history 时保持单轮语义：没有上一轮的东西混进来", async () => {
    const dir = await makeSandbox();
    const seen: { role: string; content: string }[][] = [];
    const chat: StreamChatFn = async (_profile, messages, opts) => {
      seen.push(messages.map((message) => ({ role: message.role, content: message.content })));
      opts.onFinish?.("stop");
      return "好";
    };
    await startAgentRun({
      prompt: "第一次",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
    }).done;
    const roles = (seen[0] ?? []).map((m) => m.role);
    expect(roles.filter((role) => role === "user")).toHaveLength(1);
  });

  it("传入项目约定时，它进系统提示词（但用户这一轮的提问不进）", async () => {
    const dir = await makeSandbox();
    const seen: { role: string; content: string }[][] = [];
    const chat: StreamChatFn = async (_profile, messages, opts) => {
      seen.push(messages.map((message) => ({ role: message.role, content: message.content })));
      opts.onFinish?.("stop");
      return "好";
    };
    const section = "## 项目约定（本工作区）\n\n改完要跑 pnpm test。";
    await startAgentRun({
      prompt: "改一下这个函数",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
      projectRules: section,
    }).done;

    const system = (seen[0] ?? []).find((message) => message.role === "system")?.content ?? "";
    expect(system).toContain("## 项目约定（本工作区）");
    expect(system).toContain("改完要跑 pnpm test。");
    // 约定段只算规矩，不该把「改一下这个函数」也算进去。
    expect(system).not.toContain("改一下这个函数");
  });

  it("不传项目约定时提示词里没有这一段（保持旧行为）", async () => {
    const dir = await makeSandbox();
    const seen: { role: string; content: string }[][] = [];
    const chat: StreamChatFn = async (_profile, messages, opts) => {
      seen.push(messages.map((message) => ({ role: message.role, content: message.content })));
      opts.onFinish?.("stop");
      return "好";
    };
    await startAgentRun({
      prompt: "随便做点什么",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
    }).done;
    const system = (seen[0] ?? []).find((message) => message.role === "system")?.content ?? "";
    expect(system).not.toContain("## 项目约定（本工作区）");
  });
});
