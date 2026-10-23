import { utf8Length } from "./memory/storage.js";
import type { StorageLike } from "./memory/types.js";

/**
 * 本机存储水位（d.31 §2.2 的读侧）：把「谁吃掉了配额」摊开成模块明细。
 *
 * 背景：localStorage 是**同源一条预算**（Chromium 下限 5MB），而本仓有 40+ 个
 * `heming.*` 键，各处 `*BYTE_LIMIT` 各自为政、互不知情。写不下时 `setItem` 抛
 * `QuotaExceededError`，各处的兜底是「回退空表 / 静默不落」——用户看到的是
 * 「记忆权重无故退回 ×1、任务记录消失」，界面上却没有任何水位。
 *
 * 本文件**只读不删**：统计口径是「各键值的 UTF-8 字节数按模块汇总」，
 * 清理入口与界面在别处。
 *
 * ★ 关于「不读内容」：`localStorage` 只有 `length` / `key(i)` 能列键名，
 * 没有「只看键名不看值」的 API，所以算字节数必然要 `getItem`。这里的「不读内容」
 * 指的是**不解析、不缓存、不跨函数传递**明文（`heming.msgCache.*` 里是解密后的
 * 消息正文）——每个键只 `getItem` 一次，算完字节就把值丢掉。
 */

/** 保守默认配额（Chromium 同源 localStorage 的常见下限）。 */
export const DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024;

/** 配额探测用的临时键（探测结束必须删掉，否则本机白占几 MB）。 */
const QUOTA_PROBE_KEY = "heming.storage.probe";

/** 单块写入大小：256KB。写满 5MB 约 20 次，量得够准又不会把盘写爆。 */
const PROBE_CHUNK_BYTES = 256 * 1024;

/** 探测写入量上限：超过就认为「测不动了」（纯防呆，正常配额远小于此）。 */
const PROBE_MAX_BYTES = 64 * 1024 * 1024;

/** 没命中任何前缀的键归这里（含 `heming.token` 这类杂项）。 */
export const OTHER_MODULE = "其它";

/** 一条「键名前缀 → 模块名」的规则。 */
export interface StorageModuleRule {
  /** 键名前缀（`startsWith` 匹配）。 */
  prefix: string;
  /** 模块名（界面直接显示）。 */
  module: string;
}

/**
 * 键前缀 → 模块名。**显式映射表，不做模糊匹配**。
 *
 * 为什么显式：模糊匹配（「键里含 memory 就算记忆」）会把 `heming.memory.probe`、
 * `heming.notifications.v1` 这类键归错地方，用户按着提示去清理却找不到东西。
 * 键名是本仓自己定的，映射表也是本仓自己维护的——一一对应最省心。
 *
 * 为什么按**前缀最长优先**匹配：`heming.memory.` 与 `heming.memory.usage`
 * 都是合法前缀，先命中短的会把用量账本算进「记忆」，用户去清理记忆时
 * 账本纹丝不动。表里同名的模块（`heming.tasks.` 与 `heming.taskTemplates.`）
 * 则不受影响——它们互不为前缀。
 */
export const STORAGE_MODULE_RULES: readonly StorageModuleRule[] = [
  { prefix: "heming.msgCache.", module: "明文缓存" },
  { prefix: "heming.recallLog.", module: "辅助账本" },
  { prefix: "heming.memory.recallLog", module: "辅助账本" },
  { prefix: "heming.memory.usage", module: "辅助账本" },
  { prefix: "heming.memory.", module: "记忆" },
  { prefix: "heming.tasks.", module: "任务" },
  { prefix: "heming.taskTemplates.", module: "任务" },
  { prefix: "heming.e2e.", module: "加密会话" },
  { prefix: "heming.x3dh.", module: "加密会话" },
  { prefix: "heming.mcp.", module: "接口与 Registry" },
  { prefix: "heming.mcpRegistry.", module: "接口与 Registry" },
  { prefix: "heming.selfEdit.", module: "自我修改" },
  { prefix: "heming.selfAudit.", module: "自我修改" },
  { prefix: "heming.skills.", module: "技能" },
  { prefix: "heming.skillBindings.", module: "技能" },
  { prefix: "heming.skillAssignments.", module: "技能" },
  { prefix: "heming.hitl.", module: "HITL" },
  { prefix: "heming.notifications.", module: "通知" },
];

/**
 * 规则按前缀长度降序（等长的保持表序，排序稳定）。
 * 最长前缀优先 ⇒ `heming.memory.usage` 不会被 `heming.memory.` 抢走。
 */
const RULES_BY_LENGTH_DESC: readonly StorageModuleRule[] = [...STORAGE_MODULE_RULES].sort(
  (a, b) => b.prefix.length - a.prefix.length,
);

