/**
 * `relativizeToolArgs`：把模型/MCP 客户端发来的绝对路径换成「相对工作区」的写法。
 *
 * 这条规则很窄但很重要：文件工具的契约是相对路径，而不改写就等于「一次合法的写」直接失败。
 * 同时它**不放松安全边界**——工作区外的绝对路径只是被改写成 `../…`，仍然会被越界检查挡下。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createScriptedApprover } from "./approvals.js";
import { createCliGate, createCliTooling, relativizeToolArgs } from "./tooling.js";
import { listCliRewinds, rewindDir } from "./rewind.js";
import { mcpToolName, type McpConnection } from "./mcpClient.js";

const CWD = path.resolve("D:/work/proj").replace(/\\\\/g, "/");

/** 本轮建过的临时目录，跑完统一删掉。 */
const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清不掉就算了：这是临时目录，不该让测试因此失败。
    }
  }
});

describe("relativizeToolArgs（d.288）", () => {
  it("相对路径、非路径字段、非 JSON 一律原样返回", () => {
    expect(relativizeToolArgs('{"path":"src/a.ts"}', CWD)).toBe('{"path":"src/a.ts"}');
    expect(relativizeToolArgs('{"command":"npm test"}', CWD)).toBe('{"command":"npm test"}');
    expect(relativizeToolArgs("不是 JSON", CWD)).toBe("不是 JSON");
    expect(relativizeToolArgs("[1,2]", CWD)).toBe("[1,2]");
    expect(relativizeToolArgs("null", CWD)).toBe("null");
  });

  it("工作区内的绝对路径改写成相对路径（只用正斜杠）", () => {
    const out = JSON.parse(relativizeToolArgs(JSON.stringify({ path: `${CWD}/src/a.ts`, content: "x" }), CWD));
    expect(out).toEqual({ path: "src/a.ts", content: "x" });

    // Windows 反斜杠写法也认。
    const win = JSON.parse(relativizeToolArgs(JSON.stringify({ path: `${CWD}\\src\\b.ts` }), CWD));
    expect(win.path).toBe("src/b.ts");

    // 正好是工作区本身 → "."（不是空串）。
    const atRoot = JSON.parse(relativizeToolArgs(JSON.stringify({ path: CWD }), CWD));
    expect(atRoot.path).toBe(".");
  });

  it("工作区外的绝对路径变成 ../… —— 仍然进越界检查，不会被「治好」", () => {
    const outside = path.resolve("D:/other/secret.txt").replace(/\\/g, "/");
    const out = JSON.parse(relativizeToolArgs(JSON.stringify({ path: outside }), CWD));
    expect(out.path.startsWith("..")).toBe(true);
    expect(out.path).toContain("secret.txt");
  });

  it("path / file / target / from / to 与 paths / files 数组都覆盖", () => {
    const inside = `${CWD}/a.md`;
    const json = JSON.stringify({
      path: inside,
      file: inside,
      target: inside,
      from: inside,
      to: inside,
      paths: [inside, "already/rel.md"],
      files: [inside],
    });
    const out = JSON.parse(relativizeToolArgs(json, CWD));
    expect(out.path).toBe("a.md");
    expect(out.file).toBe("a.md");
    expect(out.target).toBe("a.md");
    expect(out.from).toBe("a.md");
    expect(out.to).toBe("a.md");
    expect(out.paths).toEqual(["a.md", "already/rel.md"]);
    expect(out.files).toEqual(["a.md"]);
  });

  it("glob 模式剥掉工作区前缀；不在工作区下的模式不动", () => {
    const out = JSON.parse(relativizeToolArgs(JSON.stringify({ pattern: `${CWD}/**/*.ts` }), CWD));
    expect(out.pattern).toBe("**/*.ts");

    const rootOnly = JSON.parse(relativizeToolArgs(JSON.stringify({ glob: CWD }), CWD));
    expect(rootOnly.glob).toBe("**/*");

    const elsewhere = JSON.parse(
      relativizeToolArgs(JSON.stringify({ pattern: "D:/other/**/*.ts" }), CWD),
    );
    expect(elsewhere.pattern).toBe("D:/other/**/*.ts");
  });

  it("没有发生改写时返回原字符串（避免无意义的重序列化）", () => {
    const original = '{"path":  "src/a.ts",   "content":"x"}';
    expect(relativizeToolArgs(original, CWD)).toBe(original);
  });

  it("glob 前缀在 Windows 下大小写不敏感，与 path 分支同口径（d.412.4.205）", () => {
    // CWD 全大写后仍是同一个 Windows 路径（盘符/目录大小写不敏感）。
    const folded = CWD.toUpperCase();
    const out = JSON.parse(relativizeToolArgs(JSON.stringify({ pattern: `${folded}/**/*.ts` }), CWD));
    const rootOnly = JSON.parse(relativizeToolArgs(JSON.stringify({ glob: folded }), CWD));
    if (process.platform === "win32") {
      // path 分支用 path.relative（大小写不敏感）；glob 分支此前手写 startsWith 会剥不掉。
      expect(out.pattern).toBe("**/*.ts");
      expect(rootOnly.glob).toBe("**/*");
    } else {
      // POSIX 路径大小写敏感：不同的大小写不是同一个工作区，保持原样。
      expect(out.pattern).toBe(`${folded}/**/*.ts`);
    }
  });
});
/** 只读模式测试用的唯一可写根（与 CLI 装配时的形状一致）。 */
const ROOTS = [{ path: CWD, mode: "write" as const, name: "work" }];

