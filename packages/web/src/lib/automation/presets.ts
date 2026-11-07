import { ALL_WEEKDAYS, validateDraft, type AutomationDraft } from "./model.js";

/**
 * 自动化的「开箱即用预设」（d.76）。
 *
 * 为什么要有它：新建自动化原本要自己选动作、挑来源、填时间、勾全量/导出——
 * 大多数人的需求其实只有四种固定组合。预设把它们做成一键创建，把「配置表单」
 * 降级成高级入口；建完仍可在列表里改（预设只是草稿，不是不可变模板）。
 *
 * 约束：预设必须是**合法草稿**（`validateDraft` 通过），否则一键创建会失败；
 * 单测逐条钉住这一点，改时间/来源时不会悄悄造出存不进去的草稿。
 */
export interface AutomationPreset {
  id: string;
  /** 卡片标题（也是任务名）。 */
  label: string;
  /** 一句话说明做什么。 */
  description: string;
  /** 什么时候跑（卡片上直接可读）。 */
  scheduleText: string;
  draft: AutomationDraft;
}

function daily(time: string, weekdays: readonly number[] = ALL_WEEKDAYS): AutomationDraft["schedule"] {
  return { type: "daily", time, weekdays: [...weekdays] };
}

export const AUTOMATION_PRESETS: readonly AutomationPreset[] = [
  {
    id: "daily-sync",
    label: "每日同步归档",
    description: "每天把 QQ / 微信的新消息同步进本机归档。",
    scheduleText: "每天 08:00",
    draft: {
      name: "每日同步归档",
      kind: "infohub.sync",
      schedule: daily("08:00"),
      sync: { sources: ["qq", "wechat"], full: false, archive: false },
    },
  },
  {
    id: "interval-sync",
    label: "每 2 小时增量同步",
    description: "白天高频同步，聊天记录不会积压太久。",
    scheduleText: "每 2 小时",
    draft: {
      name: "每 2 小时增量同步",
      kind: "infohub.sync",
      schedule: { type: "interval", minutes: 120 },
      sync: { sources: ["qq", "wechat"], full: false, archive: false },
    },
  },
  {
    id: "daily-agenda",
    label: "每天早上重扫日程",
    description: "把归档里的日程表重新扫一遍，临期事项早一点发现。",
    scheduleText: "每天 07:30",
    draft: {
      name: "每天早上重扫日程",
      kind: "infohub.agenda",
      schedule: daily("07:30"),
      sync: { sources: [], full: false, archive: false },
    },
  },
  {
    id: "weekly-export",
    label: "每周日导出知识库",
    description: "同步归档并导出到 InfoHub 配置的 Obsidian 目录。",
    scheduleText: "每周日 20:00",
    draft: {
      name: "每周日导出知识库",
      kind: "infohub.sync",
      schedule: daily("20:00", [0]),
      sync: { sources: ["qq", "wechat"], full: false, archive: true },
    },
  },
];

/** 预设里存的是草稿模板；创建前深拷贝，避免 store/校验拿到共享引用。 */
export function presetDraft(preset: AutomationPreset): AutomationDraft {
  const { draft } = preset;
  return {
    name: draft.name,
    kind: draft.kind,
    schedule:
      draft.schedule.type === "daily"
        ? { type: "daily", time: draft.schedule.time, weekdays: [...draft.schedule.weekdays] }
        : { type: "interval", minutes: draft.schedule.minutes },
    sync: { ...draft.sync, sources: [...draft.sync.sources] },
  };
}

/** 预设草稿必须能通过正常校验（防止改预设时造出存不进去的任务）。 */
export function validatePresets(presets: readonly AutomationPreset[] = AUTOMATION_PRESETS): string[] {
  const errors: string[] = [];
  for (const preset of presets) {
    const invalid = validateDraft(presetDraft(preset));
    if (invalid) errors.push(`${preset.id}: ${invalid}`);
  }
  return errors;
}

export function presetById(id: string): AutomationPreset | undefined {
  return AUTOMATION_PRESETS.find((preset) => preset.id === id);
}
