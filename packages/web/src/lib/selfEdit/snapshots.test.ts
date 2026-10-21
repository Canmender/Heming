import { describe, it, expect } from "vitest";
import { MemoryStore } from "../memory/store.js";
import { SkillPool } from "../skills/store.js";
import { McpRegistry } from "../mcp/store.js";
import { SelfEditBudget, SelfEditStore, readAudit, type StorageLike } from "./guards.js";
import { buildSelfToolBridge } from "./tools.js";
import {
  MAX_SNAPSHOTS,
  SNAPSHOT_KEY,
  SelfSnapshotStore,
  rollbackSnapshot,
} from "./snapshots.js";

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
}

function setup(agentId = "a1") {
  const storage = new FakeStorage();
  let t = 1_700_000_000_000;
  const now = () => (t += 1000);
  const memory = new MemoryStore(storage, now);
  const skills = new SkillPool(storage, now);
  const mcp = new McpRegistry(storage, () => new Date(now()).toISOString());
  const bridge = buildSelfToolBridge(
    {
      memory,
      skills,
      mcp,
      storage,
      policy: new SelfEditStore(storage),
      budget: new SelfEditBudget(),
      now,
    },
    { agentId, conversationId: "c1" },
  );
  const call = (name: string, args: Record<string, unknown> = {}) =>
    bridge.execute({ name, arguments: JSON.stringify(args) });
  return { storage, memory, skills, mcp, bridge, call, snapshots: new SelfSnapshotStore(storage, now) };
}

describe("快照仓库", () => {
  it("最新在前，超出上限丢最旧的", () => {
    const storage = new FakeStorage();
    const store = new SelfSnapshotStore(storage, () => 1_700_000_000_000);
    for (let i = 0; i < MAX_SNAPSHOTS + 5; i++) {
      store.record({
        agentId: "a1",
        scope: "memory",
        action: "write",
        target: `k${i}`,
        label: `改 ${i}`,
        patch: { kind: "memory-remove", entry: {} as never },
      });
    }
    const list = store.list();
    expect(list).toHaveLength(MAX_SNAPSHOTS);
    // 最后一次写入在最前（id 含时间与随机数，用 label 判断顺序）
    expect(list[0].label).toBe(`改 ${MAX_SNAPSHOTS + 4}`);
  });

  it("按智能体过滤", () => {
    const store = new SelfSnapshotStore(new FakeStorage());
    store.record({ agentId: "a1", scope: "memory", action: "write", target: "k", label: "x", patch: { kind: "memory-remove", entry: {} as never } });
    store.record({ agentId: "a2", scope: "memory", action: "write", target: "k", label: "y", patch: { kind: "memory-remove", entry: {} as never } });
    expect(store.list("a1")).toHaveLength(1);
    expect(store.list("a1")[0].label).toBe("x");
  });

  it("存储损坏时返回空而不是抛", () => {
    const storage = new FakeStorage();
    storage.setItem(SNAPSHOT_KEY, "{坏 JSON");
    expect(new SelfSnapshotStore(storage).list()).toEqual([]);
  });

  it("回滚失败时不抛，返回原因", () => {
    const storage = new FakeStorage();
    const mcp = new McpRegistry(storage);
    const snap = new SelfSnapshotStore(storage).record({
      agentId: "a1",
      scope: "mcp",
      action: "update_server",
      target: "不存在",
      label: "改 MCP",
      patch: {
        kind: "mcp-update-server",
        id: "ghost",
        prior: { id: "ghost", name: "x", transport: "http", enabled: true } as never,
      },
    });
    const r = rollbackSnapshot(snap, {
      memory: new MemoryStore(storage),
      skills: new SkillPool(storage),
      mcp,
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("回滚失败");
  });
});

describe("self.* 快照与回滚：记忆", () => {
  it("新建记忆可回滚（删除）", async () => {
    const { call, memory } = setup();
    await call("self_memory_write", { key: "偏好-语言", value: "简体中文" });
    expect(memory.semanticGlobal()).toHaveLength(1);

    const list = await call("self_snapshot_list");
    expect(list.text).toContain("记忆「偏好-语言」");
    const id = list.text.match(/\[(snap-[^\]]+)\]/)![1];

    const r = await call("self_rollback", { id });
    expect(r.ok).toBe(true);
    expect(memory.semanticGlobal()).toHaveLength(0);
    // 回滚后快照被移除
    expect((await call("self_snapshot_list")).text).toContain("没有可回滚");
  });

  it("更新记忆可回滚（恢复旧值）", async () => {
    const { call, memory } = setup();
    await call("self_memory_write", { key: "k", value: "旧值" });
    await call("self_memory_write", { key: "k", value: "新值" });

    const list = await call("self_snapshot_list");
    // 最新一条是「更新」（label 相同，取第一条）
    const id = list.text.match(/\[(snap-[^\]]+)\]/)![1];
    const r = await call("self_rollback", { id });

    expect(r.ok).toBe(true);
    expect(memory.semanticGlobal()).toHaveLength(1);
    expect(memory.semanticGlobal()[0].value).toBe("旧值");
  });

  it("删除记忆可回滚（恢复条目）", async () => {
    const { call, memory } = setup();
    await call("self_memory_write", { key: "k", value: "要保留" });
    await call("self_memory_remove", { key: "k" });
    expect(memory.semanticGlobal()).toHaveLength(0);

    const list = await call("self_snapshot_list");
    const id = list.text.match(/\[(snap-[^\]]+)\]/)![1];
    expect((await call("self_rollback", { id })).ok).toBe(true);
    expect(memory.semanticGlobal()[0].value).toBe("要保留");
  });
});

