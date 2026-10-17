import { describe, it, expect } from "vitest";
import {
  BUILTIN_SKILLS,
  SkillPool,
  formatSkillSection,
  parseImportText,
  parseSkillJson,
  parseSkillMarkdown,
  skillToMarkdown,
  MAX_POOL_CHARS,
  SKILLS_KEY,
  SKILL_BINDINGS_KEY,
  type SkillDefinition,
  type StorageLike,
} from "./index.js";

/** 每个用例独立的内存存储，避免用例间互相污染。 */
function makeStorage(): { storage: StorageLike; map: Map<string, string> } {
  const map = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
  return { storage, map };
}

/** 递增时钟：让 createdAt/updatedAt 有序，便于断言淘汰顺序。 */
function clock(start = Date.UTC(2026, 0, 1)): () => number {
  let t = start;
  return () => (t += 1000);
}

function freshPool(): {
  pool: SkillPool;
  storage: StorageLike;
  map: Map<string, string>;
} {
  const { storage, map } = makeStorage();
  return { pool: new SkillPool(storage, clock()), storage, map };
}

function createSkill(pool: SkillPool, name: string, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return pool.create({
    name,
    description: overrides.description ?? "",
    instructions: overrides.instructions ?? "默认正文",
    triggers: overrides.triggers ?? [],
    tags: overrides.tags ?? [],
    enabled: overrides.enabled ?? true,
    version: overrides.version ?? "1.0.0",
  });
}

const BUILTIN_IDS = [
  "builtin-memory-curator",
  "builtin-writing",
  "builtin-code-review",
  "builtin-meeting-notes",
];

describe("技能池 · 首启种子与容错", () => {
  it("首启写入 4 个内置技能并记录 seeded 标记", () => {
    const { pool, map } = freshPool();
    const skills = pool.list();
    expect(skills.map((s) => s.id)).toEqual(BUILTIN_IDS);
    expect(skills.every((s) => s.builtin && s.source === "builtin" && s.enabled)).toBe(true);
    const raw = JSON.parse(map.get(SKILLS_KEY) as string) as { seeded?: boolean };
    expect(raw.seeded).toBe(true);
  });

  it("再次构造同一 storage 不会重复种子（幂等）", () => {
    const { storage } = makeStorage();
    const first = new SkillPool(storage, clock());
    const second = new SkillPool(storage, clock());
    expect(first.list()).toHaveLength(4);
    expect(second.list()).toHaveLength(4);
  });

  it("内置技能长度符合设计上限（name ≤ 32 / description ≤ 200 / instructions ≤ 8000）", () => {
    for (const seed of BUILTIN_SKILLS) {
      expect(seed.name.length).toBeLessThanOrEqual(32);
      expect(seed.description.length).toBeLessThanOrEqual(200);
      expect(seed.instructions.length).toBeGreaterThan(0);
      expect(seed.instructions.length).toBeLessThanOrEqual(8000);
      expect(seed.triggers.length).toBeGreaterThan(0);
    }
  });

  it("删除内置技能后重建不复活", () => {
    const { storage } = makeStorage();
    const pool = new SkillPool(storage, clock());
    pool.remove("builtin-writing");
    const reopened = new SkillPool(storage, clock());
    expect(reopened.list().map((s) => s.id)).not.toContain("builtin-writing");
    expect(reopened.list()).toHaveLength(3);
  });

  it("技能键损坏 → 回退空池且不复活内置（不回退到种子）", () => {
    const { storage, map } = makeStorage();
    map.set(SKILLS_KEY, "{ 这不是 JSON");
    const pool = new SkillPool(storage, clock());
    expect(pool.list()).toEqual([]);
    createSkill(pool, "手工技能");
    expect(pool.list()).toHaveLength(1);
  });

  it("绑定键损坏 → 回退空绑定，不影响技能读取", () => {
    const { storage, map } = makeStorage();
    const pool = new SkillPool(storage, clock());
    map.set(SKILL_BINDINGS_KEY, "][");
    const reopened = new SkillPool(storage, clock());
    expect(reopened.list()).toHaveLength(4);
    expect(reopened.bindings("a1")).toEqual({ agentId: "a1", pinned: [], disabled: [] });
  });

  it("storage 写异常静默：不抛出，内存态仍可用", () => {
    const failing: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    const pool = new SkillPool(failing, clock());
    expect(pool.list()).toHaveLength(4);
    expect(() => createSkill(pool, "写入失败技能")).not.toThrow();
    expect(pool.list()).toHaveLength(5);
  });
});