/** 只读模式：闸门层面「除只读工具外一律拒」，不依赖 `--allow-danger`。 */
function gateOf(options: { readOnly?: boolean; allowDanger?: boolean; risk?: "read" | "write" | "danger" }) {
  return createCliGate({
    roots: () => ROOTS,
    allowDanger: options.allowDanger === true,
    readOnly: options.readOnly === true,
    metaOf: () => (options.risk ? { risk: options.risk } : undefined),
  });
}

function denyReasonOf(outcome: Awaited<ReturnType<ReturnType<typeof gateOf>>>[number]): string {
  if (outcome.kind !== "deny") throw new Error(`期望被拒绝，实际是 ${outcome.kind}`);
  return outcome.reason ?? "";
}

describe("只读模式（d.314）", () => {
  const call = (name: string, args: Record<string, unknown> = { path: "src/a.ts", content: "x" }) => ({
    id: "c1",
    function: { name, arguments: JSON.stringify(args) },
  });

  it("写工具一律被拒，理由说清是只读模式", async () => {
    for (const name of ["file_write", "file_edit", "file_patch"]) {
      const reason = denyReasonOf((await gateOf({ readOnly: true, risk: "write" })([call(name)]))[0]!);
      expect(reason).toContain("只读模式");
      expect(reason).toContain(name);
    }
  });

  it("只读工具照常放行（只读不是「什么都不许看」）", async () => {
    const outcome = (await gateOf({ readOnly: true, risk: "read" })([call("file_read", { path: "src/a.ts" })]))[0]!;
    expect(outcome.kind).toBe("allow");
  });

  it("危险工具与没声明风险的工具同样被拒（宁缺勿滥）", async () => {
    const danger = denyReasonOf((await gateOf({ readOnly: true, allowDanger: true, risk: "danger" })([call("run_command", { command: "git status" })]))[0]!);
    expect(danger).toContain("只读模式");

    const unknown = denyReasonOf((await gateOf({ readOnly: true })([call("some_new_tool")]))[0]!);
    expect(unknown).toContain("只读模式");
  });

  it("命令工具即使在 --allow-danger 下也被拒：只读赢", async () => {
    const outcomes = await gateOf({ readOnly: true, allowDanger: true })([
      { id: "c1", function: { name: "run_command", arguments: JSON.stringify({ command: "npm test" }) } },
    ]);
    expect(denyReasonOf(outcomes[0]!)).toContain("只读模式");
  });

  it("不开只读时行为不变（写工具照常过闸门）", async () => {
    const outcome = (await gateOf({ risk: "write" })([call("file_write")]))[0]!;
    expect(outcome.kind).toBe("allow");
  });
});

/**
 * 交互式审批（`--ask`，d.322）：只有 danger 类调用会问到人。
 *
 * 这些用例守的是三条约束：问到的人是唯一放行来源、拒绝的 cause 必须记成 `user`、
 * 写文件的越界检查不因为有人点头而放松。
 */
