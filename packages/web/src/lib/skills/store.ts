import type {
  SkillBinding,
  SkillDefinition,
  SkillMatch,
  SkillUsage,
  StorageLike,
} from "./types.js";
import {
  MAX_POOL_CHARS,
  SKILLS_KEY,
  SKILL_BINDINGS_KEY,
  SKILL_ASSIGNMENTS_KEY,
  DEFAULT_ROUTE_BUDGET,
  DEFAULT_ROUTE_TOP_K,
} from "./types.js";
import { buildBuiltinSkills } from "./builtins.js";
import { routeSkills } from "./router.js";
import { parseImportText, skillToMarkdown } from "./markdown.js";

/** 技能名上限（与类型注释一致）；沉淀副本加后缀后仍需满足。 */
const MAX_SKILL_NAME = 32;
const DISTILL_SUFFIX = "（沉淀）";

/** 沉淀副本命名：加「（沉淀）」后缀并按 32 字截断原名，避免与原件并排时混淆。 */
function distilledName(name: string): string {
  const room = MAX_SKILL_NAME - DISTILL_SUFFIX.length;
  return `${name.length > room ? name.slice(0, room) : name}${DISTILL_SUFFIX}`;
}

/**
 * 技能池（设计 §5、§8）：技能与智能体绑定分两键存本机 localStorage。
 * 首启写入 4 个内置技能并记 `seeded: true`——删除后不再复活；
 * 读取损坏回退空池、写入异常静默，绝不影响聊天主链路。
 */

interface PoolData {
  version: 1;
  seeded: boolean;
  skills: SkillDefinition[];
  usage: Record<string, SkillUsage>;
}

function emptyPool(seeded: boolean): PoolData {
  return { version: 1, seeded, skills: [], usage: {} };
}

/** localStorage 不可用（隐私模式/无 DOM）时的内存兜底。 */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
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

function defaultStorage(): StorageLike {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch {
    // 个别环境访问 localStorage 本身即抛错 → 退回内存
  }
  return memoryStorage();
}