describe("技能池 · CRUD 与绑定", () => {
  it("create/get/update/remove 完整闭环，update 保留 id 与 createdAt", () => {
    const { pool } = freshPool();
    const created = createSkill(pool, "翻译助手", { triggers: ["翻译"], tags: ["语言"] });
    expect(pool.list()).toHaveLength(5);
    expect(pool.get(created.id)?.name).toBe("翻译助手");

    const updated = pool.update(created.id, { name: "翻译润色", triggers: ["翻译", "笔译"] });
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.triggers).toEqual(["翻译", "笔译"]);
    expect(pool.get(created.id)?.name).toBe("翻译润色");

    pool.remove(created.id);
    expect(pool.get(created.id)).toBeUndefined();
    expect(pool.list()).toHaveLength(4);
  });

  it("update 未知 id 抛中文错误；exportOne 未知 id 同样抛错", () => {
    const { pool } = freshPool();
    expect(() => pool.update("nope", { name: "x" })).toThrow(/技能不存在/);
    expect(() => pool.exportOne("nope")).toThrow(/技能不存在/);
  });

  it("返回值为副本：外部改动不污染池内数据", () => {
    const { pool } = freshPool();
    const list = pool.list();
    list[0].name = "被改坏的名字";
    list[0].triggers.push("污染");
    expect(pool.list()[0].name).not.toBe("被改坏的名字");
    expect(pool.list()[0].triggers).not.toContain("污染");
  });

  it("setEnabled 关闭后路由不再命中（全局禁用过滤）", () => {
    const { pool } = freshPool();
    pool.setEnabled("builtin-code-review", false);
    expect(pool.get("builtin-code-review")?.enabled).toBe(false);
    const matches = pool.route({ query: "帮我审查这段代码" });
    expect(matches.map((m) => m.skill.id)).not.toContain("builtin-code-review");
  });

  it("绑定默认空、可持久化并被新实例读取；未知技能 id 被丢弃", () => {
    const { storage } = makeStorage();
    const pool = new SkillPool(storage, clock());
    expect(pool.bindings("agent-a")).toEqual({ agentId: "agent-a", pinned: [], disabled: [] });

    pool.setBinding("agent-a", { pinned: ["builtin-writing", "不存在"], disabled: ["builtin-code-review"] });
    const reopened = new SkillPool(storage, clock());
    expect(reopened.bindings("agent-a")).toEqual({
      agentId: "agent-a",
      pinned: ["builtin-writing"],
      disabled: ["builtin-code-review"],
    });
  });

  it("删除技能会同时从各智能体绑定中剔除", () => {
    const { pool } = freshPool();
    pool.setBinding("agent-a", { pinned: ["builtin-writing"], disabled: ["builtin-writing"] });
    pool.remove("builtin-writing");
    expect(pool.bindings("agent-a").pinned).toEqual([]);
    expect(pool.bindings("agent-a").disabled).toEqual([]);
  });
});