describe("交互式审批（d.322）", () => {
  const shellCall = (command = "git status") => ({
    id: "c1",
    function: { name: "run_command", arguments: JSON.stringify({ command }) },
  });

  /** 闸门 + 脚本化审批器：`answers` 按顺序给人回答，`seen` 记录问了什么。 */
  function askedGate(answers: Parameters<typeof createScriptedApprover>[0], options: { allowDanger?: boolean } = {}) {
    const approver = createScriptedApprover(answers);
    const choices: string[] = [];
    const gate = createCliGate({
      roots: () => ROOTS,
      allowDanger: options.allowDanger === true,
      metaOf: (name: string) => (name === "run_command" ? { risk: "danger", displayName: "在本机执行命令" } : { risk: "read" }),
      ask: approver,
      onApproval: (choice) => choices.push(choice),
    });
    return { gate, approver, choices };
  }

  it("没有 --ask 时 danger 仍是确定性拒绝（老行为不变）", async () => {
    const { gate, approver } = askedGate([]);
    const noAskGate = createCliGate({
      roots: () => ROOTS,
      allowDanger: false,
      metaOf: () => ({ risk: "danger" }),
    });
    const outcome = (await noAskGate([shellCall()]))[0]!;
    expect(outcome.kind).toBe("deny");
    expect(outcome.kind === "deny" ? outcome.cause : "").toBe("gate");
    expect(approver.requests).toHaveLength(0);
    expect(gate).toBeDefined();
  });

  it("人答「允许这一次」就放行，并把这次询问记下来", async () => {
    const { gate, approver, choices } = askedGate(["allow-once"]);
    const outcome = (await gate([shellCall()]))[0]!;
    expect(outcome.kind).toBe("allow");
    expect(approver.requests).toHaveLength(1);
    expect(approver.requests[0]?.tool).toBe("run_command");
    expect(approver.requests[0]?.displayName).toBe("在本机执行命令");
    expect(approver.requests[0]?.detail).toContain("command=git status");
    expect(choices).toEqual(["allow-once"]);
  });

  it("人答「不要」就拒绝，cause 记 user（回灌文案要说「用户拒绝」）", async () => {
    const { gate, choices } = askedGate(["deny"]);
    const outcome = (await gate([shellCall()]))[0]!;
    expect(outcome.kind).toBe("deny");
    expect(outcome.kind === "deny" ? outcome.cause : "").toBe("user");
    expect(outcome.kind === "deny" ? outcome.reason : "").toContain("你在终端里拒绝了这次调用");
    expect(choices).toEqual(["deny"]);
  });

  it("人答「停下」也是拒绝且 cause 记 user", async () => {
    const { gate } = askedGate(["deny-all"]);
    const outcome = (await gate([shellCall()]))[0]!;
    expect(outcome.kind).toBe("deny");
    expect(outcome.kind === "deny" ? outcome.cause : "").toBe("user");
  });

  it("只读工具不问人", async () => {
    const approver = createScriptedApprover(["allow-once"]);
    const gate = createCliGate({
      roots: () => ROOTS,
      allowDanger: false,
      metaOf: () => ({ risk: "read" }),
      ask: approver,
    });
    const outcome = (await gate([{ id: "c1", function: { name: "file_read", arguments: JSON.stringify({ path: "a.ts" }) } }]))[0]!;
    expect(outcome.kind).toBe("allow");
    expect(approver.requests).toHaveLength(0);
  });

  it("写文件的越界检查不因审批而放松：根外写仍然被拒，也不问人", async () => {
    const approver = createScriptedApprover(["allow-once", "allow-session"]);
    const gate = createCliGate({
      roots: () => ROOTS,
      allowDanger: false,
      metaOf: () => ({ risk: "write" }),
      ask: approver,
    });
    const outside = path.resolve("D:/other/a.ts").replace(/\\/g, "/");
    const outcome = (await gate([
      { id: "c1", function: { name: "file_write", arguments: JSON.stringify({ path: outside, content: "x" }) } },
    ]))[0]!;
    expect(outcome.kind).toBe("deny");
    expect(approver.requests).toHaveLength(0);
  });

  it("工作区规则里的 ask 在 --ask 下真的问人，答允许就放行", async () => {
    const approver = createScriptedApprover(["allow-once"]);
    const gate = createCliGate({
      roots: () => ROOTS,
      allowDanger: false,
      metaOf: () => ({ risk: "write" }),
      rules: {
        source: ".heming/permissions.json",
        trusted: false,
        allowActive: false,
        config: { allow: [], deny: [], ask: [{ tool: "file_write", path: "src/**" }] },
      } as never,
      ask: approver,
    });
    const outcome = (await gate([
      { id: "c1", function: { name: "file_write", arguments: JSON.stringify({ path: "src/a.ts", content: "x" }) } },
    ]))[0]!;
    expect(outcome.kind).toBe("allow");
    expect(approver.requests).toHaveLength(1);
    expect(approver.requests[0]?.reason).toContain("工作区权限规则要求先确认");
  });

  it("工作区规则里的 ask 被拒绝时 cause 也记 user", async () => {
    const approver = createScriptedApprover(["deny"]);
    const gate = createCliGate({
      roots: () => ROOTS,
      allowDanger: false,
      metaOf: () => ({ risk: "write" }),
      rules: {
        source: ".heming/permissions.json",
        trusted: false,
        allowActive: false,
        config: { allow: [], deny: [], ask: [{ tool: "file_write", path: "src/**" }] },
      } as never,
      ask: approver,
    });
    const outcome = (await gate([
      { id: "c1", function: { name: "file_write", arguments: JSON.stringify({ path: "src/a.ts", content: "x" }) } },
    ]))[0]!;
    expect(outcome.kind).toBe("deny");
    expect(outcome.kind === "deny" ? outcome.cause : "").toBe("user");
    expect(outcome.kind === "deny" ? outcome.reason : "").toContain("工作区权限规则要求确认");
  });

  it("--allow-danger 时不问人（已经显式放行了）", async () => {
    const { gate, approver } = askedGate(["deny"], { allowDanger: true });
    const outcome = (await gate([shellCall()]))[0]!;
    expect(outcome.kind).toBe("allow");
    expect(approver.requests).toHaveLength(0);
  });
});

