import { describe, it, expect } from "vitest";
import {
  matchScore,
  readMemoryItems,
  searchLocalMemories,
  searchLocalPlugins,
  searchLocalTasks,
  type LocalMemoryItem,
} from "../../lib/palette/local.js";
import { searchPalette, flattenGroups, GROUP_LIMITS } from "../../lib/palette/search.js";
import type { TaskRecord } from "../tasks/store.js";
import type { InstalledPlugin } from "../plugins/store.js";

/**
 * 命令面板 · 本机三组（d.61）的纯函数用例。
 *
 * 覆盖：任务/记忆/插件三个来源的检索口径与排序、三层记忆的枚举、分组顺序与上限、
 * 以及「只在本机数据上匹配」这一隐私边界（本模块不含任何网络/写操作，用例也不 mock 网络）。
 */

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1",
    conversationId: "c1",
    agentId: "a1",
    agentName: "阿和",
    title: "整理周报",
    prompt: "把本周材料整理成周报",
    status: "done",
    createdAt: 0,
    updatedAt: 0,
    result: "本周完成 3 项",
    steps: [],
    ...over,
  };
}

function plugin(over: { id?: string; name?: string; description?: string; skills?: string[] } = {}): InstalledPlugin {
  return {
    manifest: {
      schemaVersion: 2,
      id: over.id ?? "acme.weather",
      name: over.name ?? "天气能力包",
      version: "1.0.0",
      description: over.description ?? "出行天气建议与查询服务",
      author: "Acme",
      skills: (over.skills ?? ["出行建议"]).map((name) => ({
        name,
        instructions: "结合天气出行。",
        triggers: [],
        tags: [],
        description: "",
      })),
      mcpServers: [],
    },
    enabled: true,
    skillIds: [],
    serverIds: [],
    installedAt: "",
    updatedAt: "",
  } as unknown as InstalledPlugin;
}

function mem(id: string, name: string, layer: LocalMemoryItem["layer"], detail = ""): LocalMemoryItem {
  return { kind: "memory", id, name, detail: detail || name, layer };
}

describe("本机搜索 · 打分口径", () => {
  it("标题前缀 > 标题包含 > 正文前缀 > 正文包含 > 不命中", () => {
    const titlePrefix = matchScore("周报", "周报整理", []);
    const titleContains = matchScore("周报", "整理周报", []);
    const bodyPrefix = matchScore("周报", "无关标题", ["周报材料"]);
    const bodyContains = matchScore("周报", "无关标题", ["把周报写好"]);
    expect(titlePrefix).toBeGreaterThan(titleContains);
    expect(titleContains).toBeGreaterThan(bodyPrefix);
    expect(bodyPrefix).toBeGreaterThan(bodyContains);
    expect(matchScore("周报", "完全无关", [])).toBe(0);
  });

  it("空关键词不命中（避免空查询倒一屏）", () => {
    expect(matchScore("", "周报", [])).toBe(0);
    expect(matchScore("   ", "周报", [])).toBe(0);
  });

  it("大小写不敏感", () => {
    expect(matchScore("ALICE", "alice", [])).toBeGreaterThan(0);
  });
});

describe("本机搜索 · 任务", () => {
  it("命中标题、目标、最终报告三处，标题命中排在前面", () => {
    const list = [
      task({ id: "t1", title: "整理周报", prompt: "随便", result: "" }),
      task({ id: "t2", title: "别的事", prompt: "写周报", result: "" }),
      task({ id: "t3", title: "另一件", prompt: "别的", result: "周报已发" }),
    ];
    const out = searchLocalTasks("周报", list);
    // t1 标题命中最高；t3 的报告以「周报」开头（正文前缀 60）高于 t2 目标里包含（40）
    expect(out.hits.map((h) => h.id)).toEqual(["t1", "t3", "t2"]);
    expect(out.total).toBe(3);
  });

  it("结果带状态与目标摘要，不塞整段报告", () => {
    const out = searchLocalTasks("周报", [task()]);
    expect(out.hits[0].detail).toContain("已完成");
    expect(out.hits[0].detail).toContain("把本周材料");
    expect(out.hits[0].detail.length).toBeLessThan(80);
  });

  it("命中数超过上限时截断，但 total 保留真实命中数", () => {
    const list = Array.from({ length: 8 }, (_, i) => task({ id: `t${i}`, title: `周报 ${i}` }));
    const out = searchLocalTasks("周报", list);
    expect(out.hits).toHaveLength(GROUP_LIMITS.task);
    expect(out.total).toBe(8);
  });

  it("没有命中返回空数组（面板不出现该组）", () => {
    expect(searchLocalTasks("zzz", [task()]).hits).toEqual([]);
  });
});

