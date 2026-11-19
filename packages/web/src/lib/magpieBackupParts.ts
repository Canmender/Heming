/**
 * 备份与恢复「带上什么 / 覆盖什么」：把内核的 flag 反过来讲给人听。
 *
 * 内核的默认值不统一：`magpie backup` 默认**带** Key、**带**技能与 MCP 库、**不带**订阅与插件的登录；
 * `magpie restore` 则是三样全恢复。命令行里记这组正反面太费劲，页面就按「这块要不要」来勾，
 * 由这里翻译成 `--no-keys` / `--sign-ins` 这类 flag。
 */

/** 备份时可选的三块。 */
export type BackupPartKey = "keys" | "library" | "signIns";
/** 恢复时可选的三块（与备份同一套名字，但 agents 只在恢复这头有）。 */
export type RestorePartKey = "agents" | "library" | "signIns";

export interface BackupPart<K extends string> {
  key: K;
  label: string;
  /** 一行说明：勾/不勾分别意味着什么。 */
  hint: string;
  /** 摘要里用的短名。 */
  short: string;
  /** 默认带不带。 */
  byDefault: boolean;
  /** 勾上才加这个 flag（when），还是取消才加（unless）。 */
  mode: "when" | "unless";
  flag: string;
}

export const BACKUP_PARTS: BackupPart<BackupPartKey>[] = [
  {
    key: "keys",
    label: "来源的 Key",
    hint: "不勾也照样备份地址与模型选择，只是拿回来要重新填 Key。",
    short: "Key",
    byDefault: true,
    mode: "unless",
    flag: "--no-keys",
  },
  {
    key: "library",
    label: "技能与 MCP 库",
    hint: "技能、MCP 服务器、子代理与钩子；不勾就只备份来源与账号。",
    short: "技能库",
    byDefault: true,
    mode: "unless",
    flag: "--no-library",
  },
  {
    key: "signIns",
    label: "订阅与插件的登录",
    hint: "带上这些登录意味着：拿到文件又知道口令的人，就能用这些账号。",
    short: "登录",
    byDefault: false,
    mode: "when",
    flag: "--sign-ins",
  },
];

export const RESTORE_PARTS: BackupPart<RestorePartKey>[] = [
  {
    key: "agents",
    label: "本机工具的模型设置",
    hint: "各工具配置里写进去的模型；不勾就只恢复来源与账号。",
    short: "工具设置",
    byDefault: true,
    mode: "unless",
    flag: "--no-agents",
  },
  {
    key: "library",
    label: "技能与 MCP 库",
    hint: "备份里带的技能与 MCP；不勾就不动本机现有的。",
    short: "技能库",
    byDefault: true,
    mode: "unless",
    flag: "--no-library",
  },
  {
    key: "signIns",
    label: "订阅与插件的登录",
    hint: "不勾就不用备份里的登录覆盖本机现在登着的账号。",
    short: "登录",
    byDefault: true,
    mode: "unless",
    flag: "--no-sign-ins",
  },
];

function defaults<K extends string>(parts: BackupPart<K>[]): Record<K, boolean> {
  const out = {} as Record<K, boolean>;
  for (const part of parts) out[part.key] = part.byDefault;
  return out;
}

/** 三块默认状态（新建备份）。 */
export function defaultBackupParts(): Record<BackupPartKey, boolean> {
  return defaults(BACKUP_PARTS);
}

/** 三块默认状态（恢复）。 */
export function defaultRestoreParts(): Record<RestorePartKey, boolean> {
  return defaults(RESTORE_PARTS);
}

function flagsOf<K extends string>(parts: BackupPart<K>[], values: Record<K, boolean>): string[] {
  const flags: string[] = [];
  for (const part of parts) {
    const on = values[part.key];
    if (part.mode === "when" ? on : !on) flags.push(part.flag);
  }
  return flags;
}

/** `magpie backup [flag…] <file>`。 */
export function backupArgs(file: string, values: Record<BackupPartKey, boolean>): string[] {
  return ["backup", ...flagsOf(BACKUP_PARTS, values), file].filter((part) => part !== "");
}

/** `magpie restore [flag…] <file>`。 */
export function restoreArgs(file: string, values: Record<RestorePartKey, boolean>): string[] {
  return ["restore", ...flagsOf(RESTORE_PARTS, values), file].filter((part) => part !== "");
}

function describe<K extends string>(parts: BackupPart<K>[], values: Record<K, boolean>, verb: string): string {
  const words = parts.map((part) => `${values[part.key] ? verb : `不${verb}`}${part.short}`);
  return words.join("、");
}

/** 「带 Key、带技能库、不带登录」——新建备份时给一句人话。 */
export function describeBackupParts(values: Record<BackupPartKey, boolean>): string {
  return describe(BACKUP_PARTS, values, "带");
}

/** 「覆盖工具设置、覆盖技能库、不覆盖登录」——恢复前给一句人话。 */
export function describeRestoreParts(values: Record<RestorePartKey, boolean>): string {
  return describe(RESTORE_PARTS, values, "覆盖");
}
