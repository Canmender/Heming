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
  it("缺省全部未安装：安装包默认不携带任何模块", () => {
    const state = defaultModuleState();
    expect(state.installed).toEqual({ staff: false, infohub: false, automations: false });
    expect(state.enabled).toEqual({ staff: false, infohub: false, automations: false });
    expect(effectiveModuleIds(state)).toEqual([]);
  });

  it("坏 JSON / 非对象 / 缺字段一律回落默认（不把模块锁死）", () => {
    expect(parseModuleState("{bad json").installed.staff).toBe(false);
    expect(parseModuleState("null").installed.infohub).toBe(false);
    // 老存储只有 enabled（没有 installed）：不再视为已安装
    expect(normalizeModuleState({ enabled: { staff: true } })).toEqual(defaultModuleState());
    // 已安装但缺 enabled → 启用（装过就是开着）
    const migrated = normalizeModuleState({ installed: { staff: true } });
    expect(migrated.installed.staff).toBe(true);
    expect(migrated.enabled.staff).toBe(true);
    // 非布尔值不认
    expect(normalizeModuleState({ installed: { staff: "yes" } }).installed.staff).toBe(false);
  });

  it("未知模块 id 直接丢弃（卸载模块后的残留不会变成幽灵开关）", () => {
    const state = normalizeModuleState({
      installed: { ghost: true, staff: true },
      enabled: { ghost: true, staff: true },
    });
    expect(state.installed).toEqual({ staff: true, infohub: false, automations: false });
    expect(state.enabled).toEqual({ staff: true, infohub: false, automations: false });
  });
});

describe("内置能力模块 · 安装 / 启用语义", () => {
  it("自动化不依赖信息中枢：只停信息中枢时自动化仍生效", () => {
    const state = defaultModuleState();
    state.installed.infohub = true;
    state.enabled.infohub = true;
    state.installed.automations = true;
    state.enabled.automations = true;

    state.enabled.infohub = false;
    expect(state.enabled.automations).toBe(true);
    expect(isModuleEffective(state, "automations")).toBe(true);
    expect(missingRequirements(state, "automations")).toEqual([]);
    expect(effectiveModuleIds(state)).toEqual(["automations"]);
  });

  it("已安装但自身关闭即不生效；未安装时开关为 false", () => {
    const state = defaultModuleState();
    state.installed.staff = true;
    state.enabled.staff = false;
    expect(isModuleEffective(state, "staff")).toBe(false);
    expect(isModuleEffective(state, "infohub")).toBe(false);
  });
});

describe("内置能力模块 · 存储", () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
    setModuleStorage(storage);
    useModuleStore.getState().reset();
  });

  it("默认未安装时读盘返回未安装（没有旧键）", () => {
    expect(readModuleState(storage)).toEqual(defaultModuleState());
  });

  it("install 落盘（安装并启用），重新读回一致（本机、不上云）", () => {
    useModuleStore.getState().install("infohub");
    const s = useModuleStore.getState();
    expect(s.installed.infohub).toBe(true);
    expect(s.enabled.infohub).toBe(true);
    const raw = storage.map.get(MODULES_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toEqual({
      installed: { staff: false, infohub: true, automations: false },
      enabled: { staff: false, infohub: true, automations: false },
    });
    expect(readModuleState(storage).installed.infohub).toBe(true);
  });

  it("setEnabled 只改开关；uninstall 回到未安装并关掉开关", () => {
    useModuleStore.getState().install("staff");
    useModuleStore.getState().setEnabled("staff", false);
    expect(useModuleStore.getState().installed.staff).toBe(true);
    expect(useModuleStore.getState().enabled.staff).toBe(false);

    useModuleStore.getState().uninstall("staff");
    expect(useModuleStore.getState().installed.staff).toBe(false);
    expect(useModuleStore.getState().enabled.staff).toBe(false);
  });

  it("未安装时 setEnabled 无效；reset 恢复全部未安装", () => {
    useModuleStore.getState().install("staff");
    useModuleStore.getState().reset();
    expect(useModuleStore.getState().installed.staff).toBe(false);
    const before = storage.map.get(MODULES_KEY);
    useModuleStore.getState().setEnabled("staff", true);
    expect(useModuleStore.getState().enabled.staff).toBe(false);
    expect(storage.map.get(MODULES_KEY)).toBe(before);
  });
});