function newSkillId(): string {
  return `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function asStringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

function uniq(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

/** 单条技能的结构校验：字段缺失补默认值，无法识别时返回 null（当作不存在）。 */
function coerceSkill(raw: unknown, fallbackAt: string): SkillDefinition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!id || !name) return null;
  const source =
    r.source === "builtin" ||
    r.source === "user" ||
    r.source === "imported" ||
    r.source === "distilled"
      ? r.source
      : "user";
  return {
    id,
    name,
    description: typeof r.description === "string" ? r.description : "",
    instructions: typeof r.instructions === "string" ? r.instructions : "",
    triggers: asStringList(r.triggers),
    tags: asStringList(r.tags),
    enabled: r.enabled !== false,
    builtin: r.builtin === true,
    version: typeof r.version === "string" && r.version ? r.version : "1.0.0",
    source,
    pluginId: typeof r.pluginId === "string" && r.pluginId ? r.pluginId : undefined,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : fallbackAt,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : fallbackAt,
  };
}

function copySkill(skill: SkillDefinition): SkillDefinition {
  return { ...skill, triggers: [...skill.triggers], tags: [...skill.tags] };
}

export class SkillPool {
  private readonly storage: StorageLike;
  private readonly now: () => number;
  private data: PoolData;
  private bindingMap: Record<string, SkillBinding>;
  /** 智能体 → 已分配技能 id（无记录 = 默认内置全部分配）。 */
  private assignmentMap: Record<string, string[]>;

  constructor(storage?: StorageLike, now?: () => number) {
    this.storage = storage ?? defaultStorage();
    this.now = now ?? (() => Date.now());
    const raw = this.read(SKILLS_KEY);
    this.data = this.parsePool(raw);
    this.bindingMap = this.parseBindings(this.read(SKILL_BINDINGS_KEY));
    this.assignmentMap = this.parseAssignments(this.read(SKILL_ASSIGNMENTS_KEY));
    if (raw === null) {
      // 首启：写入内置技能并打 seeded 标记（此后删空也不复活）
      this.data = {
        version: 1,
        seeded: true,
        skills: buildBuiltinSkills(this.iso()),
        usage: {},
      };
      this.save();
    }
  }

  list(): SkillDefinition[] {
    return this.data.skills.map(copySkill);
  }

  /**
   * 重新读本机存储并重建内存态（安装事务回滚后必须调）。
   *
   * 为什么需要它：技能池只在构造期读一次存储，安装事务回滚只恢复了 localStorage，
   * 内存里仍留着「刚装进去的技能」——插件记录说没装、技能池却说有，界面就成了半装态。
   *
   * 与构造函数的唯一区别：**不重放首启种子**。回滚场景下存储里本来就有数据；
   * 若存储被清空（极端情况），重建为空池比「悄悄写回内置技能」更诚实。
   */
  reload(): void {
    this.data = this.parsePool(this.read(SKILLS_KEY));
    this.bindingMap = this.parseBindings(this.read(SKILL_BINDINGS_KEY));
    this.assignmentMap = this.parseAssignments(this.read(SKILL_ASSIGNMENTS_KEY));
  }

  get(id: string): SkillDefinition | undefined {
    const found = this.data.skills.find((s) => s.id === id);
    return found ? copySkill(found) : undefined;
  }

  create(
    input: Omit<SkillDefinition, "id" | "createdAt" | "updatedAt" | "builtin" | "source"> & {
      source?: SkillDefinition["source"];
    },
  ): SkillDefinition {
    const at = this.iso();
    const skill: SkillDefinition = {
      id: newSkillId(),
      name: input.name,
      description: input.description ?? "",
      instructions: input.instructions ?? "",
      triggers: asStringList(input.triggers),
      tags: asStringList(input.tags),
      enabled: input.enabled ?? true,
      builtin: false,
      version: input.version || "1.0.0",
      source: input.source ?? "user",
      pluginId: input.pluginId,
      createdAt: at,
      updatedAt: at,
    };
    this.data.skills.push(skill);
    this.save();
    return copySkill(skill);
  }

  update(id: string, patch: Partial<SkillDefinition>): SkillDefinition {
    const skill = this.data.skills.find((s) => s.id === id);
    if (!skill) throw new Error(`技能不存在：${id}`);
    const merged: SkillDefinition = {
      ...skill,
      ...patch,
      id: skill.id,
      createdAt: skill.createdAt,
      builtin: skill.builtin, // 内置标识不可由外部改写
      updatedAt: this.iso(),
    };
    merged.triggers = asStringList(patch.triggers ?? skill.triggers);
    merged.tags = asStringList(patch.tags ?? skill.tags);
    Object.assign(skill, merged);
    this.save();
    return copySkill(skill);
  }

  remove(id: string): void {
    this.data.skills = this.data.skills.filter((s) => s.id !== id);
    delete this.data.usage[id];
    this.dropFromBindings(id);
    this.save();
    this.saveBindings();
  }

  setEnabled(id: string, enabled: boolean): void {
    this.update(id, { enabled });
  }

  /**
   * 沉淀：把已验证好用的技能复制成 `source: "distilled"` 的独立条目（原件保留）。
   * - 副本名加「（沉淀）」后缀，便于与原技能并排区分；
   * - 副本默认启用：能被沉淀即视为已验证可用；
   * - 同名沉淀已存在时原地刷新内容（重复沉淀不会产生重复条目）。
   */
  distill(id: string): SkillDefinition {
    const src = this.data.skills.find((s) => s.id === id);
    if (!src) throw new Error(`技能不存在：${id}`);
    const name = distilledName(src.name);
    const existing = this.data.skills.find((s) => s.source === "distilled" && s.name === name);
    if (existing) {
      return this.update(existing.id, {
        description: src.description,
        instructions: src.instructions,
        triggers: [...src.triggers],
        tags: [...src.tags],
        version: src.version,
        enabled: true,
      });
    }
    return this.create({
      name,
      description: src.description,
      instructions: src.instructions,
      triggers: [...src.triggers],
      tags: [...src.tags],
      enabled: true,
      version: src.version,
      source: "distilled",
    });
  }

  /** 使用统计只读快照（技能池列表的「使用次数 / 最近使用」列）。 */
  usages(): Record<string, SkillUsage> {
    const out: Record<string, SkillUsage> = {};
    for (const [id, stat] of Object.entries(this.data.usage)) out[id] = { ...stat };
    return out;
  }

  /**
   * 该智能体已分配的技能 id（保持存储顺序，并过滤已被删除的技能）。
   * 没有显式记录时返回全部内置技能与插件技能 —— 新智能体开箱即可用，
   * 手工新建/导入的技能仍需显式分配。
   */
  assigned(agentId: string): string[] {
    const known = new Set(this.data.skills.map((s) => s.id));
    const saved = this.assignmentMap[agentId];
    if (saved) return uniq(saved).filter((id) => known.has(id));
    return this.data.skills
      .filter((s) => s.builtin || Boolean(s.pluginId))
      .map((s) => s.id);
  }

  /**
   * 把技能追加到所有已有显式分配记录的智能体（无记录者走默认分配，无需处理）。
   * 插件安装后调用：装完即可用，不必逐台手动分配。
   */
  assignToAllWithAssignments(skillIds: string[]): void {
    const known = new Set(this.data.skills.map((s) => s.id));
    const add = uniq(skillIds).filter((id) => known.has(id));
    if (add.length === 0) return;
    for (const agentId of Object.keys(this.assignmentMap)) {
      this.assignmentMap[agentId] = uniq([...this.assignmentMap[agentId], ...add]);
    }
    this.saveAssignments();
  }

  /** 给智能体分配一个技能（幂等；已分配则原样返回）。 */
  assign(agentId: string, skillId: string): string[] {
    if (!this.data.skills.some((s) => s.id === skillId)) return this.assigned(agentId);
    const next = uniq([...this.assigned(agentId), skillId]);
    this.assignmentMap[agentId] = next;
    this.saveAssignments();
    return next;
  }

  /** 取消分配（幂等）。 */
  unassign(agentId: string, skillId: string): string[] {
    const next = this.assigned(agentId).filter((id) => id !== skillId);
    this.assignmentMap[agentId] = next;
    this.saveAssignments();
    return next;
  }

  bindings(agentId: string): SkillBinding {
    const found = this.bindingMap[agentId];
    if (!found) return { agentId, pinned: [], disabled: [] };
    return { agentId, pinned: [...found.pinned], disabled: [...found.disabled] };
  }

  setBinding(agentId: string, patch: Partial<Omit<SkillBinding, "agentId">>): void {
    const current = this.bindings(agentId);
    const known = new Set(this.data.skills.map((s) => s.id));
    const keep = (items: string[]): string[] => uniq(items).filter((id) => known.has(id));
    this.bindingMap[agentId] = {
      agentId,
      pinned: patch.pinned ? keep(patch.pinned) : current.pinned,
      disabled: patch.disabled ? keep(patch.disabled) : current.disabled,
    };
    this.saveBindings();
  }

  /**
   * 路由：带 `agentId` 时只能命中**已分配**的技能（分配是真边界，不只是技能页展示）。
   * 没有分配记录时 `assigned()` 回落到全部内置技能，开箱即用语义不变。
   */
  route(input: {
    query: string;
    agentId?: string;
    topK?: number;
    charBudget?: number;
  }): SkillMatch[] {
    return routeSkills(
      {
        skills: this.data.skills,
        usage: this.data.usage,
        binding: input.agentId ? this.bindingMap[input.agentId] : undefined,
        allowed: input.agentId ? this.assigned(input.agentId) : undefined,
      },
      {
        query: input.query,
        topK: input.topK ?? DEFAULT_ROUTE_TOP_K,
        charBudget: input.charBudget ?? DEFAULT_ROUTE_BUDGET,
      },
    );
  }

  recordUsage(id: string): void {
    if (!this.data.skills.some((s) => s.id === id)) return;
    const prev = this.data.usage[id];
    this.data.usage[id] = { count: (prev?.count ?? 0) + 1, at: this.iso() };
    this.save();
  }

  /** 单技能导出为 SKILL.md。 */
  exportOne(id: string): string {
    const skill = this.data.skills.find((s) => s.id === id);
    if (!skill) throw new Error(`技能不存在：${id}`);
    return skillToMarkdown(skill);
  }

  /** 整池导出为 JSON bundle（`{ version: 1, skills: [...] }`）。 */
  exportAll(): string {
    return JSON.stringify({ version: 1, skills: this.data.skills }, null, 2);
  }

  /** 导入 SKILL.md / 单技能 JSON / 整池 JSON；解析失败抛中文错误。 */
  importText(text: string): { added: number; updated: number } {
    const parsed = parseImportText(text);
    let added = 0;
    let updated = 0;
    for (const item of parsed) {
      const existing = item.id
        ? this.data.skills.find((s) => s.id === item.id)
        : this.data.skills.find((s) => s.name === item.name);
      if (existing) {
        existing.description = item.description ?? existing.description;
        existing.instructions = item.instructions || existing.instructions;
        if (item.triggers) existing.triggers = [...item.triggers];
        if (item.tags) existing.tags = [...item.tags];
        if (item.version) existing.version = item.version;
        if (item.enabled !== undefined) existing.enabled = item.enabled;
        if (item.source) existing.source = item.source;
        existing.updatedAt = this.iso();
        updated += 1;
      } else {
        const at = item.createdAt ?? this.iso();
        this.data.skills.push({
          id: item.id ?? newSkillId(),
          name: item.name,
          description: item.description ?? "",
          instructions: item.instructions,
          triggers: [...(item.triggers ?? [])],
          tags: [...(item.tags ?? [])],
          enabled: item.enabled ?? true,
          builtin: item.builtin === true,
          version: item.version || "1.0.0",
          source: item.source ?? "imported",
          createdAt: at,
          updatedAt: item.updatedAt ?? at,
        });
        added += 1;
      }
    }
    if (added > 0 || updated > 0) this.save();
    return { added, updated };
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private read(key: string): string | null {
    try {
      return this.storage.getItem(key);
    } catch {
      return null; // 读异常按「无数据」处理
    }
  }

  private write(key: string, value: string): void {
    try {
      this.storage.setItem(key, value);
    } catch {
      // 写失败静默：配额/隐私模式下不影响内存态与主链路
    }
  }

  private parsePool(raw: string | null): PoolData {
    if (raw === null) return emptyPool(false);
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad");
      const obj = parsed as Record<string, unknown>;
      if (!Array.isArray(obj.skills)) throw new Error("bad");
      const at = this.iso();
      const skills: SkillDefinition[] = [];
      for (const item of obj.skills) {
        const skill = coerceSkill(item, at);
        if (skill && !skills.some((s) => s.id === skill.id)) skills.push(skill);
      }
      const usage: Record<string, SkillUsage> = {};
      const rawUsage = obj.usage;
      if (rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)) {
        for (const [id, value] of Object.entries(rawUsage as Record<string, unknown>)) {
          const u = value as Partial<SkillUsage> | null;
          if (u && typeof u === "object" && typeof u.count === "number") {
            usage[id] = { count: u.count, at: typeof u.at === "string" ? u.at : at };
          }
        }
      }
      return { version: 1, seeded: obj.seeded === true, skills, usage };
    } catch {
      // 损坏数据回退空池：标记 seeded，避免误判为首启而复活内置技能
      return emptyPool(true);
    }
  }

  private parseAssignments(raw: string | null): Record<string, string[]> {
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string[]> = {};
      for (const [agentId, ids] of Object.entries(parsed as Record<string, unknown>)) {
        if (!agentId || !Array.isArray(ids)) continue;
        out[agentId] = uniq(ids.filter((id): id is string => typeof id === "string"));
      }
      return out;
    } catch {
      return {};
    }
  }

  private saveAssignments(): void {
    this.write(SKILL_ASSIGNMENTS_KEY, JSON.stringify(this.assignmentMap));
  }

  private parseBindings(raw: string | null): Record<string, SkillBinding> {
    if (raw === null) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, SkillBinding> = {};
      for (const [agentId, value] of Object.entries(parsed as Record<string, unknown>)) {
        const v = value as Partial<SkillBinding> | null;
        out[agentId] = {
          agentId,
          pinned: uniq(asStringList(v?.pinned)),
          disabled: uniq(asStringList(v?.disabled)),
        };
      }
      return out;
    } catch {
      return {};
    }
  }

  private save(): void {
    const evicted = this.evictToQuota();
    this.write(SKILLS_KEY, JSON.stringify(this.data));
    // 淘汰会顺带清理绑定，需同步落盘，避免下次读取出现悬空 id
    if (evicted) this.saveBindings();
  }

  private saveBindings(): void {
    this.write(SKILL_BINDINGS_KEY, JSON.stringify(this.bindingMap));
  }

  /** 单键 JSON 超 1.2MB → 按「最久未使用」淘汰（内置技能同样可淘汰）。返回是否发生淘汰。 */
  private evictToQuota(): boolean {
    let evicted = false;
    let serialized = JSON.stringify(this.data);
    while (serialized.length > MAX_POOL_CHARS && this.data.skills.length > 0) {
      let victim = 0;
      let victimKey = this.usageKey(this.data.skills[0]);
      for (let i = 1; i < this.data.skills.length; i += 1) {
        const key = this.usageKey(this.data.skills[i]);
        if (key < victimKey) {
          victim = i;
          victimKey = key;
        }
      }
      const [removed] = this.data.skills.splice(victim, 1);
      delete this.data.usage[removed.id];
      this.dropFromBindings(removed.id);
      evicted = true;
      serialized = JSON.stringify(this.data);
    }
    return evicted;
  }

  private usageKey(skill: SkillDefinition): string {
    return this.data.usage[skill.id]?.at ?? skill.updatedAt;
  }

  private dropFromBindings(skillId: string): void {
    for (const [agentId, binding] of Object.entries(this.bindingMap)) {
      this.bindingMap[agentId] = {
        agentId,
        pinned: binding.pinned.filter((id) => id !== skillId),
        disabled: binding.disabled.filter((id) => id !== skillId),
      };
    }
  }
}
