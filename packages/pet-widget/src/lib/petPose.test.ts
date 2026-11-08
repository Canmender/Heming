import { describe, expect, it } from "vitest";
import {
  PET_POSES,
  poseDrivesMouth,
  poseForEvent,
  poseMotion,
  resolvePose,
  type PetPose,
  type PoseInput,
} from "./petPose.js";

/** 默认输入：一切平静。 */
const base: PoseInput = {
  hasError: false,
  streaming: false,
  inputOpen: false,
  celebrating: false,
};

const pose = (patch: Partial<PoseInput> = {}) => resolvePose({ ...base, ...patch });

describe("姿态优先级", () => {
  it("平静时待机", () => {
    expect(pose()).toBe("idle");
  });

  it("出错最高优先：即便同时在说话，也报错态", () => {
    expect(pose({ hasError: true })).toBe("alerting");
    expect(pose({ hasError: true, streaming: true })).toBe("alerting");
  });

  it("说话优先于开心（说到一半被点，不能闭嘴切动作）", () => {
    expect(pose({ streaming: true, celebrating: true })).toBe("speaking");
  });

  it("开心优先于等待输入（刚被摸的反馈要立刻给）", () => {
    expect(pose({ celebrating: true, inputOpen: true })).toBe("happy");
  });

  it("输入框打开 → 等待输入", () => {
    expect(pose({ inputOpen: true })).toBe("listening");
  });
});

describe("姿态映射表", () => {
  const all: PetPose[] = ["idle", "listening", "thinking", "speaking", "alerting", "happy"];

  it("每个姿态都有映射（新增姿态漏了表会被这条抓住）", () => {
    for (const p of all) {
      expect(PET_POSES[p], p).toBeDefined();
      expect(PET_POSES[p].mouth === "text" || PET_POSES[p].mouth === "closed", p).toBe(true);
    }
  });

  it("只有说话态由文字驱动口型", () => {
    expect(all.filter(poseDrivesMouth)).toEqual(["speaking"]);
  });

  it("待机/思考不播进入动作（避免和模型自带动作打架）", () => {
    expect(poseMotion("idle")).toBeNull();
    expect(poseMotion("thinking")).toBeNull();
  });

  it("只有「开心」有进入动作（常驻窗口里每种状态都播一次就是噪音）", () => {
    expect(poseMotion("happy")).toBe("TapBody");
    for (const p of all.filter((x) => x !== "happy")) {
      expect(poseMotion(p), p).toBeNull();
    }
  });

  it("动作组名不是空串（空串会让 playMotion 白跑一趟）", () => {
    for (const p of all) {
      const m = PET_POSES[p].enterMotion;
      if (m !== null) expect(m.length, p).toBeGreaterThan(0);
    }
  });
});

describe("平台事件 → 姿态（在场感）", () => {
  it("任务成功 → 开心（唯一带动进入动作，算「轻微动作」）", () => {
    expect(poseForEvent({ kind: "task", ok: true })).toBe("happy");
  });

  it("任务失败 / 日程临期 → 提醒态（需要看一眼）", () => {
    expect(poseForEvent({ kind: "task", ok: false })).toBe("alerting");
    expect(poseForEvent({ kind: "schedule" })).toBe("alerting");
  });

  it("幕僚开口 → 说话态（配口型）", () => {
    expect(poseForEvent({ kind: "speak" })).toBe("speaking");
  });

  it("显式 pose 事件原样采用；reset/未知不产生姿态", () => {
    expect(poseForEvent({ kind: "pose", pose: "thinking" })).toBe("thinking");
    expect(poseForEvent({ kind: "reset" })).toBeNull();
    expect(poseForEvent({ kind: "unknown" })).toBeNull();
  });
});
