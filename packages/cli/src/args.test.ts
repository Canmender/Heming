import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";

/** 窄化断言：解析成功且是运行命令。 */
function expectRun(argv: string[]) {
  const parsed = parseArgs(argv);
  if (!parsed.ok || parsed.action !== "run") {
    throw new Error(`期望解析成功，实际：${JSON.stringify(parsed)}`);
  }
  return parsed.options;
}

describe("parseArgs", () => {
  it("run：多个位置参数用一个空格拼成 prompt", () => {
    const options = expectRun(["run", "读一下", "README", "并总结"]);
    expect(options.command).toBe("run");
    expect(options.prompt).toBe("读一下 README 并总结");
    expect(options.json).toBe(false);
    expect(options.allowDanger).toBe(false);
    expect(options.cwd).toBeUndefined();
    expect(options.maxRounds).toBeUndefined();
  });

  it("exec：--json 与非交互命令", () => {
    const options = expectRun(["exec", "--json", "列出目录"]);
    expect(options.command).toBe("exec");
    expect(options.json).toBe(true);
    expect(options.prompt).toBe("列出目录");
  });

  it("选项支持 --x value 与 --x=value 两种写法", () => {
    const spaced = expectRun(["run", "--cwd", "D:/work", "--max-rounds", "3", "hi"]);
    expect(spaced.cwd).toBe("D:/work");
    expect(spaced.maxRounds).toBe(3);

    const inline = expectRun([
      "exec",
      "--cwd=D:/work",
      "--max-rounds=5",
      "--model=gpt-4o-mini",
      "--base-url=http://localhost:8080/v1",
      "--api-key=sk-test",
      "hi",
    ]);
    expect(inline.cwd).toBe("D:/work");
    expect(inline.maxRounds).toBe(5);
    expect(inline.model).toBe("gpt-4o-mini");
    expect(inline.baseUrl).toBe("http://localhost:8080/v1");
    expect(inline.apiKey).toBe("sk-test");
  });

  it("--allow-danger 是布尔开关，不接受取值", () => {
    expect(expectRun(["run", "--allow-danger", "hi"]).allowDanger).toBe(true);
    const parsed = parseArgs(["run", "--allow-danger=yes", "hi"]);
    expect(parsed.ok).toBe(false);
  });

  it("选项可以出现在命令前后", () => {
    const options = expectRun(["--cwd", "D:/a", "exec", "--json", "hi"]);
    expect(options.command).toBe("exec");
    expect(options.cwd).toBe("D:/a");
    expect(options.json).toBe(true);
  });

  it("`--` 之后的内容全部算 prompt（prompt 里可以带 --xxx）", () => {
    const options = expectRun(["exec", "--json", "--", "--not-an-option", "内容"]);
    expect(options.prompt).toBe("--not-an-option 内容");
  });

  it("未知选项报错，不静默忽略", () => {
    const parsed = parseArgs(["run", "--nope", "hi"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.error).toContain("未知选项");
  });

  it("未知短选项同样报错", () => {
    const parsed = parseArgs(["run", "-x", "hi"]);
    expect(parsed.ok).toBe(false);
  });

  it("--max-rounds 只接受正整数", () => {
    for (const value of ["0", "-1", "1.5", "abc"]) {
      const parsed = parseArgs(["run", `--max-rounds=${value}`, "hi"]);
      expect(parsed.ok).toBe(false);
    }
  });

  it("缺少命令 / 缺少 prompt 都是用法错误", () => {
    expect(parseArgs([]).ok).toBe(false);
    expect(parseArgs(["run"]).ok).toBe(false);
    expect(parseArgs(["exec", "--json"]).ok).toBe(false);
    expect(parseArgs(["unknown", "hi"]).ok).toBe(false);
  });

  it("run 不接受 --json（需要机器结果时用 exec）", () => {
    const parsed = parseArgs(["run", "--json", "hi"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.error).toContain("exec --json");
  });

  it("--help 与 --version 优先于其它内容", () => {
    expect(parseArgs(["--help"])).toEqual({ ok: true, action: "help" });
    expect(parseArgs(["run", "hi", "-h"])).toEqual({ ok: true, action: "help" });
    expect(parseArgs(["--version"])).toEqual({ ok: true, action: "version" });
    expect(parseArgs(["exec", "-v"])).toEqual({ ok: true, action: "version" });
  });

  it("取值的选项在值缺失时报错", () => {
    for (const argv of [["run", "--cwd"], ["run", "--model", "--json", "hi"]]) {
      const parsed = parseArgs(argv);
      expect(parsed.ok).toBe(false);
    }
  });

  it("--output-format：text 默认，json 只换输出形态，stream-json 可给 run 与 exec", () => {
    expect(expectRun(["run", "hi"]).outputFormat).toBe("text");
    const exec = expectRun(["exec", "--output-format", "stream-json", "hi"]);
    expect(exec.outputFormat).toBe("stream-json");
    // stream-json 是事件流，不是「只有一个对象」，所以 json 标志保持 false。
    expect(exec.json).toBe(false);
    const json = expectRun(["exec", "--output-format", "json", "hi"]);
    expect(json.outputFormat).toBe("json");
    expect(json.json).toBe(true);
    // run 也能用事件流（CI 里想边跑边打印进度时用），只要不是「一个 JSON 对象」。
    expect(expectRun(["run", "--output-format", "stream-json", "hi"]).outputFormat).toBe("stream-json");
    // --output-format=value 的等号写法同样认。
    expect(expectRun(["exec", "--output-format=stream-json", "hi"]).outputFormat).toBe("stream-json");
  });

  it("--output-format 的非法值与冲突要当场报错", () => {
    const bad = parseArgs(["exec", "--output-format", "yaml", "hi"]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("stream-json");

    const conflict = parseArgs(["exec", "--json", "--output-format", "stream-json", "hi"]);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toContain("冲突");

    const runJson = parseArgs(["run", "--output-format", "json", "hi"]);
    expect(runJson.ok).toBe(false);
    if (!runJson.ok) expect(runJson.error).toContain("exec --json");
  });

  it("prompt 写 - 表示从 stdin 读（此时不要求位置参数）", () => {
    const exec = expectRun(["exec", "-"]);
    expect(exec.fromStdin).toBe(true);
    expect(exec.prompt).toBe("");
    const run = expectRun(["run", "-"]);
    expect(run.fromStdin).toBe(true);
    // 普通 prompt 不会被误判成 stdin。
    expect(expectRun(["exec", "读一下 - 后面的文件"]).fromStdin).toBe(false);
  });
});

/** 窄化断言：解析成功且是 MCP 服务命令。 */
function expectMcp(argv: string[]) {
  const parsed = parseArgs(argv);
  if (!parsed.ok || parsed.action !== "mcp") {
    throw new Error(`期望解析成 mcp，实际：${JSON.stringify(parsed)}`);
  }
  return parsed.options;
}

describe("parseArgs：mcp serve（d.288）", () => {
  it("mcp serve 不需要 prompt，能带 --cwd / --allow-danger", () => {
    const bare = expectMcp(["mcp", "serve"]);
    expect(bare.cwd).toBeUndefined();
    expect(bare.allowDanger).toBe(false);

    const full = expectMcp(["mcp", "serve", "--cwd", "D:/work", "--allow-danger"]);
    expect(full.cwd).toBe("D:/work");
    expect(full.allowDanger).toBe(true);
  });

  it("只认 serve 子命令，且不接受多余的位置参数", () => {
    const wrongSub = parseArgs(["mcp", "start"]);
    expect(wrongSub.ok).toBe(false);
    if (!wrongSub.ok) expect(wrongSub.error).toContain("serve");

    const noSub = parseArgs(["mcp"]);
    expect(noSub.ok).toBe(false);
    if (!noSub.ok) expect(noSub.error).toContain("serve");

    const extra = parseArgs(["mcp", "serve", "读一下"]);
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.error).toContain("不接受多余的位置参数");
  });

  it("与模型相关的选项一律拒绝（这条路不调模型，静默忽略等于骗人）", () => {
    for (const argv of [
      ["mcp", "serve", "--model", "gpt-4o-mini"],
      ["mcp", "serve", "--api-key", "sk-1"],
      ["mcp", "serve", "--max-rounds", "3"],
      ["mcp", "serve", "--json"],
      ["mcp", "serve", "--output-format", "stream-json"],
    ]) {
      const parsed = parseArgs(argv);
      expect(parsed.ok, argv.join(" ")).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("mcp serve 不接");
    }
  });
});

/** 窄化断言：解析成功且是 listings 命令。 */
function expectSessions(argv: string[]) {
  const parsed = parseArgs(argv);
  if (!parsed.ok || parsed.action !== "sessions") {
    throw new Error(`期望解析成 sessions，实际：${JSON.stringify(parsed)}`);
  }
  return parsed.options;
}

describe("parseArgs：会话与续聊（d.303）", () => {
  it("--continue / --resume / --session-dir 都能解析", () => {
    const cont = expectRun(["run", "--continue", "接着改"]);
    expect(cont.continueSession).toBe(true);
    expect(cont.resume).toBeUndefined();
    expect(cont.prompt).toBe("接着改");

    const resumed = expectRun(["run", "--resume", "20261118-144230-ab12", "继续"]);
    expect(resumed.continueSession).toBe(false);
    expect(resumed.resume).toBe("20261118-144230-ab12");

    const dir = expectRun(["run", "--session-dir", "D:/sessions", "hi"]);
    expect(dir.sessionDir).toBe("D:/sessions");
    expect(dir.continueSession).toBe(false);
    expect(dir.resume).toBeUndefined();
  });

  it("--continue 与 --resume 只能选一个（两个都要等于没说清接哪份）", () => {
    const parsed = parseArgs(["run", "--continue", "--resume", "20261118-144230-ab12", "hi"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("--continue");
      expect(parsed.error).toContain("--resume");
    }
  });

  it("--resume 缺值时当场报错，而不是静默开新会话", () => {
    const parsed = parseArgs(["run", "--resume"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("--resume 需要一个值");
  });

  it("heming sessions 只列存档：--json / --cwd / --session-dir 可用", () => {
    const bare = expectSessions(["sessions"]);
    expect(bare.json).toBe(false);
    expect(bare.cwd).toBeUndefined();

    const full = expectSessions(["sessions", "--json", "--cwd", "D:/repo", "--session-dir", "D:/s"]);
    expect(full.json).toBe(true);
    expect(full.cwd).toBe("D:/repo");
    expect(full.sessionDir).toBe("D:/s");
  });

  it("sessions 不接位置参数与跑模型的选项（列存档不该偷偷调模型）", () => {
    const extra = parseArgs(["sessions", "读一下"]);
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.error).toContain("不接受位置参数");

    for (const argv of [
      ["sessions", "--model", "gpt-4o-mini"],
      ["sessions", "--max-rounds", "3"],
      ["sessions", "--allow-danger"],
      ["sessions", "--continue"],
      ["sessions", "--resume", "20261118-144230-ab12"],
    ]) {
      const parsed = parseArgs(argv);
      expect(parsed.ok, argv.join(" ")).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("sessions 不接");
    }
  });

  it("mcp serve 也不接会话选项（它不跑模型，没有会话可接）", () => {
    for (const argv of [
      ["mcp", "serve", "--continue"],
      ["mcp", "serve", "--resume", "20261118-144230-ab12"],
      ["mcp", "serve", "--session-dir", "D:/s"],
    ]) {
      const parsed = parseArgs(argv);
      expect(parsed.ok, argv.join(" ")).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("mcp serve 不接");
    }
  });
});

describe("parseArgs：信任工作区规则（d.306）", () => {
  it("默认不信任：allow 规则不生效，也不会悄悄替用户打开", () => {
    const run = expectRun(["run", "改一下"]);
    expect(run.trustWorkspace).toBe(false);

    const mcp = expectMcp(["mcp", "serve"]);
    expect(mcp.trustWorkspace).toBe(false);
  });

  it("run 与 mcp serve 都认 --trust-workspace", () => {
    expect(expectRun(["run", "--trust-workspace", "改一下"]).trustWorkspace).toBe(true);
    expect(expectMcp(["mcp", "serve", "--trust-workspace"]).trustWorkspace).toBe(true);
  });

  it("--trust-workspace 不接受取值（写成 =true 会当成多余的位置参数报错）", () => {
    const parsed = parseArgs(["run", "--trust-workspace=no", "改一下"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("--trust-workspace");
  });

  it("sessions 不接 --trust-workspace（列存档不跑工具，谈不到放行）", () => {
    const parsed = parseArgs(["sessions", "--trust-workspace"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("sessions 不接");
  });
});

describe("parseArgs：信任工作区钩子（d.312）", () => {
  it("默认不信任：仓库里的 hooks 脚本不执行", () => {
    expect(expectRun(["run", "改一下"]).trustHooks).toBe(false);
    expect(expectMcp(["mcp", "serve"]).trustHooks).toBe(false);
  });

  it("run 与 mcp serve 都认 --trust-hooks", () => {
    expect(expectRun(["run", "--trust-hooks", "改一下"]).trustHooks).toBe(true);
    expect(expectMcp(["mcp", "serve", "--trust-hooks"]).trustHooks).toBe(true);
  });

  it("--trust-hooks 不接受取值", () => {
    const parsed = parseArgs(["run", "--trust-hooks=yes", "改一下"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("--trust-hooks");
  });

  it("sessions 不接 --trust-hooks", () => {
    const parsed = parseArgs(["sessions", "--trust-hooks"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("sessions 不接");
  });
});
describe("parseArgs：只读模式（d.314）", () => {
  it("默认不是只读：写工具照常可用", () => {
    expect(expectRun(["run", "改一下"]).readOnly).toBe(false);
    expect(expectMcp(["mcp", "serve"]).readOnly).toBe(false);
  });

  it("run 与 mcp serve 都认 --read-only", () => {
    expect(expectRun(["run", "--read-only", "先看看"]).readOnly).toBe(true);
    expect(expectMcp(["mcp", "serve", "--read-only"]).readOnly).toBe(true);
  });

  it("--read-only 不接受取值", () => {
    const parsed = parseArgs(["run", "--read-only=1", "先看看"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("--read-only");
  });

  it("sessions 不接 --read-only（列存档不跑工具，谈不到只读）", () => {
    const parsed = parseArgs(["sessions", "--read-only"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("sessions 不接");
  });
});
describe("parseArgs：交互式审批（d.322）", () => {
  it("默认不开：危险调用仍然一律拒绝", () => {
    expect(expectRun(["run", "跑一下"]).ask).toBe(false);
  });

  it("run 认 --ask", () => {
    expect(expectRun(["run", "--ask", "跑一下测试"]).ask).toBe(true);
  });

  it("--ask 不接受取值", () => {
    const parsed = parseArgs(["run", "--ask=yes", "跑一下"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("--ask");
  });

  it("不能和 `run -` 一起用：审批与提示词抢同一个 stdin", () => {
    const parsed = parseArgs(["run", "--ask", "-"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("--ask 不能和");
      expect(parsed.error).toContain("run -");
    }
  });

  it("sessions 与 mcp serve 都不接 --ask", () => {
    const sessions = parseArgs(["sessions", "--ask"]);
    expect(sessions.ok).toBe(false);
    if (!sessions.ok) expect(sessions.error).toContain("sessions 不接");

    const mcp = parseArgs(["mcp", "serve", "--ask"]);
    expect(mcp.ok).toBe(false);
    if (!mcp.ok) expect(mcp.error).toContain("mcp serve 不接");
  });
});
describe("parseArgs：续聊的上下文预算（d.317）", () => {
  it("默认折叠、预算交给默认值（不写字段）", () => {
    const options = expectRun(["run", "--continue", "接着聊"]);
    expect(options.compact).toBe(true);
    expect(options.contextBudget).toBeUndefined();
  });

  it("--context-budget 认 4000，也认 --context-budget=4000", () => {
    expect(expectRun(["run", "--continue", "--context-budget", "4000", "接着聊"]).contextBudget).toBe(4000);
    expect(expectRun(["run", "--context-budget=4000", "接着聊"]).contextBudget).toBe(4000);
  });

  it("--context-budget 的非法值当场报错（不夹逼）", () => {
    for (const value of ["0", "abc", "4000.5"]) {
      const parsed = parseArgs(["run", "--context-budget", value, "接着聊"]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("正整数");
    }
    const tooSmall = parseArgs(["run", "--context-budget", "100", "接着聊"]);
    expect(tooSmall.ok).toBe(false);
    if (!tooSmall.ok) expect(tooSmall.error).toContain("--no-compact");
  });

  it("--no-compact 不接受取值；sessions 与 mcp serve 都不接这两个选项", () => {
    const inline = parseArgs(["run", "--no-compact=1", "接着聊"]);
    expect(inline.ok).toBe(false);
    if (!inline.ok) expect(inline.error).toContain("--no-compact");

    expect(expectRun(["run", "--no-compact", "接着聊"]).compact).toBe(false);

    for (const argv of [
      ["sessions", "--no-compact"],
      ["sessions", "--context-budget", "4000"],
      ["mcp", "serve", "--no-compact"],
      ["mcp", "serve", "--context-budget", "4000"],
    ]) {
      const parsed = parseArgs(argv);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("不接");
    }
  });
});
describe("parseArgs：工作区记忆（d.329）", () => {
  it("默认开启，--no-memory 关掉", () => {
    expect(expectRun(["run", "看看代码"]).memory).toBe(true);
    expect(expectRun(["run", "--no-memory", "看看代码"]).memory).toBe(false);
  });

  it("--no-memory 不接受取值；sessions / mcp serve / memory 自己都不接", () => {
    const inline = parseArgs(["run", "--no-memory=1", "看看代码"]);
    expect(inline.ok).toBe(false);
    if (!inline.ok) expect(inline.error).toContain("--no-memory");

    for (const argv of [["sessions", "--no-memory"], ["mcp", "serve", "--no-memory"], ["memory", "--no-memory"]]) {
      const parsed = parseArgs(argv);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("不接");
    }
  });

  it("memory 子命令：默认列出、add 一句话、forget 一个键", () => {
    const list = parseArgs(["memory"]);
    expect(list.ok && list.action).toBe("memory");
    if (list.ok && list.action === "memory") {
      expect(list.options.add).toBeUndefined();
      expect(list.options.forget).toBeUndefined();
    }

    const add = parseArgs(["memory", "add", "以后都用中文回答"]);
    expect(add.ok && add.action).toBe("memory");
    if (add.ok && add.action === "memory") expect(add.options.add).toBe("以后都用中文回答");

    const forget = parseArgs(["memory", "forget", "2"]);
    expect(forget.ok && forget.action).toBe("memory");
    if (forget.ok && forget.action === "memory") expect(forget.options.forget).toBe("2");
  });

  it("memory 子命令的用法错误说清怎么改", () => {
    const emptyAdd = parseArgs(["memory", "add"]);
    expect(emptyAdd.ok).toBe(false);
    if (!emptyAdd.ok) expect(emptyAdd.error).toContain("需要一句话");

    const emptyForget = parseArgs(["memory", "forget"]);
    expect(emptyForget.ok).toBe(false);
    if (!emptyForget.ok) expect(emptyForget.error).toContain("id 或序号");

    const unknown = parseArgs(["memory", "dump"]);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("只支持 list");
  });

  it("模型相关选项对 memory 一律不接（它不调模型）", () => {
    for (const argv of [
      ["memory", "--allow-danger"],
      ["memory", "--model", "gpt-4o"],
      ["memory", "--max-rounds", "3"],
      ["memory", "--continue"],
    ]) {
      const parsed = parseArgs(argv);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("不接");
    }
  });
});
describe("parseArgs：子代理（d.331）", () => {
  it("默认开：不给 --no-subagent 就是开着", () => {
    expect(expectRun(["run", "查一下"]).subagent).toBe(true);
  });

  it("--no-subagent 关掉", () => {
    expect(expectRun(["run", "--no-subagent", "查一下"]).subagent).toBe(false);
  });

  it("--no-subagent 不接受取值", () => {
    const parsed = parseArgs(["run", "--no-subagent=yes", "查一下"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("--no-subagent 不接受取值");
  });

  it("sessions / memory / mcp serve 都不接它", () => {
    for (const argv of [
      ["sessions", "--no-subagent"],
      ["memory", "--no-subagent"],
      ["mcp", "serve", "--no-subagent"],
    ]) {
      const parsed = parseArgs(argv);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("--no-subagent");
    }
  });
});

describe("parseArgs：工作区命令（d.333）", () => {
  it("commands 只看 --json 与 --cwd", () => {
    const bare = parseArgs(["commands"]);
    expect(bare.ok && bare.action).toBe("commands");
    if (bare.ok && bare.action === "commands") {
      expect(bare.options.json).toBe(false);
      expect(bare.options.cwd).toBeUndefined();
    }

    const both = parseArgs(["commands", "--json", "--cwd", "D:/work/proj"]);
    expect(both.ok && both.action).toBe("commands");
    if (both.ok && both.action === "commands") {
      expect(both.options.json).toBe(true);
      expect(both.options.cwd).toBe("D:/work/proj");
    }
  });

  it("commands 不接受位置参数", () => {
    const parsed = parseArgs(["commands", "review"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("不接受位置参数");
  });

  for (const extra of [["--model", "m"], ["--allow-danger"], ["--read-only"], ["--ask"], ["--no-memory"], ["--mcp"], ["--continue"]]) {
    it(`commands 不接 ${extra[0]}`, () => {
      const parsed = parseArgs(["commands", ...extra]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("commands 不接");
    });
  }

  it("未知命令的提示里带上 commands", () => {
    const parsed = parseArgs(["commandz"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("commands");
  });
});