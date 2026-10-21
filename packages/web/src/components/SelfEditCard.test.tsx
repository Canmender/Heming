import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SelfEditCard } from "./SelfEditCard.js";
import { SelfEditStore, type StorageLike } from "../lib/selfEdit/guards.js";
import { SelfSnapshotStore } from "../lib/selfEdit/snapshots.js";
import { MemoryStore } from "../lib/memory/store.js";
import { SkillPool } from "../lib/skills/store.js";
import { McpRegistry } from "../lib/mcp/store.js";

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

describe("SelfEditCard 快照回滚", () => {
  let storage: FakeStorage;
  let memory: MemoryStore;
  let skills: SkillPool;
  let mcp: McpRegistry;
  let snapshots: SelfSnapshotStore;

  beforeEach(() => {
    storage = new FakeStorage();
    const now = () => 1_700_000_000_000;
    memory = new MemoryStore(storage, now);
    skills = new SkillPool(storage, now);
    mcp = new McpRegistry(storage, () => new Date(now()).toISOString());
    snapshots = new SelfSnapshotStore(storage, now);
  });

  it("列出可回滚的修改，点回滚后真的还原并移除快照", () => {
    const created = skills.create({
      name: "临时技能",
      description: "x",
      instructions: "y",
      triggers: [],
      tags: [],
      enabled: true,
      version: "1.0.0",
      source: "distilled",
    });
    snapshots.record({
      agentId: "a1",
      scope: "skill",
      action: "create",
      target: created.name,
      label: `新建技能「${created.name}」`,
      patch: { kind: "skill-create", id: created.id },
    });

    render(
      <SelfEditCard
        agents={[{ id: "a1", name: "小鸣" }]}
        agentId="a1"
        storage={storage}
        policyStore={new SelfEditStore(storage)}
        snapshotStore={snapshots}
        targets={{ memory, skills, mcp }}
      />,
    );

    expect(screen.getByText("新建技能「临时技能」")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回滚 新建技能「临时技能」" }));
    // 回滚会覆盖之后的改动：需要二次确认
    expect(skills.list().some((s) => s.id === created.id)).toBe(true);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "回滚这一项改动" })).getByRole("button", {
        name: "回滚",
      }),
    );

    expect(skills.list().some((s) => s.id === created.id)).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("已回滚");
    expect(
      screen.queryByRole("button", { name: "回滚 新建技能「临时技能」" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("还没有可回滚的修改。")).toBeInTheDocument();
  });

  it("没接入存储时只提示，不假装成功", () => {
    snapshots.record({
      agentId: "a1",
      scope: "memory",
      action: "write",
      target: "k",
      label: "记忆「k」",
      patch: { kind: "memory-upsert", key: "k", prior: null, createdId: "m1" },
    });

    render(
      <SelfEditCard
        agents={[]}
        agentId="a1"
        storage={storage}
        snapshotStore={snapshots}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "回滚 记忆「k」" }));

    expect(screen.getByRole("status").textContent).toContain("只能查看不能回滚");
    expect(snapshotText()).toContain("记忆「k」");
  });

  it("没有快照时给空态", () => {
    render(
      <SelfEditCard
        agents={[]}
        agentId="a1"
        storage={storage}
        snapshotStore={snapshots}
        targets={{ memory, skills, mcp }}
      />,
    );
    expect(screen.getByText("还没有可回滚的修改。")).toBeInTheDocument();
  });

  it("未选择智能体时提示先选", () => {
    render(<SelfEditCard agents={[]} agentId="" storage={storage} snapshotStore={snapshots} />);
    expect(screen.getByText("选择智能体后显示。")).toBeInTheDocument();
  });

  /** 只取快照区的文本，避免和留痕区的同名条目混淆。 */
  function snapshotText() {
    return document.querySelector("section")?.textContent ?? "";
  }
});
