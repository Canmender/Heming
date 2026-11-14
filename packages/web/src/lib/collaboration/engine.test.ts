import { describe, expect, it, vi } from "vitest";
import {
  estimateTurnCount,
  planCollaboration,
  runCollaboration,
  type CollaborationAsk,
} from "./engine.js";
import type { CollaborationConfig, CollaborationParticipant } from "./types.js";

const person = (id: string): CollaborationParticipant => ({ agentId: id, name: `助手${id}` });

function config(
  mode: CollaborationConfig["mode"],
  participants: CollaborationParticipant[],
  rounds = 1,
): CollaborationConfig {
  return { mode, rounds, participants, task: "把季度复盘整理成可执行计划" };
}

interface Call {
  agentId: string;
  messages: Parameters<CollaborationAsk>[1];
  signal: AbortSignal;
}

function recorder(respond?: (agentId: string, callIndex: number) => string) {
  const calls: Call[] = [];
  const ask = vi.fn<CollaborationAsk>(async (agentId, messages, signal) => {
    calls.push({ agentId, messages, signal });
    const index = calls.length;
    return respond ? respond(agentId, index) : `产出-${agentId}-${index}`;
  });
  return { ask, calls };
}

const lastUserText = (call: Call): string => {
  const row = call.messages[call.messages.length - 1];
  return row?.content ?? "";
};

describe("协作引擎 · sequential（流水线）", () => {
  it("按参与者顺序执行，后一位能看到前序产出", async () => {
    const { ask, calls } = recorder();
    const run = await runCollaboration(
      config("sequential", [person("a"), person("b"), person("c")]),
      { ask },
    );

    expect(run.status).toBe("done");
    expect(run.turns.map((t) => t.agentId)).toEqual(["a", "b", "c"]);
    expect(run.turns.map((t) => t.role)).toEqual(["方案", "补充与实现", "评审与定稿"]);
    expect(calls).toHaveLength(3);

    // 第一人看不到产出，只看到任务
    expect(lastUserText(calls[0])).toContain("把季度复盘整理成可执行计划");
    expect(lastUserText(calls[0])).not.toContain("产出-a-1");
    // 后续成员看到前序正文（按 agent 标注）
    expect(lastUserText(calls[1])).toContain("产出-a-1");
    expect(lastUserText(calls[2])).toContain("产出-a-1");
    expect(lastUserText(calls[2])).toContain("产出-b-2");
  });

  it("rounds 控制接力遍数（2 轮 = 参与者数 × 2）", async () => {
    const { ask } = recorder();
    const run = await runCollaboration(
      config("sequential", [person("a"), person("b")], 2),
      { ask },
    );
    expect(run.turns).toHaveLength(4);
    expect(run.turns.map((t) => t.round)).toEqual([1, 1, 2, 2]);
    expect(run.turns[3].role).toBe("复核与定稿");
  });
});

describe("协作引擎 · supervisor（协调者-工作者）", () => {
  it("协调者拆解 → 工作者按轮执行 → 协调者汇总", async () => {
    const { ask, calls } = recorder();
    const run = await runCollaboration(
      config("supervisor", [person("lead"), person("w1"), person("w2")], 2),
      { ask },
    );

    expect(run.status).toBe("done");
    // 1 次拆解 + 2 位 × 2 轮 + 1 次汇总
    expect(run.turns).toHaveLength(6);
    expect(run.turns[0]).toMatchObject({ agentId: "lead", role: "协调者 · 拆解" });
    expect(run.turns.slice(1, 5).map((t) => t.agentId)).toEqual(["w1", "w2", "w1", "w2"]);
    expect(run.turns[5]).toMatchObject({ agentId: "lead", role: "协调者 · 汇总" });

    // 工作者看到计划；第二轮能看到上一轮两位工作者的产出
    expect(lastUserText(calls[1])).toContain("产出-lead-1");
    expect(lastUserText(calls[3])).toContain("产出-lead-1");
    expect(lastUserText(calls[3])).toContain("产出-w1-2");
    // 汇总看到全部
    expect(lastUserText(calls[5])).toContain("产出-w2-5");
  });

  it("只有协调者一人时退化为单回合执行", async () => {
    const { ask } = recorder();
    const run = await runCollaboration(config("supervisor", [person("solo")]), { ask });
    expect(run.turns).toHaveLength(1);
    expect(run.turns[0].role).toBe("协调者 · 执行");
  });
});