describe("技能池 · 路由", () => {
  it("中文查询命中对应技能并给出命中词理由", () => {
    const { pool } = freshPool();
    const matches = pool.route({ query: "帮我审查这段代码" });
    expect(matches[0].skill.id).toBe("builtin-code-review");
    expect(matches[0].reason).toContain("命中：");
    expect(matches[0].reason).toContain("代码");
    expect(matches[0].reason).toContain("审查");
    expect(matches[0].score).toBeGreaterThan(0);
  });

  it("ASCII 查询命中触发器（review）", () => {
    const { pool } = freshPool();
    const matches = pool.route({ query: "please review this patch" });
    expect(matches.map((m) => m.skill.id)).toContain("builtin-code-review");
  });

  it("中文标签命中：会议/待办 → 会议纪要", () => {
    const { pool } = freshPool();
    const ids = pool.route({ query: "把周会的待办整理出来" }).map((m) => m.skill.id);
    expect(ids).toContain("builtin-meeting-notes");
  });

  it("零命中返回空数组；空查询返回空数组", () => {
    const { pool } = freshPool();
    expect(pool.route({ query: "今天天气不错" })).toEqual([]);
    expect(pool.route({ query: "" })).toEqual([]);
  });

  it("自定义技能按字段权重排在前面", () => {
    const { pool } = freshPool();
    const custom = createSkill(pool, "翻译助手", {
      description: "把中英文本互译，保持术语一致",
      triggers: ["翻译", "笔译"],
      tags: ["语言"],
    });
    const matches = pool.route({ query: "帮我把这段英文翻译成中文" });
    expect(matches[0].skill.id).toBe(custom.id);
    // 权重最高的命中词排在最前（翻译 命中 name/triggers/tags，英文 仅命中 description）
    expect(matches[0].reason.startsWith("命中：翻译")).toBe(true);
  });

  it("pinned 先入且不受 top-K 限制（仍受预算约束）", () => {
    const { pool } = freshPool();
    pool.setBinding("agent-a", { pinned: ["builtin-meeting-notes"] });
    const matches = pool.route({ query: "帮我审查这段代码", agentId: "agent-a", topK: 1 });
    expect(matches).toHaveLength(2);
    expect(matches[0].skill.id).toBe("builtin-meeting-notes");
    expect(matches[0].reason).toBe("用户置顶");
    expect(matches[1].skill.id).toBe("builtin-code-review");
  });

  it("pinned 在零命中查询下也注入（不受分数为 0 的过滤约束）", () => {
    const { pool } = freshPool();
    pool.setBinding("agent-a", { pinned: ["builtin-writing"] });
    const matches = pool.route({ query: "", agentId: "agent-a" });
    expect(matches.map((m) => m.skill.id)).toEqual(["builtin-writing"]);
  });

  it("该智能体 disabled 的技能被过滤（其他智能体不受影响）", () => {
    const { pool } = freshPool();
    pool.setBinding("agent-a", { disabled: ["builtin-code-review"] });
    expect(pool.route({ query: "审查代码", agentId: "agent-a" })).toEqual([]);
    expect(pool.route({ query: "审查代码", agentId: "agent-b" }).map((m) => m.skill.id)).toContain(
      "builtin-code-review",
    );
  });

  it("topK 限制普通命中数量（默认 top3）", () => {
    const { pool } = freshPool();
    for (let i = 0; i < 5; i += 1) {
      createSkill(pool, `路由技能${i}`, { triggers: ["并发审查"], description: "并发审查专用" });
    }
    expect(pool.route({ query: "并发审查" }).length).toBe(3);
    expect(pool.route({ query: "并发审查", topK: 5 }).length).toBe(5);
  });

  it("usage 微增益：使用过的技能分数提升且幅度有限", () => {
    const { pool } = freshPool();
    const before = pool.route({ query: "润色一下" })[0];
    for (let i = 0; i < 3; i += 1) pool.recordUsage(before.skill.id);
    const after = pool.route({ query: "润色一下" })[0];
    expect(after.skill.id).toBe(before.skill.id);
    expect(after.score).toBeGreaterThan(before.score);
    expect(after.score).toBeLessThan(before.score * 1.3);
  });

  it("总注入预算：超预算的技能被丢弃，段落长度不超过 charBudget", () => {
    const { pool } = freshPool();
    const long = "预".repeat(300);
    createSkill(pool, "预算甲", { instructions: long, triggers: ["预算测试"] });
    createSkill(pool, "预算乙", { instructions: long, triggers: ["预算测试"] });

    const wide = pool.route({ query: "预算测试", charBudget: 1600 });
    expect(wide).toHaveLength(2);

    const narrow = pool.route({ query: "预算测试", charBudget: 500 });
    expect(narrow.length).toBeLessThan(wide.length);
    expect(formatSkillSection(narrow).length).toBeLessThanOrEqual(500);
  });

  it("pinned 超预算时截断正文而非整条丢弃", () => {
    const { pool } = freshPool();
    const pinned = createSkill(pool, "超长置顶", {
      instructions: "长".repeat(2000),
      triggers: ["置顶测试"],
    });
    pool.setBinding("agent-a", { pinned: [pinned.id] });
    const matches = pool.route({ query: "置顶测试", agentId: "agent-a", charBudget: 300 });
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toBe("用户置顶");
    expect(matches[0].skill.instructions.endsWith("…")).toBe(true);
    expect(formatSkillSection(matches).length).toBeLessThanOrEqual(300);
  });

  it("formatSkillSection：空匹配不注入标题，非空以 ## 已启用技能 开头", () => {
    expect(formatSkillSection([])).toBe("");
    const { pool } = freshPool();
    const section = formatSkillSection(pool.route({ query: "帮我审查这段代码" }));
    expect(section.startsWith("## 已启用技能")).toBe(true);
    expect(section).toContain("### 代码审查（命中：");
  });
});