describe("self.* 快照与回滚：技能", () => {
  it("新建技能可回滚（删除）", async () => {
    const { call, skills } = setup();
    await call("self_skill_create", {
      name: "发布流程",
      description: "发版顺序",
      instructions: "1. bump",
    });
    expect(skills.list().some((s) => s.name === "发布流程")).toBe(true);

    const list = await call("self_snapshot_list");
    const id = list.text.match(/\[(snap-[^\]]+)\]/)![1];
    expect((await call("self_rollback", { id })).ok).toBe(true);
    expect(skills.list().some((s) => s.name === "发布流程")).toBe(false);
  });

  it("更新技能可回滚（恢复定义）", async () => {
    const { call, skills } = setup();
    await call("self_skill_create", {
      name: "排障",
      description: "排查",
      instructions: "先看日志",
    });
    await call("self_skill_update", { name: "排障", instructions: "先看指标" });

    const list = await call("self_snapshot_list");
    const id = list.text.match(/\[(snap-[^\]]+)\]/)![1];
    expect((await call("self_rollback", { id })).ok).toBe(true);
    expect(skills.list().find((s) => s.name === "排障")?.instructions).toBe("先看日志");
  });
});

describe("self.* 快照与回滚：MCP", () => {
  it("启用工具可回滚（恢复停用）", async () => {
    const { call, mcp } = setup();
    const server = mcp.add({ name: "s", transport: "http", url: "https://x.com" });
    mcp.setTools(server.id, [{ name: "search" }]);
    mcp.setToolEnabled(server.id, "search", false);

    await call("self_mcp_enable", { tool: `${server.id}::search` });
    expect(mcp.isToolEnabled(server.id, "search")).toBe(true);

    const list = await call("self_snapshot_list");
    const id = list.text.match(/\[(snap-[^\]]+)\]/)![1];
    expect((await call("self_rollback", { id })).ok).toBe(true);
    expect(mcp.isToolEnabled(server.id, "search")).toBe(false);
  });

  it("新增服务可回滚（删除服务）", async () => {
    const { call, mcp } = setup();
    await call("self_mcp_add_server", {
      name: "天气",
      transport: "http",
      url: "https://weather.example.com/mcp",
    });
    expect(mcp.servers().some((s) => s.name === "天气")).toBe(true);

    const list = await call("self_snapshot_list");
    const id = list.text.match(/\[(snap-[^\]]+)\]/)![1];
    expect((await call("self_rollback", { id })).ok).toBe(true);
    expect(mcp.servers().some((s) => s.name === "天气")).toBe(false);
  });

  it("修改服务可回滚（恢复配置）", async () => {
    const { call, mcp } = setup();
    const server = mcp.add({ name: "原名", transport: "http", url: "https://a.com" });
    await call("self_mcp_update_server", { id: server.id, name: "新名", url: "https://b.com" });
    expect(mcp.get(server.id)?.name).toBe("新名");

    const list = await call("self_snapshot_list");
    const id = list.text.match(/\[(snap-[^\]]+)\]/)![1];
    expect((await call("self_rollback", { id })).ok).toBe(true);
    const restored = mcp.get(server.id);
    expect(restored?.name).toBe("原名");
    expect(restored?.url).toBe("https://a.com");
  });

  it("删除服务可回滚（按原 id 重新加回）", async () => {
    const { call, mcp } = setup();
    const server = mcp.add({ name: "要留着", transport: "http", url: "https://keep.example.com" });
    await call("self_mcp_remove_server", { id: server.id });
    expect(mcp.get(server.id)).toBeUndefined();

    const list = await call("self_snapshot_list");
    const id = list.text.match(/\[(snap-[^\]]+)\]/)![1];
    expect((await call("self_rollback", { id })).ok).toBe(true);
    expect(mcp.get(server.id)?.name).toBe("要留着");
  });
});

