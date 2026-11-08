import {
  DEFAULT_DAILY_CONFIG,
  dailyNotePath,
  resolveDailyConfig,
  type DailyConfig,
} from "../../lib/vault/daily.js";
import type { VaultEntry } from "../../lib/vault/types.js";

/**
 * 知识库界面的日记设置：**只负责存**（按库 id 落 localStorage），
 * 路径与格式计算全部走引擎 `lib/vault/daily.ts`——`dailyNotePath` / `resolveDailyConfig`
 * 是唯一口径，界面不再自己拼日期与目录。
 *
 * 为什么设置本身不写进 vault 文件：它属于界面偏好，写进 .md 会污染用户笔记；
 * 也不进主进程注册表，避免为一张设置卡加一个 IPC。
 */

export type { DailyConfig };

export const DAILY_CONFIG_KEY = "heming.vault.daily.v1";

/** 默认配置直接取引擎的默认值（不要在界面再写一份）。 */
export const UI_DEFAULT_DAILY_CONFIG: DailyConfig = { ...DEFAULT_DAILY_CONFIG };

/** 读配置：按库 id 存；坏 JSON / 存储不可用/非法值一律交给引擎回退。 */
export function readDailyConfig(
  vaultId: string | null,
  storage: Pick<Storage, "getItem"> | null = defaultStorage(),
): DailyConfig {
  if (!storage || !vaultId) return { ...UI_DEFAULT_DAILY_CONFIG };
  try {
    const raw = storage.getItem(DAILY_CONFIG_KEY);
    if (!raw) return { ...UI_DEFAULT_DAILY_CONFIG };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // 引擎负责校验（文件夹非法字符、格式必须可反解），这里只喂原始值
    return resolveDailyConfig(parsed?.[vaultId] as Partial<DailyConfig> | undefined).config;
  } catch {
    return { ...UI_DEFAULT_DAILY_CONFIG };
  }
}

/** 写配置（保留其它库的条目）；存不下时只影响本次会话，不抛。 */
export function saveDailyConfig(
  vaultId: string | null,
  config: Partial<DailyConfig>,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage(),
): DailyConfig {
  const resolved = resolveDailyConfig(config).config;
  if (!storage || !vaultId) return resolved;
  try {
    const raw = storage.getItem(DAILY_CONFIG_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    all[vaultId] = resolved;
    storage.setItem(DAILY_CONFIG_KEY, JSON.stringify(all));
  } catch {
    /* 隐私模式/配额满：本次生效即可 */
  }
  return resolved;
}

/** 今天（或任意日期）的日记 rel：直接调引擎。 */
export function dailyRelOf(config: DailyConfig, date: Date = new Date()): string {
  return dailyNotePath(config, date);
}

/** 没有模板时的新日记正文：至少带 date frontmatter 与一个标题。 */
export const DEFAULT_DAILY_TEMPLATE = "---\ndate: {{date}}\n---\n\n# {{date}}\n\n";

/** 模板候选：从目录树里找 `templates/*.md`（只认一层目录，够用且可预期）。 */
export function templatesOfTree(entries: readonly VaultEntry[]): { rel: string; label: string }[] {
  const dir = entries.find((entry) => entry.kind === "dir" && entry.rel === "templates");
  if (!dir?.children) return [];
  return dir.children
    .filter((entry) => entry.kind === "md")
    .map((entry) => ({ rel: entry.rel, label: entry.name.replace(/\.md$/i, "") }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
