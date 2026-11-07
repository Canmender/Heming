import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { Agent, SharedFileMeta } from "@heming/shared";
import { MemoryPage } from "./MemoryPage.js";
import {
  AGENT_PREFS_KEY,
  AgentPrefsStore,
  GLOBAL_AGENT_ID,
  KB_KEY,
  KnowledgeBase,
  MEMORY_KEYS,
  RECALL_LOG_KEY,
  USAGE_KEY,
  MemoryStore,
  RecallLog,
  RecallRecorder,
  UsageLedger,
  recallMemory,
  summarizeInjection,
  type RecallRun,
  type StorageLike,
} from "../lib/memory/index.js";

// 导出落盘是唯一会离开页面的动作：mock 掉桥接层，只断言页面交给它的内容。
const { saveExportFileMock, hasDesktopExportBridgeMock } = vi.hoisted(() => ({
  saveExportFileMock: vi.fn(),
  hasDesktopExportBridgeMock: vi.fn(() => false),
}));

vi.mock("../lib/export/file.js", () => ({
  hasDesktopExportBridge: hasDesktopExportBridgeMock,
  saveExportFile: saveExportFileMock,
}));

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

function renderPage(mem: MemoryStore = memory) {
  return render(<MemoryPage memory={mem} kb={kb} prefs={prefs} />);
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

  /** d.62-B 布局迁移守卫：页头统一走 PageShell。 */
  it("页头由 PageShell 提供：唯一 h1 用 ui-page-title，副标题用 ui-page-sub", () => {
    mockApi({ agents: AGENTS });
    renderPage();
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveClass("ui-page-title");
    expect(headings[0]).toHaveTextContent("记忆区");
    expect(document.querySelector(".ui-page-sub")?.textContent).toContain("智能体的记忆开关");
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

  it("保留天数非法：保存仍可点，提示用错误色且不改设置", async () => {
    mockApi({ agents: AGENTS });
    renderPage();
    openTab("数据库");

    const overview = screen.getByRole("region", { name: "数据库记忆概览" });
    const days = screen.getByLabelText("保留天数");
    fireEvent.change(days, { target: { value: "0" } });

    const save = within(overview).getByRole("button", { name: "保存" });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("保留天数需为 1–3650 之间的整数");
    expect(alert.className).toContain("text-red-600");
    expect(memory.getSettings().retentionDays).toBe(90);
  });

  it("手动添加的条目不显示「置信度」，自动提取的仍显示（d.77）", async () => {
    mockApi({ agents: AGENTS });
    memory.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    memory.upsertSemantic({
      agentId: "a2",
      key: "偏好-语言",
      value: "默认使用简体中文",
      source: "explicit",
      confidence: 0.8,
    });
    renderPage();
    openTab("数据库");

    // 手动录入的条目：只有来源，没有置信度
    const manualRow = within(semanticList())
      .getByText("手动添加")
      .closest("[data-memory-id]") as HTMLElement;
    expect(manualRow).toHaveTextContent("手动添加");
    expect(manualRow).not.toHaveTextContent("置信度");
    // 自动提取的条目：置信度仍在（它是「提取可信度」，对自动条目有意义）
    const autoRow = within(semanticList())
      .getByText(/对话识别/)
      .closest("[data-memory-id]") as HTMLElement;
    expect(autoRow).toHaveTextContent("置信度 0.80");
  });

  it("检索过滤语义/情景条目，删除后条目消失", async () => {    mockApi({ agents: AGENTS });
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

    fireEvent.click(screen.getByRole("button", { name: "复制 JSON" }));
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

  it("智能体列只显示名称，原始 ID 收进 title（d.77）", async () => {
    mockApi({ agents: AGENTS });
    renderPage();

    // 等名册到位后取表格里的名称单元格（下拉框里也有同名 option，按 title 定位）
    const card = await screen.findByRole("region", { name: "智能体记忆开关" });
    const nameCell = await within(card).findByTitle("智能体 ID：a1");
    expect(nameCell).toHaveTextContent("阿和");
    // 原始 id 不再作为正文出现
    expect(screen.queryByText("a1")).toBeNull();
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

  it("渲染频率三档、每隔几轮与容量条", async () => {
    render(<MemoryPage memory={memory} prefs={prefs} fetchSharedFiles={async () => []} />);
    expect(screen.getByRole("region", { name: "复盘沉淀" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复盘频率 仅复杂任务" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // d.77：孤零零的数字看不出在控制什么，改成「每 N 轮才复盘一次」
    expect(screen.getByText(/轮才复盘一次/)).toBeInTheDocument();
    expect(screen.getByLabelText("每隔几轮复盘")).toBeInTheDocument();
    expect(screen.getByLabelText("每隔几轮复盘")).toBeEnabled();
  });

  it("频率切到「关闭」后，间隔输入框禁用（不再复盘，节流参数无意义）", () => {
    render(<MemoryPage memory={memory} prefs={prefs} fetchSharedFiles={async () => []} />);
    fireEvent.click(screen.getByRole("button", { name: "复盘频率 关闭" }));
    expect(screen.getByLabelText("每隔几轮复盘")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "复盘频率 每轮都复盘" }));
    expect(screen.getByLabelText("每隔几轮复盘")).toBeEnabled();
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

/**
 * 召回可观测性（d.27）：预览区要能区分「召回」与「注入」，记忆区要有本机留档。
 * 日志走注入的 recorder（内存 StorageLike），不碰真 localStorage，也不依赖聊天页。
 */
describe("MemoryPage 召回可观测性", () => {
  /** 每条 ~170 字：语义层额度 480 字，3 条多一点就到顶，「预算外」才有得看。 */
  const FILLER = "服务挂在网关后面要保留原始请求头与客户端地址回滚时先摘流量再执行迁移脚本要能重入";
  const longValue = (index: number) =>
    `部署方案${index}：${FILLER}${FILLER}${FILLER}${FILLER}`;

  let logMap: Map<string, string>;
  let clock: { at: number };

  function makeRecorder() {
    clock = { at: T0 };
    const storage: StorageLike = {
      getItem: (key) => (logMap.has(key) ? (logMap.get(key) as string) : null),
      setItem: (key, value) => logMap.set(key, value),
      removeItem: (key) => logMap.delete(key),
    };
    return new RecallRecorder(
      new RecallLog(storage, () => clock.at),
      () => clock.at,
      new UsageLedger(storage, () => clock.at),
    );
  }

  /** 复刻聊天页那一轮：召回 → 注入旁路 → 收尾落档。 */
  function recordTurn(rec: RecallRecorder, mem: MemoryStore, query: string, answer: string) {
    const recalled = recallMemory(mem, { agentId: "a1", conversationId: "c1", query }, rec.usageView);
    const { observability } = summarizeInjection(recalled);
    rec.capture("a1", "c1", query, observability);
    clock.at += 60_000;
    rec.settle({ agentId: "a1", conversationId: "c1", userText: query, assistantText: answer });
  }

  function renderWith(rec: RecallRecorder, mem: MemoryStore) {
    return render(
      <MemoryPage memory={mem} kb={kb} prefs={prefs} recorder={rec} fetchSharedFiles={async () => []} />,
    );
  }

  beforeEach(() => {
    logMap = new Map();
  });

  it("预览逐条标注打分，且「注入」与「预算外未注入」分开显示", async () => {
    mockApi({ agents: AGENTS });
    for (let i = 0; i < 5; i++) {
      memory.upsertSemantic({ agentId: "a1", key: `部署方案${i}`, value: longValue(i), source: "manual" });
    }
    renderPage();
    await pickAgent();
    openTab("数据库");

    fireEvent.change(screen.getByLabelText("召回预览输入"), { target: { value: "部署" } });
    fireEvent.click(screen.getByRole("button", { name: "预览召回" }));

    const out = screen.getByRole("group", { name: "召回预览结果" });
    expect(within(out).getByText("语义（5）")).toBeInTheDocument();
    // 打分来自召回旁路（保留 4 位，UI 显示 3 位）
    expect(within(out).getAllByText(/打分 \d\.\d{3}/).length).toBeGreaterThan(0);
    expect(within(out).getAllByText(/· 注入/).length).toBeGreaterThan(0);
    expect(within(out).getAllByText(/· 预算外，未注入/).length).toBeGreaterThan(0);
    // 召回 ≠ 注入：结论行两个数字必须不相等
    const summary = within(out).getByText(/→ 注入/).textContent ?? "";
    const matched = summary.match(/召回\s*(\d+)\s*条[\s\S]*?注入\s*(\d+)\s*条/);
    expect(matched).not.toBeNull();
    expect(Number(matched?.[2])).toBeLessThan(Number(matched?.[1]));
    // 截断行必须说明原因，否则用户以为整条都进了提示词
    expect(within(out).getAllByText(/· 注入（超预算已截断）/).length).toBeGreaterThan(0);
  });

  it("同键旧值不显示成漏召回，而是标注「被同键新值覆盖」", async () => {
    mockApi({ agents: AGENTS });
    const winner = memory.upsertSemantic({ agentId: "a1", key: "称呼", value: "王总", source: "manual" });
    // 手工再灌一条同键旧条目：upsertSemantic 会按键合并，历史脏数据只能这样造
    const raw = JSON.parse(memoryMap.get(MEMORY_KEYS.semantic) as string);
    const oldIso = new Date(T0 - 30 * 86_400_000).toISOString();
    raw[GLOBAL_AGENT_ID] = [{ ...winner, id: "sem-old", value: "老王", createdAt: oldIso, updatedAt: oldIso }, ...raw[GLOBAL_AGENT_ID]];
    memoryMap.set(MEMORY_KEYS.semantic, JSON.stringify(raw));
    const seeded = new MemoryStore(makeStorage(memoryMap), () => T0);

    renderPage(seeded);
    await pickAgent();
    openTab("数据库");

    fireEvent.change(screen.getByLabelText("召回预览输入"), { target: { value: "称呼" } });
    fireEvent.click(screen.getByRole("button", { name: "预览召回" }));

    const out = screen.getByRole("group", { name: "召回预览结果" });
    expect(within(out).getByText("称呼：王总")).toBeInTheDocument();
    expect(within(out).queryByText("称呼：老王")).not.toBeInTheDocument();
    expect(within(out).getByText(/1 条旧值被同主题键的新值覆盖/)).toBeInTheDocument();
  });

  it("没有留档时给出可操作的空态，且不出现清除按钮", async () => {
    mockApi({ agents: AGENTS });
    renderWith(makeRecorder(), memory);
    await pickAgent();
    openTab("数据库");

    expect(screen.getByText(/还没有记录/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清除记录" })).not.toBeInTheDocument();
  });

  it("召回记录默认只列最近 3 条，展开明细可见注入/未注入/疑似引用", async () => {
    mockApi({ agents: AGENTS });
    for (let i = 0; i < 4; i++) {
      memory.upsertSemantic({ agentId: "a1", key: `部署方案${i}`, value: longValue(i), source: "manual" });
    }
    const rec = makeRecorder();
    for (let i = 0; i < 4; i++) {
      recordTurn(rec, memory, `部署方案 ${i}`, `部署方案 ${i} 已确认，重启即可`);
    }
    renderWith(rec, memory);
    await pickAgent();
    openTab("数据库");

    const rows = () => screen.getByRole("list", { name: "召回记录列表" });
    expect(within(rows()).getAllByRole("listitem")).toHaveLength(3);
    // 最近优先
    expect(within(rows()).getAllByRole("listitem")[0]).toHaveTextContent("部署方案 3");
    fireEvent.click(screen.getByRole("button", { name: "展开全部 4 条" }));
    expect(within(rows()).getAllByRole("listitem")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "只看最近 3 条" }));
    expect(within(rows()).getAllByRole("listitem")).toHaveLength(3);

    const row = within(rows()).getAllByRole("listitem")[0];
    expect(within(row).getByText(/召回 语义\d+\/情景\d+\/短期\d+ → 注入 \d+ 条/)).toBeInTheDocument();
    expect(within(row).getByText(/未注入 \d+ 条/)).toBeInTheDocument();
    expect(within(row).getByText(/疑似引用 \d+ 条/)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "明细" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(within(row).getByRole("button", { name: "明细" }));
    expect(within(row).getByRole("button", { name: "收起" })).toHaveAttribute("aria-expanded", "true");
    // 注入行带层名与打分；引用行另有标记
    expect(within(row).getAllByText(/▪ 引用/).length).toBeGreaterThan(0);
    // 被预算裁掉的行也带原文，不能只给一个 id
    expect(within(row).getByText(/预算外，未注入：部署方案/)).toBeInTheDocument();
  });

  it("语义卡带「最近注入 / 疑似引用」注脚，清除记录后注脚与留档一起消失", async () => {
    mockApi({ agents: AGENTS });
    memory.upsertSemantic({
      agentId: "a1",
      key: "线上端口",
      value: "线上监听 8787 端口",
      source: "manual",
    });
    const rec = makeRecorder();
    recordTurn(rec, memory, "线上端口", "线上监听 8787 端口，重启即可");
    renderWith(rec, memory);
    await pickAgent();
    openTab("数据库");

    const card = semanticList();
    expect(
      within(card).getByText(/最近注入 2026-10-17 · 疑似引用 2026-10-17/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清除记录" }));
    const dialog = screen.getByRole("dialog", { name: "清除召回记录" });
    expect(within(dialog).getByText(/清除全部 1 条召回记录？/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "清除" }));
    expect(logMap.has(RECALL_LOG_KEY)).toBe(false);
    expect(within(card).queryByText(/最近注入/)).not.toBeInTheDocument();
    expect(screen.getByText(/还没有记录/)).toBeInTheDocument();
  });

  /**
   * 个性化加权（d.28）。两条与「部署」同等相关（命中数、置信度、更新时间全同）的记忆，
   * 只有正文里复述过词的那条提权：
   * A 的注入文本与回答共有 部署/署端/端口/8787 四个词 → 判为疑似引用；
   * B 只共享「部署」这一个二字词（不足 2 个词、长度也不到 3）→ 永远不算被引用。
   */
  const seedTwin = () => {
    memory.upsertSemantic({ agentId: "a1", key: "部署目录", value: "生产放在 /var/www", source: "manual" });
    memory.upsertSemantic({ agentId: "a1", key: "部署端口", value: "8787", source: "manual" });
  };
  const RECORDS = 6;

  it("被引用过的记忆带加权注脚；反复注入却没被引用的进「长期未被引用」清单", async () => {
    mockApi({ agents: AGENTS });
    seedTwin();
    const rec = makeRecorder();
    for (let i = 0; i < RECORDS; i++) recordTurn(rec, memory, "部署", "部署端口 8787 保持不变");
    renderWith(rec, memory);
    await pickAgent();
    openTab("数据库");

    const card = semanticList();
    // ×(1 + 25% × 6/(6+3)) = 1.1667：手算得出来，不是「模型觉得它有用」
    expect(within(card).getByText(/累计注入 6 次 · 疑似引用 6 次 · 个性化加权 ×1\.1667/)).toBeInTheDocument();
    expect(within(card).getByText(/累计注入 6 次 · 未被引用/)).toBeInTheDocument();

    const cold = screen.getByRole("list", { name: "长期未被引用的记忆" });
    expect(within(cold).getByText("部署目录")).toBeInTheDocument();
    expect(within(cold).queryByText("部署端口")).not.toBeInTheDocument();
    // 措辞必须讲清「不会自动删」，否则用户以为系统在偷偷清他的记忆
    expect(screen.getByText(/系统不会因为「冷」自动降权或删除/)).toBeInTheDocument();
  });

  it("召回预览标出乘子，并把提权的那条排到同等相关度的另一条之前", async () => {
    mockApi({ agents: AGENTS });
    seedTwin();
    const rec = makeRecorder();
    for (let i = 0; i < RECORDS; i++) recordTurn(rec, memory, "部署", "部署端口 8787 保持不变");
    renderWith(rec, memory);
    await pickAgent();
    openTab("数据库");

    fireEvent.change(screen.getByLabelText("召回预览输入"), { target: { value: "部署" } });
    fireEvent.click(screen.getByRole("button", { name: "预览召回" }));
    const out = screen.getByRole("group", { name: "召回预览结果" });
    const lines = within(out).getAllByText(/^部署(端口|目录)：/) as HTMLElement[];
    expect(lines[0].textContent).toContain("部署端口：");
    expect(within(out).getAllByText(/加权 ×1\.1667/).length).toBeGreaterThan(0);
    // 冷的那条一分没变：没有乘子标注
    expect(lines[1].textContent).not.toContain("加权");
  });

  it("清除召回记录把加权账本一起清零（不留「有权重、无档案」）", async () => {
    mockApi({ agents: AGENTS });
    seedTwin();
    const rec = makeRecorder();
    recordTurn(rec, memory, "部署", "部署端口 8787 保持不变");
    renderWith(rec, memory);
    await pickAgent();
    openTab("数据库");

    const card = semanticList();
    expect(within(card).getByText(/累计注入 1 次 · 疑似引用 1 次 · 个性化加权 ×1\.0625/)).toBeInTheDocument();
    expect(logMap.has(USAGE_KEY)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "清除记录" }));
    const dialog = screen.getByRole("dialog", { name: "清除召回记录" });
    expect(within(dialog).getByText(/个性化加权回到起点/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "清除" }));
    expect(logMap.has(RECALL_LOG_KEY)).toBe(false);
    expect(logMap.has(USAGE_KEY)).toBe(false);
    // 注脚随账本一起消失：视图必须跟着这次清除重算，不能停在旧快照上
    expect(within(card).queryByText(/累计注入/)).not.toBeInTheDocument();
  });

  it("删除记忆后它的计数从账本里摘掉，不留孤儿 id", async () => {
    mockApi({ agents: AGENTS });
    seedTwin();
    const rec = makeRecorder();
    for (let i = 0; i < RECORDS; i++) recordTurn(rec, memory, "部署", "部署端口 8787 保持不变");
    const before = memory
      .semantic("a1")
      .find((entry) => entry.key === "部署端口") as { id: string };
    renderWith(rec, memory);
    await pickAgent();
    openTab("数据库");

    fireEvent.click(screen.getByRole("button", { name: "删除记忆 部署端口" }));
    const dialog = screen.getByRole("dialog", { name: "删除记忆" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    const ledger = JSON.parse(logMap.get(USAGE_KEY) as string) as Record<string, unknown>;
    expect(ledger[before.id]).toBeUndefined();
    expect(Object.keys(ledger).length).toBe(1); // 只剩「部署目录」那条的计数
  });

  /**
   * 冷清单的覆盖面（d.29）。召回读的是「全局桶 + 该智能体私有」，
   * 清单若只看全局桶，私有条目和情景沉淀白占预算也永远列不出来。
   */
  it("「长期未被引用」覆盖私有语义与情景条目，按注入次数排，删除时连计数一起摘", async () => {
    mockApi({ agents: AGENTS });
    const shared = memory.upsertSemantic({ agentId: "a1", key: "灰度批次", value: "灰度先放五个用户", source: "manual" });
    const priv = memory.upsertSemantic({
      agentId: "a1",
      key: "内网网段",
      value: "内网固定 10.20.0.0/16",
      source: "manual",
      bucket: "a1",
    });
    const epi = memory.addEpisodic({
      agentId: "a1",
      conversationId: "c9",
      summary: "上周确认灰度先放五个用户",
      sourceTurns: 6,
    });
    logMap.set(
      USAGE_KEY,
      JSON.stringify({
        [shared.id]: { injected: 9, used: 0, lastAt: ISO },
        [priv.id]: { injected: 7, used: 0, lastAt: ISO },
        [epi.id]: { injected: 6, used: 0, lastAt: ISO },
      }),
    );
    const rec = makeRecorder();
    renderWith(rec, memory);
    await pickAgent();
    openTab("数据库");

    const cold = screen.getByRole("list", { name: "长期未被引用的记忆" });
    const rows = within(cold).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    // 注入次数多的在前：这份清单是给人逐条删的，「挡了多少预算」就是排序依据
    expect(rows[0]).toHaveTextContent("灰度批次");
    expect(rows[1]).toHaveTextContent("内网网段");
    expect(rows[2]).toHaveTextContent("上周确认灰度先放五个用户");
    // 层名必须标出来：情景条目没有 key，只写日期人看不出那是对话沉淀
    expect(within(rows[0]).getByText(/语义/)).toBeInTheDocument();
    expect(within(rows[2]).getByText(/情景/)).toBeInTheDocument();
    expect(within(rows[0]).getByText(/累计注入 9 次 · 未被引用/)).toBeInTheDocument();

    fireEvent.click(within(rows[2]).getByRole("button", { name: /删除冷记忆 情景/ }));
    const dialog = screen.getByRole("dialog", { name: "删除情景记忆" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    const after = JSON.parse(logMap.get(USAGE_KEY) as string) as Record<string, unknown>;
    expect(after[epi.id]).toBeUndefined();
    expect(after[shared.id]).toBeDefined();
    expect(screen.getByRole("list", { name: "长期未被引用的记忆" })).not.toHaveTextContent("上周确认灰度");
  });

  it("未选中智能体时冷清单标出条目归属（私有条目跨智能体混排，不写来源看不出是谁的）", async () => {
    mockApi({ agents: AGENTS });
    const priv = memory.upsertSemantic({
      agentId: "a2",
      key: "小码的构建参数",
      value: "小码用 pnpm -r build",
      source: "manual",
      bucket: "a2",
    });
    logMap.set(USAGE_KEY, JSON.stringify({ [priv.id]: { injected: 8, used: 0, lastAt: ISO } }));
    const rec = makeRecorder();
    renderWith(rec, memory);
    openTab("数据库");

    const cold = screen.getByRole("list", { name: "长期未被引用的记忆" });
    // 「全部智能体」视角：layers.semantic 是所有桶的并集，私有条目同样进清单
    expect(within(cold).getByText("小码的构建参数")).toBeInTheDocument();
    expect(within(cold).getAllByText(/小码/).length).toBeGreaterThan(0);
  });
});

/**
 * 导出到文件（d.35）：默认不附辅助账本（与 exportAll 逐字节一致）；
 * 勾选后附加用量/召回日志，但 data 不变（免得导入端看到两套数据）。
 */
describe("MemoryPage 导出到文件", () => {
  const AUX_RUN: RecallRun = {
    id: "rr-1",
    at: ISO,
    agentId: "a1",
    conversationId: "c1",
    query: "部署端口",
    recalled: { semantic: 1, episodic: 0, working: 0 },
    injected: [{ id: "s1", layer: "semantic", content: "部署端口：8787", truncated: false }],
    dropped: [],
    used: ["s1"],
  };
  const AUX_USAGE = { s1: { injected: 3, used: 2, lastAt: ISO } };

  /** 页面只读 list/usageSnapshot 两个读口；其余能力本组用例用不到。 */
  function auxRecorder(): RecallRecorder {
    return {
      list: () => [AUX_RUN],
      usageSnapshot: () => AUX_USAGE,
    } as unknown as RecallRecorder;
  }

  function renderWithAux() {
    return render(
      <MemoryPage
        memory={memory}
        kb={kb}
        prefs={prefs}
        recorder={auxRecorder()}
        fetchSharedFiles={async () => []}
      />,
    );
  }

  it("两个导出按钮文案可区分：文件下载 vs 复制到剪贴板（d.77）", async () => {
    mockApi({ agents: AGENTS });
    const writeText = mockClipboard();
    memory.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    renderWithAux();
    openTab("数据库");

    const download = screen.getByRole("button", { name: "下载文件" });
    const copy = screen.getByRole("button", { name: "复制 JSON" });
    expect(download).toHaveAttribute("title", "下载为 JSON 文件");
    expect(copy).toHaveAttribute("title", "复制到剪贴板，不产生文件");

    // 复制只走剪贴板，不触发文件导出
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(saveExportFileMock).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    hasDesktopExportBridgeMock.mockReturnValue(false);
    saveExportFileMock.mockReset();
    saveExportFileMock.mockResolvedValue({ via: "download" });
  });

  it("默认不附辅助账本：导出内容与 exportAll() 逐字节一致", async () => {
    mockApi({ agents: AGENTS });
    memory.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    renderWithAux();
    openTab("数据库");

    const box = screen.getByRole("checkbox", { name: "附上辅助账本（用量/召回记录，可再生）" });
    expect(box).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "下载文件" }));
    await waitFor(() => expect(saveExportFileMock).toHaveBeenCalledTimes(1));

    const [fileName, content] = saveExportFileMock.mock.calls[0] as [string, string];
    expect(fileName).toBe("记忆导出-2026-10-17.json");
    expect(content).toBe(memory.exportAll());
    expect(JSON.parse(content)).not.toHaveProperty("aux");
    expect(await screen.findByText(/已开始下载：记忆导出-2026-10-17\.json/)).toBeInTheDocument();
  });

  it("勾选后导出内容含 aux（usage/recallLog/note），data 不变", async () => {
    mockApi({ agents: AGENTS });
    memory.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    renderWithAux();
    openTab("数据库");

    const box = screen.getByRole("checkbox", { name: "附上辅助账本（用量/召回记录，可再生）" });
    fireEvent.click(box);
    expect(box).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "下载文件" }));
    await waitFor(() => expect(saveExportFileMock).toHaveBeenCalledTimes(1));

    const [, content] = saveExportFileMock.mock.calls[0] as [string, string];
    const doc = JSON.parse(content) as {
      data: unknown;
      aux: { note: string; usage: unknown; recallLog: unknown };
    };
    expect(doc.data).toEqual(JSON.parse(memory.exportAll()).data);
    expect(doc.aux.usage).toEqual(AUX_USAGE);
    expect(doc.aux.recallLog).toEqual([AUX_RUN]);
    expect(doc.aux.note).toContain("可再生数据");
    expect(doc.aux.note).toContain("不参与导入");
  });

  it("有桌面桥时按钮为「导出到文件」，成功提示带落盘路径", async () => {
    hasDesktopExportBridgeMock.mockReturnValue(true);
    saveExportFileMock.mockResolvedValue({
      via: "desktop",
      path: "C:\\Users\\u\\Heming\\exports\\记忆导出-2026-10-17.json",
    });
    mockApi({ agents: AGENTS });
    renderWithAux();
    openTab("数据库");

    fireEvent.click(screen.getByRole("button", { name: "导出到文件" }));
    await waitFor(() => expect(saveExportFileMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/已导出到文件/)).toBeInTheDocument();
    expect(screen.getByText(/Heming\\exports/)).toBeInTheDocument();
  });
});
