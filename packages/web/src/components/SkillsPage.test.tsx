import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { SkillsPage, SkillsView, categorizeSkill, SOURCE_LABEL, SKILL_TEMPLATES } from "./SkillsPage.js";
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
    expect(screen.getByRole("tab", { name: "按智能体" })).toHaveAttribute("aria-selected", "true");
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
    // d.65：内置技能的来源徽标改为「系统：<系统能力名>」（非按钮、不可点）。
    // 徽标拆成两个文本节点，这里断言整段文案，来源分类本身不变。
    expect(
      within(screen.getByRole("row", { name: /记忆整理/ })).getByText("：系统能力", { exact: false }),
    ).toBeInTheDocument();
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

  it("搜索框在页头，并且同样过滤分组视图", async () => {
    pool.importText(SKILL_MD);
    const imported = pool.list().find((s) => s.name === "财报速读")!;
    pool.assign("a1", imported.id);
    await renderReady();

    // 搜索框不属于任何分组卡（此前埋在「技能池」面板里）
    const search = screen.getByLabelText("搜索技能");
    expect(search.closest('[role="region"]')).toBeNull();

    fireEvent.change(search, { target: { value: "现金流" } });
    expect(
      within(group("已装技能")).getByRole("group", { name: "技能卡 财报速读" }),
    ).toBeInTheDocument();
    // 不匹配的内置技能从分组里消失，并给出「没有匹配」而不是「还没有这类技能」
    expect(
      within(group("内置技能")).queryByRole("group", { name: "技能卡 记忆整理" }),
    ).not.toBeInTheDocument();
    expect(within(group("内置技能")).getByText("没有匹配「现金流」的技能")).toBeInTheDocument();
  });

  it("技能卡操作区常显（弱化而非 hover 才出现）", async () => {
    await renderReady();
    const card = within(group("内置技能")).getByRole("group", { name: "技能卡 记忆整理" });
    const remove = within(card).getByRole("button", { name: "移除 记忆整理" });
    const bar = remove.parentElement as HTMLElement;
    expect(bar.className).not.toContain("opacity-0");
    expect(bar.className).toContain("opacity-70");
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

    fireEvent.click(screen.getByRole("tab", { name: "按智能体" }));
    expect(within(group("沉淀技能")).getByText("1")).toBeInTheDocument();
  });

  it("导入 SKILL.md 后可用 ＋ 把它加进已装技能组", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));

    fireEvent.click(screen.getByRole("button", { name: "导入 SKILL.md" }));
    fireEvent.change(screen.getByLabelText("导入技能内容"), { target: { value: SKILL_MD } });
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));

    expect(screen.getByRole("status")).toHaveTextContent("导入完成：新增 1 个，更新 0 个");

    fireEvent.click(screen.getByRole("tab", { name: "按智能体" }));
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

  it("删除技能要二次确认：取消不删，确认后从技能池移除", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));
    fireEvent.click(screen.getByRole("button", { name: "导入 SKILL.md" }));
    fireEvent.change(screen.getByLabelText("导入技能内容"), { target: { value: SKILL_MD } });
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));

    const remove = await screen.findByRole("button", { name: "池中删除 财报速读" });

    fireEvent.click(remove);
    const dialog = screen.getByRole("dialog", { name: "删除技能" });
    expect(within(dialog).getByText(/此操作不可恢复/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(pool.list().some((k) => k.name === "财报速读")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "池中删除 财报速读" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "删除技能" })).getByRole("button", {
        name: "删除",
      }),
    );
    expect(pool.list().some((k) => k.name === "财报速读")).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent("已删除技能：财报速读");
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

/* ------------------------------------------- 新建技能（d.68 简化流程） */