describe("技能池 · SKILL.md 与 JSON 导入导出", () => {
  it("导出 SKILL.md 结构与设计一致（5 键 frontmatter + 正文）", () => {
    const { pool } = freshPool();
    const md = pool.exportOne("builtin-code-review");
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("name: 代码审查");
    expect(md).toContain("description: ");
    expect(md).toContain("version: 1.0.0");
    expect(md).toContain("triggers: [审查, 代码审查, review, 缺陷, 重构, 安全]");
    expect(md).toContain("tags: [代码, 工程]");
    expect(md).toContain("你在审查一段代码变更。");
  });

  it("SKILL.md 往返：同池导入按 name 更新，不新增", () => {
    const { pool } = freshPool();
    const created = createSkill(pool, "整理助手", {
      description: "整理成条目",
      instructions: "正文一\n正文二",
      triggers: ["整理", "归纳"],
      tags: ["记忆"],
      version: "2.1.0",
    });
    const md = pool.exportOne(created.id);
    const before = pool.list().length;

    const result = pool.importText(md);
    expect(result).toEqual({ added: 0, updated: 1 });
    expect(pool.list()).toHaveLength(before);
    const after = pool.get(created.id) as SkillDefinition;
    expect(after.description).toBe("整理成条目");
    expect(after.instructions).toBe("正文一\n正文二");
    expect(after.triggers).toEqual(["整理", "归纳"]);
    expect(after.tags).toEqual(["记忆"]);
    expect(after.version).toBe("2.1.0");
    expect(after.createdAt).toBe(created.createdAt);
  });

  it("新名字的 SKILL.md 导入记为 added，source 为 imported", () => {
    const { pool } = freshPool();
    const md = [
      "---",
      "name: 头脑风暴",
      "description: 生成候选方案",
      "version: 1.2.0",
      "triggers: [头脑风暴, brainstorm]",
      "tags: [创意]",
      "---",
      "",
      "先发散再收敛。",
    ].join("\n");
    expect(pool.importText(md)).toEqual({ added: 1, updated: 0 });
    const added = pool.list().find((s) => s.name === "头脑风暴") as SkillDefinition;
    expect(added.source).toBe("imported");
    expect(added.builtin).toBe(false);
    expect(added.triggers).toEqual(["头脑风暴", "brainstorm"]);
    expect(added.instructions).toBe("先发散再收敛。");
  });

  it("整池 JSON 导出后导入到已种子池：按 id 更新，计数正确", () => {
    const { pool } = freshPool();
    createSkill(pool, "私有技能", { triggers: ["私有"] });
    const bundle = pool.exportAll();
    const parsed = JSON.parse(bundle) as { version: number; skills: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.skills).toHaveLength(5);

    const { pool: target } = freshPool();
    // 4 个内置按 id 命中更新，私有技能为新增
    expect(target.importText(bundle)).toEqual({ added: 1, updated: 4 });
    expect(target.list()).toHaveLength(5);
    expect(target.list().find((s) => s.name === "私有技能")?.source).toBe("user");
  });

  it("整池 JSON 导入到空池（损坏回退态）：全部 added 且字段保真", () => {
    const { pool } = freshPool();
    const bundle = pool.exportAll();
    const { storage, map } = makeStorage();
    map.set(SKILLS_KEY, "坏数据");
    const empty = new SkillPool(storage, clock());
    expect(empty.list()).toEqual([]);
    expect(empty.importText(bundle)).toEqual({ added: 4, updated: 0 });
    expect(empty.list().map((s) => s.id).sort()).toEqual([...BUILTIN_IDS].sort());
    expect(empty.list()[0].builtin).toBe(true);
  });

  it("parseImportText 自动识别：SKILL.md / 单技能 JSON / 整池 JSON", () => {
    const md = "---\nname: 甲\ntriggers: [一, 二]\n---\n正文";
    expect(parseImportText(md)).toHaveLength(1);

    const single = JSON.stringify({ name: "乙", instructions: "正文", tags: ["x"] });
    expect(parseSkillJson(single)).toHaveLength(1);
    expect(parseImportText(single)).toHaveLength(1);

    const pool = JSON.stringify({ version: 1, skills: [{ name: "丙" }, { name: "丁" }] });
    expect(parseImportText(pool)).toHaveLength(2);
    expect(parseImportText(pool)[1].name).toBe("丁");
  });

  it("frontmatter 数组支持 [a, b] 与逗号串（含中文逗号、顿号）", () => {
    expect(parseSkillMarkdown("---\nname: 甲\ntriggers: [a, b]\n---\n正文").triggers).toEqual(["a", "b"]);
    expect(parseSkillMarkdown("---\nname: 甲\ntriggers: 会议, 纪要\n---\n正文").triggers).toEqual([
      "会议",
      "纪要",
    ]);
    expect(parseSkillMarkdown("---\nname: 甲\ntags: 代码，工程、文档\n---\n正文").tags).toEqual([
      "代码",
      "工程",
      "文档",
    ]);
    expect(parseSkillMarkdown("---\nname: 甲\ntriggers: []\n---\n正文").triggers).toEqual([]);
    expect(parseSkillMarkdown("---\nname: 甲\n---\n正文").triggers).toBeUndefined();
  });

  it("解析失败抛明确中文错误：空文本 / 非 SKILL.md 非 JSON / frontmatter 未闭合 / 缺 name", () => {
    expect(() => parseImportText("   ")).toThrow(/内容为空/);
    expect(() => parseImportText("随便一段话")).toThrow(/无法识别的导入内容/);
    expect(() => parseImportText("---\nname: 甲\n正文没闭合")).toThrow(/未闭合/);
    expect(() => parseImportText("---\ndescription: 只有描述\n---\n正文")).toThrow(/缺少 name/);
    expect(() => parseSkillMarkdown("name: 甲\n正文")).toThrow(/需以 --- 开头/);
  });

  it("JSON 解析失败与结构不符都给出具体提示", () => {
    expect(() => parseImportText('{"name": "甲", }')).toThrow(/JSON 解析失败/);
    expect(() => parseImportText('{"foo": 1}')).toThrow(/JSON 结构无法识别/);
    expect(() => parseImportText('{"version": 1, "skills": "x"}')).toThrow(/JSON 结构无法识别/);
    expect(() => parseImportText('[{"description": "缺名字"}]')).toThrow(/第 1 个技能缺少 name/);
  });

  it("导入失败不改动池内数据", () => {
    const { pool } = freshPool();
    const before = JSON.stringify(pool.list());
    expect(() => pool.importText("乱七八糟")).toThrow();
    expect(JSON.stringify(pool.list())).toBe(before);
  });

  it("skillToMarkdown 与 parseSkillMarkdown 往返保真", () => {
    const { pool } = freshPool();
    const skill = pool.get("builtin-writing") as SkillDefinition;
    const round = parseSkillMarkdown(skillToMarkdown(skill));
    expect(round.name).toBe(skill.name);
    expect(round.description).toBe(skill.description);
    expect(round.version).toBe(skill.version);
    expect(round.triggers).toEqual(skill.triggers);
    expect(round.tags).toEqual(skill.tags);
    expect(round.instructions).toBe(skill.instructions.trim());
  });
});

