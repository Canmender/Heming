import { describe, it, expect } from "vitest";
import {
  AGENT_PREFS_KEY,
  AgentPrefsStore,
  DEFAULT_AGENT_PREFS,
  resolveAgentMemoryPrefs,
} from "./agentPrefs.js";
import type { StorageLike } from "./types.js";

/** 偏好纯函数的缺省/脏数据收敛，以及落盘键名。 */

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

describe("resolveAgentMemoryPrefs", () => {
  it("非对象输入返回空表", () => {
    expect(resolveAgentMemoryPrefs(null)).toEqual({});
    expect(resolveAgentMemoryPrefs(undefined)).toEqual({});
    expect(resolveAgentMemoryPrefs("x")).toEqual({});
    expect(resolveAgentMemoryPrefs([1, 2])).toEqual({});
  });

  it("缺字段回落：短期关、长期关、个人数据库允许", () => {
    expect(resolveAgentMemoryPrefs({ a1: { shortTerm: true } })).toEqual({
      a1: { shortTerm: true, longTerm: false, personalDb: true },
    });
    expect(resolveAgentMemoryPrefs({ a1: {} })).toEqual({ a1: { ...DEFAULT_AGENT_PREFS } });
  });

  it("脏数据回落缺省，非对象条目与空 ID 丢弃", () => {
    expect(
      resolveAgentMemoryPrefs({
        a1: { shortTerm: "yes", longTerm: 1, personalDb: null },
        a2: null,
        "": { shortTerm: true },
        "  ": { shortTerm: true },
        a3: { personalDb: false, extra: 1 },
      }),
    ).toEqual({
      a1: { shortTerm: false, longTerm: false, personalDb: true },
      a3: { shortTerm: false, longTerm: false, personalDb: false },
    });
  });
});

describe("AgentPrefsStore", () => {
  it("未配置取缺省，set 后按 agentId 落盘且读取一致", () => {
    const map = new Map<string, string>();
    const store = new AgentPrefsStore(makeStorage(map));

    expect(store.get("a1")).toEqual(DEFAULT_AGENT_PREFS);

    store.set("a1", { shortTerm: true });
    expect(store.get("a1")).toEqual({ shortTerm: true, longTerm: false, personalDb: true });
    expect(JSON.parse(map.get(AGENT_PREFS_KEY) as string)).toEqual({
      a1: { shortTerm: true, longTerm: false, personalDb: true },
    });

    // 重新水合：从同一存储构造仍读到已落盘值
    const reloaded = new AgentPrefsStore(makeStorage(map));
    expect(reloaded.get("a1").shortTerm).toBe(true);
    expect(reloaded.get("a2")).toEqual(DEFAULT_AGENT_PREFS);
  });

  it("落盘内容损坏时回落缺省而非抛错", () => {
    const map = new Map([[AGENT_PREFS_KEY, "{不是 JSON"]]);
    const store = new AgentPrefsStore(makeStorage(map));
    expect(store.all()).toEqual({});
    expect(store.get("a1")).toEqual(DEFAULT_AGENT_PREFS);
  });
});
