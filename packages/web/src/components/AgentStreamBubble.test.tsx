import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentStreamBubble, MessageProcess, MessageSteps, ReasoningBlock, ToolTraceGroup, ToolTraceList } from "./AgentStreamBubble.js";
import type { ToolTrace } from "../store/chat.js";

describe("AgentStreamBubble", () => {
  it("streaming 态显示累积文本与光标（d.248 起不再显示名字）", () => {
    render(<AgentStreamBubble name="和小鸣" text="你好" status="streaming" />);
    expect(screen.queryByText("和小鸣")).toBeNull();
    expect(screen.getByText(/你好/)).toBeInTheDocument();
    expect(document.body.textContent).toContain("▌");
  });

  it("error 态显示原因与继续生成回调", () => {
    const retry = vi.fn();
    render(
      <AgentStreamBubble
        name="和小鸣"
        text="半"
        status="error"
        errorMessage="HTTP 401"
        onRetry={retry}
      />,
    );
    expect(screen.getByText(/HTTP 401/)).toBeInTheDocument();
    // A2：错误行动作统一为「继续生成」
    fireEvent.click(screen.getByText("继续生成"));
    expect(retry).toHaveBeenCalled();
  });
});

describe("AgentStreamBubble 无障碍状态播报（③-2）", () => {
  it("流式：只播报「正在生成」，正文不进 live region（避免逐 token 念屏）", () => {
    render(<AgentStreamBubble name="和小鸣" text="这是一段很长的正文" status="streaming" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/正在生成回复/);
    expect(status).not.toHaveTextContent("这是一段很长的正文");
    // 视觉隐藏但可被读屏读到
    expect(status.className).toContain("sr-only");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("失败：播报「生成失败」；没有错误信息时按「已生成」播报", () => {
    const { rerender } = render(
      <AgentStreamBubble name="和小鸣" text="" status="error" errorMessage="HTTP 401" />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/生成失败/);

    rerender(<AgentStreamBubble name="和小鸣" text="答案" status="error" />);
    expect(screen.getByRole("status")).toHaveTextContent(/已生成回复/);
  });

  it("流式中不再显示「生成中…」视觉提示（d.346），读屏播报保留", () => {
    render(<AgentStreamBubble name="和小鸣" text="" status="streaming" reasoning="想一想" />);
    expect(screen.queryByText("生成中…")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/和小鸣 正在生成回复/);
  });
});

describe("AgentStreamBubble 可视化（思考过程 / 工具调用）", () => {
  it("思考过程：流式中默认展开，可折叠；结束后自动收起", () => {
    const { rerender } = render(
      <AgentStreamBubble name="和小鸣" text="" status="streaming" reasoning="先分析一下问题" />,
    );
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("先分析一下问题")).toBeInTheDocument();
    expect(screen.getByText(/7 字/)).toBeInTheDocument();

    // 手动折叠
    fireEvent.click(screen.getByRole("button", { name: "思考过程" }));
    expect(screen.queryByText("先分析一下问题")).not.toBeInTheDocument();

    // 再次展开
    fireEvent.click(screen.getByRole("button", { name: "思考过程" }));
    expect(screen.getByText("先分析一下问题")).toBeInTheDocument();

    // 流式结束 → 自动收起
    rerender(<AgentStreamBubble name="和小鸣" text="答案" status="error" reasoning="先分析一下问题" />);
    expect(screen.queryByText("先分析一下问题")).not.toBeInTheDocument();
  });

  it("思考片段太长时只显示一段（流式留尾巴），展开才看全文（d.247）", () => {
    const longReasoning = `${"旧想法。".repeat(200)}最新想法在这里`;
    render(<AgentStreamBubble name="和小鸣" text="" status="streaming" reasoning={longReasoning} />);

    // 只渲染尾巴：气泡不会被几万字撑满，正文也不会被顶到屏幕外
    const body = screen.getByTestId("reasoning-body");
    expect(body.textContent).toContain("最新想法在这里");
    expect(body.textContent!.length).toBeLessThan(longReasoning.length);
    // 说明「前面还有多少字没显示」，用户不会以为内容丢了
    expect(screen.getByText(/前面还有 \d+ 字没显示/)).toBeInTheDocument();

    // 展开：全文都在
    fireEvent.click(screen.getByTestId("reasoning-expand"));
    expect(screen.getByTestId("reasoning-body").textContent).toContain("旧想法。旧想法。");
    expect(screen.getByTestId("reasoning-body").textContent).toContain("最新想法在这里");
    expect(screen.queryByText(/前面还有 \d+ 字没显示/)).toBeNull();

    // 收起：回到「只看一段」
    fireEvent.click(screen.getByTestId("reasoning-collapse"));
    expect(screen.getByText(/前面还有 \d+ 字没显示/)).toBeInTheDocument();
  });

  it("短思考不出现「展开全部」（控制大小不等于处处折叠）（d.247）", () => {
    render(<AgentStreamBubble name="和小鸣" text="" status="streaming" reasoning="想一下就好" />);
    expect(screen.getByText("想一下就好")).toBeInTheDocument();
    expect(screen.queryByTestId("reasoning-expand")).toBeNull();
  });

  it("工具调用：显示名称/状态/耗时，展开看参数与结果", () => {
    render(
      <AgentStreamBubble
        name="和小鸣"
        text=""
        status="streaming"
        tools={[
          {
            id: "t1",
            name: "srv__echo",
            args: '{"q":"hi"}',
            status: "ok",
            result: "回声：hi",
            startedAt: 1000,
            endedAt: 1120,
          },
          {
            id: "t2",
            name: "srv__now",
            args: "{}",
            status: "running",
            startedAt: 2000,
          },
        ]}
      />,
    );
    expect(screen.getByText("srv · echo")).toBeInTheDocument();
    expect(screen.getByText("srv · echo").getAttribute("title")).toBe("srv__echo");
    expect(screen.getByText("完成")).toBeInTheDocument();
    expect(screen.getByText("120ms")).toBeInTheDocument();
    expect(screen.getByText("srv · now")).toBeInTheDocument();
    expect(screen.getByText("调用中")).toBeInTheDocument();
    // 结果默认折叠在 details 里（DOM 中可见但不可见文本仍可查询）
    expect(screen.getByText("回声：hi")).toBeInTheDocument();
    expect(screen.getByText('{"q":"hi"}')).toBeInTheDocument();
  });

  it("工具行默认就带一行人话摘要：写文件显示路径与行数，原始 JSON 留在 title（d.216）", () => {
    render(
      <AgentStreamBubble
        name="和小鸣"
        text=""
        status="streaming"
        tools={[
          {
            id: "t1",
            name: "file_write",
            args: JSON.stringify({ path: "notes/新.md", content: "一行\n两行" }),
            status: "ok",
            result: "已写入 2 行",
            startedAt: 1000,
            endedAt: 1100,
          },
          {
            id: "t2",
            name: "run_command",
            args: JSON.stringify({ command: "pnpm -w typecheck", cwd: "D:/Heming" }),
            status: "running",
            startedAt: 2000,
          },
        ]}
      />,
    );
    const summaries = screen.getAllByTestId("tool-arg-summary");
    expect(summaries.map((node) => node.textContent)).toEqual(["notes/新.md · +2 行", "pnpm -w typecheck · D:/Heming"]);
    // 原始 JSON 仍可从悬停（title）与展开区的「参数」里拿到
    expect(summaries[0]?.getAttribute("title")).toContain('"content":"一行\\n两行"');
  });

  it("工具失败用错误态展示", () => {
    render(
      <AgentStreamBubble
        name="和小鸣"
        text=""
        status="streaming"
        tools={[
          {
            id: "t1",
            name: "srv__boom",
            args: "{}",
            status: "error",
            result: "工具调用失败：连接断了",
            startedAt: 1,
            endedAt: 2,
          },
        ]}
      />,
    );
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.getAllByText(/连接断了/).length).toBeGreaterThan(0);
  });

  it("没有思考过程与工具时，不渲染这两块（保持旧结构）", () => {
    render(<AgentStreamBubble name="和小鸣" text="你好" status="streaming" />);
    expect(screen.queryByText("思考过程")).not.toBeInTheDocument();
    expect(screen.queryByText("调用中")).not.toBeInTheDocument();
  });

  it("候选链：换过候选才显示，带上失败分类与这一次用量（d.48）", () => {
    render(
      <AgentStreamBubble
        name="和小鸣"
        text="你好"
        status="streaming"
        attempts={[
          {
            profileId: "p1",
            profileLabel: "废 Key",
            model: "m",
            ok: false,
            kind: "rate",
            restedMs: 60_000,
            error: "provider_error: HTTP 429",
            hop: 0,
          },
          {
            profileId: "p2",
            profileLabel: "备用 Key",
            model: "m",
            ok: true,
            restedMs: 0,
            hop: 1,
            usage: { totalTokens: 1200 },
          },
        ]}
      />,
    );
    expect(screen.getByText("候选链")).toBeInTheDocument();
    expect(screen.getByText(/废 Key\s*·\s*rate/)).toBeInTheDocument();
    // 成功候选的标记从「✓」字符换成了 CheckIcon（字形在不同字体里基线不稳），
    // 所以这里查文字要放宽、并显式断言图标存在。
    const okChip = screen.getByText(/备用 Key\s*1\.2k/);
    expect(okChip.querySelector("svg")).not.toBeNull();
  });

  it("第一次就问对（没有失败候选）→ 候选链这一行不占位", () => {
    render(
      <AgentStreamBubble
        name="和小鸣"
        text="你好"
        status="streaming"
        attempts={[
          { profileId: "p1", profileLabel: "唯一候选", model: "m", ok: true, restedMs: 0, hop: 0 },
        ]}
      />,
    );
    expect(screen.queryByText("候选链")).not.toBeInTheDocument();
  });
});