/** 模块的规范顺序（用于明细里字节数相同时的稳定排序）。 */
const MODULE_ORDER: readonly string[] = [
  ...new Set(STORAGE_MODULE_RULES.map((rule) => rule.module)),
  OTHER_MODULE,
];

/** 键名 → 模块名（最长前缀优先；没命中任何前缀归「其它」）。 */
export function moduleOf(key: string): string {
  for (const rule of RULES_BY_LENGTH_DESC) {
    if (key.startsWith(rule.prefix)) return rule.module;
  }
  return OTHER_MODULE;
}

/**
 * 存储探针：把「列键名」与「取值」两个能力凑成一个形状。
 *
 * 为什么要有它：本仓的记忆/任务存储抽象 `StorageLike` 只有
 * `getItem/setItem/removeItem`，**没有列键名的能力**；浏览器 `localStorage`
 * 虽有 `length`/`key(i)`，类型却是 DOM 的 `Storage`。两者形状不同，
 * 统一成这两个方法后，测试就能喂假数据而不必真去动 localStorage。
 */
export interface StorageProbe {
  /** 全部键名。 */
  keys(): string[];
  /** 取某个键的原始字符串（用于算字节数）。 */
  getItem(k: string): string | null;
}

/** 空探针：没有 localStorage 时（SSR / Node）用它兜底。 */
const EMPTY_PROBE: StorageProbe = { keys: () => [], getItem: () => null };

/** 包装一个 DOM `Storage`（浏览器 localStorage 就是它）：`length` + `key(i)` 列键名。 */
export function probeOfStorage(storage: Storage): StorageProbe {
  return {
    keys: () => {
      const out: string[] = [];
      // 用 length 取个数、key(i) 取名字——这两步都不碰值。
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key != null) out.push(key);
      }
      return out;
    },
    getItem: (k) => storage.getItem(k),
  };
}

/** 浏览器 localStorage 探针；本机没有 localStorage 时退化为空探针（绝不抛）。 */
export function browserProbe(): StorageProbe {
  const store = resolveLocalStorage();
  return store ? probeOfStorage(store) : EMPTY_PROBE;
}

/**
 * 「已知键名清单 + 一个 StorageLike」的探针。
 *
 * 给那些拿得到键名清单、但存储只有 `StorageLike` 形状的调用方用
 * （比如降级成纯内存的记忆存储）——此时没有 `key(i)` 可用，键名得由外面给。
 */
export function probeFromKeys(storage: StorageLike, keys: readonly string[]): StorageProbe {
  const list = [...keys];
  return {
    keys: () => [...list],
    getItem: (k) => {
      try {
        return storage.getItem(k);
      } catch {
        return null;
      }
    },
  };
}

/** 测试用探针：一张内存表（键 → 原始字符串）。 */
export function probeFrom(entries: Record<string, string>): StorageProbe {
  const map = new Map(Object.entries(entries));
  return {
    keys: () => [...map.keys()],
    getItem: (k) => map.get(k) ?? null,
  };
}

/** 单个模块的用量。 */
export interface StorageUsageEntry {
  /** 模块名（中文，界面直接显示）。 */
  module: string;
  /** 该模块占用的字节数。 */
  bytes: number;
  /** 该模块下的键数。 */
  keys: number;
}

/** 本机存储用量的总览。 */
export interface StorageUsage {
  /** 逐模块明细，按字节数降序。 */
  entries: StorageUsageEntry[];
  /** 总字节数。 */
  totalBytes: number;
  /** 总键数。 */
  totalKeys: number;
  /** 估算配额字节数（见 `probeQuotaBytes`）。 */
  quotaBytes: number;
  /** 估算是否可信（false = 用的保守默认值，没实测过）。 */
  quotaEstimated: boolean;
}

/**
 * 统计本机存储用量。
 *
 * @param probe 存储探针（默认用浏览器的 localStorage）。
 * @param quotaBytes 实测配额；传 null / 不传 ⇒ 用保守默认 5MB 并标 `quotaEstimated`。
 */
