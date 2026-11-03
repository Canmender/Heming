import { describe, expect, it } from "vitest";
import {
  AUTOMATION_KINDS,
  AUTOMATION_KIND_META,
  isAutomationKind,
  kindMeta,
  listKindMeta,
  type AutomationKind,
} from "./kinds.js";

/**
 * 注册表元数据是模型层与页面共用的口径：少一个字段，某一处就会退回硬编码。
 * 这里钉住两条底线——每个 kind 的元数据完备、未知值一律拒绝。
 */

describe("自动化动作元数据", () => {
  it("清单与元数据一一对应，且每项字段完整", () => {
    expect(AUTOMATION_KINDS.length).toBeGreaterThan(0);
    expect(AUTOMATION_KIND_META.map((meta) => meta.kind)).toEqual([...AUTOMATION_KINDS]);
    for (const meta of AUTOMATION_KIND_META) {
      expect(meta.label.trim()).not.toBe("");
      expect(meta.defaultName.trim()).not.toBe("");
      expect(meta.summary.trim()).not.toBe("");
      expect(typeof meta.hasSyncParams).toBe("boolean");
      expect(kindMeta(meta.kind)).toBe(meta);
      expect(listKindMeta()).toContain(meta);
    }
  });

  it("isAutomationKind 只接受清单里的值", () => {
    for (const kind of AUTOMATION_KINDS) expect(isAutomationKind(kind)).toBe(true);
    for (const value of [
      "",
      "infohub",
      "infohub.sync ",
      "INFOHUB.SYNC",
      "sync",
      null,
      undefined,
      1,
      ["infohub.sync"],
      {},
    ]) {
      expect(isAutomationKind(value)).toBe(false);
    }
  });

  it("只有同步动作声明同步参数面板，默认名称沿用现有文案", () => {
    expect(
      AUTOMATION_KIND_META.filter((meta) => meta.hasSyncParams).map((meta) => meta.kind),
    ).toEqual(["infohub.sync"]);
    expect(kindMeta("infohub.sync").label).toBe("同步本机归档");
    expect(kindMeta("infohub.agenda").label).toBe("重扫日程");
    expect(kindMeta("infohub.sync").defaultName).toBe("同步本机归档");
    expect(kindMeta("infohub.agenda").defaultName).toBe("重扫日程");
  });

  it("未知动作取元数据直接抛错，不静默降级成默认动作", () => {
    expect(() => kindMeta("infohub.unknown" as unknown as AutomationKind)).toThrow(
      /未知的自动化动作/,
    );
  });
});