/**
 * 批准状态是要**消费**的：闸门先问、桥后执行，`allow-once` 只够一次。
 *
 * 这一组直接走 `createCliTooling`，因为「问过一次之后还能不能跑第二次」这件事
 * 只有在闸门 + 桥 + 命令工具三者都在场时才看得出来。
 */
describe("交互式审批的许可消费（d.322）", () => {
  /** 在临时目录里跑一条几乎无害的真命令（`node -e` 只写一行到 stdout）。 */
  const ECHO = `"${process.execPath}" -e "process.stdout.write('hi')"`;

  function toolingWith(answers: Parameters<typeof createScriptedApprover>[0]) {
    const dir = mkdtempSync(path.join(tmpdir(), "heming-ask-"));
    tmpDirs.push(dir);
    const approver = createScriptedApprover(answers);
    const tooling = createCliTooling({
      cwd: dir,
      allowDanger: false,
      conversationId: "ask-test",
      ask: approver,
    });
    return { tooling, approver };
  }

  const shellCall = { name: "run_command", arguments: JSON.stringify({ command: ECHO }) };

  it("命令工具在 --ask 下会出现在工具清单里（否则人无从放行）", () => {
    const { tooling } = toolingWith([]);
    const names = (tooling.toolBridge.tools as { function: { name: string } }[]).map((spec) => spec.function.name);
    expect(names).toContain("run_command");
  });

  it("答「允许这一次」能跑一次，第二次仍会被拒（许可被消费掉了）", async () => {
    const { tooling, approver } = toolingWith(["allow-once", "deny"]);

    // 编排层的顺序是：闸门先问（confirm）→ 放行后桥再执行（execute）。
    const gateOutcome = await tooling.confirm([{ id: "c1", function: shellCall }]);
    expect(gateOutcome[0]?.kind).toBe("allow");
    const first = await tooling.toolBridge.execute(shellCall);
    expect(first.ok).toBe(true);

    const secondGate = await tooling.confirm([{ id: "c2", function: shellCall }]);
    expect(secondGate[0]?.kind).toBe("deny");
    const second = await tooling.toolBridge.execute(shellCall);
    expect(second.ok).toBe(false);
    expect(second.text).toContain("未执行");
    // 第二次确实又问了一次（一次性的许可用完了就得再问），拿到的是 deny。
    expect(approver.requests).toHaveLength(2);
  });

  it("答「本次运行都允许」之后不再问，连续两次都跑", async () => {
    const { tooling, approver } = toolingWith(["allow-session"]);
    await tooling.confirm([{ id: "c1", function: shellCall }]);
    expect((await tooling.toolBridge.execute(shellCall)).ok).toBe(true);
    expect((await tooling.toolBridge.execute(shellCall)).ok).toBe(true);
    expect(approver.requests).toHaveLength(1);
  });

  it("答「不要」时命令不执行，文案说清是被拒绝而不是参数错", async () => {
    const { tooling } = toolingWith(["deny"]);
    const result = await tooling.toolBridge.execute(shellCall);
    expect(result.ok).toBe(false);
    // 闸门在桥前面：编排层没放行的调用到不了桥，这里直接执行时由桥兜底拒绝。
    expect(result.text).toContain("未执行");
  });

  it("工作区 ask 规则内答「本次运行都允许」不会误开整次运行的 danger 总闸（d.412.4.210）", async () => {
    // 场景：仓库 permissions.json 只让 `git status` 这条命令「先问一下」。人在这条规则问询上
    // 答「本次运行都允许」，语义只是「git status 在这个仓库可以跑」，不该顺带放行别的危险
    // 命令。此前 rule-ask 分支调 input.ask 没标 kind，审批包装把它当 danger 询问处理，
    // allow-session 直接置 sessionAllowed=true——随后任何不命中规则的 run_command 都被静默放行。
    const dir = mkdtempSync(path.join(tmpdir(), "heming-ruleask-"));
    tmpDirs.push(dir);
    const approver = createScriptedApprover(["allow-session"]);
    const tooling = createCliTooling({
      cwd: dir,
      allowDanger: false,
      conversationId: "ruleask-test",
      ask: approver,
      rules: {
        source: ".heming/permissions.json",
        trusted: false,
        allowActive: false,
        config: { allow: [], deny: [], ask: [{ tool: "run_command", command: "*hi*" }] },
      } as never,
    });

    // 第一条：命中 ask 规则（命令输出含 hi），问一次（allow-session）后放行。
    expect((await tooling.confirm([{ id: "c1", function: shellCall }]))[0]?.kind).toBe("allow");
    expect((await tooling.toolBridge.execute(shellCall)).ok).toBe(true);
    expect(approver.requests).toHaveLength(1);

    // 第二条：不命中规则（输出 bye）。正确行为是「危险工具仍要单独问」——队列空则 deny；
    // 若 rule-ask 的 allow-session 误开了总闸，这条会被静默 allow、且不会再问人。
    const unmatched = {
      name: "run_command",
      arguments: JSON.stringify({ command: `"${process.execPath}" -e "process.stdout.write('bye')"` }),
    };
    expect((await tooling.confirm([{ id: "c2", function: unmatched }]))[0]?.kind).toBe("deny");
    expect(approver.requests).toHaveLength(2);

    // 正面语义没丢：同一条规则后续命中仍放行、且不再问人（仍需一次性许可过桥）。
    expect((await tooling.confirm([{ id: "c3", function: shellCall }]))[0]?.kind).toBe("allow");
    expect((await tooling.toolBridge.execute(shellCall)).ok).toBe(true);
    expect(approver.requests).toHaveLength(2);
  });

  it("没有 --ask 也没有 --allow-danger 时命令工具根本不挂（老行为）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "heming-noask-"));
    tmpDirs.push(dir);
    const tooling = createCliTooling({ cwd: dir, allowDanger: false, conversationId: "no-ask" });
    const names = (tooling.toolBridge.tools as { function: { name: string } }[]).map((spec) => spec.function.name);
    expect(names).not.toContain("run_command");
  });
});
/**
 * 工作区记忆（d.329）。
 *
 * 这里验的是「工具挂没挂」和「执行时写到了哪」——记忆文件必须落在工作区的
 * `.heming/memory.json`，而不是别处的某个全局目录。
 */
