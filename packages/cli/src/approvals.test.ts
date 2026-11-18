import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  APPROVAL_ANSWER_HINTS,
  approvalDetail,
  createScriptedApprover,
  createTerminalApprover,
  describeApprovalRequest,
  parseApprovalAnswer,
} from "./approvals.js";

/** 造一个可以按行喂的终端审批器：输出攒在 `output` 里，方便断言提示写了什么。 */
function terminal(answers: string[] | null, maxRetries?: number) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  const approver = createTerminalApprover({ input, output, ...(maxRetries !== undefined ? { maxRetries } : {}) });
  if (answers) {
    // 先写进流里（readline 会自己排队），然后关掉，模拟「用户答完就断开」。
    for (const line of answers) input.write(`${line}\n`);
    input.end();
  }
  return {
    approver,
    input,
    output,
    text: (): string => chunks.join(""),
  };
}

/** 一次审批请求（内容不重要，只要形状对）。 */
const REQUEST = {
  tool: "run_command",
  displayName: "在本机执行命令",
  detail: "command=git status",
  reason: "这是在本机执行命令（或由外部服务代跑）的工具：放行之后它会真的动手。",
};

describe("parseApprovalAnswer", () => {
  it("认「允许这一次」的各种写法", () => {
    for (const raw of ["y", "Y", " yes ", "ok", "allow", "是", "好", "允许", "1"]) {
      expect(parseApprovalAnswer(raw)).toBe("allow-once");
    }
  });

  it("认「本次运行都允许」", () => {
    for (const raw of ["a", "all", "always", "都允许", "全部", "本次都允许"]) {
      expect(parseApprovalAnswer(raw)).toBe("allow-session");
    }
  });

  it("认「不要」", () => {
    for (const raw of ["n", "no", "deny", "不要", "否", "拒绝", "2"]) {
      expect(parseApprovalAnswer(raw)).toBe("deny");
    }
  });

  it("认「停下」", () => {
    for (const raw of ["q", "quit", "stop", "停", "停下", "3"]) {
      expect(parseApprovalAnswer(raw)).toBe("deny-all");
    }
  });

  it("认不出来返回 null（不猜）", () => {
    for (const raw of ["", "   ", "maybe", "行吧", "y n", "??"]) {
      expect(parseApprovalAnswer(raw)).toBeNull();
    }
  });
});

describe("describeApprovalRequest", () => {
  it("三行：工具与人话名字、原因、四种回答", () => {
    const text = describeApprovalRequest(REQUEST);
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("需要你确认");
    expect(lines[0]).toContain("在本机执行命令（run_command）");
    expect(lines[0]).toContain("command=git status");
    expect(lines[1]).toContain("放行之后它会真的动手");
    expect(lines[2]).toContain(APPROVAL_ANSWER_HINTS);
  });

  it("没有 displayName 时不写括号，没有 detail 时不留空位", () => {
    const text = describeApprovalRequest({ tool: "mcp__svc__echo", reason: "外部服务代跑。" });
    const head = text.split("\n")[0]!;
    expect(head).toContain("需要你确认：mcp__svc__echo");
    expect(head).not.toContain("（");
  });

  it("displayName 与工具名相同时只写一次", () => {
    const head = describeApprovalRequest({ tool: "x", displayName: "x", reason: "r" }).split("\n")[0]!;
    expect(head).toContain("需要你确认：x");
    expect(head).not.toContain("x（x）");
  });

  it("参数摘要过长会被压成一行并截断", () => {
    const head = describeApprovalRequest({ ...REQUEST, detail: `command=${"a".repeat(300)}` }).split("\n")[0]!;
    expect(head.length).toBeLessThan(200);
    expect(head).toContain("…");
  });
});

describe("approvalDetail", () => {
  it("从参数里挑出最有信息量的那个字段（带前导空格，直接拼进一行）", () => {
    expect(approvalDetail(JSON.stringify({ command: "git status" }))).toBe(" command=git status");
    expect(approvalDetail(JSON.stringify({ path: "src/a.ts" }))).toBe(" path=src/a.ts");
  });

  it("挑不到字段或参数不是 JSON 时给空串（不编造）", () => {
    expect(approvalDetail("{不是 JSON")).toBe("");
    expect(approvalDetail(JSON.stringify({ other: 1 }))).toBe("");
    expect(approvalDetail(JSON.stringify(["a"]))).toBe("");
  });
});

describe("createScriptedApprover", () => {
  it("按顺序给答案，用完之后一律拒绝（不会无限放行）", async () => {
    const approver = createScriptedApprover(["allow-once", "deny"]);
    expect(await approver(REQUEST)).toBe("allow-once");
    expect(await approver(REQUEST)).toBe("deny");
    expect(await approver(REQUEST)).toBe("deny");
    expect(approver.requests).toHaveLength(3);
    expect(approver.requests[0]?.tool).toBe("run_command");
  });
});

describe("createTerminalApprover", () => {
  it("读到 y 就放行这一次，并把提示写到 output", async () => {
    const t = terminal(["y"]);
    await expect(t.approver.ask(REQUEST)).resolves.toBe("allow-once");
    expect(t.text()).toContain("需要你确认");
    expect(t.text()).toContain("> ");
    t.approver.close();
  });

  it("四种回答各自对应一个决定", async () => {
    const t = terminal(["a", "n", "q"]);
    await expect(t.approver.ask(REQUEST)).resolves.toBe("allow-session");
    await expect(t.approver.ask(REQUEST)).resolves.toBe("deny");
    await expect(t.approver.ask(REQUEST)).resolves.toBe("deny-all");
    t.approver.close();
  });

  it("答「停下」之后不再追问，直接拒绝", async () => {
    const t = terminal(["q"]);
    await expect(t.approver.ask(REQUEST)).resolves.toBe("deny-all");
    const before = t.text().length;
    await expect(t.approver.ask(REQUEST)).resolves.toBe("deny");
    // 没有再写一遍审批框。
    expect(t.text().length).toBe(before);
    t.approver.close();
  });

  it("没看懂就再问一次，答对为止", async () => {
    const t = terminal(["嗯？", "y"]);
    await expect(t.approver.ask(REQUEST)).resolves.toBe("allow-once");
    expect(t.text()).toContain("没看懂");
    t.approver.close();
  });

  it("连续答错到达上限后按「不要」处理，且不再问", async () => {
    const t = terminal(["?", "?", "?"], 3);
    await expect(t.approver.ask(REQUEST)).resolves.toBe("deny-all");
    expect(t.text()).toContain("连续 3 次没答对");
    const before = t.text().length;
    await expect(t.approver.ask(REQUEST)).resolves.toBe("deny");
    expect(t.text().length).toBe(before);
    t.approver.close();
  });

  it("stdin 已关闭（EOF）按「不要」处理，并且不再追问", async () => {
    const t = terminal([]);
    await expect(t.approver.ask(REQUEST)).resolves.toBe("deny-all");
    expect(t.text()).toContain("没有读到回答");
    await expect(t.approver.ask(REQUEST)).resolves.toBe("deny");
    t.approver.close();
  });

  it("close 之后再 close 不抛错", () => {
    const t = terminal(null);
    t.approver.close();
    expect(() => t.approver.close()).not.toThrow();
  });
});