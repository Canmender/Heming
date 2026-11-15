import { describe, expect, it } from "vitest";
import { buildTurnEvidence, evidenceFromTranscript } from "./evidence.js";
import type { ChatMessage } from "../llmClient.js";

/**
 * 「完成即证据」（P3/T15）：证据只记**成功且真的动了外部世界**的动作。
 *
 * 为什么这些断言值得写：证据面板/评测是用户判断「它到底做没做」的唯一凭据，
 * 多记一条（把失败的写当成证据）比少记一条更糟——它会让「完成」变成一句无法反驳的假话。
 */

const patchArgs = JSON.stringify({
  patch: [
    "*** Begin Patch",
    "*** Update File: notes/待办.md",
    "@@",
    "-先不放入库",
    "+已确认只放入库摘要与红项",
    "*** End Patch",
  ].join("\n"),
});

describe("buildTurnEvidence", () => {
  it("成功的补丁：文件来自补丁头的文件、命令带路径、摘要来自工具结果", () => {
    const evidence = buildTurnEvidence([
      {
        call: { name: "file_patch", arguments: patchArgs },
        text: "已修改 1 个文件，已写入磁盘：\nnotes/待办.md",
        ok: true,
      },
    ]);
    expect(evidence?.files).toEqual(["notes/待办.md"]);
    expect(evidence?.commands[0]).toContain("file_patch");
    expect(evidence?.commands[0]).toContain("notes/待办.md");
    expect(evidence?.outputDigest).toContain("已写入磁盘");
  });

  it("失败的调用不算证据：它什么都没证明", () => {
    expect(
      buildTurnEvidence([
        {
          call: { name: "file_patch", arguments: patchArgs },
          text: "锚点匹配失败（match-failed）",
          ok: false,
        },
      ]),
    ).toBeUndefined();
  });

  it("内部动作（tool_search）与无副作用的读都不算证据", () => {
    expect(
      buildTurnEvidence([
        { call: { name: "tool_search", arguments: '{"query":"文件"}' }, text: "已加入", ok: true },
      ]),
    ).toBeUndefined();
  });

  it("命令类工具：记一条「工具名: 参数」的命令证据", () => {
    const evidence = buildTurnEvidence([
      {
        call: { name: "shell__run", arguments: '{"command":"pnpm typecheck"}' },
        text: "typecheck 通过",
        ok: true,
      },
    ]);
    expect(evidence?.commands).toEqual(['shell__run: {"command":"pnpm typecheck"}']);
    expect(evidence?.files).toEqual([]);
  });

  it("同一文件改两次只记一条（去重保序），摘要按首次出现顺序拼接", () => {
    const evidence = buildTurnEvidence([
      { call: { name: "file_patch", arguments: patchArgs }, text: "第一次", ok: true },
      { call: { name: "file_patch", arguments: patchArgs }, text: "第二次", ok: true },
    ]);
    expect(evidence?.files).toEqual(["notes/待办.md"]);
    expect(evidence?.outputDigest).toBe("第一次 | 第二次");
  });

  it("Move to 也是落盘目标；JSON 的 path 键同样认", () => {
    const moved = buildTurnEvidence([
      {
        call: {
          name: "file_patch",
          arguments: JSON.stringify({
            patch: "*** Begin Patch\n*** Update File: a.md\n*** Move to: b.md\n@@\n-x\n+y\n*** End Patch",
          }),
        },
        text: "已写入磁盘",
        ok: true,
      },
    ]);
    expect(moved?.files).toEqual(["a.md", "b.md"]);

    const written = buildTurnEvidence([
      { call: { name: "fs__write_file", arguments: '{"path":"notes/x.md","content":"hi"}' }, text: "ok", ok: true },
    ]);
    expect(written?.files).toEqual(["notes/x.md"]);
  });

  it("参数不是合法 JSON 也不炸：从原文里找补丁头", () => {
    const evidence = buildTurnEvidence([
      {
        call: { name: "file_patch", arguments: "*** Begin Patch\n*** Add File: x.md\n+hi\n*** End Patch" },
        text: "已写入磁盘：x.md",
        ok: true,
      },
    ]);
    expect(evidence?.files).toEqual(["x.md"]);
  });
});

describe("evidenceFromTranscript", () => {
  it("按 tool_call_id 把助手消息的参数和工具结果配起来，重建证据", () => {
    const messages = [
      { role: "user", content: "把待办改一下" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "t1", type: "function", function: { name: "file_patch", arguments: patchArgs } },
        ],
      },
      { role: "tool", name: "file_patch", content: "已写入磁盘：notes/待办.md", tool_call_id: "t1" },
    ] as unknown as ChatMessage[];
    const evidence = evidenceFromTranscript(messages);
    expect(evidence?.files).toEqual(["notes/待办.md"]);
    expect(evidence?.outputDigest).toContain("已写入磁盘");
  });

  it("只有结果、没有调用参数时不猜路径：宁可没证据也不造证据", () => {
    const messages = [
      { role: "tool", name: "file_patch", content: "已写入磁盘：notes/待办.md", tool_call_id: "缺失" },
    ] as unknown as ChatMessage[];
    expect(evidenceFromTranscript(messages)).toBeUndefined();
  });
});