describe("工作区记忆工具（d.329）", () => {
  /** 闸门看到的形状（带 id 与 function 包装）。 */
  const rememberGateCall = (text: string) => ({
    id: "c-remember",
    function: { name: "remember", arguments: JSON.stringify({ text }) },
  });
  /** 桥 execute 看到的形状（扁平 name/arguments）。 */
  const rememberCall = (text: string) => ({ name: "remember", arguments: JSON.stringify({ text }) });

  it("开启时 remember 出现在工具清单里，且自报为写类", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "heming-mem-"));
    tmpDirs.push(dir);
    const tooling = createCliTooling({ cwd: dir, allowDanger: false, conversationId: "mem-on", memory: true });
    const names = (tooling.toolBridge.tools as { function: { name: string } }[]).map((spec) => spec.function.name);
    expect(names).toContain("remember");
    expect(tooling.toolBridge.meta?.("remember")?.risk).toBe("write");
  });

  it("关闭时不挂；硬调它会说明「这次没开记忆」而不是「未知工具」", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "heming-mem-"));
    tmpDirs.push(dir);
    const tooling = createCliTooling({ cwd: dir, allowDanger: false, conversationId: "mem-off" });
    const names = (tooling.toolBridge.tools as { function: { name: string } }[]).map((spec) => spec.function.name);
    expect(names).not.toContain("remember");

    const result = await tooling.toolBridge.execute(rememberCall("以后都用中文回答"));
    expect(result.ok).toBe(false);
    expect(result.text).toContain("--no-memory");
  });

  it("放行后真的落到工作区的 .heming/memory.json，并能读回来", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "heming-mem-"));
    tmpDirs.push(dir);
    const tooling = createCliTooling({ cwd: dir, allowDanger: false, conversationId: "mem-write", memory: true });

    const gateOutcome = await tooling.confirm([rememberGateCall("以后都用中文回答")]);
    expect(gateOutcome[0]?.kind).toBe("allow");

    const result = await tooling.toolBridge.execute(rememberCall("以后都用中文回答"));
    expect(result.ok).toBe(true);
    expect(result.text).toContain("已记下");

    const raw = JSON.parse(readFileSync(path.join(dir, ".heming", "memory.json"), "utf8")) as {
      entries: { text: string }[];
    };
    expect(raw.entries.map((entry) => entry.text)).toEqual(["以后都用中文回答"]);
  });

  it("参数不对时给出可改的提示，而不是抛异常", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "heming-mem-"));
    tmpDirs.push(dir);
    const tooling = createCliTooling({ cwd: dir, allowDanger: false, conversationId: "mem-bad", memory: true });

    const missing = await tooling.toolBridge.execute({ name: "remember", arguments: "{}" });
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("text 字段");

    const broken = await tooling.toolBridge.execute({ name: "remember", arguments: "{ 不是 JSON" });
    expect(broken.ok).toBe(false);
    expect(broken.text).toContain("不是合法 JSON");
  });

  it("只读模式下一个都不挂（列出来等于承诺能写）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "heming-mem-"));
    tmpDirs.push(dir);
    const tooling = createCliTooling({
      cwd: dir,
      allowDanger: false,
      conversationId: "mem-ro",
      readOnly: true,
      memory: true,
    });
    const names = (tooling.toolBridge.tools as { function: { name: string } }[]).map((spec) => spec.function.name);
    expect(names).not.toContain("remember");
  });
});