describe("技能池 · 配额守卫", () => {
  it("单键 JSON 超 1.2MB 时按最久未使用淘汰（内置同样可淘汰）", () => {
    const { pool, map } = freshPool();
    const huge = "大".repeat(450_000);
    createSkill(pool, "大技能A", { instructions: huge });
    createSkill(pool, "大技能B", { instructions: huge });
    createSkill(pool, "大技能C", { instructions: huge });

    const names = pool.list().map((s) => s.name);
    expect(names).not.toContain("大技能A"); // 最早创建（最久未使用）先淘汰
    expect(names).toContain("大技能B");
    expect(names).toContain("大技能C");
    expect((map.get(SKILLS_KEY) as string).length).toBeLessThanOrEqual(MAX_POOL_CHARS);
  });

  it("recordUsage 刷新使用时间，使技能免于被优先淘汰", () => {
    const { pool } = freshPool();
    const huge = "大".repeat(450_000);
    const a = createSkill(pool, "大技能A", { instructions: huge });
    createSkill(pool, "大技能B", { instructions: huge });
    pool.recordUsage(a.id); // A 变成最近使用
    createSkill(pool, "大技能C", { instructions: huge });

    const names = pool.list().map((s) => s.name);
    expect(names).toContain("大技能A");
  });

  it("淘汰技能时同步清理绑定并落盘", () => {
    const { pool, map } = freshPool();
    const huge = "大".repeat(450_000);
    const a = createSkill(pool, "大技能A", { instructions: huge });
    pool.setBinding("agent-a", { pinned: [a.id] });
    createSkill(pool, "大技能B", { instructions: huge });
    createSkill(pool, "大技能C", { instructions: huge });

    expect(pool.get(a.id)).toBeUndefined();
    expect(pool.bindings("agent-a").pinned).toEqual([]);
    const persisted = JSON.parse(map.get(SKILL_BINDINGS_KEY) as string) as Record<
      string,
      { pinned: string[] }
    >;
    expect(persisted["agent-a"].pinned).toEqual([]);
  });
});
