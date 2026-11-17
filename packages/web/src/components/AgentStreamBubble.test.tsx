import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentStreamBubble, ReasoningBlock, ToolTraceGroup, ToolTraceList } from "./AgentStreamBubble.js";

describe("AgentStreamBubble", () => {
  it("streaming 态显示名字与累积文本", () => {
    render(<AgentStreamBubble name="和小鸣" text="你好" status="streaming" />);
    expect(screen.getByText("和小鸣")).toBeInTheDocument();
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

  it("生成中/思考过程等次级文字用可读对比度（不再用 #bbb 这类极浅灰）", () => {
    render(<AgentStreamBubble name="和小鸣" text="" status="streaming" reasoning="想一想" />);
    const streamingHint = screen.getByText("生成中…");
    expect(streamingHint.className).not.toMatch(/#bbb|#999|#888/);
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