describe("回退日志（d.336）", () => {
  it("写工具动手之前抓到原文，收尾时落盘", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "heming-tooling-rewind-"));
    tmpDirs.push(cwd);
    writeFileSync(path.join(cwd, "a.ts"), "原来的内容`n", "utf8");
    const tooling = createCliTooling({ cwd, allowDanger: false, conversationId: "c-rewind" });

    const result = await tooling.toolBridge.execute({
      name: "file_write",
      arguments: JSON.stringify({ path: "a.ts", content: "改过的内容" }),
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(cwd, "a.ts"), "utf8")).toBe("改过的内容");

    const run = await tooling.rewind.close();
    expect(run?.files).toEqual([{ path: "a.ts", before: "原来的内容`n" }]);
    const loaded = await listCliRewinds(cwd);
    expect(loaded?.ok && loaded.runs.length).toBe(1);
  });

  it("--no-rewind 时一条也不抓", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "heming-tooling-norewind-"));
    tmpDirs.push(cwd);
    writeFileSync(path.join(cwd, "a.ts"), "x`n", "utf8");
    const tooling = createCliTooling({ cwd, allowDanger: false, conversationId: "c-norewind", rewind: false });
    const result = await tooling.toolBridge.execute({
      name: "file_write",
      arguments: JSON.stringify({ path: "a.ts", content: "y" }),
    });
    expect(result.ok).toBe(true);
    expect(await tooling.rewind.close()).toBeNull();
    expect(existsSync(rewindDir(cwd))).toBe(false);
  });

  it("只读工具不产生回退记录", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "heming-tooling-read-"));
    tmpDirs.push(cwd);
    writeFileSync(path.join(cwd, "a.ts"), "x`n", "utf8");
    const tooling = createCliTooling({ cwd, allowDanger: false, conversationId: "c-read" });
    await tooling.toolBridge.execute({ name: "file_read", arguments: JSON.stringify({ path: "a.ts" }) });
    expect(await tooling.rewind.close()).toBeNull();
  });
});

describe("命令改动的范围（d.337）", () => {
  it("命令新建的文件被记进这一轮（回退时能删掉）", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "heming-tooling-shell-"));
    tmpDirs.push(cwd);
    writeFileSync(path.join(cwd, "keep.ts"), "keep", "utf8");
    const tooling = createCliTooling({ cwd, allowDanger: true, conversationId: "c-shell" });
    const command = `"${process.execPath}" -e "require('fs').writeFileSync('made.txt','hi')"`;

    const result = await tooling.toolBridge.execute({
      name: "run_command",
      arguments: JSON.stringify({ command }),
    });
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(cwd, "made.txt"))).toBe(true);

    const run = await tooling.rewind.close();
    expect(run?.commandChanges?.created).toContain("made.txt");
    expect(run?.commandChanges?.modified ?? []).toEqual([]);
  }, 30_000);

  it("--no-rewind 时命令改动也不扫盘", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "heming-tooling-shell-off-"));
    tmpDirs.push(cwd);
    const tooling = createCliTooling({ cwd, allowDanger: true, conversationId: "c-shell-off", rewind: false });
    const command = `"${process.execPath}" -e "require('fs').writeFileSync('made.txt','hi')"`;
    const result = await tooling.toolBridge.execute({
      name: "run_command",
      arguments: JSON.stringify({ command }),
    });
    expect(result.ok).toBe(true);
    expect(await tooling.rewind.close()).toBeNull();
  }, 30_000);
});