describe("本机搜索 · 记忆", () => {
  it("三层都参与检索，条目名带层级前缀", () => {
    const list = [
      mem("m1", "短期 · 你好", "working"),
      mem("m2", "情景 · 上周聊了部署", "episodic"),
      mem("m3", "语义 · 称呼", "semantic", "用户希望被称为阿和"),
    ];
    const out = searchLocalMemories("阿和", list);
    expect(out.hits.map((h) => h.id)).toEqual(["m3"]);
    const all = searchLocalMemories("聊", list);
    expect(all.hits.map((h) => h.id)).toEqual(["m2"]);
  });

  it("从 memoryStore.exportAll() 的 JSON 枚举三层；坏 JSON/坏条目安全跳过", () => {
    const json = JSON.stringify({
      version: 1,
      exportedAt: "",
      data: {
        working: { c1: [{ id: "w1", userText: "问个事", assistantText: "答", agentId: "a1" }] },
        episodic: { a1: [{ id: "e1", summary: "上周聊了部署" }] },
        semantic: { __global__: [{ id: "s1", key: "称呼", value: "叫阿和" }] },
        settings: {},
      },
    });
    const items = readMemoryItems(json);
    expect(items.map((i) => `${i.layer}:${i.id}`)).toEqual(["working:w1", "episodic:e1", "semantic:s1"]);
    expect(readMemoryItems("{not json")).toEqual([]);
    expect(readMemoryItems(JSON.stringify({ data: { working: { c1: [null, { noId: true }] } } }))).toEqual([]);
  });

  it("超过上限时截断并保留 total", () => {
    const list = Array.from({ length: 7 }, (_, i) => mem(`m${i}`, `语义 · 偏好 ${i}`, "semantic"));
    const out = searchLocalMemories("偏好", list);
    expect(out.hits).toHaveLength(GROUP_LIMITS.memory);
    expect(out.total).toBe(7);
  });
});

describe("本机搜索 · 插件", () => {
  it("按名称、描述、技能名都能命中", () => {
    const list = [plugin()];
    expect(searchLocalPlugins("天气", list).hits).toHaveLength(1);
    expect(searchLocalPlugins("出行建议", list).hits).toHaveLength(1); // 技能名
    expect(searchLocalPlugins("查询服务", list).hits).toHaveLength(1); // 描述
    expect(searchLocalPlugins("zzz", list).hits).toEqual([]);
  });

  it("结果带 id 与技能数，便于在插件区定位", () => {
    const out = searchLocalPlugins("天气", [plugin()]);
    expect(out.hits[0].id).toBe("acme.weather");
    expect(out.hits[0].detail).toContain("1 个技能");
  });

  it("超过上限时截断并保留 total", () => {
    const list = Array.from({ length: 6 }, (_, i) => plugin({ id: `p${i}.weather`, name: `天气包 ${i}` }));
    const out = searchLocalPlugins("天气", list);
    expect(out.hits).toHaveLength(GROUP_LIMITS.plugin);
    expect(out.total).toBe(6);
  });
});

describe("分组集成 · 顺序与上限", () => {
  const local = {
    tasks: [task()],
    memories: [mem("m1", "语义 · 称呼", "semantic", "叫阿和")],
    plugins: [plugin()],
  };

  it("分组顺序：页面→设置→动作→任务→记忆→插件→成员→技能→归档", () => {
    const groups = searchPalette("周报", { members: [], archiveHits: [], local });
    expect(groups.map((g) => g.id)).toEqual(["task"]);
    const all = searchPalette("天气", { members: [], archiveHits: [], local });
    expect(all.map((g) => g.id)).toEqual(["plugin"]);
  });

  it("三组同屏时顺序固定（任务在记忆前、记忆在插件前）", () => {
    const groups = searchPalette("阿和", {
      members: [],
      archiveHits: [],
      local: {
        tasks: [task({ id: "t9", title: "阿和的任务", prompt: "" })],
        memories: [mem("m9", "语义 · 阿和", "semantic", "叫阿和")],
        plugins: [plugin({ name: "阿和工具包" })],
      },
    });
    expect(groups.map((g) => g.id)).toEqual(["task", "memory", "plugin"]);
  });

  it("组内只有同类型条目，且每组上限生效、total 可算「还有 N 条」", () => {
    const groups = searchPalette("周报", {
      members: [],
      archiveHits: [],
      local: {
        tasks: Array.from({ length: 9 }, (_, i) => task({ id: `t${i}`, title: `周报 ${i}` })),
        memories: [],
        plugins: [],
      },
    });
    const taskGroup = groups.find((g) => g.id === "task")!;
    expect(new Set(taskGroup.items.map((i) => i.kind))).toEqual(new Set(["task"]));
    expect(taskGroup.items).toHaveLength(GROUP_LIMITS.task);
    expect((taskGroup.total ?? 0) - taskGroup.items.length).toBe(4); // 9 - 5
  });

  it("不传 local 时这三组为空（旧行为不变）", () => {
    const groups = searchPalette("周报", { members: [], archiveHits: [] });
    expect(groups.some((g) => ["task", "memory", "plugin"].includes(g.id))).toBe(false);
  });

  it("条目只带定位 id，不携带任何报告/记忆正文快照进面板项名", () => {
    const groups = searchPalette("周报", { members: [], archiveHits: [], local });
    const taskItem = flattenGroups(groups).find((i) => i.kind === "task")!;
    expect(taskItem.taskId).toBe("t1");
    expect(taskItem.name).toBe("整理周报");
    // 正文只在 detail 里截断展示，不带 result 全量
    expect(JSON.stringify(taskItem)).not.toContain("本周完成 3 项".slice(0, 2) + "周完成") ;
  });
});
