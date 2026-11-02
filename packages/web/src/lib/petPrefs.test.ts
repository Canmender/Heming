import { describe, expect, it } from "vitest";
import {
  DEFAULT_PET_MODEL,
  DEFAULT_PET_PREFS,
  PET_PREFS_KEY,
  isValidModelPath,
  loadPetPrefs,
  petModelUrl,
  savePetPrefs,
} from "./petPrefs.js";

/** 最小 Storage 替身：只实现本模块用到的方法。 */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

describe("桌宠偏好", () => {
  it("空存储返回默认（默认不启用，否则桌面上会凭空多出东西）", () => {
    const prefs = loadPetPrefs(fakeStorage());
    expect(prefs).toEqual(DEFAULT_PET_PREFS);
    expect(prefs.enabled).toBe(false);
  });

  it("写入后可读回", () => {
    const store = fakeStorage();
    savePetPrefs({ enabled: true, agentId: "a1", modelPath: "pet/X/x.model3.json" }, store);
    expect(loadPetPrefs(store)).toEqual({
      enabled: true,
      agentId: "a1",
      modelPath: "pet/X/x.model3.json",
    });
  });

  it("坏 JSON 整份回落默认，不抛错", () => {
    expect(loadPetPrefs(fakeStorage({ [PET_PREFS_KEY]: "{not json" }))).toEqual(DEFAULT_PET_PREFS);
    expect(loadPetPrefs(fakeStorage({ [PET_PREFS_KEY]: "[1,2,3]" }))).toEqual(DEFAULT_PET_PREFS);
    expect(loadPetPrefs(fakeStorage({ [PET_PREFS_KEY]: "null" }))).toEqual(DEFAULT_PET_PREFS);
  });

  it("单字段坏掉只回落该字段，其余保留", () => {
    const store = fakeStorage({
      [PET_PREFS_KEY]: JSON.stringify({
        enabled: true,
        agentId: 42,
        modelPath: "../../etc/passwd.model3.json",
      }),
    });
    const prefs = loadPetPrefs(store);
    expect(prefs.enabled).toBe(true);
    expect(prefs.agentId).toBeNull();
    expect(prefs.modelPath).toBe(DEFAULT_PET_MODEL);
  });

  it("enabled 只认严格的 true", () => {
    for (const v of ["true", 1, {}, []]) {
      const store = fakeStorage({ [PET_PREFS_KEY]: JSON.stringify({ enabled: v }) });
      expect(loadPetPrefs(store).enabled).toBe(false);
    }
  });

  it("agentId 去空白，空串视为未绑定", () => {
    expect(loadPetPrefs(fakeStorage({ [PET_PREFS_KEY]: JSON.stringify({ agentId: "  a1  " }) })).agentId).toBe("a1");
    expect(loadPetPrefs(fakeStorage({ [PET_PREFS_KEY]: JSON.stringify({ agentId: "   " }) })).agentId).toBeNull();
  });

  it("保存时也过白名单（脏模型路径不落盘）", () => {
    const store = fakeStorage();
    savePetPrefs({ enabled: false, agentId: null, modelPath: "../evil.model3.json" }, store);
    expect(loadPetPrefs(store).modelPath).toBe(DEFAULT_PET_MODEL);
  });

  it("存储不可用 / 配额失败时不抛错", () => {
    expect(() => savePetPrefs(DEFAULT_PET_PREFS, null)).not.toThrow();
    const broken = {
      ...fakeStorage(),
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    } as Storage;
    expect(loadPetPrefs(broken)).toEqual(DEFAULT_PET_PREFS);
    expect(() => savePetPrefs(DEFAULT_PET_PREFS, broken)).not.toThrow();
  });
});

describe("模型路径白名单", () => {
  it("合法路径放行", () => {
    expect(isValidModelPath("pet/Hiyori/Hiyori.model3.json")).toBe(true);
    expect(isValidModelPath("pet\\Hiyori\\Hiyori.model3.json")).toBe(true);
    expect(isValidModelPath("pet/Shizuku/shizuku.model.json")).toBe(true);
    expect(isValidModelPath("pet/我的角色/a.model3.json")).toBe(true);
  });

  it("穿越 / 绝对 / 协议 / 非模型文件一律拒绝", () => {
    for (const bad of [
      "../a.model3.json",
      "pet/../../a.model3.json",
      "/etc/a.model3.json",
      "C:/a.model3.json",
      "file:///a.model3.json",
      "http://evil/a.model3.json",
      "pet//a.model3.json",
      "pet/a.txt",
      "pet/a.json",
      "pet/a.model3.json\u0000",
      "",
      "   ",
      null,
      undefined,
      42,
    ]) {
      expect(isValidModelPath(bad), String(bad)).toBe(false);
    }
  });

  it("超长路径拒绝", () => {
    expect(isValidModelPath("pet/" + "a".repeat(300) + ".model3.json")).toBe(false);
  });
});

describe("模型地址拼接", () => {
  it("与页面同源，不把路径拼成绝对地址", () => {
    expect(petModelUrl("pet/Hiyori/Hiyori.model3.json", "app://heming")).toBe(
      "app://heming/pet/Hiyori/Hiyori.model3.json",
    );
    // 基址末尾带斜杠也不产生双斜杠
    expect(petModelUrl("pet/Hiyori/Hiyori.model3.json", "app://heming/")).toBe(
      "app://heming/pet/Hiyori/Hiyori.model3.json",
    );
  });

  it("脏路径回落默认模型（不拼出越界地址）", () => {
    expect(petModelUrl("../../secret.model3.json", "app://heming")).toBe(
      `app://heming/${DEFAULT_PET_MODEL}`,
    );
  });
});