/**
 * 写文件也先问（`--ask-writes`，d.340）：
 * 「改了什么」在审批框里要看得见，且人的点头不能把越界写变成合法。
 */
describe("MCP 工具按全名精确派发（d.412）", () => {
  /** 造一个假连接：记录被叫到的工具与参数，返回固定文本。 */
  function connection(
    server: string,
    tools: string[],
    seen: { tool: string; args: unknown }[],
  ): McpConnection {
    return {
      server,
      tools: tools.map((name) => ({ name, description: "", inputSchema: undefined })),
      async callTool(tool, args) {
        seen.push({ tool, args });
        return { text: `${server}/${tool} 调用了`, isError: false };
      },
      close() {},
    };
  }

  it("服务名含 __ 时工具仍能正确派发（不再靠反解名字猜边界）", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "heming-mcp-dispatch-"));
    tmpDirs.push(cwd);
    const seen: { tool: string; args: unknown }[] = [];
    const conn = connection("my__server", ["read", "write"], seen);
    const name = mcpToolName("my__server", "write");
    expect(name).toBe("mcp__my__server__write"); // 格式本身不变

    const tooling = createCliTooling({ cwd, allowDanger: true, conversationId: "mcp-dispatch", mcp: [conn] });
    // 工具清单里挂的是全名；meta 也应识别它（danger）。
    const names = (tooling.toolBridge.tools as { function: { name: string } }[]).map((spec) => spec.function.name);
    expect(names).toContain(name);
    expect(tooling.toolBridge.meta?.(name)?.risk).toBe("danger");

    const result = await tooling.toolBridge.execute({ name, arguments: '{"path":"a.ts"}' });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("my__server/write 调用了");
    // 关键：旧的 parseMcpToolName 会把它当成 server=my、tool=server__write 派给 my（不存在）。
    expect(seen).toEqual([{ tool: "write", args: { path: "a.ts" } }]);
  });
});

/**
 * 工作区 allow 规则必须贯穿到执行层（d.412.4.191）。
 *
 * 闸门（createCliGate）在受信任（--trust-workspace）的 allow 规则下会放行 danger 工具，
 * 但桥（toolBridge.execute）此前只认 --allow-danger / 交互许可，于是出现
 * 「闸门说可以、桥说不行」的假授权——规则形同虚设。这里把两端口径钉在一起。
 */
describe("受信任的 allow 规则贯穿到执行层（d.412.4.191）", () => {
  const ECHO = `"${process.execPath}" -e "process.stdout.write('hi')"`;

  function ruleSet(allowActive: boolean, tool: string): never {
    return {
      source: ".heming/permissions.json",
      trusted: allowActive,
      allowActive,
      config: { allow: [{ tool, allowDanger: true }], deny: [], ask: [] },
    } as never;
  }

  function pingConnection(seen: { tool: string; args: unknown }[]): McpConnection {
    return {
      server: "srv",
      tools: [{ name: "ping", description: "", inputSchema: undefined }],
      async callTool(tool, args) {
        seen.push({ tool, args });
        return { text: "srv/ping 调用了", isError: false };
      },
      close() {},
    };
  }

  it("受信任的 allow 规则放行 MCP：闸门 allow 后桥也真的执行", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "heming-allow-mcp-"));
    tmpDirs.push(cwd);
    const seen: { tool: string; args: unknown }[] = [];
    const name = mcpToolName("srv", "ping");
    const tooling = createCliTooling({
      cwd,
      allowDanger: false,
      conversationId: "allow-mcp",
      mcp: [pingConnection(seen)],
      rules: ruleSet(true, "*"),
    });
    const gateCall = { id: "c1", function: { name, arguments: "{}" } };
    expect((await tooling.confirm([gateCall]))[0]?.kind).toBe("allow");

    const result = await tooling.toolBridge.execute({ name, arguments: "{}" });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ tool: "ping", args: {} }]);
  });

  it("未受信任的规则（allowActive:false）不例外：桥仍拒绝", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "heming-allow-off-"));
    tmpDirs.push(cwd);
    const name = mcpToolName("srv", "ping");
    const tooling = createCliTooling({
      cwd,
      allowDanger: false,
      conversationId: "allow-off",
      mcp: [pingConnection([])],
      rules: ruleSet(false, "*"),
    });
    const result = await tooling.toolBridge.execute({ name, arguments: "{}" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("未执行");
  });

  it("受信任的 allow 规则放行命令工具：闸门不提问、桥也执行", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "heming-allow-shell-"));
    tmpDirs.push(cwd);
    const approver = createScriptedApprover([]);
    const tooling = createCliTooling({
      cwd,
      allowDanger: false,
      conversationId: "allow-shell",
      ask: approver,
      rules: ruleSet(true, "run_command"),
    });
    const call = { name: "run_command", arguments: JSON.stringify({ command: ECHO }) };
    expect((await tooling.confirm([{ id: "c1", function: call }]))[0]?.kind).toBe("allow");
    expect(approver.requests).toHaveLength(0);

    const result = await tooling.toolBridge.execute(call);
    expect(result.ok).toBe(true);
    expect(approver.requests).toHaveLength(0);
  });
});

