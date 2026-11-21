import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createScriptedApprover } from "./approvals.js";
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

  it("流式输出跨代理对分帧时不在屏幕上劈出乱码（stdout 与 JSON 一致）", async () => {
    const dir = await makeSandbox();
    // 模拟 SSE delta 正好切在 emoji 代理对中间：第一帧以高代理结尾。
    const chat: StreamChatFn = async (_profile, _messages, opts) => {
      opts.onDelta("A\ud83d");
      opts.onDelta("\ude00B");
      opts.onUsage?.({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
      opts.onFinish?.("stop");
      return "A😀B";
    };

    const chunks: string[] = [];
    const outcome = await startAgentRun({
      prompt: "say hi",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
      onStdout: (chunk) => chunks.push(chunk),
    }).done;

    // stdout 是逐块写出的字节流：每块单独按 UTF-8 编码。若某块以落单高代理结尾，
    // 它会变成 U+FFFD，屏幕就成了 A??B，与 JSON 里的 A😀B 不一致。
    const onScreen = Buffer.concat(chunks.map((c) => Buffer.from(c, "utf8"))).toString("utf8");
    expect(onScreen).toBe("A😀B");
    expect(outcome.json.text).toBe("A😀B");
    expect(onScreen).toBe(outcome.json.text);
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

  it("run_command 未授权被拒时，stderr 进度行与 JSON 事件口径一致都报「已拒绝」", async () => {
    const dir = await makeSandbox();
    const chat = createScriptedChat([
      { tool_calls: [{ name: "run_command", arguments: { command: "echo nope" } }] },
      { text: "命令未获授权，我没有执行。" },
    ]);

    const progressLines: string[] = [];
    const events: CliEvent[] = [];
    await startAgentRun({
      prompt: "跑一条命令",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
      onProgress: (line) => progressLines.push(line),
      onEvent: (event) => events.push(event),
    }).done;

    // JSON 事件与工具记录都按「未授权 = 策略拒绝」口径记。
    const end = events.find((event) => event.type === "tool_end");
    expect(end).toMatchObject({ type: "tool_end", name: "run_command", denied: true, ok: false });

    // stderr 上那行进度也应该说「已拒绝」而不是「失败」——否则看 stderr 的人
    // 以为命令真的执行后出错了，而 stream-json 的消费者却看到 denied:true，两边对不上。
    const endLine = progressLines.find((line) => line.startsWith("工具 run_command"));
    expect(endLine).toContain("已拒绝");
    expect(endLine).not.toContain("失败");
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
    // 只读模式没开时不该出现只读说明（否则模型会白白放弃写能力）。
    expect(system).not.toContain("这次是只读模式");
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
describe("只读模式（--read-only，d.314）", () => {
  it("提示词里说明只读并劝它把改动写成说明", async () => {
    const dir = await makeSandbox();
    const seen: { role: string; content: string }[][] = [];
    const chat: StreamChatFn = async (_profile, messages, opts) => {
      seen.push(messages.map((message) => ({ role: message.role, content: message.content })));
      opts.onFinish?.("stop");
      return "好";
    };
    await startAgentRun({
      prompt: "看看这里有什么问题",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
      readOnly: true,
    }).done;

    const system = (seen[0] ?? []).find((message) => message.role === "system")?.content ?? "";
    expect(system).toContain("这次是只读模式");
    expect(system).toContain("--read-only");
    // 关键一句：让它别把轮数烧在注定失败的写调用上。
    expect(system).toContain("重试不会改变结果");
  });

  it("只读模式下写工具的调用被拒，磁盘不变", async () => {
    const dir = await makeSandbox();
    let round = 0;
    const chat: StreamChatFn = async (_profile, messages, opts) => {
      round += 1;
      if (round === 1) {
        const call = {
          id: `call-${round}`,
          type: "function" as const,
          function: { name: "file_write", arguments: JSON.stringify({ path: "ro.txt", content: "不该落盘" }) },
        };
        messages.push({ role: "assistant", content: "", tool_calls: [call] } as never);
        return "";
      }
      opts.onFinish?.("stop");
      return "没写。";
    };
    const outcome = await startAgentRun({
      prompt: "写一个文件",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
      readOnly: true,
    }).done;
    expect(outcome.json.ok).toBe(true);
    // 被拦下的写不算落盘。
    expect(outcome.json.writes).toEqual([]);
    await expect(readFile(path.join(dir, "ro.txt"), "utf8")).rejects.toThrow();
  });
});
describe("续聊的上下文预算（d.317）", () => {
  /** 一段够长的中文：1 字 ≈ 1 token，几轮就能顶出小预算。 */
  const LONG = "这次改动要把会话过期的分支补上，并补一个回归用例，避免以后又改回去，".repeat(8);

  function longHistory(turns: number) {
    const rows: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 1; i <= turns; i += 1) {
      rows.push({ role: "user", content: `第 ${i} 轮：${LONG}` });
      rows.push({ role: "assistant", content: `第 ${i} 轮做完了：${LONG}` });
    }
    return rows;
  }

  it("历史超预算时早期对话被折成摘要，最近一轮与本轮提问都还在", async () => {
    const dir = await makeSandbox();
    const seen: { role: string; content: string }[][] = [];
    const stats: unknown[] = [];
    const chat: StreamChatFn = async (_profile, messages, opts) => {
      seen.push(messages.map((message) => ({ role: message.role, content: message.content })));
      opts.onFinish?.("stop");
      return "接着做完了";
    };
    const history = longHistory(10);
    const outcome = await startAgentRun({
      prompt: "继续",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
      history,
      contextBudget: 3000,
      onContext: (value) => stats.push(value),
    }).done;

    expect(outcome.json.ok).toBe(true);
    const messages = seen[0] ?? [];
    // 早期对话被换成摘要段：这是「省 token」的可见证据。
    // 摘要在系统提示词里——多条 system 会被编排层合并成一条，所以查「包含」而不是「开头」。
    const systemText = messages.find((m) => m.role === "system")?.content ?? "";
    expect(systemText).toContain("【早期对话摘要】");
    // 最后一轮的原文仍然完整（折到它就等于把刚说的话忘了）。
    expect(messages.some((m) => m.role === "assistant" && m.content.startsWith("第 10 轮做完了"))).toBe(true);
    // 本轮提问永远在最后。
    expect(messages.at(-1)?.content).toBe("继续");
    // 上报的统计与实际一致。
    expect(stats).toHaveLength(1);
    const first = stats[0] as { folded: number; enabled: boolean };
    expect(first.enabled).toBe(true);
    expect(first.folded).toBeGreaterThan(0);
  });

  it("--no-compact 时整段历史原样发送，不出现摘要头", async () => {
    const dir = await makeSandbox();
    const seen: { role: string; content: string }[][] = [];
    const chat: StreamChatFn = async (_profile, messages, opts) => {
      seen.push(messages.map((message) => ({ role: message.role, content: message.content })));
      opts.onFinish?.("stop");
      return "好";
    };
    const history = longHistory(10);
    const outcome = await startAgentRun({
      prompt: "继续",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
      history,
      contextBudget: 3000,
      compact: false,
    }).done;

    expect(outcome.json.ok).toBe(true);
    const messages = seen[0] ?? [];
    expect(messages.some((m) => m.content.startsWith("【早期对话摘要】"))).toBe(false);
    // 第一轮的痕迹还在：真的是原样发送。
    expect(messages.some((m) => m.content.startsWith("第 1 轮："))).toBe(true);
  });
});
/**
 * 交互式审批（`--ask`，d.322）的端到端回路。
 *
 * 单测已经守住了闸门逻辑；这里要证的是**编排层真的把批准用上了**：人答「允许」之后
 * 命令确实跑了、结果回到模型手里；人答「不要」之后命令一步都没动。
 */
describe("写文件也先问（--ask-writes，d.340）", () => {
  it("放行之后才真的落盘，且审批框里带着改了什么", async () => {
    const dir = await makeSandbox();
    const chat = createScriptedChat([
      { tool_calls: [{ name: "file_write", arguments: { path: "made.ts", content: "export const a = 1;\n" } }] },
      { text: "写好了。" },
    ]);
    const approver = createScriptedApprover(["allow-once"]);

    const outcome = await startAgentRun({
      prompt: "新建 made.ts",
      cwd: dir,
      profile,
      allowDanger: false,
      ask: approver,
      askWrites: true,
      streamChat: chat,
      }).done;

    expect(outcome.json.ok).toBe(true);
    expect(outcome.json.writes).toHaveLength(1);
    expect(await readFile(path.join(dir, "made.ts"), "utf8")).toContain("export const a = 1;");
    expect(approver.requests).toHaveLength(1);
    expect(approver.requests[0]?.kind).toBe("write");
    expect(approver.requests[0]?.detail).toContain("新增 1 行");
    expect(approver.requests[0]?.preview?.[0]).toBe("+ export const a = 1;");
  });

  it("拒绝之后文件不存在，模型拿到的是「用户拒绝」", async () => {
    const dir = await makeSandbox();
    const chat = createScriptedChat([
      { tool_calls: [{ name: "file_write", arguments: { path: "nope.ts", content: "x" } }] },
      { text: "那我先不写。" },
    ]);
    const approver = createScriptedApprover(["deny"]);

    const outcome = await startAgentRun({
      prompt: "新建 nope.ts",
      cwd: dir,
      profile,
      allowDanger: false,
      ask: approver,
      askWrites: true,
      streamChat: chat,
      }).done;

    expect(outcome.json.toolCalls[0]).toMatchObject({ name: "file_write", ok: false, denied: true });
    expect(await readdir(dir)).not.toContain("nope.ts");
    expect(approver.requests).toHaveLength(1);
  });
});
describe("交互式审批（--ask，d.322）", () => {
  it("人答「允许这一次」：命令真的执行，结果回到模型，退出码 0", async () => {
    const dir = await makeSandbox();
    const command = `node -e "require('node:fs').writeFileSync('approved.txt','ran')"`;
    const chat = createScriptedChat([
      { tool_calls: [{ name: "run_command", arguments: { command } }] },
      { text: "命令跑完了。" },
    ]);
    const approver = createScriptedApprover(["allow-once"]);

    const outcome = await startAgentRun({
      prompt: "把 approved.txt 写出来",
      cwd: dir,
      profile,
      allowDanger: false,
      ask: approver,
      streamChat: chat,
    }).done;

    expect(outcome.json.ok).toBe(true);
    expect(outcome.json.toolCalls[0]).toMatchObject({ name: "run_command", ok: true, denied: false });
    // 真的跑了：文件存在。
    expect(await readFile(path.join(dir, "approved.txt"), "utf8")).toBe("ran");
    // 而且确实问过那次命令。
    expect(approver.requests).toHaveLength(1);
    expect(approver.requests[0]?.tool).toBe("run_command");
    expect(outcomeExitCode(outcome)).toBe(0);
  });

  it("人答「不要」：命令没跑，模型收到的是「拒绝」而不是「参数错」", async () => {
    const dir = await makeSandbox();
    const command = `node -e "require('node:fs').writeFileSync('denied.txt','ran')"`;
    const chat = createScriptedChat([
      { tool_calls: [{ name: "run_command", arguments: { command } }] },
      { text: "好的，那我先不动。" },
    ]);
    const approver = createScriptedApprover(["deny"]);

    const outcome = await startAgentRun({
      prompt: "写个文件",
      cwd: dir,
      profile,
      allowDanger: false,
      ask: approver,
      streamChat: chat,
    }).done;

    expect(outcome.json.toolCalls[0]?.denied).toBe(true);
    expect(outcome.json.toolCalls[0]?.ok).toBe(false);
    // 拒绝的回灌文案要让人/模型都看出这是「用户不让」。
    expect(outcome.json.toolCalls[0]?.text ?? "").toMatch(/拒绝|未执行/);
    await expect(readFile(path.join(dir, "denied.txt"), "utf8")).rejects.toThrow();
    expect(outcomeExitCode(outcome)).toBe(0);
  });

  it("答「本次运行都允许」：同一轮里第二条命令不再追问", async () => {
    const dir = await makeSandbox();
    const command = `node -e "require('node:fs').appendFileSync('twice.txt','x')"`;
    const chat = createScriptedChat([
      { tool_calls: [{ name: "run_command", arguments: { command } }] },
      { tool_calls: [{ name: "run_command", arguments: { command } }] },
      { text: "两条都跑了。" },
    ]);
    const approver = createScriptedApprover(["allow-session"]);

    const outcome = await startAgentRun({
      prompt: "跑两次",
      cwd: dir,
      profile,
      allowDanger: false,
      ask: approver,
      streamChat: chat,
    }).done;

    expect(outcome.json.toolCalls.filter((call) => call.ok)).toHaveLength(2);
    expect(await readFile(path.join(dir, "twice.txt"), "utf8")).toBe("xx");
    // 只问了一次：这正是「本次运行都允许」的意义。
    expect(approver.requests).toHaveLength(1);
  });
});
/**
 * 工作区记忆（d.329）在运行这一层的两件事：
 *
 * 1) 入口挑好的召回段真的进了系统提示词（否则「记了但用不上」，等于没记）；
 * 2) 模型调 `remember` 时，内容真的落到工作区的 `.heming/memory.json`。
 */
describe("工作区记忆（--no-memory / remember，d.329）", () => {
  function capturingChat(turns: ScriptTurn[]): { chat: StreamChatFn; seen: { system: string; last: string }[] } {
    const inner = createScriptedChat(turns);
    const seen: { system: string; last: string }[] = [];
    const chat: StreamChatFn = async (llmProfile, messages, opts) => {
      const systemRow = messages.find((message) => message.role === "system");
      seen.push({
        system: typeof systemRow?.content === "string" ? systemRow.content : "",
        last: messages[messages.length - 1]?.content ?? "",
      });
      return inner(llmProfile, messages, opts);
    };
    return { chat, seen };
  }

  it("召回段进系统提示词，位置在人设之后", async () => {
    const dir = await makeSandbox();
    const section = "## 长期记忆（这个工作区记下的）\n\n- 以后都用中文回答";
    const { chat, seen } = capturingChat([{ text: "好的。" }]);

    await startAgentRun({
      prompt: "随便聊两句",
      cwd: dir,
      profile,
      allowDanger: false,
      memorySection: section,
      streamChat: chat,
    }).done;

    expect(seen).toHaveLength(1);
    expect(seen[0]!.system).toContain("长期记忆");
    expect(seen[0]!.system).toContain("以后都用中文回答");
  });

  it("模型调 remember：内容落到 .heming/memory.json，第二轮能看到结果回灌", async () => {
    const dir = await makeSandbox();
    const chat = createScriptedChat([
      { tool_calls: [{ name: "remember", arguments: { text: "以后都用中文回答" } }] },
      { text: "记下了。" },
    ]);

    const outcome = await startAgentRun({
      prompt: "以后都用中文回答，记住这一点",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
    }).done;

    expect(outcome.json.toolCalls).toHaveLength(1);
    expect(outcome.json.toolCalls[0]).toMatchObject({ name: "remember", ok: true, denied: false });
    // 写的是记忆文件，不该被算成「改了你的源码」。
    expect(outcome.json.writes).toEqual([]);

    const raw = JSON.parse(await readFile(path.join(dir, ".heming", "memory.json"), "utf8")) as {
      entries: { text: string }[];
    };
    expect(raw.entries.map((entry) => entry.text)).toEqual(["以后都用中文回答"]);
  });

  it("--no-memory 时 remember 不挂：模型硬调只会拿到「这次没开记忆」", async () => {
    const dir = await makeSandbox();
    const chat = createScriptedChat([
      { tool_calls: [{ name: "remember", arguments: { text: "以后都用中文回答" } }] },
      { text: "没记下来。" },
    ]);

    const outcome = await startAgentRun({
      prompt: "记住：以后都用中文回答",
      cwd: dir,
      profile,
      allowDanger: false,
      memory: false,
      streamChat: chat,
    }).done;

    expect(outcome.json.toolCalls[0]?.ok).toBe(false);
    expect(outcome.json.toolCalls[0]?.text ?? "").toContain("--no-memory");
    await expect(readFile(path.join(dir, ".heming", "memory.json"), "utf8")).rejects.toThrow();
  });

  it("只读模式下 remember 也不挂（只读就是只读）", async () => {
    const dir = await makeSandbox();
    const chat = createScriptedChat([
      { tool_calls: [{ name: "remember", arguments: { text: "以后都用中文回答" } }] },
      { text: "只读模式，没记。" },
    ]);

    const outcome = await startAgentRun({
      prompt: "记住：以后都用中文回答",
      cwd: dir,
      profile,
      allowDanger: false,
      readOnly: true,
      streamChat: chat,
    }).done;

    expect(outcome.json.toolCalls[0]?.ok).toBe(false);
    await expect(readFile(path.join(dir, ".heming", "memory.json"), "utf8")).rejects.toThrow();
  });
});

describe("子代理（d.331）", () => {
  const namesOf = (tools: readonly unknown[]): string[] =>
    tools
      .map((tool) => {
        const fn = (tool as { function?: { name?: unknown } }).function;
        return typeof fn?.name === "string" ? fn.name : "";
      })
      .filter(Boolean);

  it("默认开启：第一次请求的工具清单里有 agent_task", async () => {
    const dir = await makeSandbox();
    let offered: string[] = [];
    const chat: StreamChatFn = async (_profile, _messages, opts) => {
      offered = namesOf(opts.tools ?? []);
      opts.onDelta("好");
      return "好";
    };

    const outcome = await startAgentRun({
      prompt: "查一下",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
    }).done;

    expect(outcome.json.ok).toBe(true);
    expect(offered).toContain("agent_task");
  });

  it("--no-subagent：清单里没有它，硬调只拿到「没有开子代理」", async () => {
    const dir = await makeSandbox();
    let offered: string[] = [];
    const inner = createScriptedChat([
      { tool_calls: [{ name: "agent_task", arguments: { task: "查限流" } }] },
      { text: "结论：我自己查了" },
    ]);
    const chat: StreamChatFn = async (p, messages, opts) => {
      if (offered.length === 0) offered = namesOf(opts.tools ?? []);
      return inner(p, messages, opts);
    };

    const outcome = await startAgentRun({
      prompt: "查一下",
      cwd: dir,
      profile,
      allowDanger: false,
      subagent: false,
      streamChat: chat,
    }).done;

    expect(outcome.json.ok).toBe(true);
    expect(offered).not.toContain("agent_task");
    const record = outcome.json.toolCalls.find((call) => call.name === "agent_task");
    expect(record?.ok).toBe(false);
    expect(record?.text).toContain("没有开子代理");
  });

  it("子代理的模型调用用量计入 exec --json（帮助承诺 rounds 与用量都算，d.412.4.213）", async () => {
    const dir = await makeSandbox();
    let n = 0;
    // 调用序：主代理第 1 轮派子代理 → 子代理 1 轮出结论 → 主代理第 2 轮给最终答案。
    const chat: StreamChatFn = async (_profile, _messages, opts) => {
      n += 1;
      if (n === 1) {
        opts.onToolCalls?.([
          { id: "c_task", type: "function", function: { name: "agent_task", arguments: JSON.stringify({ task: "查一下" }) } },
        ]);
        opts.onUsage?.({ inputTokens: 100, outputTokens: 10, totalTokens: 110 });
        opts.onFinish?.("tool_calls");
        return "";
      }
      if (n === 2) {
        // 这一轮是子代理直接 await deps.chat 发起的：用量必须也记进本回合的账。
        opts.onDelta("子代理结论");
        opts.onUsage?.({ inputTokens: 777, outputTokens: 77, totalTokens: 854 });
        opts.onFinish?.("stop");
        return "子代理结论";
      }
      opts.onDelta("最终答案");
      opts.onUsage?.({ inputTokens: 200, outputTokens: 20, totalTokens: 220 });
      opts.onFinish?.("stop");
      return "最终答案";
    };

    const outcome = await startAgentRun({
      prompt: "派个子代理查一下",
      cwd: dir,
      profile,
      allowDanger: false,
      streamChat: chat,
    }).done;

    expect(outcome.json.ok).toBe(true);
    expect(n).toBe(3);
    // 主代理 100+200、子代理 777 都要进账；修复前子代理那 777 会丢（只剩 300）。
    expect(outcome.json.usage.input).toBe(1077);
    expect(outcome.json.usage.output).toBe(107);
  });
});