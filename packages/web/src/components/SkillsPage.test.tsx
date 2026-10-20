import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { SkillsPage, categorizeSkill, SOURCE_LABEL } from "./SkillsPage.js";
import { SkillPool, SKILLS_KEY, BUILTIN_SKILLS, type StorageLike } from "../lib/skills/index.js";

/**
 * 技能区 UI 用例：全部跑真实 lib/skills 的 SkillPool，只注入独立内存存储，
 * 用例之间零污染；分类映射走导出的纯函数 categorizeSkill。
 */

// 技能按智能体分配：页面会拉名册，测试固定返回一个智能体。
vi.mock("../lib/agentsApi.js", () => ({
  listAgents: vi.fn(async () => [
    { id: "a1", name: "和鸣助手" },
    { id: "a2", name: "财报助手" },
  ]),
}));

const T0 = new Date("2026-10-17T08:00:00.000Z").getTime();

const SKILL_MD = `---
name: 财报速读
description: 从财报里提取收入、利润与现金流的关键变化
version: 1.2.0
triggers: [财报, 年报, 财务]
tags: [财务, 阅读]
---

你在阅读一份财报。
1. 先看收入与毛利率的同比变化。
2. 再看经营现金流与净利润是否背离。
3. 只输出结论，不复述报表原文。`;

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

let map: Map<string, string>;
let pool: SkillPool;

beforeEach(() => {
  vi.restoreAllMocks();
  map = new Map();
  pool = new SkillPool(makeStorage(map), () => T0);
});

function renderPage() {
  return render(<SkillsPage skills={pool} />);
}

/** 等名册到位（选中有智能体、内置技能默认已分配）后再断言。 */
async function renderReady() {
  const r = renderPage();
  const select = (await screen.findByLabelText("选择智能体")) as HTMLSelectElement;
  // 名册到位后 agentId 自动选中第一个智能体
  await waitFor(() => expect(select.value).toBe("a1"));
  return r;
}

