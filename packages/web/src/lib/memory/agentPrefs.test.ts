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

  it("缺字段回落：三个开关都取全开缺省（记忆无界面开关）", () => {
    expect(resolveAgentMemoryPrefs({ a1: { shortTerm: true } })).toEqual({
      a1: { shortTerm: true, longTerm: true, personalDb: true },
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
      // 非布尔值一律回落全开缺省；只有显式 false 会被收敛函数保留（但 get 不再采信）。
      a1: { shortTerm: true, longTerm: true, personalDb: true },
      a3: { shortTerm: true, longTerm: true, personalDb: false },
    });
  });
});

describe("AgentPrefsStore", () => {
  it("读取恒为全开；set 仍按 agentId 落盘（旧 false 不再生效）", () => {
    const map = new Map<string, string>();
    const store = new AgentPrefsStore(makeStorage(map));

    expect(store.get("a1")).toEqual(DEFAULT_AGENT_PREFS);

    // set 仍能写落盘，但 get 恒全开——记忆页已删除，没有关掉它的入口。
    store.set("a1", { shortTerm: false });
    expect(store.get("a1")).toEqual(DEFAULT_AGENT_PREFS);
    expect(JSON.parse(map.get(AGENT_PREFS_KEY) as string)).toEqual({
      a1: { shortTerm: false, longTerm: true, personalDb: true },
    });

    // 重新水合：旧落盘值读得到，但 get 依旧全开
    const reloaded = new AgentPrefsStore(makeStorage(map));
    expect(reloaded.all()).toEqual({ a1: { shortTerm: false, longTerm: true, personalDb: true } });
    expect(reloaded.get("a1")).toEqual(DEFAULT_AGENT_PREFS);
    expect(reloaded.get("a2")).toEqual(DEFAULT_AGENT_PREFS);
  });

  it("落盘内容损坏时回落缺省而非抛错", () => {
    const map = new Map([[AGENT_PREFS_KEY, "{不是 JSON"]]);
    const store = new AgentPrefsStore(makeStorage(map));
    expect(store.all()).toEqual({});
    expect(store.get("a1")).toEqual(DEFAULT_AGENT_PREFS);
  });
});
