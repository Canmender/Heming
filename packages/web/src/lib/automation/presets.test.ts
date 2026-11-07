import { describe, expect, it } from "vitest";
import { AUTOMATION_PRESETS, presetById, presetDraft, validatePresets } from "./presets.js";

/**
 * 自动化预设（d.76）：一键创建的草稿必须能通过正常校验，且不共享可变引用。
 * 这里只测纯数据；「点一下真的建出任务」由 AutomationPage 组件用例覆盖。
 */
describe("自动化预设", () => {
  it("四条预设、id 唯一、覆盖两种动作与三种排期", () => {
    expect(AUTOMATION_PRESETS).toHaveLength(4);
    expect(new Set(AUTOMATION_PRESETS.map((p) => p.id)).size).toBe(4);
    expect(new Set(AUTOMATION_PRESETS.map((p) => p.draft.kind))).toEqual(
      new Set(["infohub.sync", "infohub.agenda"]),
    );
    expect(AUTOMATION_PRESETS.some((p) => p.draft.schedule.type === "interval")).toBe(true);
    expect(AUTOMATION_PRESETS.some((p) => p.draft.sync.archive)).toBe(true);
  });

  it("每条预设都是合法草稿（不会建出存不进去的任务）", () => {
    expect(validatePresets()).toEqual([]);
  });

  it("presetDraft 深拷贝：改返回值不影响预设本身", () => {
    const preset = presetById("daily-sync");
    expect(preset).toBeTruthy();
    const draft = presetDraft(preset!);
    draft.sync.sources.push("qq");
    if (draft.schedule.type === "daily") draft.schedule.weekdays.push(0);
    expect(preset!.draft.sync.sources).toEqual(["qq", "wechat"]);
    if (preset!.draft.schedule.type === "daily") {
      expect(preset!.draft.schedule.weekdays).toEqual([1, 2, 3, 4, 5, 6, 0]);
    }
  });

  it("presetById：未知 id 返回 undefined", () => {
    expect(presetById("nope")).toBeUndefined();
  });
});