function group(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

describe("SkillsPage 技能区", () => {
  it("默认渲染技能 tab、四类分组与已分配技能（内置默认分配）", async () => {
    await renderReady();

    expect(screen.getByRole("heading", { name: "技能区" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "技能" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "技能池" })).toHaveAttribute("aria-selected", "false");

    // 首启种子 4 个内置技能
    expect(within(group("内置技能")).getByText(String(BUILTIN_SKILLS.length))).toBeInTheDocument();
    expect(
      within(group("内置技能")).getByRole("group", { name: "技能卡 记忆整理" }),
    ).toBeInTheDocument();

    for (const title of ["已装技能", "沉淀技能", "自定义技能"]) {
      expect(within(group(title)).getByText("0")).toBeInTheDocument();
    }
    // 已选智能体：沉淀组空态是「该智能体还没有这类技能」
    expect(
      within(group("沉淀技能")).getByText(/「和鸣助手」还没有这类技能/),
    ).toBeInTheDocument();
  });

  it("categorizeSkill 把四种来源映射为四类分组", () => {
    expect(categorizeSkill({ source: "builtin" })).toBe("builtin");
    expect(categorizeSkill({ source: "imported" })).toBe("installed");
    expect(categorizeSkill({ source: "distilled" })).toBe("distilled");
    expect(categorizeSkill({ source: "user" })).toBe("custom");

    expect(SOURCE_LABEL).toMatchObject({
      builtin: "内置",
      imported: "已装",
      distilled: "沉淀",
      user: "自定义",
    });
  });

  it("切到技能池后列出全部技能（含未启用）与来源、使用统计", async () => {
    pool.create({
      name: "私有技能",
      description: "仅本机使用的内部技能",
      instructions: "按内部规范处理。",
      triggers: ["内部"],
      tags: ["内部"],
      enabled: false,
      version: "1.0.0",
    });
    pool.importText(SKILL_MD);
    const imported = pool.list().find((skill) => skill.name === "财报速读");
    expect(imported).toBeDefined();
    pool.distill((imported as { id: string }).id);
    const disabled = pool.list().find((skill) => skill.name === "私有技能");
    pool.recordUsage((disabled as { id: string }).id);

    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));

    expect(screen.getByRole("tab", { name: "技能池" })).toHaveAttribute("aria-selected", "true");
    // 表头 + 全部技能行
    expect(screen.getAllByRole("row")).toHaveLength(pool.list().length + 1);

    // 未启用的自定义技能同样在池中，且开关为关
    const customRow = screen.getByRole("row", { name: /私有技能/ });
    expect(within(customRow).getByText("自定义")).toBeInTheDocument();
    expect(
      within(customRow).getByRole("switch", { name: "启用 私有技能" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(within(customRow).getByText("1")).toBeInTheDocument();
    expect(within(customRow).getByText(/^2026-10-17 \d{2}:\d{2}$/)).toBeInTheDocument();

    // 四种来源标签都能在池中出现
    expect(within(screen.getByRole("row", { name: /记忆整理/ })).getByText("内置")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /财报速读（沉淀）/ })).getByText("沉淀")).toBeInTheDocument();
    expect(
      within(screen.getByRole("row", { name: /^财报速读 [^（]/ })).getByText("已装"),
    ).toBeInTheDocument();
  });

  it("技能池搜索按名称、描述、标签过滤并给无结果提示", async () => {
    pool.importText(SKILL_MD);
    await renderReady();
    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));

    const search = screen.getByLabelText("搜索技能");
    fireEvent.change(search, { target: { value: "财务" } }); // 命中标签
    expect(screen.getByRole("row", { name: /财报速读/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /记忆整理/ })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "现金流" } }); // 命中描述
    expect(screen.getByRole("row", { name: /财报速读/ })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "查无此技能" } });
    expect(screen.getByText("没有匹配「查无此技能」的技能")).toBeInTheDocument();
  });

  it("启用开关会调用 store 并立即反映到两个视图", async () => {
    await renderReady();

    const toggle = screen.getByRole("switch", { name: "启用 写作润色" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);

    expect(pool.get("builtin-writing")?.enabled).toBe(false);
    expect(screen.getByRole("switch", { name: "启用 写作润色" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));
    expect(screen.getByRole("switch", { name: "启用 写作润色" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("技能池可把已装技能转为沉淀，沉淀会自动分配给当前智能体", async () => {
    pool.importText(SKILL_MD);
    await renderReady();
    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));

    fireEvent.click(screen.getByRole("button", { name: "沉淀 财报速读" }));

    const distilled = pool.list().filter((skill) => skill.source === "distilled");
    expect(distilled).toHaveLength(1);
    expect(distilled[0].name).toBe("财报速读（沉淀）");
    expect(distilled[0].enabled).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("已沉淀为「财报速读（沉淀）」");
    // 沉淀副本自身不再提供「转为沉淀」
    expect(
      screen.queryByRole("button", { name: "沉淀 财报速读（沉淀）" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "技能" }));
    expect(within(group("沉淀技能")).getByText("1")).toBeInTheDocument();
  });

  it("导入 SKILL.md 后可用 ＋ 把它加进已装技能组", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));

    fireEvent.click(screen.getByRole("button", { name: "导入 SKILL.md" }));
    fireEvent.change(screen.getByLabelText("导入技能内容"), { target: { value: SKILL_MD } });
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));

    expect(screen.getByRole("status")).toHaveTextContent("导入完成：新增 1 个，更新 0 个");

    fireEvent.click(screen.getByRole("tab", { name: "技能" }));
    // 导入的技能默认不分配：用分组头 ＋ 加进来
    expect(within(group("已装技能")).getByText("0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "为已装技能添加技能" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 财报速读" }));
    expect(
      within(group("已装技能")).getByRole("group", { name: "技能卡 财报速读" }),
    ).toBeInTheDocument();
  });

  it("详情抽屉展示完整指令，内置技能不提供删除", async () => {
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: "详情 代码审查" }));

    const dialog = screen.getByRole("dialog", { name: "技能详情 代码审查" });
    expect(within(dialog).getByRole("heading", { name: "代码审查" })).toBeInTheDocument();
    expect(within(dialog).getByText(/你在审查一段代码变更/)).toBeInTheDocument();
    expect(within(dialog).getByText("审查")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /删除/ })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("四组皆空时给出「该智能体还没有这类技能」空态", async () => {
    map.set(
      SKILLS_KEY,
      JSON.stringify({ version: 1, seeded: true, skills: [], usage: {} }),
    );
    pool = new SkillPool(makeStorage(map), () => T0);
    await renderReady();

    for (const title of ["内置技能", "已装技能", "沉淀技能", "自定义技能"]) {
      expect(within(group(title)).getByText("0")).toBeInTheDocument();
    }
    // 已选中智能体时，空态是「该智能体还没有这类技能」，而不是「池里没有」
    expect(screen.getAllByText(/还没有这类技能，点上方 ＋ 添加/)).toHaveLength(4);
  });
});

