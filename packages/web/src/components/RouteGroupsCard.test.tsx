/**
 * 候选链设置卡（d.48）：选路档要能存下来，逐候选账要能看见。
 *
 * 两块都是「用户看不看得懂换候选这件事」的落点：路由层与记账本身在
 * llmRoute.test.ts / tokenUsage.test.ts 里覆盖，这里只管界面口径
 * ——便宜与否、钱花在哪、没数据时怎么说。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RouteGroupsCard } from "./RouteGroupsCard.js";
import { accountKey, llmHealth } from "../lib/llmHealth.js";
import { useLlmStore, type LlmProfile } from "../store/llm.js";
import { useTokenUsageStore } from "../store/tokenUsage.js";

const p = (id: string, model: string): LlmProfile => ({
  id,
  label: id,
  provider: "openai",
  apiKey: "k",
  model,
});

beforeEach(() => {
  localStorage.clear();
  llmHealth.reset();
  useLlmStore.setState({
    profiles: [p("贵 Key", "moonshot-v1-8k"), p("便宜 Key", "deepseek-chat")],
    routes: [],
    bindings: {},
    prompts: {},
  });
  useTokenUsageStore.getState().reset();
});

const createChain = (strategyChoice?: string) => {
  fireEvent.click(screen.getByLabelText("新建候选链"));
  fireEvent.change(screen.getByLabelText("候选链名称"), { target: { value: "主备链" } });
  for (const id of ["贵 Key", "便宜 Key"]) {
    fireEvent.change(screen.getByLabelText("添加候选连接"), { target: { value: id } });
    fireEvent.click(screen.getByText("加入"));
  }
  if (strategyChoice) fireEvent.click(screen.getByLabelText(`${strategyChoice}选路`));
  fireEvent.click(screen.getByText("保存"));
};

describe("候选链 · 选路档", () => {
  it("默认按声明顺序，界面上也这么说", () => {
    render(<RouteGroupsCard />);
    createChain();
    expect(useLlmStore.getState().routes[0].strategy).toBe("order");
    expect(screen.getByText(/2 个候选 · 按声明顺序/)).toBeInTheDocument();
  });

  it("选「参考价优先」→ 存进本机档并标在链上", () => {
    render(<RouteGroupsCard />);
    createChain("参考价优先");
    expect(useLlmStore.getState().routes[0].strategy).toBe("cheap");
    expect(screen.getByText(/2 个候选 · 参考价优先/)).toBeInTheDocument();
  });

  it("八档都能选，每档带一行中文说明（客户端口径：不读供应商配额）", () => {
    render(<RouteGroupsCard />);
    fireEvent.click(screen.getByLabelText("新建候选链"));
    expect(screen.getAllByRole("radio")).toHaveLength(8);
    for (const label of [
      "按声明顺序",
      "参考价优先",
      "智能",
      "用得最少优先",
      "按节奏优先",
      "按权重",
      "按速度优先",
      "轮流",
    ]) {
      expect(screen.getByLabelText(`${label}选路`)).toBeInTheDocument();
      expect(screen.getAllByText(new RegExp(label)).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText(/不读供应商配额/).length).toBeGreaterThan(0);
  });

  it("选「按速度优先」→ 存 fast，摘要行显示中文名", () => {
    render(<RouteGroupsCard />);
    createChain("按速度优先");
    expect(useLlmStore.getState().routes[0].strategy).toBe("fast");
    expect(screen.getByText(/2 个候选 · 按速度优先/)).toBeInTheDocument();
  });

  it("weight 档：成员行出现权重输入（缺省 1），改了能存进成员", () => {
    render(<RouteGroupsCard />);
    fireEvent.click(screen.getByLabelText("新建候选链"));
    fireEvent.change(screen.getByLabelText("候选链名称"), { target: { value: "权重链" } });
    for (const id of ["贵 Key", "便宜 Key"]) {
      fireEvent.change(screen.getByLabelText("添加候选连接"), { target: { value: id } });
      fireEvent.click(screen.getByText("加入"));
    }
    // 非 weight 档不显示权重输入
    expect(screen.queryByLabelText("权重 贵 Key")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("按权重选路"));
    expect(screen.getByLabelText<HTMLInputElement>("权重 贵 Key").value).toBe("1");
    fireEvent.change(screen.getByLabelText("权重 贵 Key"), { target: { value: "5" } });
    fireEvent.click(screen.getByText("保存"));

    const saved = useLlmStore.getState().routes[0];
    expect(saved.strategy).toBe("weight");
    expect(saved.members[0].weight).toBe(5);
    expect(saved.members[1].weight).toBeUndefined(); // 没改的保持缺省（路由层按 1 算）
    expect(screen.getByText(/2 个候选 · 按权重/)).toBeInTheDocument();
    expect(screen.getByText("权重 5")).toBeInTheDocument();
  });

  it("编辑已有链时回填选路档（不是每次都退回默认）", () => {
    useLlmStore.getState().addRoute({
      id: "g1",
      label: "已存在的链",
      members: [{ profileId: "贵 Key" }, { profileId: "便宜 Key" }],
      strategy: "cheap",
    });
    render(<RouteGroupsCard />);
    fireEvent.click(screen.getByLabelText("编辑 已存在的链"));
    expect(screen.getByLabelText<HTMLInputElement>("参考价优先选路").checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("按声明顺序选路").checked).toBe(false);
  });

  it("编辑高速档的链：回填「按速度优先」而不是退回默认", () => {
    useLlmStore.getState().addRoute({
      id: "g1",
      label: "速度链",
      members: [{ profileId: "贵 Key" }, { profileId: "便宜 Key" }],
      strategy: "fast",
    });
    render(<RouteGroupsCard />);
    fireEvent.click(screen.getByLabelText("编辑 速度链"));
    expect(screen.getByLabelText<HTMLInputElement>("按速度优先选路").checked).toBe(true);
  });

  it("休息中的候选在链上标出来（换了人得看得见为什么换）", () => {
    useLlmStore.getState().addRoute({
      id: "g1",
      label: "已存在的链",
      members: [{ profileId: "贵 Key" }, { profileId: "便宜 Key" }],
    });
    llmHealth.mark(accountKey("贵 Key"), {
      kind: "rate",
      rests: true,
      scope: "account",
      failover: true,
    });
    render(<RouteGroupsCard />);
    expect(screen.getAllByText(/休息/).length).toBeGreaterThan(0);
    expect(screen.getByText("休息中的候选")).toBeInTheDocument();
  });
});

describe("候选链 · 本月逐候选用量", () => {
  const now = () => new Date().toISOString();

  it("有归属且有拆分 → 按 连接×模型 列一行，给参考价估算", () => {
    useTokenUsageStore
      .getState()
      .record("deepseek-chat", 300_000, now(), {
        profileId: "便宜 Key",
        profileLabel: "便宜 Key",
        input: 240_000,
        output: 60_000,
      });
    render(<RouteGroupsCard />);
    expect(screen.getByText("本月逐候选用量")).toBeInTheDocument();
    expect(screen.getByText(/便宜 Key · deepseek-chat/)).toBeInTheDocument();
    expect(screen.getByText("300000 tokens")).toBeInTheDocument();
    // 240k×2 + 60k×8 = 0.48 + 0.48 = 0.96 元（每百万 token 计价）
    expect(screen.getByText(/≈ ¥0\.960/)).toBeInTheDocument();
    expect(screen.getByText("参考价，以服务商账单为准")).toBeInTheDocument();
  });

  it("没报拆分 → 说「暂无可估的费用数据」，不拿总量猜比例", () => {
    useTokenUsageStore.getState().record("deepseek-chat", 300_000, now(), {
      profileId: "便宜 Key",
      profileLabel: "便宜 Key",
    });
    render(<RouteGroupsCard />);
    expect(screen.getByText("暂无可估的费用数据")).toBeInTheDocument();
  });

  it("未上报的轮数单独标出来（null 不当 0 吞掉）", () => {
    const s = useTokenUsageStore.getState();
    s.recordUnreported("deepseek-chat", now(), { profileId: "便宜 Key", profileLabel: "便宜 Key" });
    render(<RouteGroupsCard />);
    expect(screen.getByText("1 轮未上报")).toBeInTheDocument();
  });

  it("老记录没有归属 → 这份账不出现（归不到具体 Key 就不假装知道）", () => {
    useTokenUsageStore.getState().record("deepseek-chat", 300, now());
    render(<RouteGroupsCard />);
    expect(screen.queryByText("本月逐候选用量")).not.toBeInTheDocument();
  });
});
