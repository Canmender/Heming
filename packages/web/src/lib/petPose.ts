/**
 * 桌宠的姿态（d.53 第三期预留）。
 *
 * 存在的理由：此前「现在该是什么状态」散在组件里用三元表达式拼
 * （`chat.error ? … : chat.reply ? … : unreadHint ? …`），动作组名也写死在调用点。
 * 这带来两个具体问题：
 *   1. 加一种表达（比如「被摸之后开心一下」）要改渲染逻辑，容易漏掉某条分支；
 *   2. 换个模型时，动作组名对不上只能改代码。
 *
 * 所以把「姿态」抽成数据：**状态由纯函数判定，表现由表决定**。
 * 以后要加姿态（第三期：任务完成、日程临期、幕僚简报），加一条映射 + 一个输入条件即可，
 * 不需要碰渲染代码，也不需要再散落三元表达式。
 */

/** 桌宠的姿态。新增时同步补 `PET_POSES` 与 `resolvePose`，测试会拦住漏项。 */
export type PetPose =
  /** 待机：呼吸/眨眼由模型自带动作，这里不额外播 */
  | "idle"
  /** 输入框打开、等你说话 */
  | "listening"
  /** 已发出、还没收到第一个字 */
  | "thinking"
  /** 正在流式输出（口型由文字驱动） */
  | "speaking"
  /** 需要你看一眼：有新消息，或出错 */
  | "alerting"
  /** 被摸/被点之后短暂开心 */
  | "happy";

export interface PoseSpec {
  /**
   * 进入该姿态时播一次的动作组名；null = 不播。
   * ★ 模型不一定有这些组（Hiyori 只有 Idle/TapBody/TapHead/Flick…），
   *   `playMotion` 找不到时必须静默跳过，不能因为换模型就报错。
   */
  enterMotion: string | null;
  /** 口型来源：closed=闭着；text=由流式文字驱动（见 PetWindow 的口型 effect） */
  mouth: "closed" | "text";
}

/**
 * 姿态 → 表现的映射表。
 *
 * 换模型时只需要改这里（或让用户在设置里覆盖）：渲染代码不再认识任何具体动作组名。
 */
export const PET_POSES: Record<PetPose, PoseSpec> = {
  idle: { enterMotion: null, mouth: "closed" },
  // 以下五种都**不播动作**：桌宠常驻桌面，任何「进入状态就播一次」的设计很快变成噪音。
  // 待机与说话靠模型自带动作 + 口型；提醒靠角标；等待输入靠输入框本身。
  // 只有「被摸」需要一个即时反馈，其余交给视觉元素表达。
  listening: { enterMotion: null, mouth: "closed" },
  thinking: { enterMotion: null, mouth: "closed" },
  speaking: { enterMotion: null, mouth: "text" },
  alerting: { enterMotion: null, mouth: "closed" },
  happy: { enterMotion: "TapBody", mouth: "closed" },
};

/** 判定姿态所需的输入。全部是布尔/计数，便于单测而不必渲染组件。 */
export interface PoseInput {
  /** 出错了（气泡在报错） */
  hasError: boolean;
  /** 正在流式接收回复 */
  streaming: boolean;
  /** 输入框是否打开 */
  inputOpen: boolean;
  /** 未读总数 */
  unreadTotal: number;
  /** 刚被点/摸（happy 的短窗口，由调用方计时） */
  celebrating: boolean;
}

/**
 * 判定当前姿态（纯函数）。
 *
 * 优先级是**表达准确性**而非"最新事件"：
 *   错误 > 说话 > 开心 > 等待输入 > 有未读 > 待机
 *
 * 为什么说话排在开心前面：正在输出时被点一下就把嘴闭上、切到开心动作，
 * 用户看到的是「它说到一半不理我了」。反过来，开心只持续几百毫秒，等一下不影响。
 */
export function resolvePose(input: PoseInput): PetPose {
  if (input.hasError) return "alerting";
  if (input.streaming) return "speaking";
  if (input.celebrating) return "happy";
  if (input.inputOpen) return "listening";
  if (input.unreadTotal > 0) return "alerting";
  return "idle";
}

/** 取姿态对应的动作组名（无映射时返回 null，调用方应静默跳过）。 */
export function poseMotion(pose: PetPose): string | null {
  return PET_POSES[pose]?.enterMotion ?? null;
}

/** 该姿态下口型是否由文字驱动。 */
export function poseDrivesMouth(pose: PetPose): boolean {
  return PET_POSES[pose]?.mouth === "text";
}
