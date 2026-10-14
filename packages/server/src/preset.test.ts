import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore, type Store } from "./store.js";
import { seedPreset } from "./preset.js";

describe("seedPreset", () => {
  let store: Store;
  beforeEach(() => {
    store = createMemoryStore();
  });

  it("无用户时不播种返回 null", () => {
    expect(seedPreset(store)).toBeNull();
  });

  it("有用户时播种 agent+预设群，幂等", () => {
    store.createUser("alice", "h", "A");
    const r1 = seedPreset(store);
    expect(r1).toBeTruthy();
    const r2 = seedPreset(store);
    expect(r2?.groupId).toBe(r1?.groupId);
    const convs = store.listConversations(store.findUserByUsername("alice")!.user.id);
    expect(convs.filter((c) => c.type === "group")).toHaveLength(1);
    const members = store.listMembers(r1!.groupId);
    expect(members.some((m) => m.kind === "agent" && m.name === "和小鸣")).toBe(true);
    expect(members.filter((m) => m.kind === "user")).toHaveLength(1);
  });

  it("agent 行在成员尾部，user 行在前；listAgentIds 返回 system-assistant", () => {
    store.createUser("alice", "h", "A");
    const r = seedPreset(store)!;
    const members = store.listMembers(r.groupId);
    expect(members[members.length - 1]).toEqual({
      kind: "agent",
      id: "system-assistant",
      name: "和小鸣",
      avatar: null,
      user: null,
    });
    expect(store.listAgentIds(r.groupId)).toEqual(["system-assistant"]);
  });
});
