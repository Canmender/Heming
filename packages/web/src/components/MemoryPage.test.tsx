import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { Agent } from "@heming/shared";
import { MemoryPage } from "./MemoryPage.js";
import { MemoryStore, MEMORY_KEYS, type StorageLike } from "../lib/memory/index.js";
import { SkillPool } from "../lib/skills/index.js";

/**
 * 记忆区 UI 用例（设计 §7）：三层记忆总览与技能池都跑真实 lib/memory、lib/skills，
 * 只注入各自独立的内存存储（构造参数即 StorageLike），保证用例间零污染。
 */

const T0 = new Date("2026-10-17T08:00:00.000Z").getTime();
const ISO = "2026-10-17T08:00:00.000Z";

const AGENTS: Agent[] = [
  { id: "a1", owner_id: "u1", name: "阿和", avatar: null, description: "通用助理" },
  { id: "a2", owner_id: "u1", name: "小码", avatar: null, description: "编码助手" },
];

function makeStorage(map: Map<string, string> = new Map()): StorageLike {
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 名册走真实 agentsApi（fetch 层 mock）：成功返回名册，失败返回 500。 */
function mockRoster(agents: Agent[] | "fail") {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url === "/api/agents") {
      return Promise.resolve(agents === "fail" ? jsonRes({ error: "boom" }, 500) : jsonRes(agents));
    }
    return Promise.resolve(jsonRes({ error: "not found" }, 404));
  });
}