describe("self_rollback 的边界", () => {
  it("找不到快照时说明原因", async () => {
    const { call } = setup();
    const r = await call("self_rollback", { id: "snap-ghost" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("没有找到快照");
  });

  it("不能回滚别的智能体的快照", async () => {
    const storage = new FakeStorage();
    const a1 = setupWith(storage, "a1");
    const a2 = setupWith(storage, "a2");
    await a1.call("self_memory_write", { key: "k", value: "v" });
    const id = (await a1.call("self_snapshot_list")).text.match(/\[(snap-[^\]]+)\]/)![1];

    const r = await a2.call("self_rollback", { id });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("没有找到快照");
    // a1 的快照没有被误删
    expect((await a1.call("self_snapshot_list")).text).toContain("记忆「k」");
  });

  it("回滚记入留痕（other/rollback）", async () => {
    const { call, storage } = setup();
    await call("self_memory_write", { key: "k", value: "v" });
    const id = (await call("self_snapshot_list")).text.match(/\[(snap-[^\]]+)\]/)![1];
    await call("self_rollback", { id });

    expect(
      readAudit(storage, "a1").some((e) => e.scope === "other" && e.action === "rollback"),
    ).toBe(true);
  });

  it("回滚失败时不清掉快照，便于用户修好后再试", async () => {
    const { call, mcp, snapshots } = setup();
    const server = mcp.add({ name: "x", transport: "http", url: "https://x.com" });
    await call("self_mcp_update_server", { id: server.id, name: "y" });
    const id = (await call("self_snapshot_list")).text.match(/\[(snap-[^\]]+)\]/)![1];

    mcp.remove(server.id);
    const r = await call("self_rollback", { id });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("回滚失败");
    expect(snapshots.get(id)).toBeTruthy();
  });
});

/** 共享同一份存储的两个智能体，用来验证快照隔离。 */
function setupWith(storage: FakeStorage, agentId: string) {
  let t = 1_700_000_000_000;
  const now = () => (t += 1000);
  const bridge = buildSelfToolBridge(
    {
      memory: new MemoryStore(storage, now),
      skills: new SkillPool(storage, now),
      mcp: new McpRegistry(storage, () => new Date(now()).toISOString()),
      storage,
      policy: new SelfEditStore(storage),
      budget: new SelfEditBudget(),
      now,
    },
    { agentId, conversationId: "c1" },
  );
  return {
    call: (name: string, args: Record<string, unknown> = {}) =>
      bridge.execute({ name, arguments: JSON.stringify(args) }),
  };
}
