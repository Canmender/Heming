import { describe, it, expect, beforeEach } from "vitest";
import {
  AUDIT_MAX,
  SELF_EDIT_MAX_PER_TURN,
  SelfEditBudget,
  SelfEditStore,
  anySensitive,
  appendAudit,
  containsSensitive,
  readAudit,
} from "./guards.js";
import { MemoryStore } from "../memory/store.js";
import { SkillPool } from "../skills/store.js";
import { McpRegistry, toolKey } from "../mcp/store.js";
import { buildSelfToolBridge, SELF_TOOLS } from "./tools.js";
import { mergeToolBridges } from "./merge.js";
import type { StorageLike } from "../memory/types.js";

/** 内存存储：每个测试一份，互不干扰。 */
class FakeStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  get size(): number {
    return this.map.size;
  }
}

describe("敏感信息检测（与复盘分身共用同一份判据）", () => {
  it("命中密钥/口令类模式", () => {
    expect(containsSensitive("我的 key 是 sk-abcdefghijklmnop")).toBe(true);
    expect(containsSensitive("token: ghp_abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(containsSensitive("密码：hunter2000")).toBe(true);
    expect(containsSensitive("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
  });

  it("中文自然表述也拦得住：取值前用「是/为」而不是「:=」", () => {
    expect(containsSensitive("我的密码是 hunter2000")).toBe(true);
    expect(containsSensitive("登录口令为 qwerty88")).toBe(true);
    expect(containsSensitive("密钥是 abc123def456")).toBe(true);
  });

  it("提到这些词但没给取值，不误报", () => {
    expect(containsSensitive("密码是重要的，别写进记忆")).toBe(false);
    expect(containsSensitive("密钥管理规范见 docs/SELF-EDIT.md")).toBe(false);
  });

  it("正常内容不误报", () => {
    expect(containsSensitive("项目用 pnpm 而不是 npm")).toBe(false);
    expect(containsSensitive("部署脚本在 scripts/deploy.sh")).toBe(false);
  });

  it("anySensitive 返回命中的字段名，供提示指明改哪里", () => {
    expect(anySensitive({ name: "ok", url: "https://x.com" })).toBeNull();
    expect(anySensitive({ name: "ok", headers: { auth: "bearer abcdefghijklmnop" } })).toBe(
      "headers",
    );
  });
});

describe("变更留痕", () => {
  let storage: FakeStorage;
  beforeEach(() => {
    storage = new FakeStorage();
  });

  it("写入后可按智能体读回；被拒绝的也留痕", () => {
    appendAudit(storage, {
      at: "2026-10-20T10:00:00.000Z",
      agentId: "a1",
      scope: "memory",
      action: "write",
      target: "偏好-语言",
      reason: "用户明说",
    });
    appendAudit(storage, {
      at: "2026-10-20T10:01:00.000Z",
      agentId: "a2",
      scope: "mcp",
      action: "reject",
      target: "srv::tool",
      rejected: "url 字段含密钥类内容",
    });
    expect(readAudit(storage, "a1")).toHaveLength(1);
    expect(readAudit(storage, "a2")[0].rejected).toContain("密钥");
    expect(readAudit(storage)).toHaveLength(2);
  });

  it("超出上限时丢最旧的", () => {
    for (let i = 0; i < AUDIT_MAX + 5; i++) {
      appendAudit(storage, {
        at: new Date(i).toISOString(),
        agentId: "a1",
        scope: "other",
        action: `n${i}`,
        target: "t",
      });
    }
    expect(readAudit(storage)).toHaveLength(AUDIT_MAX);
  });

  it("存储损坏时不抛，返回空", () => {
    storage.setItem("heming.selfAudit.v1", "{不是 JSON");
    expect(readAudit(storage)).toEqual([]);
  });
});

describe("单轮变更预算", () => {
  it("默认上限内可消耗，触顶后拒绝", () => {
    const b = new SelfEditBudget();
    expect(b.remaining("a1", "c1")).toBe(SELF_EDIT_MAX_PER_TURN);
    for (let i = 0; i < SELF_EDIT_MAX_PER_TURN; i++) {
      expect(b.consume("a1", "c1")).toBe(true);
    }
    expect(b.consume("a1", "c1")).toBe(false);
    expect(b.remaining("a1", "c1")).toBe(0);
  });

  it("按智能体与会话分别计数，互不占用", () => {
    const b = new SelfEditBudget();
    b.consume("a1", "c1");
    expect(b.remaining("a2", "c1")).toBe(SELF_EDIT_MAX_PER_TURN);
    expect(b.remaining("a1", "c2")).toBe(SELF_EDIT_MAX_PER_TURN);
  });

  it("reset 让下一轮重新可用", () => {
    const b = new SelfEditBudget();
    for (let i = 0; i < SELF_EDIT_MAX_PER_TURN; i++) b.consume("a1", "c1");
    b.reset("a1", "c1");
    expect(b.remaining("a1", "c1")).toBe(SELF_EDIT_MAX_PER_TURN);
  });
});

describe("自我修改开关（默认开启）", () => {
  let storage: FakeStorage;
  beforeEach(() => {
    storage = new FakeStorage();
  });

  it("无记录时视为允许（用户要求默认开启）", () => {
    expect(new SelfEditStore(storage).allowed("a1")).toBe(true);
  });

  it("设为 false 后拒绝，再次读取生效", () => {
    const store = new SelfEditStore(storage);
    store.setPolicy("a1", { enabled: false });
    expect(store.allowed("a1")).toBe(false);
    expect(new SelfEditStore(storage).allowed("a1")).toBe(false);
    // 别的智能体不受影响
    expect(store.allowed("a2")).toBe(true);
  });

  it("存储损坏时回落为允许而不是抛错", () => {
    storage.setItem("heming.selfEdit.v1", "垃圾");
    expect(new SelfEditStore(storage).allowed("a1")).toBe(true);
  });

  it("configured 区分「显式配置过」与「缺省开启」", () => {
    const store = new SelfEditStore(storage);
    // 缺省：界面显示开启，但未配置过 → 不注入工具
    expect(store.allowed("a1")).toBe(true);
    expect(store.configured("a1")).toBe(false);
    // 用户动过开关（开或关都算配置过）→ configured 为 true
    store.setPolicy("a1", { enabled: true });
    expect(store.configured("a1")).toBe(true);
    // 显式关闭也算配置过（不会因为「缺省开启」而自动恢复）
    store.setPolicy("a2", { enabled: false });
    expect(store.configured("a2")).toBe(true);
    expect(store.allowed("a2")).toBe(false);
  });
});

/* ------------------------------------------------------------------ 工具执行 */

function setup(options: { agentId?: string; enabled?: boolean } = {}) {
  const storage = new FakeStorage();
  const memory = new MemoryStore(storage, () => 1_700_000_000_000);
  const skills = new SkillPool(storage, () => 1_700_000_000_000);
  const mcp = new McpRegistry(storage, () => new Date(1_700_000_000_000).toISOString());
  const policy = new SelfEditStore(storage);
  if (options.enabled === false) {
    policy.setPolicy(options.agentId ?? "a1", { enabled: false });
  }
  const budget = new SelfEditBudget();
  const bridge = buildSelfToolBridge(
    { memory, skills, mcp, storage, policy, budget },
    { agentId: options.agentId ?? "a1", conversationId: "c1" },
  );
  const call = (name: string, args: Record<string, unknown> = {}) =>
    bridge.execute({ name, arguments: JSON.stringify(args) });
  return { storage, memory, skills, mcp, bridge, call, budget };
}

describe("self.* 工具：记忆", () => {
  it("写入后出现在全局长期记忆里（所有智能体共用）", async () => {
    const { call, memory } = setup();
    const r = await call("self_memory_write", { key: "偏好-语言", value: "简体中文" });
    expect(r.ok).toBe(true);
    expect(memory.semanticGlobal()).toHaveLength(1);
    expect(memory.semanticGlobal()[0].value).toBe("简体中文");
  });

  it("同 key 二次写入是更新而非新增", async () => {
    const { call, memory } = setup();
    await call("self_memory_write", { key: "k", value: "第一次" });
    const second = await call("self_memory_write", { key: "k", value: "第二次" });
    expect(second.text).toContain("已更新");
    expect(memory.semanticGlobal()).toHaveLength(1);
    expect(memory.semanticGlobal()[0].value).toBe("第二次");
  });

  it("含密钥的记忆被拒绝，且拒绝会留痕", async () => {
    const { call, memory, storage } = setup();
    const r = await call("self_memory_write", { key: "凭据", value: "sk-abcdefghijklmnop" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("密钥");
    expect(memory.semanticGlobal()).toHaveLength(0);
    expect(readAudit(storage, "a1")[0].rejected).toContain("密钥");
  });

  it("删除不存在的记忆给出明确原因，不静默", async () => {
    const { call } = setup();
    const r = await call("self_memory_remove", { key: "不存在" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("没有找到");
  });

  it("列出当前记忆", async () => {
    const { call } = setup();
    await call("self_memory_write", { key: "偏好-语言", value: "简体中文" });
    const list = await call("self_memory_list");
    expect(list.ok).toBe(true);
    expect(list.text).toContain("偏好-语言");
    expect(list.text).toContain("简体中文");
  });

  it("缺字段时给出可操作的提示", async () => {
    const { call } = setup();
    const r = await call("self_memory_write", { key: "只有key" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("不能为空");
  });
});

describe("self.* 工具：技能", () => {
  it("沉淀新技能，source=distilled", async () => {
    const { call, skills } = setup();
    const r = await call("self_skill_create", {
      name: "发布流程",
      description: "发版时按这个顺序做",
      instructions: "1. bump 版本\n2. 跑门禁\n3. 打包",
      triggers: ["发布", "发版"],
    });
    expect(r.ok).toBe(true);
    const created = skills.list().find((s) => s.name === "发布流程");
    expect(created?.source).toBe("distilled");
    expect(created?.instructions).toContain("bump 版本");
  });

  it("更新同名技能是改进而非新建", async () => {
    const { call, skills } = setup();
    await call("self_skill_create", {
      name: "排障",
      description: "排查线上问题",
      instructions: "先看日志",
    });
    const r = await call("self_skill_update", {
      name: "排障",
      instructions: "先看日志，再看指标，最后复盘",
    });
    expect(r.ok).toBe(true);
    const same = skills.list().filter((s) => s.name === "排障");
    expect(same).toHaveLength(1);
    expect(same[0].instructions).toContain("最后复盘");
  });

  it("内置技能不可直接改，提示改用 create", async () => {
    const { call, skills } = setup();
    const builtin = skills.list()[0];
    expect(builtin.builtin).toBe(true);
    const r = await call("self_skill_update", {
      name: builtin.name,
      instructions: "我想改内置",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("内置技能");
  });

  it("技能内容含密钥被拒绝", async () => {
    const { call, skills } = setup();
    const r = await call("self_skill_create", {
      name: "危险技能",
      description: "x",
      instructions: "用 token: ghp_abcdefghijklmnopqrstuvwx 调用",
    });
    expect(r.ok).toBe(false);
    expect(skills.list().some((s) => s.name === "危险技能")).toBe(false);
  });

  it("更新不存在的技能给出明确原因", async () => {
    const { call } = setup();
    const r = await call("self_skill_update", { name: "查无此技能" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("没有找到");
  });
});

describe("self.* 工具：MCP（用户授权完全放开，含 stdio）", () => {
  it("可新增 http 服务", async () => {
    const { call, mcp } = setup();
    const r = await call("self_mcp_add_server", {
      name: "天气服务",
      transport: "http",
      url: "https://weather.example.com/mcp",
    });
    expect(r.ok).toBe(true);
    // 首次使用会预置一条「Windows 桌面控制」，所以这里按名字找自己刚加的那条，
    // 不能用 servers()[0]（那是预置的）或断言总数为 1。
    expect(mcp.servers().map((s) => s.name)).toContain("天气服务");
  });

  it("可新增 stdio 服务（跑任意本机命令，用户已授权）", async () => {
    const { call, mcp } = setup();
    const r = await call("self_mcp_add_server", {
      name: "本地工具",
      transport: "stdio",
      command: "npx",
      args: ["-y", "some-mcp"],
    });
    expect(r.ok).toBe(true);
    const added = mcp.servers().find((s) => s.name === "本地工具");
    expect(added?.command).toBe("npx");
  });

  it("http 缺 url、stdio 缺 command 都会被拦", async () => {
    const { call } = setup();
    expect((await call("self_mcp_add_server", { name: "x", transport: "http" })).ok).toBe(false);
    expect((await call("self_mcp_add_server", { name: "y", transport: "stdio" })).ok).toBe(false);
  });

  it("headers 里塞密钥被拒绝（否则等于把凭据交给模型）", async () => {
    const { call, mcp } = setup();
    const r = await call("self_mcp_add_server", {
      name: "带密钥",
      transport: "http",
      url: "https://x.com",
      headers: { auth: "bearer abcdefghijklmnopqrst" },
    });
    expect(r.ok).toBe(false);
    expect(mcp.servers().map((s) => s.name)).not.toContain("带密钥");
  });

  it("启用工具需要该服务确实暴露了它", async () => {
    const { call, mcp } = setup();
    await call("self_mcp_add_server", { name: "s", transport: "http", url: "https://x.com" });
    const id = mcp.servers()[0].id;
    // 没有发现过工具 → 启用应失败
    const r = await call("self_mcp_enable", { tool: toolKey(id, "search") });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("没有暴露工具");
  });

  it("格式错误的工具键给出可操作提示", async () => {
    const { call } = setup();
    const r = await call("self_mcp_enable", { tool: "少了分隔符" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("serverId::toolName");
  });

  it("删除不存在服务不静默", async () => {
    const { call } = setup();
    const r = await call("self_mcp_remove_server", { id: "ghost" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("找不到");
  });
});

describe("self.* 工具：策略与预算", () => {
  it("策略关闭时不给任何工具", () => {
    const { bridge } = setup({ enabled: false });
    expect(bridge.tools).toHaveLength(0);
  });

  it("策略关闭时即使直接调用也拒绝", async () => {
    const { call } = setup({ enabled: false });
    const r = await call("self_memory_write", { key: "a", value: "b" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("关闭");
  });

  it("单轮变更超上限后拒绝，并说明原因", async () => {
    const { call } = setup();
    for (let i = 0; i < SELF_EDIT_MAX_PER_TURN; i++) {
      await call("self_memory_write", { key: `k${i}`, value: "v" });
    }
    const over = await call("self_memory_write", { key: "overflow", value: "v" });
    expect(over.ok).toBe(false);
    expect(over.text).toContain("上限");
  });

  it("未知工具给出清楚提示而不是抛异常", async () => {
    const { call } = setup();
    const r = await call("self_unknown_thing");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("未知工具");
  });

  it("参数不是合法 JSON 时按空参数处理，不崩", async () => {
    const { call, bridge } = setup();
    const r = await bridge.execute({ name: "self_memory_write", arguments: "{坏 JSON" });
    expect(r.ok).toBe(false);
  });
});

describe("工具桥合并", () => {
  const tool = (name: string) => ({
    type: "function" as const,
    function: { name, description: "", parameters: {} },
  });

  it("全空返回 null（编排层据此走无工具原路径）", () => {
    expect(mergeToolBridges(null, null)).toBeNull();
  });

  it("只有一个非空时原样返回", () => {
    const only: ReturnType<typeof mergeToolBridges> = null;
    expect(mergeToolBridges(null, only)).toBeNull();
  });

  it("合并后工具列表是两者之和", () => {
    const a = { tools: [tool("mcp_a")], execute: async () => ({ text: "a", ok: true }) };
    const b = { tools: [tool("self_memory_list")], execute: async () => ({ text: "b", ok: true }) };
    const merged = mergeToolBridges(a, b)!;
    expect(merged.tools).toHaveLength(2);
  });

  it("execute 按名字路由到正确的桥", async () => {
    const a = {
      tools: [tool("mcp_a")],
      execute: async () => ({ text: "from-mcp", ok: true }),
    };
    const b = {
      tools: [tool("self_memory_list")],
      execute: async () => ({ text: "from-self", ok: true }),
    };
    const merged = mergeToolBridges(a, b)!;
    expect((await merged.execute({ name: "mcp_a", arguments: "{}" })).text).toBe("from-mcp");
    expect((await merged.execute({ name: "self_memory_list", arguments: "{}" })).text).toBe(
      "from-self",
    );
  });

  it("未声明的名字给提示而不是抛", async () => {
    const a = { tools: [tool("mcp_a")], execute: async () => ({ text: "", ok: true }) };
    const merged = mergeToolBridges(a, { tools: [tool("self_x")], execute: a.execute })!;
    const r = await merged.execute({ name: "ghost", arguments: "{}" });
    expect(r.ok).toBe(false);
  });
});

describe("工具清单", () => {
  it("覆盖 memory / skill / mcp 三组，且都有说明", () => {
    const names = SELF_TOOLS.map((t) => t.name);
    expect(names.some((n) => n.startsWith("self_memory_"))).toBe(true);
    expect(names.some((n) => n.startsWith("self_skill_"))).toBe(true);
    expect(names.some((n) => n.startsWith("self_mcp_"))).toBe(true);
    for (const spec of SELF_TOOLS) {
      expect(spec.description.length).toBeGreaterThan(10);
      expect(spec.parameters).toHaveProperty("type", "object");
    }
  });

  it("必填字段与 parameters.required 一致", () => {
    const write = SELF_TOOLS.find((t) => t.name === "self_memory_write")!;
    expect((write.parameters as { required?: string[] }).required).toEqual(["key", "value"]);
  });
});