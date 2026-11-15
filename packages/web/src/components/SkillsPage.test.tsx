import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import {
  SkillsPage,
  SkillsView,
  categorizeSkill,
  SOURCE_LABEL,
  SKILL_TEMPLATES,
} from "./SkillsPage.js";
import { SkillPool, SKILLS_KEY, BUILTIN_SKILLS, type StorageLike } from "../lib/skills/index.js";

/**
 * 技能区 UI 用例（d.148.4.95 单一列表版）：
 * 全部跑真实 lib/skills 的 SkillPool，只注入独立内存存储，用例之间零污染；
 * 分类映射走导出的纯函数 categorizeSkill。
 *
 * 这一版去掉了多智能体时代的「已分配 / 技能池」两页签与全部「分配」动作：
 * 技能只有「启用 / 停用」，启用后对话时自动匹配。
 */

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

/** 渲染并等「本机技能」列表视图就绪。 */
async function renderReady() {
  const r = renderPage();
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "本机技能" })).toHaveAttribute(
      "aria-selected",
      "true",
    ),
  );
  return r;
}

function group(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

function card(name: string): HTMLElement {
  return screen.getByRole("group", { name: `技能卡 ${name}` });
}

describe("SkillsPage 技能区（单一列表）", () => {
  it("页签键盘可达：整组一个 Tab 停靠点，←/→ 在「本机技能 / 社区」间切换并移动焦点", async () => {
    await renderReady();
    const list = screen.getByRole("tablist", { name: "技能视图" });
    const localTab = within(list).getByRole("tab", { name: "本机技能" });
    const hubTab = within(list).getByRole("tab", { name: "社区" });

    expect(localTab).toHaveAttribute("tabindex", "0");
    expect(hubTab).toHaveAttribute("tabindex", "-1");

    localTab.focus();
    fireEvent.keyDown(localTab, { key: "ArrowRight" });
    expect(hubTab).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(hubTab);
    expect(document.getElementById("skill-hub-panel")).not.toBeNull();

    fireEvent.keyDown(hubTab, { key: "ArrowLeft" });
    expect(localTab).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(localTab);
  });

  it("默认就是本机技能单列表：四类分组、内置技能、计数与搜索都在，没有分配页签", async () => {
    await renderReady();

    expect(screen.getByRole("heading", { name: "技能区" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "本机技能" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "社区" })).toHaveAttribute("aria-selected", "false");

    // 多智能体时代的分配页签/入口已删除。
    expect(screen.queryByRole("tab", { name: "已分配" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "技能池" })).toBeNull();
    expect(screen.queryByText(/分配给「和鸣」/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^为.*添加技能$/ })).toBeNull();

    // 首启种子内置技能全在「内置技能」组里。
    expect(
      within(group("内置技能")).getByText(String(BUILTIN_SKILLS.length)),
    ).toBeInTheDocument();
    expect(within(group("内置技能")).getByRole("group", { name: "技能卡 记忆整理" })).toBeInTheDocument();

    for (const title of ["已装技能", "沉淀技能", "自定义技能"]) {
      expect(within(group(title)).getByText("0")).toBeInTheDocument();
    }
    expect(
      within(group("沉淀技能")).getByText(/暂无沉淀技能/),
    ).toBeInTheDocument();

    // 页头只讲「启用后生效」，不再提分配。
    expect(
      screen.getByText(
        `技能启用后即在对话里生效；共 ${BUILTIN_SKILLS.length} 个 · 已启用 ${BUILTIN_SKILLS.length} 个`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("搜索技能")).toBeInTheDocument();
    expect(screen.getByText("搜索同时作用于名称、描述与标签")).toBeInTheDocument();

    // 自我优化卡已从页面移除（功能改为系统内部默认开启）。
    expect(screen.queryByText(/允许自我优化/)).toBeNull();
  });

  it("categorizeSkill 把四种来源映射为四类分组，模板保留三个", () => {
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

    expect(SKILL_TEMPLATES.map((item) => item.label)).toEqual(["写作润色", "代码审查", "会议纪要"]);
  });

  it("搜索按名称、描述、标签过滤；无结果时给出提示", async () => {
    await renderReady();
    const search = screen.getByLabelText("搜索技能");

    fireEvent.change(search, { target: { value: "记忆" } });
    expect(screen.getByText("匹配 1 个")).toBeInTheDocument();
    expect(within(group("内置技能")).getByRole("group", { name: "技能卡 记忆整理" })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "财报" } });
    expect(screen.getByText("匹配 0 个")).toBeInTheDocument();
    expect(screen.getByText("没有匹配「财报」的技能")).toBeInTheDocument();
  });

  it("内置技能不可删，启用开关直接写回技能池", async () => {
    await renderReady();
    const builtinCard = card("记忆整理");

    expect(within(builtinCard).getByText("内置不可删")).toBeInTheDocument();
    expect(within(builtinCard).queryByRole("button", { name: "删除 记忆整理" })).toBeNull();

    const toggle = within(builtinCard).getByRole("switch", { name: "启用 记忆整理" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(pool.list().find((skill) => skill.name === "记忆整理")?.enabled).toBe(false);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("导入 SKILL.md：进「已装技能」组并可打开详情", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "导入 SKILL.md" }));
    fireEvent.change(screen.getByLabelText("导入技能内容"), { target: { value: SKILL_MD } });
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));

    expect(screen.getByRole("status")).toHaveTextContent("导入完成：新增 1 个，更新 0 个");
    expect(within(group("已装技能")).getByText("1")).toBeInTheDocument();
    const imported = card("财报速读");
    expect(within(imported).getByText(/已装/)).toBeInTheDocument();

    fireEvent.click(within(imported).getByRole("button", { name: "详情 财报速读" }));
    expect(screen.getByRole("dialog", { name: "技能详情 财报速读" })).toBeInTheDocument();
  });

  it("删除技能要二次确认：取消不删，确认后从列表移除", async () => {
    pool.importText(SKILL_MD);
    await renderReady();

    fireEvent.click(within(card("财报速读")).getByRole("button", { name: "删除 财报速读" }));
    let dialog = screen.getByRole("dialog", { name: "删除技能" });
    expect(within(dialog).queryByText(/分配记录/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "删除技能" })).toBeNull();
    expect(card("财报速读")).toBeInTheDocument();

    fireEvent.click(within(card("财报速读")).getByRole("button", { name: "删除 财报速读" }));
    dialog = screen.getByRole("dialog", { name: "删除技能" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    expect(screen.getByRole("status")).toHaveTextContent("已删除技能：财报速读");
    expect(screen.queryByRole("group", { name: "技能卡 财报速读" })).toBeNull();
  });

  it("新建技能可用模板填好空字段，创建后进「自定义技能」且无需分配", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "新建技能" }));
    const dialog = screen.getByRole("dialog", { name: "新建技能" });

    fireEvent.click(within(dialog).getByRole("button", { name: "使用模板 写作润色" }));
    expect(within(dialog).getByLabelText("技能名称")).toHaveValue("写作润色");
    expect(within(dialog).getByText(/已套用「写作润色」/)).toBeInTheDocument();

    // 模板名与内置技能同名：改个名字，避免「技能卡 写作润色」二义。
    fireEvent.change(within(dialog).getByLabelText("技能名称"), {
      target: { value: "周报润色" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建技能" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "已新建技能「周报润色」；对话时就会按需匹配。",
    );
    expect(within(group("自定义技能")).getByText("1")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "技能卡 周报润色" })).toBeInTheDocument();
    expect(screen.queryByText(/分配给/)).toBeNull();
  });

  it("技能为空时给出单一空态与两个出口", async () => {
    map.set(SKILLS_KEY, JSON.stringify({ version: 1, seeded: true, skills: [], usage: {} }));
    const empty = new SkillPool(makeStorage(map), () => T0);
    render(<SkillsView skills={empty} />);

    expect(screen.getByText("还没有任何技能")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建技能" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入 SKILL.md" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "内置技能" })).toBeNull();
    expect(screen.getByText(/共 0 个 · 已启用 0 个/)).toBeInTheDocument();
  });

  it("嵌入式 SkillsView 无 h1；旧外壳仍保留「技能区」标题", async () => {
    const { unmount } = render(<SkillsView skills={pool} />);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByRole("tab", { name: "本机技能" })).toBeInTheDocument();
    unmount();

    renderPage();
    expect(screen.getByRole("heading", { name: "技能区" })).toBeInTheDocument();
  });
});