export function measureStorageUsage(
  probe?: StorageProbe,
  quotaBytes?: number | null,
): StorageUsage {
  const p = probe ?? browserProbe();
  const buckets = new Map<string, { bytes: number; keys: number }>();
  let totalBytes = 0;
  let totalKeys = 0;

  let keys: string[] = [];
  try {
    keys = typeof p?.keys === "function" ? (p.keys() ?? []) : [];
  } catch {
    keys = []; // 隐私模式等：读不出来就当空的，绝不把界面搞崩
  }

  for (const key of keys) {
    let raw: string | null = null;
    try {
      // 每个键**只读一次**：值可能很大（明文缓存是解密后的消息正文），
      // 重复读等于把正文反复拉进内存。算完字节就丢，不缓存、不外传。
      raw = p.getItem(key);
    } catch {
      raw = null;
    }
    const bytes = raw == null ? 0 : utf8Length(raw);
    const module = moduleOf(key);
    const bucket = buckets.get(module) ?? { bytes: 0, keys: 0 };
    bucket.bytes += bytes;
    bucket.keys += 1;
    buckets.set(module, bucket);
    totalBytes += bytes;
    totalKeys += 1;
  }

  const entries: StorageUsageEntry[] = [...buckets.entries()]
    .map(([module, bucket]) => ({ module, bytes: bucket.bytes, keys: bucket.keys }))
    .sort((a, b) => b.bytes - a.bytes || moduleRank(a.module) - moduleRank(b.module));

  const measured =
    typeof quotaBytes === "number" && Number.isFinite(quotaBytes) && quotaBytes > 0;
  return {
    entries,
    totalBytes,
    totalKeys,
    quotaBytes: measured ? quotaBytes : DEFAULT_QUOTA_BYTES,
    quotaEstimated: !measured,
  };
}

/** 模块在规范顺序里的序号（字节数相同时的稳定 tie-break）。 */
function moduleRank(module: string): number {
  const index = MODULE_ORDER.indexOf(module);
  return index < 0 ? MODULE_ORDER.length : index;
}

/**
 * 实测配额：往一个临时键逐块写数据，直到 `setItem` 抛 `QuotaExceededError`。
 *
 * 返回**总配额**（= 探测时写进去的字节数 + 当时的已用量），与默认值的口径一致——
 * 默认的 5MB 是「同源总容量」，若这里返回「剩余可用」就与它不同口径，
 * 水位条会永远显示接近满。
 *
 * ★ 代价：为了测出配额要写满几 MB。**所以只在用户点「重新检测」时调用**，
 * 绝不自动跑。探针键写完必删（哪怕中途失败）。
 *
 * @returns 实测的总配额字节数；测不出来（隐私模式 / 配额已满 / 无 localStorage）返回 null。
 */
export function probeQuotaBytes(storage?: Storage): number | null {
  const store = storage ?? resolveLocalStorage();
  if (!store) return null;
  try {
    // 先估当前用量：① 用来把「可用」换算成「总量」；② 配额已满时不白写。
    const used = measureStorageUsage(probeOfStorage(store)).totalBytes;
    if (used >= DEFAULT_QUOTA_BYTES) {
      // 已经过了保守下限：再写要么立刻抛、要么要写好几 MB 才抛，两种都不划算。
      // 老实回落 5MB 估算（界面标注「估算」），总比把本机写满强。
      return null;
    }

    let written = 0;
    // ★ 每块用**不同的键**：反复写同一个键只是覆盖它，用量永远停在 256KB，
    // 探测会一路空转到 PROBE_MAX_BYTES 才放弃（表现为「点了重新检测没反应」）。
    // 分键写入才能真正把用量推上去。清理时逐个删。
    const probeKeys: string[] = [];
    try {
      for (let i = 0; ; i += 1) {
        const key = `${QUOTA_PROBE_KEY}.${i}`;
        try {
          store.setItem(key, "a".repeat(PROBE_CHUNK_BYTES));
        } catch (err) {
          if (isQuotaError(err)) break; // 写满了 ⇒ 剩余空间就这么多
          return null; // 其它错误（隐私模式等）⇒ 测不了
        }
        probeKeys.push(key);
        written += PROBE_CHUNK_BYTES;
        if (written >= PROBE_MAX_BYTES) return null; // 测不动：超出防呆上限
      }
    } finally {
      for (const key of probeKeys) {
        try {
          store.removeItem(key); // 探针键必须清掉，否则白占几 MB
        } catch {
          /* 删不掉也只能这样 */
        }
      }
      try {
        store.removeItem(QUOTA_PROBE_KEY); // 兼容旧实现留下的单键
      } catch {
        /* 同上 */
      }
    }

    // 连第一块都写不进 ⇒ 配额已被现有数据占满，测不出数。
    if (written <= 0) return null;
    return used + written;
  } catch {
    return null; // 探测过程绝不能把异常抛给界面
  }
}

/** 是不是「配额写满」这一类错误（DOMException 名 / 老式 code 22 都认）。 */
function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { name, code } = err as { name?: unknown; code?: unknown };
  return name === "QuotaExceededError" || code === 22;
}

/** 取本机 localStorage；访问本身可能抛（隐私模式），所以整段包 try。 */
function resolveLocalStorage(): Storage | null {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch {
    /* 隐私模式下访问 localStorage 可能直接抛 SecurityError */
  }
  return null;
}