describe("逐笔确认写入（d.340）", () => {
  function toolingWithWrites(answers: Parameters<typeof createScriptedApprover>[0]) {
    const cwd = mkdtempSync(path.join(tmpdir(), "heming-ask-writes-"));
    tmpDirs.push(cwd);
    const approver = createScriptedApprover(answers);
    const tooling = createCliTooling({
      cwd,
      allowDanger: false,
      conversationId: "ask-writes-test",
      ask: approver,
      askWrites: true,
    });
    return { tooling, approver, cwd };
  }

  const writeCall = (rel: string, content: string) => ({
    name: "file_write",
    arguments: JSON.stringify({ path: rel, content }),
  });

  it("根内写也会问，并画出增删对照", async () => {
    const { tooling, approver, cwd } = toolingWithWrites(["allow-once"]);
    const call = writeCall("a.ts", "第一行\n第二行");
    const gateOutcome = await tooling.confirm([{ id: "c1", function: call }]);
    expect(gateOutcome[0]?.kind).toBe("allow");

    expect(approver.requests).toHaveLength(1);
    const request = approver.requests[0]!;
    expect(request.kind).toBe("write");
    expect(request.tool).toBe("file_write");
    expect(request.detail).toContain("新增 2 行");
    expect(request.preview?.slice(0, 2)).toEqual(["+ 第一行", "+ 第二行"]);
    expect(request.reason).toContain("--ask-writes");

    const result = await tooling.toolBridge.execute(call);
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(cwd, "a.ts"), "utf8")).toContain("第二行");
  });

  it("答「不要」就不写，cause 记 user", async () => {
    const { tooling, cwd } = toolingWithWrites(["deny"]);
    const call = writeCall("b.ts", "不该出现");
    const gateOutcome = await tooling.confirm([{ id: "c1", function: call }]);
    expect(gateOutcome[0]?.kind).toBe("deny");
    expect(gateOutcome[0]?.kind === "deny" ? gateOutcome[0].cause : "").toBe("user");
    expect(gateOutcome[0]?.kind === "deny" ? gateOutcome[0].reason : "").toContain("拒绝了这次写入");
    // 编排层只对放行的调用执行桥；这里确认闸门拒了、文件仍不存在。
    expect(existsSync(path.join(cwd, "b.ts"))).toBe(false);
  });

  it("答「本次运行都允许写」之后不再挨个问（命令仍要单独问）", async () => {
    const { tooling, approver } = toolingWithWrites(["allow-session"]);
    expect((await tooling.confirm([{ id: "c1", function: writeCall("c.ts", "一") }]))[0]?.kind).toBe("allow");
    expect((await tooling.confirm([{ id: "c2", function: writeCall("d.ts", "二") }]))[0]?.kind).toBe("allow");
    expect(approver.requests).toHaveLength(1);
  });

  it("写根之外仍然直接拒绝，不会因为开了 --ask-writes 就问人", async () => {
    const { tooling, approver } = toolingWithWrites(["allow-once"]);
    const outside = path.resolve("D:/other/out.ts").replace(/\\/g, "/");
    const outcome = (await tooling.confirm([
      { id: "c1", function: { name: "file_write", arguments: JSON.stringify({ path: outside, content: "x" }) } },
    ]))[0]!;
    expect(outcome.kind).toBe("deny");
    expect(approver.requests).toHaveLength(0);
  });

  it("不开 --ask-writes 时写文件照旧不问（老行为不变）", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "heming-ask-writes-off-"));
    tmpDirs.push(cwd);
    const approver = createScriptedApprover(["deny"]);
    const tooling = createCliTooling({ cwd, allowDanger: false, conversationId: "no-ask-writes", ask: approver });
    const outcome = (await tooling.confirm([
      { id: "c1", function: { name: "file_write", arguments: JSON.stringify({ path: "e.ts", content: "x" }) } },
    ]))[0]!;
    expect(outcome.kind).toBe("allow");
    expect(approver.requests).toHaveLength(0);
  });
});