describe("协作引擎 · debate（评审团）", () => {
  it("独立方案互相不可见，修正轮才看到上一轮观点，最后综合", async () => {
    const { ask, calls } = recorder();
    const run = await runCollaboration(
      config("debate", [person("a"), person("b")], 1),
      { ask },
    );

    // 独立 a、独立 b、修正 a、修正 b、综合（b）
    expect(run.turns.map((t) => t.role)).toEqual([
      "独立方案",
      "独立方案",
      "第 1 轮修正",
      "第 1 轮修正",
      "综合",
    ]);
    // 独立阶段互相不可见
    expect(lastUserText(calls[0])).not.toContain("产出-b-2");
    expect(lastUserText(calls[1])).not.toContain("产出-a-1");
    // 修正阶段看到两人的独立方案，但看不到同轮另一人的修正
    const revisionA = lastUserText(calls[2]);
    expect(revisionA).toContain("产出-a-1");
    expect(revisionA).toContain("产出-b-2");
    expect(revisionA).not.toContain("产出-b-4");
    // 综合看到所有
    const synthesis = lastUserText(calls[4]);
    expect(synthesis).toContain("产出-a-3");
    expect(synthesis).toContain("产出-b-4");
  });
});

describe("协作引擎 · 边界", () => {
  it("空参与者抛可读错误", async () => {
    const { ask } = recorder();
    await expect(runCollaboration(config("sequential", []), { ask })).rejects.toThrow(
      "协作至少需要一位参与者",
    );
  });

  it("空任务抛可读错误", async () => {
    const { ask } = recorder();
    await expect(
      runCollaboration({ ...config("sequential", [person("a")]), task: "  " }, { ask }),
    ).rejects.toThrow("请先填写协作任务");
  });

  it("已是中止状态：不发起任何调用，保留空回合", async () => {
    const { ask, calls } = recorder();
    const controller = new AbortController();
    controller.abort();
    const run = await runCollaboration(config("sequential", [person("a"), person("b")]), { ask }, {
      signal: controller.signal,
    });
    expect(run.status).toBe("aborted");
    expect(run.turns).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("运行中中止：已完成的回合保留，后续不再调用", async () => {
    const { ask, calls } = recorder();
    const controller = new AbortController();
    const run = await runCollaboration(config("sequential", [person("a"), person("b")]), { ask }, {
      signal: controller.signal,
      onTurnEnd: () => controller.abort(),
    });
    expect(run.status).toBe("aborted");
    expect(run.turns).toHaveLength(1);
    expect(run.turns[0].text).toBe("产出-a-1");
    expect(calls).toHaveLength(1);
  });

  it("模型报错：错误落到该回合，后续中止", async () => {
    let index = 0;
    const ask = vi.fn<CollaborationAsk>(async () => {
      index += 1;
      if (index === 2) throw new Error("未绑定模型：助手b 还没有绑定可用模型");
      return `ok-${index}`;
    });
    const run = await runCollaboration(config("sequential", [person("a"), person("b"), person("c")]), {
      ask,
    });
    expect(run.status).toBe("error");
    expect(run.error).toContain("未绑定模型");
    expect(run.turns).toHaveLength(2);
    expect(run.turns[1].error).toContain("未绑定模型");
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("中止时保留错误的 partialText（已生成的半截内容不丢）", async () => {
    const ask = vi.fn<CollaborationAsk>(async () => {
      const error = new Error("aborted") as Error & { name: string; partialText: string };
      error.name = "AbortError";
      error.partialText = "已经写了一半";
      throw error;
    });
    const run = await runCollaboration(config("sequential", [person("a")]), { ask });
    expect(run.status).toBe("aborted");
    expect(run.turns[0].text).toBe("已经写了一半");
    expect(run.turns[0].aborted).toBe(true);
  });

  it("不把其他参与者的私有 systemPrompt 写进上下文", async () => {
    const { ask, calls } = recorder();
    const participants: CollaborationParticipant[] = [
      { ...person("a"), systemPrompt: "SECRET-PROMPT-A" },
      { ...person("b"), systemPrompt: "SECRET-PROMPT-B" },
    ];
    await runCollaboration(config("debate", participants), { ask });
    const all = calls.flatMap((c) => c.messages.map((m) => m.content)).join("\n");
    expect(all).not.toContain("SECRET-PROMPT-A");
    expect(all).not.toContain("SECRET-PROMPT-B");
  });

  it("计划规模与 UI 估算一致", () => {
    const c = config("supervisor", [person("lead"), person("w1")], 3);
    expect(planCollaboration(c)).toHaveLength(1 + 3 + 1);
    expect(estimateTurnCount(c)).toBe(5);
  });

  it("rounds 越界会被夹到 1-3", async () => {
    const { ask } = recorder();
    const run = await runCollaboration(config("sequential", [person("a")], 99), { ask });
    expect(run.rounds).toBe(3);
    expect(run.turns).toHaveLength(3);
  });
});
