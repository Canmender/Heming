import { describe, expect, it } from "vitest";
import { parseSettingsValue, settingArgs, textSetting } from "./modelSettings.js";

describe("看图 / 画图模型设置", () => {
  it("settings get 的 JSON 字符串和裸文本都读得出来，空值读成空串", () => {
    expect(parseSettingsValue('"deepseek/deepseek-flash"')).toBe("deepseek/deepseek-flash");
    expect(parseSettingsValue("   ")).toBe("");
    expect(parseSettingsValue('""')).toBe("");
    expect(parseSettingsValue("\u001b[2m\"relay/claude-opus\"\u001b[0m")).toBe("relay/claude-opus");
    expect(parseSettingsValue("not json")).toBe("not json");
  });

  it("有值就 set，清空就 reset：settings set 不接受空值", () => {
    expect(settingArgs("vision", "deepseek/deepseek-flash")).toEqual([
      "settings",
      "set",
      "vision",
      "deepseek/deepseek-flash",
    ]);
    expect(settingArgs("imageGen", "  ")).toEqual(["settings", "reset", "imageGen"]);
  });

  it("settings list 的原始值只取字符串：布尔、数组、缺失都当没设置", () => {
    const values = new Map<string, unknown>([
      ["vision", " deepseek/deepseek-chat "],
      ["visionEffort", true],
      ["imageGen", ["a", "b"]],
    ]);
    expect(textSetting(values, "vision")).toBe("deepseek/deepseek-chat");
    expect(textSetting(values, "visionEffort")).toBe("");
    expect(textSetting(values, "imageGen")).toBe("");
    expect(textSetting(values, "missing")).toBe("");
  });
});