describe("SkillsPage 按智能体分配技能", () => {
  it("切换智能体后只显示该智能体已分配的技能", async () => {
    // 先建技能再渲染（store 非响应式，渲染后新增不会自动出现在列表里）
    pool.create({
      name: "私有技能",
      description: "内部使用",
      instructions: "按规范处理。",
      triggers: ["内部"],
      tags: ["内部"],
      enabled: true,
      version: "1.0.0",
    });
    await renderReady();
    // 默认智能体 a1：内置 4 个
    expect(within(group("内置技能")).getByText(String(BUILTIN_SKILLS.length))).toBeInTheDocument();

    // 给 a1 加一个自定义技能
    fireEvent.click(screen.getByRole("button", { name: "为自定义技能添加技能" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 私有技能" }));
    expect(within(group("自定义技能")).getByText("1")).toBeInTheDocument();

    // 切到 a2：内置仍是 4，自定义回到 0（分配是 per-agent 的）
    fireEvent.change(screen.getByLabelText("选择智能体"), { target: { value: "a2" } });
    expect(within(group("自定义技能")).getByText("0")).toBeInTheDocument();
    expect(within(group("内置技能")).getByText(String(BUILTIN_SKILLS.length))).toBeInTheDocument();

    // 切回 a1：自定义 1 仍在
    fireEvent.change(screen.getByLabelText("选择智能体"), { target: { value: "a1" } });
    expect(within(group("自定义技能")).getByText("1")).toBeInTheDocument();
  });

  it("卡片上的「移除」取消分配，技能池里仍然保留该技能", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "移除 写作润色" }));

    expect(pool.assigned("a1")).not.toContain("builtin-writing");
    // 池里还在
    expect(pool.get("builtin-writing")).toBeDefined();
    expect(within(group("内置技能")).getByText(String(BUILTIN_SKILLS.length - 1))).toBeInTheDocument();
  });

  it("＋ 面板只列该分类下尚未分配的技能", async () => {
    pool.importText(SKILL_MD);
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "为已装技能添加技能" }));

    const dialog = screen.getByRole("dialog", { name: "添加技能" });
    expect(within(dialog).getByRole("button", { name: "添加 财报速读" })).toBeInTheDocument();
    // 内置技能不该出现在「已装技能」的添加面板里
    expect(within(dialog).queryByRole("button", { name: "添加 写作润色" })).not.toBeInTheDocument();
    // 加完之后面板自动关闭，卡片出现
    fireEvent.click(within(dialog).getByRole("button", { name: "添加 财报速读" }));
    expect(screen.queryByRole("dialog", { name: "添加技能" })).not.toBeInTheDocument();
    expect(within(group("已装技能")).getByText("1")).toBeInTheDocument();
  });
});
