/**
 * 常量表：分页/去重/AI 批处理上限与标签映射
 */

export const CONV_PAGE = 200;

export const MSG_PAGE = 80;

export const MERGE_GAP_SECONDS = 300;

export const KEYWORD_DEBOUNCE_MS = 220;

export const AUTO_SYNC_COOLDOWN_MS = 10 * 60 * 1000;

/** 只用于 AI 结果与导出里的来源文字，界面上不再展示来源徽标 */
export const SOURCE_LABELS = { qq: "QQ", wechat: "微信" };

/** 头像底色走原生 token（--avatar-1…6，暗色自动跟随），见 styles/app.css */
export const AVATAR_COLORS = [
  "var(--avatar-1)",
  "var(--avatar-2)",
  "var(--avatar-3)",
  "var(--avatar-4)",
  "var(--avatar-5)",
  "var(--avatar-6)",
];

/* ── AI 日程识别（d.140）：单批体积/条数上限，避免一次塞爆上下文 ── */
export const AI_DAYS = [7, 14, 30];

export const AI_BATCH_CHARS = 2600;

export const AI_BATCH_MESSAGES = 22;

export const AI_MAX_BATCHES = 12;

export const AI_MAX_CONVS = 60;

export const AI_MAX_MSGS_PER_CONV = 120;

export const AI_MAX_ITEMS = 80;

export const AI_KINDS = [
  ["task", "任务"],
  ["meeting", "会议"],
  ["activity", "活动"],
  ["exam", "考试"],
  ["signup", "报名"],
  ["payment", "缴费"],
  ["other", "其他"],
];

export const AI_KIND_LABELS = Object.fromEntries(AI_KINDS);

export const AI_PROFILE_PLACEHOLDER =
  "例：我是付梓杨，在 XX 大学读研，群里叫我「小付」。只关心课程/组会/实习/社团活动与缴费截止；广告、闲聊、抽奖一律忽略。";
