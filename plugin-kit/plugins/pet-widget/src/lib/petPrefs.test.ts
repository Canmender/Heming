import { describe, expect, it } from "vitest";
import {
  DEFAULT_PET_MODEL,
  DEFAULT_PET_SETTINGS,
  PET_SETTING_KEYS,
  isValidModelPath,
  normalizePetSettings,
  petModelUrl,
} from "./petPrefs.js";

/**
 * 拆分后的偏好层只做两件事：
 * 1. **收敛**宿主 settings（不可信输入）→ 确定的桌宠偏好；
 * 2. 模型路径白名单 + URL 拼接。
 *
 * localStorage 相关用例随实现一起删掉了（widget 在独立 origin 下没有宿主的键）。
 */
describe("设置收敛（宿主 settings → 桌宠偏好）", () => {
  it("空/畸形输入整份回落默认", () => {
    for (const bad of [null, undefined, {}, 42, "x", [], { agentId: 1, modelPath: 2, presence: 3 }]) {
      expect(normalizePetSettings(bad as never)).toEqual(DEFAULT_PET_SETTINGS);
    }
  });

  it("字段名与宿主迁移口径一致（agentId / modelPath / presence）", () => {
    expect(PET_SETTING_KEYS).toEqual({
      agentId: "agentId",
      modelPath: "modelPath",
      presence: "presence",
    });
  });

  it("合法值原样采用", () => {
    const settings = normalizePetSettings({
      agentId: " a1 ",
      modelPath: "pet/Hiyori/Hiyori.model3.json",
      presence: "eager",
    });
    expect(settings).toEqual({
      agentId: "a1",
      modelPath: "pet/Hiyori/Hiyori.model3.json",
      presence: "eager",
    });
  });

  it("单字段写坏只回落该字段，不整份丢弃", () => {
    const settings = normalizePetSettings({
      agentId: "a1",
      modelPath: "../../etc/passwd",
      presence: "loud",
    });
    expect(settings.agentId).toBe("a1");
    expect(settings.modelPath).toBe(DEFAULT_PET_MODEL);
    expect(settings.presence).toBe("normal");
  });

  it("空字符串 agentId 视为未绑定", () => {
    expect(normalizePetSettings({ agentId: "   " }).agentId).toBeNull();
  });
});

describe("模型路径白名单", () => {
  it("接受相对路径的 .model3.json", () => {
    expect(isValidModelPath("pet/Hiyori/Hiyori.model3.json")).toBe(true);
    expect(isValidModelPath("pet/自定义 模型/x.model3.json")).toBe(true);
  });

  it("拒绝绝对路径 / 反斜杠盘符 / 越界 / 非 json", () => {
    for (const bad of [
      "/pet/a.model3.json",
      "C:/pet/a.model3.json",
      "pet/../a.model3.json",
      "pet//a.model3.json",
      "https://x/a.model3.json",
      "pet/a.png",
      "",
      42,
    ]) {
      expect(isValidModelPath(bad as never)).toBe(false);
    }
  });
});

describe("模型 URL", () => {
  it("拼在页面基址下（widget:// 与 http 都成立）", () => {
    expect(petModelUrl("pet/Hiyori/Hiyori.model3.json", "widget://heming.pet/files/")).toBe(
      "widget://heming.pet/files/pet/Hiyori/Hiyori.model3.json",
    );
    expect(petModelUrl("pet/A/a.model3.json", "http://host/sub/")).toBe(
      "http://host/sub/pet/A/a.model3.json",
    );
  });

  it("非法路径回落默认模型（不让脏值进 URL）", () => {
    expect(petModelUrl("../../x", "widget://heming.pet/files/")).toBe(
      `widget://heming.pet/files/${DEFAULT_PET_MODEL}`,
    );
  });
});
