import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { Agent, SharedFileMeta } from "@heming/shared";
import { MemoryPage } from "./MemoryPage.js";
import {
  AGENT_PREFS_KEY,
  AgentPrefsStore,
  KB_KEY,
  KnowledgeBase,
  MEMORY_KEYS,
  MemoryStore,
  type StorageLike,
} from "../lib/memory/index.js";

/**
 * 记忆区 UI 用例：三块分区（短期 / 数据库 / 个人知识库）+ 智能体记忆开关。
 * 全部跑真实 lib/memory 实现，只注入独立的内存存储（构造参数即 StorageLike），用例间零污染。
 */

const T0 = new Date("2026-10-17T08:00:00.000Z").getTime();
const ISO = "2026-10-17T08:00:00.000Z";

const AGENTS: Agent[] = [
  { id: "a1", owner_id: "u1", name: "阿和", avatar: null, description: "通用助理" },
  { id: "a2", owner_id: "u1", name: "小码", avatar: null, description: "编码助手" },
];

const FILES: SharedFileMeta[] = [
  {
    id: "f1",
    owner: "u1",
    name: "发布计划.md",
    mime: "text/markdown",
    size: 2048,
    updatedAt: ISO,
  },
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

/** 名册/共享文件都走真实 api 层（fetch mock）：可按需返回失败。 */
function mockApi(routes: { agents?: Agent[] | "fail"; files?: SharedFileMeta[] | "fail" } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url === "/api/agents") {
      return Promise.resolve(
        routes.agents === "fail" ? jsonRes({ error: "boom" }, 500) : jsonRes(routes.agents ?? []),
      );
    }
    if (url === "/api/files") {
      return Promise.resolve(
        routes.files === "fail" ? jsonRes({ error: "boom" }, 500) : jsonRes(routes.files ?? []),
      );
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
let kb: KnowledgeBase;
let prefs: AgentPrefsStore;
let memoryMap: Map<string, string>;
let kbMap: Map<string, string>;
let prefsMap: Map<string, string>;

beforeEach(() => {
  vi.restoreAllMocks();
  memoryMap = new Map();
  kbMap = new Map();
  prefsMap = new Map();
  memory = new MemoryStore(makeStorage(memoryMap), () => T0);
  kb = new KnowledgeBase(makeStorage(kbMap), () => T0);
  prefs = new AgentPrefsStore(makeStorage(prefsMap));
});

function renderPage() {
  return render(<MemoryPage memory={memory} kb={kb} prefs={prefs} />);
}

/** 等名册到位后选中智能体（未选中时写操作被禁用）。 */
async function pickAgent(id = "a1", name = "阿和") {
  await screen.findByRole("option", { name });
  fireEvent.change(screen.getByLabelText("选择智能体"), { target: { value: id } });
}

function openTab(name: "智能体" | "数据库" | "个人知识库") {
  fireEvent.click(screen.getByRole("tab", { name }));
}

const semanticList = () => screen.getByRole("group", { name: "语义记忆条目" });
const episodicList = () => screen.getByRole("group", { name: "情景记忆条目" });

describe("MemoryPage 三分区结构", () => {
  it("渲染「记忆区」标题、三个分区切换与智能体选择器", async () => {
    mockApi({ agents: AGENTS });
    renderPage();

    expect(screen.getByRole("heading", { name: "记忆区" })).toBeInTheDocument();
    for (const label of ["智能体", "数据库", "个人知识库"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("tab", { name: "智能体" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "数据库" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    // 默认展示短期记忆面板
    expect(screen.getByRole("region", { name: "短期记忆" })).toBeInTheDocument();
    expect(screen.getByText(/约 2 小时未活动或满 40 轮后过期/)).toBeInTheDocument();

    expect(await screen.findByRole("option", { name: "阿和" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "小码" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "全部智能体" })).toBeInTheDocument();
  });

  it("名册加载失败：降级「全部智能体」并内联中文提示，页面照常可用", async () => {
    mockApi({ agents: "fail" });
    renderPage();

    expect(await screen.findByText(/名册加载失败/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "全部智能体" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "阿和" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "短期记忆" })).toBeInTheDocument();
    expect(screen.getByText(/名册为空/)).toBeInTheDocument();
  });
});

describe("MemoryPage 短期记忆", () => {
  it("按会话分组展示、可折叠，并能清空指定会话", async () => {
    mockApi({ agents: AGENTS });
    memory.appendTurn({
      conversationId: "c1",
      agentId: "a1",
      userText: "部署端口是多少",
      assistantText: "监听 8787",
    });
    memory.appendTurn({
      conversationId: "c2",
      agentId: "a2",
      userText: "帮我写周报",
      assistantText: "好的",
    });
    renderPage();

    const c1 = screen.getByRole("group", { name: "会话 c1" });
    expect(within(c1).getByText("用户：部署端口是多少")).toBeInTheDocument();
    expect(within(c1).getByText("助手：监听 8787")).toBeInTheDocument();
    expect(screen.getByText("共 2 轮 · 2 个会话")).toBeInTheDocument();

    // 折叠 → 逐轮内容隐藏；再展开恢复
    const toggle = within(c1).getByRole("button", { name: "会话 c1" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(c1).queryByText(/部署端口是多少/)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(within(c1).getByText(/部署端口是多少/)).toBeInTheDocument();

    // 清空 c2 只影响该会话
    fireEvent.click(screen.getByRole("button", { name: "清空会话 c2" }));
    // 清空需二次确认：确认前不动数据
    expect(memory.working("c2")).toHaveLength(1);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "清空短期记忆" })).getByRole("button", {
        name: "清空",
      }),
    );
    expect(memory.working("c2")).toHaveLength(0);
    expect(screen.queryByRole("group", { name: "会话 c2" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已清空会话 c2 的短期记忆");
    expect(within(screen.getByRole("group", { name: "会话 c1" })).getByText(/部署端口是多少/))
      .toBeInTheDocument();
  });
});

describe("MemoryPage 数据库记忆", () => {
  it("展示保留天数与总量，可调整 retentionDays 并落盘", async () => {
    mockApi({ agents: AGENTS });
    memory.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    memory.addEpisodic({
      agentId: "a1",
      conversationId: "c1",
      summary: "用户：部署端口是多少｜助手：监听 8787",
      sourceTurns: 6,
    });
    renderPage();
    openTab("数据库");

    expect(screen.getByRole("region", { name: "数据库记忆概览" })).toBeInTheDocument();
    expect(screen.getByText(/2 条 · \d+ 字符/)).toBeInTheDocument();

    const days = screen.getByLabelText("保留天数");
    expect(days).toHaveValue(90);
    fireEvent.change(days, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(memory.getSettings().retentionDays).toBe(30);
    expect(JSON.parse(memoryMap.get(MEMORY_KEYS.settings) as string).retentionDays).toBe(30);
    expect(screen.getByText("已保存：情景记忆保留 30 天")).toBeInTheDocument();
  });

  it("检索过滤语义/情景条目，删除后条目消失", async () => {
    mockApi({ agents: AGENTS });
    memory.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    memory.upsertSemantic({
      agentId: "a1",
      key: "偏好-语言",
      value: "默认使用简体中文",
      source: "manual",
    });
    memory.addEpisodic({
      agentId: "a1",
      conversationId: "c1",
      summary: "用户：部署端口是多少｜助手：监听 8787",
      sourceTurns: 6,
    });
    renderPage();
    await pickAgent();
    openTab("数据库");

    expect(within(semanticList()).getByText("称呼")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("检索记忆"), { target: { value: "语言" } });

    expect(within(semanticList()).getByText("偏好-语言")).toBeInTheDocument();
    expect(within(semanticList()).queryByText("称呼")).not.toBeInTheDocument();
    expect(within(episodicList()).getByText("无匹配条目")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("检索记忆"), { target: { value: "" } });
    fireEvent.click(within(semanticList()).getByRole("button", { name: "删除记忆 称呼" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "删除记忆" })).getByRole("button", {
        name: "删除",
      }),
    );
    expect(memory.semanticGlobal()).toHaveLength(1);
    expect(within(semanticList()).queryByText("称呼")).not.toBeInTheDocument();

    fireEvent.click(
      within(episodicList()).getByRole("button", { name: /删除情景 用户：部署端口是多少/ }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "删除情景记忆" })).getByRole("button", {
        name: "删除",
      }),
    );
    expect(memory.episodic("a1")).toHaveLength(0);
    expect(within(episodicList()).getByText("暂无条目")).toBeInTheDocument();
  });

  it("添加/编辑/置顶语义条目仍工作；未选智能体时写入口禁用", async () => {
    mockApi({ agents: AGENTS });
    renderPage();
    await screen.findByRole("option", { name: "阿和" });
    openTab("数据库");

    expect(screen.getByRole("button", { name: "添加记忆" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "立即整理" })).toBeDisabled();
    expect(screen.getByText(/需要先选择一个具体智能体/)).toBeInTheDocument();

    await pickAgent();
    fireEvent.click(screen.getByRole("button", { name: "添加记忆" }));
    const dialog = screen.getByRole("dialog", { name: "添加记忆" });
    fireEvent.change(within(dialog).getByLabelText("主题"), { target: { value: "称呼" } });
    fireEvent.change(within(dialog).getByLabelText("内容"), { target: { value: "阿和" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    expect(screen.queryByRole("dialog", { name: "添加记忆" })).not.toBeInTheDocument();
    expect(within(semanticList()).getByText("称呼")).toBeInTheDocument();
    expect(memory.semanticGlobal()).toHaveLength(1);

    fireEvent.click(within(semanticList()).getByRole("button", { name: "编辑记忆 称呼" }));
    fireEvent.change(screen.getByLabelText("编辑内容 称呼"), { target: { value: "叫我阿和" } });
    fireEvent.click(within(semanticList()).getByRole("button", { name: "保存" }));
    expect(memory.semanticGlobal()[0].value).toBe("叫我阿和");

    fireEvent.click(within(semanticList()).getByRole("button", { name: "置顶 称呼" }));
    expect(memory.semanticGlobal()[0].pinned).toBe(true);
    fireEvent.click(within(semanticList()).getByRole("button", { name: "取消置顶 称呼" }));
    expect(memory.semanticGlobal()[0].pinned).toBe(false);
  });

  it("「立即整理」把情景条目提炼为语义候选", async () => {
    mockApi({ agents: AGENTS });
    memory.addEpisodic({
      agentId: "a1",
      conversationId: "c1",
      summary: "用户：记住我的称呼是阿和｜助手：好的，以后这样称呼你",
      sourceTurns: 6,
    });
    renderPage();
    await pickAgent();
    openTab("数据库");

    fireEvent.click(screen.getByRole("button", { name: "立即整理" }));

    expect(screen.getByText(/已提炼 1 条语义候选/)).toBeInTheDocument();
    expect(within(semanticList()).getByText("称呼")).toBeInTheDocument();
    expect(memory.semanticGlobal()[0].source).toBe("consolidate");
  });

  it("记忆总开关/自动记忆落盘，关闭总开关后写入口禁用", async () => {
    mockApi({ agents: AGENTS });
    renderPage();
    await screen.findByRole("option", { name: "阿和" });
    openTab("数据库");

    const auto = screen.getByRole("switch", { name: "自动记忆" });
    expect(auto).toHaveAttribute("aria-checked", "true");
    fireEvent.click(auto);
    expect(memory.getSettings().autoCapture).toBe(false);

    const master = screen.getByRole("switch", { name: "记忆总开关" });
    expect(master).toHaveAttribute("aria-checked", "true");
    fireEvent.click(master);
    expect(memory.getSettings().enabled).toBe(false);
    expect(JSON.parse(memoryMap.get(MEMORY_KEYS.settings) as string).enabled).toBe(false);
    expect(screen.getByText(/不再记录，也不向智能体注入记忆/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加记忆" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "立即整理" })).toBeDisabled();
  });

  it("导出复制 JSON；非法导入内联报错，合法导入生效", async () => {
    mockApi({ agents: AGENTS });
    const writeText = mockClipboard();
    memory.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    renderPage();
    await screen.findByRole("option", { name: "阿和" });
    openTab("数据库");

    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(JSON.parse(writeText.mock.calls[0][0])).toMatchObject({ version: 1 });
    expect(await screen.findByText(/已复制 记忆 JSON/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    fireEvent.change(screen.getByLabelText("导入记忆 JSON"), { target: { value: "{不是 JSON" } });
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
    fireEvent.click(screen.getByRole("button", { name: "替换并导入" }));
    expect(screen.getByText(/JSON 解析失败/)).toBeInTheDocument();

    const payload = JSON.stringify({
      version: 1,
      exportedAt: ISO,
      data: {
        working: {},
        episodic: {},
        semantic: {
          __global__: [
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
    fireEvent.click(screen.getByRole("button", { name: "替换并导入" }));

    expect(await screen.findByText(/导入成功/)).toBeInTheDocument();
    await pickAgent();
    expect(within(semanticList()).getByText("部署端口")).toBeInTheDocument();
  });

  it("召回预览展示三层命中条目与预算占用字符数", async () => {
    mockApi({ agents: AGENTS });
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
    openTab("数据库");

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

describe("MemoryPage 智能体记忆开关", () => {
  it("缺省为短期关/长期关/个人数据库允许，切换后写入 localStorage", async () => {
    mockApi({ agents: AGENTS });
    renderPage();

    const short = await screen.findByRole("switch", { name: "阿和 短期记忆" });
    expect(short).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "阿和 长期记忆" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("switch", { name: "阿和 个人数据库" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.click(short);
    expect(screen.getByRole("switch", { name: "阿和 短期记忆" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const stored = JSON.parse(prefsMap.get(AGENT_PREFS_KEY) as string);
    expect(stored.a1).toEqual({ shortTerm: true, longTerm: false, personalDb: true });

    fireEvent.click(screen.getByRole("switch", { name: "阿和 长期记忆" }));
    expect(JSON.parse(prefsMap.get(AGENT_PREFS_KEY) as string).a1.longTerm).toBe(true);
  });

  it("关闭个人数据库需二次确认，确认后落盘", async () => {
    mockApi({ agents: AGENTS });
    renderPage();

    const dbSwitch = await screen.findByRole("switch", { name: "阿和 个人数据库" });
    fireEvent.click(dbSwitch);

    // 第一次点击只弹出确认，不改变状态
    expect(screen.getByRole("switch", { name: "阿和 个人数据库" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText(/个人知识库默认允许使用，确认关闭？/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认关闭 阿和 个人数据库" }));
    expect(screen.getByRole("switch", { name: "阿和 个人数据库" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(JSON.parse(prefsMap.get(AGENT_PREFS_KEY) as string).a1.personalDb).toBe(false);
  });

  it("名册读不到时可手动登记智能体，偏好仍按 ID 持久化", async () => {
    mockApi({ agents: "fail" });
    renderPage();
    await screen.findByText(/名册加载失败/);

    fireEvent.change(screen.getByLabelText("智能体 ID"), { target: { value: "a9" } });
    fireEvent.change(screen.getByLabelText("智能体名称"), { target: { value: "临时助手" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    const sw = screen.getByRole("switch", { name: "临时助手 短期记忆" });
    fireEvent.click(sw);
    expect(JSON.parse(prefsMap.get(AGENT_PREFS_KEY) as string).a9).toEqual({
      shortTerm: true,
      longTerm: false,
      personalDb: true,
    });
  });
});

describe("记忆区 · 复盘沉淀卡", () => {
  beforeEach(() => {
    // 复盘设置落在真实 localStorage：用例间清干净，避免频率断言被上一条污染
    localStorage.clear();
  });

  it("渲染频率三档、间隔轮次与容量条", async () => {
    render(<MemoryPage memory={memory} prefs={prefs} fetchSharedFiles={async () => []} />);
    expect(screen.getByRole("region", { name: "复盘沉淀" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复盘频率 仅复杂任务" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("复盘间隔轮次")).toBeInTheDocument();
  });

  it("切频率写盘并立即反映到按钮态", () => {
    render(<MemoryPage memory={memory} prefs={prefs} fetchSharedFiles={async () => []} />);
    fireEvent.click(screen.getByRole("button", { name: "复盘频率 关闭" }));
    expect(JSON.parse(localStorage.getItem("heming.memory.review.v1") as string).frequency).toBe(
      "never",
    );
    expect(screen.getByRole("button", { name: "复盘频率 关闭" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("立即复盘：没有可复盘对话时给出明确提示，不空跑模型", async () => {
    render(<MemoryPage memory={memory} prefs={prefs} fetchSharedFiles={async () => []} />);
    fireEvent.click(screen.getByRole("button", { name: "立即复盘一次" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/请先在上方选择一个智能体|还没有可复盘的对话/),
    );
  });
});