describe("SkillsPage 新建技能（简化）", () => {
  it("3 个模板只填空字段；必填只有名称与内容，缺了会指到具体字段", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));
    fireEvent.click(screen.getByRole("button", { name: "新建技能" }));

    const dialog = screen.getByRole("dialog", { name: "新建技能" });
    expect(within(dialog).getAllByRole("button", { name: /^使用模板 / })).toHaveLength(3);

    fireEvent.click(within(dialog).getByRole("button", { name: "使用模板 写作润色" }));
    const writing = SKILL_TEMPLATES.find((tpl) => tpl.key === "writing")!;
    const nameInput = within(dialog).getByLabelText("技能名称");
    const contentInput = within(dialog).getByLabelText("技能内容");
    expect(nameInput).toHaveValue(writing.name);
    expect(contentInput).toHaveValue(writing.instructions);

    // 已输入的名称不被覆盖；换模板也不覆盖已填的内容
    fireEvent.change(nameInput, { target: { value: "我的润色" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "使用模板 会议纪要" }));
    expect(within(dialog).getByLabelText("技能名称")).toHaveValue("我的润色");
    expect(within(dialog).getByLabelText("技能内容")).toHaveValue(writing.instructions);

    // 必填清空后提交：分别提示名称与内容，且不写库
    fireEvent.change(within(dialog).getByLabelText("技能名称"), { target: { value: "" } });
    fireEvent.change(within(dialog).getByLabelText("技能内容"), { target: { value: "   " } });
    const before = pool.list().length;
    fireEvent.click(within(dialog).getByRole("button", { name: "创建技能" }));
    expect(within(dialog).getByText("请给技能起个名字")).toBeInTheDocument();
    expect(within(dialog).getByText(/技能内容不能为空/)).toBeInTheDocument();
    expect(pool.list()).toHaveLength(before);
    expect(screen.getByRole("dialog", { name: "新建技能" })).toBeInTheDocument();
  });

  it("创建后自动分配给当前智能体，自定义技能组里直接可见", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));
    fireEvent.click(screen.getByRole("button", { name: "新建技能" }));

    const dialog = screen.getByRole("dialog", { name: "新建技能" });
    fireEvent.change(within(dialog).getByLabelText("技能名称"), {
      target: { value: "周报润色" },
    });
    fireEvent.change(within(dialog).getByLabelText("技能描述"), {
      target: { value: "把周报改得更短、更像人写的" },
    });
    fireEvent.change(within(dialog).getByLabelText("技能内容"), {
      target: { value: "你在帮我润色周报。\n1. 先删掉套话。\n2. 保留数字与结论。" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建技能" }));

    expect(screen.queryByRole("dialog", { name: "新建技能" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已新建技能「周报润色」");
    expect(screen.getByRole("status")).toHaveTextContent("和鸣助手");

    const created = pool.list().find((skill) => skill.name === "周报润色");
    expect(created).toBeDefined();
    expect(created?.source).toBe("user");
    expect(created?.instructions).toContain("润色周报");
    // 自动分配：否则「建好了却不会用于对话」是新手最容易踩的坑
    expect(pool.assigned("a1")).toContain(created?.id);

    fireEvent.click(screen.getByRole("tab", { name: "按智能体" }));
    expect(
      within(group("自定义技能")).getByRole("group", { name: "技能卡 周报润色" }),
    ).toBeInTheDocument();
  });

  it("新建技能后触发 onChanged，宿主（插件区）统计能同帧刷新", async () => {
    const onChanged = vi.fn();
    render(<SkillsPage skills={pool} onChanged={onChanged} />);
    await waitFor(() =>
      expect((screen.getByLabelText("选择智能体") as HTMLSelectElement).value).toBe("a1"),
    );
    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));
    fireEvent.click(screen.getByRole("button", { name: "新建技能" }));

    const dialog = screen.getByRole("dialog", { name: "新建技能" });
    fireEvent.change(within(dialog).getByLabelText("技能名称"), {
      target: { value: "自检刷新技能" },
    });
    fireEvent.change(within(dialog).getByLabelText("技能内容"), {
      target: { value: "自检用：验证宿主统计刷新。" },
    });
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "创建技能" }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("技能池空态：动作直达「新建技能」「导入 SKILL.md」", async () => {
    map.set(SKILLS_KEY, JSON.stringify({ version: 1, seeded: true, skills: [], usage: {} }));
    pool = new SkillPool(makeStorage(map), () => T0);
    await renderReady();
    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));

    expect(screen.getByText("技能池还是空的")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建技能" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "导入 SKILL.md" }));
    expect(screen.getByLabelText("导入技能内容")).toBeInTheDocument();

    // 新建入口同样直达弹窗
    fireEvent.click(screen.getByRole("button", { name: "新建技能" }));
    expect(screen.getByRole("dialog", { name: "新建技能" })).toBeInTheDocument();
  });

  it("把「未分配的技能不会用于对话」写清楚（按智能体视图与技能池各一处）", async () => {
    await renderReady();
    expect(
      screen.getByText(/只有已分配的技能才会用于「和鸣助手」的对话/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));
    expect(
      screen.getByText(/需要「启用」并「分配给对应智能体」/),
    ).toBeInTheDocument();
  });
});


describe("SkillsView 嵌入视图", () => {
  it("去掉 PageShell 与页面标题，保留智能体分配、技能池、搜索与来源徽标", async () => {
    const { container } = render(<SkillsView skills={pool} />);
    // 嵌入后由宿主页提供唯一的页面标题
    expect(container.querySelector("h1")).toBeNull();

    const select = (await screen.findByLabelText("选择智能体")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("a1"));
    expect(screen.getByRole("tab", { name: "按智能体" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "技能池" })).toBeInTheDocument();
    expect(screen.getByLabelText("搜索技能")).toBeInTheDocument();
    // 内置技能默认分配给第一个智能体，来源徽标仍是「内置：<系统能力名>」
    const card = within(group("内置技能")).getByRole("group", { name: "技能卡 记忆整理" });
    expect(within(card).getByText("：系统能力", { exact: false })).toBeInTheDocument();

    // 子页签照常可用
    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));
    expect(screen.getByRole("row", { name: /记忆整理/ })).toBeInTheDocument();
  });
});