describe("AgentStreamBubble · 失败原因说人话", () => {
  it("429 的供应商 JSON 原文不进气泡正文，只翻成一句可操作提示（原文留在 title）", () => {
    const raw = 'provider_error: HTTP 429 {"error":{"message":"rate limit exceeded","type":"rate_limit_error"}}';
    render(<AgentStreamBubble name="和小鸣" text="" status="error" errorMessage={raw} />);
    const hint = screen.getByText(/HTTP 429/);
    expect(hint.textContent).toContain("稍等");
    expect(hint.textContent).not.toContain("rate_limit_error");
    expect(hint.getAttribute("title")).toBe(raw);
  });
});

describe("历史消息转录块（d.126-C：思考/工具调用默认折叠）", () => {
  it("ReasoningBlock：非流式（历史消息）默认折叠，点击展开再收起", () => {
    render(<ReasoningBlock text="先查资料再回答" streaming={false} />);
    const toggle = screen.getByRole("button", { name: "思考过程" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/7 字/)).toBeInTheDocument(); // 折叠态仍给一行摘要
    expect(screen.queryByText("先查资料再回答")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("先查资料再回答")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByText("先查资料再回答")).not.toBeInTheDocument();
  });

  it("ToolTraceGroup：一行摘要（次数 + 成败计数），展开看逐条轨迹", () => {
    render(
      <ToolTraceGroup
        tools={[
          {
            id: "t1",
            name: "wiki_search",
            args: '{"q":"发布计划"}',
            status: "ok",
            result: "找到 3 条",
            startedAt: 1000,
            endedAt: 1120,
          },
          {
            id: "t2",
            name: "srv__boom",
            args: "{}",
            status: "error",
            result: "连接断了",
            startedAt: 2000,
            endedAt: 2500,
          },
        ]}
      />,
    );
    const toggle = screen.getByRole("button", { name: "工具调用" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.textContent).toContain("工具调用 · 2 次");
    expect(toggle.textContent).toContain("1 完成 · 1 失败");
    expect(screen.queryByText("wiki_search")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("wiki_search")).toBeInTheDocument();
    expect(screen.getByText("srv · boom")).toBeInTheDocument();
    expect(screen.getByText("找到 3 条")).toBeInTheDocument();
    expect(screen.getAllByText("连接断了").length).toBeGreaterThan(0);
  });

  it("工具失败时折叠行直接说原因、展开区给下一步；成功的行不受影响（d.220）", () => {
    render(
      <AgentStreamBubble
        name="和小鸣"
        text=""
        status="streaming"
        tools={[
          {
            id: "t1",
            name: "file_write",
            args: JSON.stringify({ path: "D:/外面/x.md", content: "hi" }),
            status: "error",
            result: [
              "路径不可用（path-escape）：D:/外面/x.md 不在可写根里",
              "可重试：把 path 改成工作区内的相对路径",
              "提示：这个目录没有被授权写入",
            ].join("\n"),
            startedAt: 1000,
            endedAt: 1050,
          },
          {
            id: "t2",
            name: "file_read",
            args: JSON.stringify({ path: "a.md" }),
            status: "ok",
            result: "文件内容",
            startedAt: 2000,
            endedAt: 2050,
          },
        ]}
      />,
    );
    // 失败行：折叠行是错误首行，不是参数摘要；悬停仍能拿到完整原文
    const headline = screen.getByTestId("tool-failure-headline");
    expect(headline.textContent).toContain("path-escape");
    expect(headline.textContent).toContain("不在可写根里");
    expect(headline.getAttribute("title")).toContain("可重试：把 path 改成工作区内的相对路径");
    // 成功行还是原来的参数摘要
    expect(screen.getByTestId("tool-arg-summary").textContent).toBe("a.md");
    // 展开区多一行「下一步」，优先用「提示」
    expect(screen.getByTestId("tool-failure-next").textContent).toBe("下一步：这个目录没有被授权写入");
    // 结果原文一个字都没少（契约行仍在展开区的原文里）
    expect(screen.getByText(/可重试：把 path 改成工作区内的相对路径/)).toBeInTheDocument();
  });

  it("工具结果很长时先给开头和结尾，展开全部才铺满（d.234）", () => {
    const longResult = Array.from({ length: 900 }, (_, i) => `log-${i + 1}`).join("\n");
    render(
      <AgentStreamBubble
        name="和小鸣"
        text=""
        status="streaming"
        tools={[
          {
            id: "t1",
            name: "run_command",
            args: '{"command":"pnpm build"}',
            status: "ok",
            result: longResult,
            startedAt: 1000,
            endedAt: 2000,
          },
        ]}
      />,
    );

    // 折叠态：开头与结尾都在，中间那行不在
    const preview = screen.getByTestId("tool-result-preview");
    expect(preview.textContent).toContain("log-1\n");
    expect(preview.textContent).toContain("log-900");
    expect(preview.textContent).not.toContain("log-450");
    expect(preview.textContent).toMatch(/中间还有 \d+ 行 \/ \d+ 字未显示/);
    // 明确告诉用户藏了多少，并给出口
    const expand = screen.getByRole("button", { name: /展开全部（还有 \d+ 字未显示）/ });
    fireEvent.click(expand);

    // 展开后是全文，且能收回去
    expect(screen.queryByTestId("tool-result-preview")).toBeNull();
    expect(screen.getByTestId("tool-result-full").textContent).toContain("log-450");
    fireEvent.click(screen.getByRole("button", { name: "收起（只看开头和结尾）" }));
    expect(screen.getByTestId("tool-result-preview")).toBeInTheDocument();
  });
});


describe("工具行的「定位」（d.235）", () => {
  const tool = (args: string) => [
    {
      id: "t1",
      name: "file_read",
      args,
      status: "ok" as const,
      startedAt: 0,
      endedAt: 12,
      result: "读到了 2 行",
    },
  ];

  it("接了 onRevealPath 才出现「定位」，点它回传绝对路径", () => {
    const onRevealPath = vi.fn();
    render(<ToolTraceList tools={tool(JSON.stringify({ path: "D:/工作区/src/a.ts" }))} onRevealPath={onRevealPath} />);
    const button = screen.getByRole("button", { name: "在文件夹里定位 a.ts" });
    fireEvent.click(button);
    expect(onRevealPath).toHaveBeenCalledWith("D:/工作区/src/a.ts");
  });

  it("没接 onRevealPath 时不渲染「定位」（老安装包不留死按钮）", () => {
    render(<ToolTraceList tools={tool(JSON.stringify({ path: "D:/工作区/src/a.ts" }))} />);
    expect(screen.queryByRole("button", { name: /在文件夹里定位/ })).toBeNull();
  });

  it("参数里没有路径的工具（比如 run_command）不出现「定位」", () => {
    const onRevealPath = vi.fn();
    render(
      <ToolTraceList
        tools={[{ id: "t2", name: "run_command", args: JSON.stringify({ command: "pnpm test" }), status: "ok" as const, startedAt: 0, endedAt: 9, result: "ok" }]}
        onRevealPath={onRevealPath}
      />,
    );
    expect(screen.queryByRole("button", { name: /在文件夹里定位/ })).toBeNull();
  });
});
describe("工具行的内联改动对照（d.239）", () => {
  const trace = (name: string, args: Record<string, unknown>, status: "ok" | "error" = "ok"): ToolTrace[] => [
    { id: "t1", name, args: JSON.stringify(args), status, startedAt: 0, endedAt: 9, result: "写好了" },
  ];

  it("file_write 成功：展开区先给「这次改动」与逐行增删", () => {
    render(<ToolTraceList tools={trace("file_write", { path: "notes/新.md", content: "第一行\n第二行\n" })} />);
    expect(screen.getByTestId("tool-inline-diff").textContent).toContain("这次改动：新增 2 行");
    const rows = screen.getAllByTestId("tool-diff-row-add");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("第一行");
    expect(rows[1]!.textContent).toContain("第二行");
  });

  it("file_edit 成功：删除行与新增行分开画", () => {
    render(
      <ToolTraceList
        tools={trace("file_edit", { path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;" })}
      />,
    );
    expect(screen.getByTestId("tool-inline-diff").textContent).toContain("新增 1 行 / 删除 1 行");
    expect(screen.getAllByTestId("tool-diff-row-del")[0]!.textContent).toContain("const a = 1;");
    expect(screen.getAllByTestId("tool-diff-row-add")[0]!.textContent).toContain("const a = 2;");
  });

  it("失败的写调用不画对照（没写成功就不说改了什么）", () => {
    render(<ToolTraceList tools={trace("file_write", { path: "notes/新.md", content: "第一行" }, "error")} />);
    expect(screen.queryByTestId("tool-inline-diff")).toBeNull();
  });

  it("不是写文件的工具不画对照", () => {
    render(<ToolTraceList tools={trace("run_command", { command: "pnpm test" })} />);
    expect(screen.queryByTestId("tool-inline-diff")).toBeNull();
  });
});

describe("工具行折叠（d.243：长任务不再把正文挤没）", () => {
  const many = (count: number, failures: number[] = []): ToolTrace[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `t-${i + 1}`,
      name: "run_command",
      args: JSON.stringify({ command: `step-${i + 1}` }),
      status: failures.includes(i + 1) ? "error" : "ok",
      result: failures.includes(i + 1) ? `命令失败（exec-${i + 1}）：退出码 1` : `第 ${i + 1} 步输出`,
      startedAt: i * 10,
      endedAt: i * 10 + 5,
    }));

  it("不传 fold 时全渲染（历史回看与进度面板保持原样）", () => {
    render(<ToolTraceList tools={many(10)} />);
    expect(screen.queryByTestId("tool-trace-hidden")).toBeNull();
    expect(document.querySelectorAll("details")).toHaveLength(10);
  });

  it("流式气泡传 fold：只留最近几条，其余折成一行按钮", () => {
    render(<ToolTraceList tools={many(10)} fold />);
    const more = screen.getByTestId("tool-trace-hidden");
    expect(more.textContent).toContain("还有 7 次工具调用已收起");
    expect(document.querySelectorAll("details")).toHaveLength(3);
    // 最近一步一定还在（用户关心「现在在干什么」）
    expect(screen.getByText("step-10")).toBeTruthy();
  });

  it("点「展开」看全部，再点「收起」回到折叠态", () => {
    render(<ToolTraceList tools={many(10)} fold />);
    fireEvent.click(screen.getByTestId("tool-trace-hidden"));
    expect(document.querySelectorAll("details")).toHaveLength(10);
    expect(screen.queryByTestId("tool-trace-hidden")).toBeNull();
    fireEvent.click(screen.getByTestId("tool-trace-collapse"));
    expect(document.querySelectorAll("details")).toHaveLength(3);
  });

  it("早先的失败调用不被折掉（否则「为什么卡住」被藏起来）", () => {
    render(<ToolTraceList tools={many(10, [2])} fold />);
    // 第 2 步失败：即使它在「早先」里，也直接显示失败原因那一行
    const headlines = screen.getAllByTestId("tool-failure-headline");
    expect(headlines.some((node) => node.textContent?.includes("exec-2"))).toBe(true);
    // 折起来的次数扣掉它
    expect(screen.getByTestId("tool-trace-hidden").textContent).toContain("还有 6 次工具调用已收起");
  });

  it("流式气泡（AgentStreamBubble）里同样生效", () => {
    render(<AgentStreamBubble name="和鸣" text="在做" status="streaming" tools={many(9)} />);
    expect(screen.getByTestId("tool-trace-hidden").textContent).toContain("还有 6 次工具调用已收起");
  });

  it("气泡里不显示智能体名字，只留生成状态（d.248）", () => {
    const longName = "一个名字非常非常长的智能体".repeat(3);
    render(<AgentStreamBubble name={longName} text="在做" status="streaming" />);
    // 名字不再占视觉空间：读屏文案（sr-only）里仍有，但界面文本里没有。
    expect(screen.queryByText(longName)).toBeNull();
    expect(screen.queryByText("生成中…")).toBeNull();
  });
});

describe("回答与工具按真实时间交错（d.4xx）", () => {
  const tool = (id: string): ToolTrace => ({
    id,
    name: "file_read",
    args: "{}",
    status: "ok",
    result: "内容",
    startedAt: 1,
    endedAt: 2,
  });

  it("answer 步骤夹在工具之间，顺序与发生顺序一致（先回答→工具→再回答）", () => {
    render(
      <MessageSteps
        steps={[
          { kind: "answer", text: "我先看一下文件" },
          { kind: "tool", toolId: "t1" },
          { kind: "answer", text: "看完了，内容是……" },
        ]}
        tools={[tool("t1")]}
        streaming={false}
      />,
    );
    const stepsEl = screen.getByTestId("agent-steps");
    // 文本节点在 DOM 里的先后顺序：第一句回答 < 工具行 < 第二句回答
    const text = stepsEl.textContent!;
    const early = text.indexOf("我先看一下文件");
    const toolPos = text.indexOf("file_read");
    const late = text.indexOf("看完了，内容是");
    expect(early).toBeGreaterThanOrEqual(0);
    expect(toolPos).toBeGreaterThan(early);
    expect(late).toBeGreaterThan(toolPos);
  });

  it("流水中最后的 answer 段长出光标，前面的 answer 不带光标", () => {
    render(
      <MessageSteps
        steps={[
          { kind: "answer", text: "第一句" },
          { kind: "tool", toolId: "t1" },
          { kind: "answer", text: "第二句" },
        ]}
        tools={[tool("t1")]}
        streaming
      />,
    );
    const stepsEl = screen.getByTestId("agent-steps");
    expect(stepsEl.textContent).toContain("第一句");
    expect(stepsEl.textContent).toContain("第二句▌");
    expect(stepsEl.textContent).not.toContain("第一句▌");
  });
});

describe("MessageProcess：落定后的过程默认收起（d.352）", () => {
  const tool = (id: string): ToolTrace => ({
    id,
    name: "file_read",
    args: "{}",
    status: "ok",
    result: "内容",
    startedAt: 1,
    endedAt: 2,
  });

  it("一行摘要写清调用次数与思考字数，点开才铺步骤", () => {
    render(
      <MessageProcess
        steps={[
          { kind: "think", text: "先看看仓库" },
          { kind: "tool", toolId: "t1" },
          { kind: "think", text: "接着写" },
        ]}
        tools={[tool("t1")]}
      />,
    );
    const toggle = screen.getByRole("button", { name: "处理过程" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.textContent).toContain("1 次工具调用");
    expect(toggle.textContent).toContain("思考 8 字");
    // 收起时不渲染步骤，正文里也看不到思考内容
    expect(screen.queryByTestId("agent-steps")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("agent-steps")).toBeInTheDocument();
  });
});

  it("工具耗时不短时，收起状态也写出来（d.392）", () => {
    render(
      <MessageProcess
        steps={[{ kind: "tool", toolId: "t1" }]}
        tools={[{ id: "t1", name: "file_read", args: "{}", status: "ok", result: "内容", startedAt: 1_000, endedAt: 5_000 }]}
      />,
    );
    expect(screen.getByRole("button", { name: "处理过程" }).textContent).toContain("工具 4.0s");
  });

  it("工具太快（不到 1 秒）不占位置", () => {
    render(<MessageProcess steps={[{ kind: "tool", toolId: "t1" }]} tools={[{ id: "t1", name: "file_read", args: "{}", status: "ok", result: "内容", startedAt: 1, endedAt: 2 }]} />);
    expect(screen.getByRole("button", { name: "处理过程" }).textContent).not.toContain("工具 ");
  });



  it("有失败的工具步时，收起摘要里写「N 步没成」（d.399）", () => {
    render(
      <MessageProcess
        steps={[
          { kind: "tool", toolId: "t1" },
          { kind: "tool", toolId: "t2" },
        ]}
        tools={[
          { id: "t1", name: "file_read", args: "{}", status: "error", result: "失败", startedAt: 1, endedAt: 2 },
          { id: "t2", name: "file_read", args: "{}", status: "ok", result: "内容", startedAt: 1, endedAt: 2 },
        ]}
      />,
    );
    const toggle = screen.getByRole("button", { name: "处理过程" });
    expect(toggle.textContent).toContain("2 次工具调用");
    expect(toggle.textContent).toContain("1 步没成");
  });
