import { describe, expect, it } from "vitest";
import { parseSettingsValue, settingArgs } from "./modelSettings.js";

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
});
