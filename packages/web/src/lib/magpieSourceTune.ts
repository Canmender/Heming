/**
 * 来源的调流（可选）：并发、每分钟请求、排队、额度用完后的休息、连续失败的休息上限。
 *
 * 这几项都落在内核 provider 上（不是 provider set 的键，而是各自一条子命令）：
 *   magpie provider at-once <id> <n|off|default>
 *   magpie provider rpm <id> <n|off>
 *   magpie provider queue <id> <length> [seconds]
 *   magpie provider quota-rest <id> <30m|6h|7d|default>
 *   magpie provider rest-cap <id> <1m|30m|6h|1d|off|default>
 * 见 vendor/magpie-core/internal/cli/providers_cli.go 的 atOnceCmd / rpmCmd / queueCmd /
 * quotaRestCmd / restCapCmd。默认值（off / 不限 / 内核自己的 15 分钟与 10 分钟）不在这里重复，
 * 留空就是「这次不改」——和「改回默认」是两件事。
 */

export type SourceTuneKey = "atOnce" | "rpm" | "queue" | "quotaRest" | "restCap";

export interface SourceTuneOption {
  value: string;
  label: string;
}

export interface SourceTuneField {
  key: SourceTuneKey;
  label: string;
  hint: string;
  /** 有选项就渲染成下拉；没有就是输入框。 */
  options?: SourceTuneOption[];
  placeholder?: string;
}

const WHOLE = /^\d+$/;

export const SOURCE_TUNE_FIELDS: SourceTuneField[] = [
  {
    key: "atOnce",
    label: "同时用几个账号",
    hint: "多账号时先上几个，其余排队等；不限就都上",
    options: [
      { value: "off", label: "不限（都上）" },
      { value: "2", label: "2 个" },
      { value: "3", label: "3 个" },
      { value: "5", label: "5 个" },
    ],
  },
  {
    key: "rpm",
    label: "每分钟请求",
    hint: "每个账号每分钟最多发几个；免费模型常要 20",
    placeholder: "如 20（留空不改）",
  },
  {
    key: "queue",
    label: "排队",
    hint: "每个账号排队几个、最多等几秒（写 20:30；只写 20 就不限等待）",
    placeholder: "如 20:30（留空不改）",
  },
  {
    key: "quotaRest",
    label: "额度用完后歇多久",
    hint: "厂商说没额度、又没说什么时候回来时，这把 Key 歇多久",
    options: [
      { value: "15m", label: "15 分钟" },
      { value: "30m", label: "半小时" },
      { value: "6h", label: "6 小时" },
      { value: "1d", label: "1 天" },
      { value: "default", label: "回到默认（15 分钟）" },
    ],
  },
  {
    key: "restCap",
    label: "连续失败最多歇多久",
    hint: "老是失败或被限流时，最多让它歇这么久",
    options: [
      { value: "1m", label: "1 分钟" },
      { value: "30m", label: "半小时" },
      { value: "2h", label: "2 小时" },
      { value: "1d", label: "1 天" },
      { value: "off", label: "不歇（失败也继续试）" },
      { value: "default", label: "回到默认（10 分钟）" },
    ],
  },
];

/** 排队那格：`20` 或 `20:30`。返回 null 表示看不懂。 */
function parseQueue(value: string): [string, string | null] | null {
  const parts = value.split(":").map((item) => item.trim());
  if (parts.length > 2) return null;
  if (!WHOLE.test(parts[0] ?? "")) return null;
  if (parts.length === 2) {
    if (!WHOLE.test(parts[1] ?? "")) return null;
    return [parts[0], parts[1]];
  }
  return [parts[0], null];
}

/**
 * 一条子命令，或者 null（留空 / 看不懂）。
 * 看不懂的由 sourceTuneRejected 说出来，不静默吞掉。
 */
export function sourceTuneCommand(
  id: string,
  key: SourceTuneKey,
  value: string,
): string[] | null {
  const provider = id.trim();
  const raw = value.trim();
  if (!provider || !raw) return null;

  switch (key) {
    case "atOnce":
      return raw === "off" || WHOLE.test(raw) ? ["provider", "at-once", provider, raw] : null;
    case "rpm":
      return raw === "off" || WHOLE.test(raw) ? ["provider", "rpm", provider, raw] : null;
    case "queue": {
      const parsed = parseQueue(raw);
      if (!parsed) return null;
      const [length, seconds] = parsed;
      return seconds === null
        ? ["provider", "queue", provider, length]
        : ["provider", "queue", provider, length, seconds];
    }
    case "quotaRest":
      return ["provider", "quota-rest", provider, raw];
    case "restCap":
      return ["provider", "rest-cap", provider, raw];
    default:
      return null;
  }
}

/**
 * 把填过的项换成一组子命令：按 SOURCE_TUNE_FIELDS 的顺序，一次只发改过的那几条。
 * 留空的项不发——「不改」和「改回默认」不是一回事。
 */
export function sourceTuneCommands(id: string, values: Partial<Record<SourceTuneKey, string>>): string[][] {
  const commands: string[][] = [];
  for (const field of SOURCE_TUNE_FIELDS) {
    const command = sourceTuneCommand(id, field.key, values[field.key] ?? "");
    if (command) commands.push(command);
  }
  return commands;
}

/** 填了但看不懂的项，按字段顺序给出标签，好让页面直接说是哪一格。 */
export function sourceTuneRejected(values: Partial<Record<SourceTuneKey, string>>): string[] {
  const rejected: string[] = [];
  for (const field of SOURCE_TUNE_FIELDS) {
    const raw = (values[field.key] ?? "").trim();
    if (!raw) continue;
    if (!sourceTuneCommand("id", field.key, raw)) rejected.push(field.label);
  }
  return rejected;
}