function mockClipboard() {
  const writeText = vi.fn((_text: string) => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

let memory: MemoryStore;
let pool: SkillPool;
let memoryMap: Map<string, string>;

beforeEach(() => {
  vi.restoreAllMocks();
  memoryMap = new Map();
  memory = new MemoryStore(makeStorage(memoryMap), () => T0);
  pool = new SkillPool(makeStorage(), () => T0);
});

function renderPage() {
  return render(<MemoryPage memory={memory} skills={pool} />);
}

/** 等名册到位后选中智能体（未选中时写操作被禁用）。 */
async function pickAgent(id = "a1", name = "阿和") {
  await screen.findByRole("option", { name });
  fireEvent.change(screen.getByLabelText("智能体"), { target: { value: id } });
}

const semanticList = () => screen.getByRole("group", { name: "语义记忆条目" });
const episodicList = () => screen.getByRole("group", { name: "情景记忆条目" });
const workingList = () => screen.getByRole("group", { name: "工作记忆条目" });

describe("MemoryPage 记忆页", () => {
  it("渲染标题、记忆/技能池分段与三层层级卡，名册到位后智能体可选", async () => {
    mockRoster(AGENTS);
    renderPage();

    expect(screen.getByRole("heading", { name: "记忆" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "记忆" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "技能池" })).toHaveAttribute("aria-selected", "false");

    for (const layer of ["工作记忆", "情景记忆", "语义记忆"]) {
      const card = screen.getByRole("region", { name: layer });
      expect(within(card).getByText("0")).toBeInTheDocument();
    }

    expect(await screen.findByRole("option", { name: "阿和" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "小码" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "全部智能体" })).toBeInTheDocument();
  });

  it("名册加载失败：降级「全部智能体」并内联中文提示，页面照常渲染", async () => {
    mockRoster("fail");
    renderPage();

    expect(await screen.findByText(/名册加载失败/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "全部智能体" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "阿和" })).not.toBeInTheDocument();
    // 不阻塞：三层卡片与写入入口都在
    expect(screen.getByRole("region", { name: "语义记忆" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加记忆" })).toBeInTheDocument();
  });

  it("未选智能体时禁用写入入口并给出原因提示", async () => {
    mockRoster(AGENTS);
    renderPage();
    await screen.findByRole("option", { name: "阿和" });

    expect(screen.getByRole("button", { name: "添加记忆" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "立即整理" })).toBeDisabled();
    expect(screen.getByText(/需要先选择一个具体智能体/)).toBeInTheDocument();
  });

  it("添加记忆：弹窗提交后语义列表出现该条目并落库", async () => {
    mockRoster(AGENTS);
    renderPage();
    await pickAgent();

    fireEvent.click(screen.getByRole("button", { name: "添加记忆" }));
    const dialog = screen.getByRole("dialog", { name: "添加记忆" });
    fireEvent.change(within(dialog).getByLabelText("主题"), { target: { value: "偏好-语言" } });
    fireEvent.change(within(dialog).getByLabelText("内容"), {
      target: { value: "默认使用简体中文" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    expect(screen.queryByRole("dialog", { name: "添加记忆" })).not.toBeInTheDocument();
    expect(within(semanticList()).getByText("偏好-语言")).toBeInTheDocument();
    expect(within(semanticList()).getByText("默认使用简体中文")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "语义记忆" })).getByText("1")).toBeInTheDocument();
    expect(memory.semantic("a1")).toHaveLength(1);
  });

  it("语义条目支持编辑、置顶/取消置顶与删除", async () => {
    mockRoster(AGENTS);
    memory.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    renderPage();
    await pickAgent();

    // 编辑
    fireEvent.click(within(semanticList()).getByRole("button", { name: "编辑记忆 称呼" }));
    fireEvent.change(screen.getByLabelText("编辑内容 称呼"), { target: { value: "叫我阿和" } });
    fireEvent.click(within(semanticList()).getByRole("button", { name: "保存" }));
    expect(within(semanticList()).getByText("叫我阿和")).toBeInTheDocument();
    expect(memory.semantic("a1")[0].value).toBe("叫我阿和");

    // 置顶 → 取消置顶
    fireEvent.click(within(semanticList()).getByRole("button", { name: "置顶 称呼" }));
    expect(memory.semantic("a1")[0].pinned).toBe(true);
    expect(within(semanticList()).getByText("置顶")).toBeInTheDocument();
    fireEvent.click(within(semanticList()).getByRole("button", { name: "取消置顶 称呼" }));
    expect(memory.semantic("a1")[0].pinned).toBe(false);

    // 删除
    fireEvent.click(within(semanticList()).getByRole("button", { name: "删除记忆 称呼" }));
    expect(memory.semantic("a1")).toHaveLength(0);
    expect(within(semanticList()).queryByText("称呼")).not.toBeInTheDocument();
    expect(within(semanticList()).getByText("暂无条目")).toBeInTheDocument();
  });

  it("情景条目可删除；工作记忆只读展示且无删除入口", async () => {
    mockRoster(AGENTS);
    memory.addEpisodic({
      agentId: "a1",
      conversationId: "c1",
      summary: "用户：部署端口是多少｜助手：监听 8787",
      sourceTurns: 6,
    });
    memory.appendTurn({
      conversationId: "c1",
      agentId: "a1",
      userText: "部署端口是多少",
      assistantText: "监听 8787",
    });
    renderPage();
    await pickAgent();

    expect(within(episodicList()).getByText(/部署端口是多少/)).toBeInTheDocument();
    expect(within(workingList()).getByText(/用户：部署端口是多少/)).toBeInTheDocument();
    expect(within(workingList()).queryByRole("button")).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "工作记忆" })).getByText("1")).toBeInTheDocument();

    fireEvent.click(
      within(episodicList()).getByRole("button", { name: /删除情景 用户：部署端口是多少/ }),
    );
    expect(memory.episodic("a1")).toHaveLength(0);
    expect(within(episodicList()).getByText("暂无条目")).toBeInTheDocument();
  });

  it("检索框按关键词过滤三层条目", async () => {
    mockRoster(AGENTS);
    memory.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    memory.upsertSemantic({
      agentId: "a1",
      key: "偏好-语言",
      value: "默认使用简体中文",
      source: "manual",
    });
    renderPage();
    await pickAgent();

    expect(within(semanticList()).getByText("称呼")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("检索记忆"), { target: { value: "语言" } });

    expect(within(semanticList()).getByText("偏好-语言")).toBeInTheDocument();
    expect(within(semanticList()).queryByText("称呼")).not.toBeInTheDocument();
  });

  it("「自动记忆」开关写入记忆设置", async () => {
    mockRoster(AGENTS);
    renderPage();
    await screen.findByRole("option", { name: "阿和" });

    const sw = screen.getByRole("switch", { name: "自动记忆" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);

    expect(memory.getSettings().autoCapture).toBe(false);
    expect(screen.getByRole("switch", { name: "自动记忆" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("「记忆总开关」默认开，切换后 settings 落盘且可恢复", async () => {
    mockRoster(AGENTS);
    renderPage();
    await screen.findByRole("option", { name: "阿和" });

    expect(screen.getByRole("switch", { name: "记忆总开关" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.click(screen.getByRole("switch", { name: "记忆总开关" }));
    expect(memory.getSettings().enabled).toBe(false);
    // 真正落盘（不只是内存态）
    expect(JSON.parse(memoryMap.get(MEMORY_KEYS.settings) as string).enabled).toBe(false);
    expect(screen.getByRole("switch", { name: "记忆总开关" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    fireEvent.click(screen.getByRole("switch", { name: "记忆总开关" }));
    expect(memory.getSettings().enabled).toBe(true);
    expect(JSON.parse(memoryMap.get(MEMORY_KEYS.settings) as string).enabled).toBe(true);
  });

  it("总开关关闭后写入口禁用并内联说明，召回预览为零注入", async () => {
    mockRoster(AGENTS);
    memory.upsertSemantic({ agentId: "a1", key: "部署端口", value: "8787", source: "manual" });
    memory.updateSettings({ enabled: false });
    renderPage();
    await pickAgent();

    expect(screen.getByText(/不再记录，也不向智能体注入记忆/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加记忆" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "立即整理" })).toBeDisabled();
    // 已有记忆仍可查看（只读封口只针对写入口）
    expect(within(semanticList()).getByText("部署端口")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("召回预览输入"), { target: { value: "部署端口" } });
    fireEvent.click(screen.getByRole("button", { name: "预览召回" }));

    const out = screen.getByRole("group", { name: "召回预览结果" });
    expect(within(out).getByText("预算占用 0 / 1200 字符")).toBeInTheDocument();
    expect(within(out).getByText(/不会注入任何记忆段/)).toBeInTheDocument();
  });

  it("导出复制 JSON 并给出可见反馈；导入失败内联中文错误、合法导入生效", async () => {
    mockRoster(AGENTS);
    const writeText = mockClipboard();
    memory.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    renderPage();
    await screen.findByRole("option", { name: "阿和" });

    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(JSON.parse(writeText.mock.calls[0][0])).toMatchObject({ version: 1 });
    expect(await screen.findByText(/已复制 记忆 JSON/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    fireEvent.change(screen.getByLabelText("导入记忆 JSON"), { target: { value: "{不是 JSON" } });
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
    expect(screen.getByText(/JSON 解析失败/)).toBeInTheDocument();

    const payload = JSON.stringify({
      version: 1,
      exportedAt: ISO,
      data: {
        working: {},
        episodic: {},
        semantic: {
          a1: [
            {
              id: "s9",
              agentId: "a1",
              key: "部署端口",
              value: "8787",
              scope: "user",
              confidence: 0.6,
              pinned: false,
              source: "manual",
              createdAt: ISO,
              updatedAt: ISO,
            },
          ],
        },
        settings: { enabled: true, autoCapture: true, retentionDays: 90 },
      },
    });
    fireEvent.change(screen.getByLabelText("导入记忆 JSON"), { target: { value: payload } });
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));

    expect(await screen.findByText(/导入成功/)).toBeInTheDocument();
    await pickAgent();
    expect(within(semanticList()).getByText("部署端口")).toBeInTheDocument();
  });

  it("「立即整理」把选中智能体的情景条目确定性提炼为语义候选", async () => {
    mockRoster(AGENTS);
    memory.addEpisodic({
      agentId: "a1",
      conversationId: "c1",
      summary: "用户：记住我的称呼是阿和｜助手：好的，以后这样称呼你",
      sourceTurns: 6,
    });
    renderPage();
    await pickAgent();

    fireEvent.click(screen.getByRole("button", { name: "立即整理" }));

    expect(screen.getByText(/已提炼 1 条语义候选/)).toBeInTheDocument();
    expect(within(semanticList()).getByText("称呼")).toBeInTheDocument();
    expect(within(semanticList()).getByText("阿和")).toBeInTheDocument();
    expect(memory.semantic("a1")[0].source).toBe("consolidate");
  });

  it("召回预览展示三层命中条目与预算占用字符数", async () => {
    mockRoster(AGENTS);
    memory.upsertSemantic({ agentId: "a1", key: "部署端口", value: "8787", source: "manual" });
    memory.addEpisodic({
      agentId: "a1",
      conversationId: "c1",
      summary: "用户：部署端口是多少｜助手：监听 8787",
      sourceTurns: 6,
    });
    memory.appendTurn({
      conversationId: "c1",
      agentId: "a1",
      userText: "部署端口是多少",
      assistantText: "监听 8787",
    });
    renderPage();
    await pickAgent();

    fireEvent.change(screen.getByLabelText("召回预览输入"), { target: { value: "部署端口" } });
    fireEvent.click(screen.getByRole("button", { name: "预览召回" }));

    const out = screen.getByRole("group", { name: "召回预览结果" });
    // 精确串匹配：注入正文 textarea 也含这些片段，正则会撞多元素
    expect(within(out).getByText("部署端口：8787")).toBeInTheDocument();
    expect(
      within(out).getByText("2026-10-17：用户：部署端口是多少｜助手：监听 8787"),
    ).toBeInTheDocument();
    expect(within(out).getByText("焦点：部署端口是多少")).toBeInTheDocument();
    expect(within(out).getByText(/预算占用 \d+ \/ 1200 字符/)).toBeInTheDocument();
    const injected = screen.getByLabelText("将被注入的记忆段") as HTMLTextAreaElement;
    expect(injected.value).toContain("长期记忆（语义）");
    expect(injected.value).toContain("## 相关情景记忆");
    expect(injected.value).toContain("## 当前会话焦点");
  });
});

describe("MemoryPage 技能池", () => {
  function openSkills() {
    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));
  }

  it("渲染内置技能卡片：名称/描述/触发词/内置标识/版本", async () => {
    mockRoster(AGENTS);
    renderPage();
    openSkills();

    const card = screen.getByRole("group", { name: "技能 代码审查" });
    // 技能名同时出现在名称与触发词里，故用 getAllByText
    expect(within(card).getAllByText("代码审查").length).toBeGreaterThan(0);
    expect(
      within(card).getByText("对代码变更做缺陷、安全与可维护性审查，按严重程度给出可执行建议"),
    ).toBeInTheDocument();
    expect(within(card).getByText("审查")).toBeInTheDocument();
    expect(within(card).getByText("内置")).toBeInTheDocument();
    expect(within(card).getByText("v1.0.0")).toBeInTheDocument();
    expect(screen.getByText(/共 4 个技能/)).toBeInTheDocument();
  });

  it("启用开关切换技能启停并落库", async () => {
    mockRoster(AGENTS);
    renderPage();
    openSkills();

    const card = screen.getByRole("group", { name: "技能 代码审查" });
    const sw = within(card).getByRole("switch", { name: "启用 代码审查" });
    expect(sw).toHaveAttribute("aria-checked", "true");

    fireEvent.click(sw);
    expect(pool.get("builtin-code-review")?.enabled).toBe(false);
    expect(
      within(screen.getByRole("group", { name: "技能 代码审查" })).getByRole("switch", {
        name: "启用 代码审查",
      }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("新建技能弹窗提交后出现在列表；编辑技能改写正文", async () => {
    mockRoster(AGENTS);
    renderPage();
    openSkills();

    fireEvent.click(screen.getByRole("button", { name: "新建技能" }));
    const dialog = screen.getByRole("dialog", { name: "新建技能" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "周报生成" } });
    fireEvent.change(within(dialog).getByLabelText("描述"), {
      target: { value: "把要点整理成周报" },
    });
    fireEvent.change(within(dialog).getByLabelText("触发词"), { target: { value: "周报, 总结" } });
    fireEvent.change(within(dialog).getByLabelText("标签"), { target: { value: "写作" } });
    fireEvent.change(within(dialog).getByLabelText("指令正文"), {
      target: { value: "1. 汇总要点\n2. 标出风险" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    expect(screen.queryByRole("dialog", { name: "新建技能" })).not.toBeInTheDocument();
    const card = screen.getByRole("group", { name: "技能 周报生成" });
    expect(within(card).getByText("周报")).toBeInTheDocument();
    const created = pool.list().find((s) => s.name === "周报生成");
    expect(created?.triggers).toEqual(["周报", "总结"]);
    expect(created?.source).toBe("user");

    fireEvent.click(within(card).getByRole("button", { name: "编辑 周报生成" }));
    const editDialog = screen.getByRole("dialog", { name: "编辑技能 周报生成" });
    expect(within(editDialog).getByLabelText("指令正文")).toHaveValue("1. 汇总要点\n2. 标出风险");
    fireEvent.change(within(editDialog).getByLabelText("指令正文"), {
      target: { value: "1. 汇总要点" },
    });
    fireEvent.click(within(editDialog).getByRole("button", { name: "保存" }));

    expect(pool.get(created!.id)?.instructions).toBe("1. 汇总要点");
  });

  it("删除技能后卡片消失", async () => {
    mockRoster(AGENTS);
    renderPage();
    openSkills();

    fireEvent.click(screen.getByRole("button", { name: "删除 会议纪要" }));
    expect(screen.queryByRole("group", { name: "技能 会议纪要" })).not.toBeInTheDocument();
    expect(pool.list().some((s) => s.name === "会议纪要")).toBe(false);
  });

  it("导入非法内容内联报错，导入 SKILL.md 后入池", async () => {
    mockRoster(AGENTS);
    renderPage();
    openSkills();

    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    fireEvent.change(screen.getByLabelText("导入技能内容"), { target: { value: "这不是技能" } });
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
    expect(screen.getByText(/无法识别的导入内容/)).toBeInTheDocument();

    const md = [
      "---",
      "name: 周报生成",
      "description: 把要点整理成周报",
      "version: 2.0.0",
      "triggers: [周报, 总结]",
      "tags: [写作]",
      "---",
      "",
      "1. 汇总要点",
    ].join("\n");
    fireEvent.change(screen.getByLabelText("导入技能内容"), { target: { value: md } });
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));

    expect(await screen.findByText(/导入完成：新增 1/)).toBeInTheDocument();
    const card = screen.getByRole("group", { name: "技能 周报生成" });
    expect(within(card).getByText("v2.0.0")).toBeInTheDocument();
    expect(within(card).getByText("导入")).toBeInTheDocument(); // 来源标识
  });

  it("导出全部复制整池 JSON 并反馈；导出单条复制 SKILL.md", async () => {
    mockRoster(AGENTS);
    const writeText = mockClipboard();
    renderPage();
    openSkills();

    fireEvent.click(screen.getByRole("button", { name: "导出全部" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(JSON.parse(writeText.mock.calls[0][0]).skills).toHaveLength(4);
    expect(await screen.findByText(/已复制 整池 JSON/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "导出 代码审查" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText.mock.calls[1][0]).toContain("name: 代码审查");
    expect(await screen.findByText(/已复制 SKILL\.md/)).toBeInTheDocument();
  });

  it("路由预览展示命中技能、命中理由与预算占用", async () => {
    mockRoster(AGENTS);
    renderPage();
    openSkills();

    fireEvent.change(screen.getByLabelText("路由预览输入"), {
      target: { value: "帮我审查这段代码" },
    });
    fireEvent.click(screen.getByRole("button", { name: "预览路由" }));

    const out = screen.getByRole("group", { name: "路由预览结果" });
    expect(within(out).getByText("代码审查")).toBeInTheDocument();
    expect(within(out).getByText(/命中：/)).toBeInTheDocument();
    expect(within(out).getByText(/预算占用 \d+ \/ 1600 字符/)).toBeInTheDocument();
  });

  it("选中智能体后可设置顶与本智能体禁用", async () => {
    mockRoster(AGENTS);
    renderPage();
    openSkills();
    await pickAgent();

    const card = screen.getByRole("group", { name: "技能 代码审查" });
    fireEvent.click(within(card).getByLabelText("置顶 代码审查"));
    expect(pool.bindings("a1").pinned).toEqual(["builtin-code-review"]);

    fireEvent.click(within(card).getByLabelText("本智能体禁用 代码审查"));
    expect(pool.bindings("a1").disabled).toEqual(["builtin-code-review"]);

    // 取消置顶
    fireEvent.click(within(card).getByLabelText("置顶 代码审查"));
    expect(pool.bindings("a1").pinned).toEqual([]);
  });

  it("「全部智能体」下不显示智能体级绑定控件", async () => {
    mockRoster(AGENTS);
    renderPage();
    openSkills();
    await screen.findByRole("option", { name: "阿和" });

    expect(screen.queryByLabelText("置顶 代码审查")).not.toBeInTheDocument();
  });
});
