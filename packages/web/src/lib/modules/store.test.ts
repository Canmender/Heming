import { describe, it, expect, beforeEach } from "vitest";
import type { StorageLike } from "../memory/types.js";
import {
  MODULES_KEY,
  defaultModuleState,
  effectiveModuleIds,
  isModuleEffective,
  missingRequirements,
  normalizeModuleState,
  parseModuleState,
  readModuleState,
  setModuleStorage,
  useModuleStore,
} from "./store.js";

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

describe("内置能力模块 · 状态规整", () => {
  it("缺省全开：升级后行为与改造前一致", () => {
    const state = defaultModuleState();
    expect(state.enabled).toEqual({ staff: true, infohub: true, automations: true, modelroute: true });
    expect(effectiveModuleIds(state)).toEqual(["staff", "infohub", "automations", "modelroute"]);
  });

  it("坏 JSON / 非对象 / 缺字段一律回落默认（不把模块锁死）", () => {
    expect(parseModuleState("{bad json").enabled.staff).toBe(true);
    expect(parseModuleState("null").enabled.infohub).toBe(true);
    expect(normalizeModuleState({ enabled: { staff: false } }).enabled).toEqual({
      staff: false,
      infohub: true,
      automations: true,
      modelroute: true,
    });
    // 非布尔值不认
    expect(normalizeModuleState({ enabled: { staff: "no" } }).enabled.staff).toBe(true);
  });

  it("未知模块 id 直接丢弃（卸载模块后的残留不会变成幽灵开关）", () => {
    const state = normalizeModuleState({ enabled: { ghost: false, staff: false } });
    expect(state.enabled).toEqual({ staff: false, infohub: true, automations: true, modelroute: true });
  });
});

describe("内置能力模块 · 依赖语义", () => {
  it("自动化依赖信息中枢：依赖停用时开关仍保留，但实际不生效；恢复后自动生效", () => {
    const state = defaultModuleState();
    state.enabled.infohub = false;
    expect(state.enabled.automations).toBe(true);
    expect(isModuleEffective(state, "automations")).toBe(false);
    expect(missingRequirements(state, "automations")).toEqual(["infohub"]);
    expect(effectiveModuleIds(state)).toEqual(["staff", "modelroute"]);

    state.enabled.infohub = true;
    expect(isModuleEffective(state, "automations")).toBe(true);
    expect(missingRequirements(state, "automations")).toEqual([]);
  });

  it("自身关闭即不生效，与依赖无关", () => {
    const state = defaultModuleState();
    state.enabled.staff = false;
    expect(isModuleEffective(state, "staff")).toBe(false);
    expect(isModuleEffective(state, "infohub")).toBe(true);
  });
});

describe("内置能力模块 · 存储", () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
    setModuleStorage(storage);
    useModuleStore.getState().reset();
  });

  it("默认全开时读盘返回全开（没有旧键）", () => {
    expect(readModuleState(storage).enabled).toEqual({
      staff: true,
      infohub: true,
      automations: true,
      modelroute: true,
    });
  });

  it("setEnabled 落盘，重新读回一致（本机、不上云）", () => {
    useModuleStore.getState().setEnabled("infohub", false);
    expect(useModuleStore.getState().enabled.infohub).toBe(false);
    const raw = storage.map.get(MODULES_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toEqual({
      enabled: { staff: true, infohub: false, automations: true, modelroute: true },
    });
    expect(readModuleState(storage).enabled.infohub).toBe(false);
  });

  it("reset 恢复全开并落盘；重复 set 同值不重复写盘", () => {
    useModuleStore.getState().setEnabled("staff", false);
    useModuleStore.getState().reset();
    expect(useModuleStore.getState().enabled.staff).toBe(true);
    const before = storage.map.get(MODULES_KEY);
    useModuleStore.getState().setEnabled("staff", true);
    expect(storage.map.get(MODULES_KEY)).toBe(before);
  });
});
