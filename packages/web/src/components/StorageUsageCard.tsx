import { useCallback, useState, type SVGProps } from "react";
import { ConfirmDialog } from "./ConfirmDialog.js";
import {
  DEFAULT_QUOTA_BYTES,
  measureStorageUsage,
  probeOfStorage,
} from "../lib/storageUsage.js";
import {
  msgCacheEncryptionStates,
  type MsgCacheEncryptionReason,
  type MsgCacheEncryptionState,
} from "../lib/e2eSession.js";
import { isMsgCacheAuxKey } from "../lib/e2e/cacheEnvelope.js";
import type { StorageLike } from "../lib/memory/types.js";

/**
 * 本机存储水位卡（d.31 · P1-1 ①「水位可见」+ ②b「一键清理」）。
 *
 * 为什么要有这张卡：本机存储（localStorage）是**一条单源预算**（Chromium 同源约 5MB），
 * 而各模块各自为政地写、各自为政地设上限——超配额时 `setItem` 抛 `QuotaExceededError`，
 * 各处的兜底都是「回退空表 / 静默不落」。用户看到的是「记忆权重无故退回 ×1」
 * 「任务记录消失」这类无法解释的降级，界面上却连一条水位都没有。
 *
 * ★ 统计只读**键名**与**字节数**，不读内容也不留内容：
 * 消息缓存（`heming.msgCache.*`）里是解密后的消息正文（有桥时是逐条密文），
 * 统计不该把它复制到别处。所以每个键只 `getItem` 一次，算出字节数就丢；
 * 「消息缓存是否已加密」也复用这一次读取的结果（见 `readSnapshot`）。
 *
 * ★ 只给数字不给出口等于让用户对着一个数字发愁，所以这张卡同时给清理入口——
 * 但**只给可再生的**（消息缓存、任务记录）删：记忆条目是用户资产，
 * E2E 私钥与棘轮丢了就是永久丢，这两类绝不提供删除入口；
 * 迁移期备份键（旧明文/旧密文）可能是唯一可恢复副本，也不提供清理入口。
 */

/** 保守配额估计：Chromium 同源配额下限 5MB。实测前用它，并在界面上标明「估算」。 */
const ESTIMATED_QUOTA_BYTES = DEFAULT_QUOTA_BYTES;

/** 探测配额时用的临时键前缀（写完立即删；统计时也跳过，避免探测途中污染读数）。 */
const PROBE_KEY_PREFIX = "heming.storageQuota.probe";

/** 探测步长：64KB。够细（探测误差 < 64KB），又不至于写太多次。 */
const PROBE_CHUNK_BYTES = 64 * 1024;

/**
 * 探测上限：配额跟着磁盘走（Chromium 取磁盘的 10%），大机器上可能远大于 5MB。
 * 不设上限就可能往盘里灌几十 GB，所以封顶 32MB：
 * 触顶还没写满 ⇒ 已知配额**大于** 32MB，用 32MB 当**下限**展示（占比会偏保守地高估）。
 */
const PROBE_CAP_BYTES = 32 * 1024 * 1024;

/** 水位阈值：≥80% 变黄，≥95% 变红。 */
const WARN_RATIO = 0.8;
const DANGER_RATIO = 0.95;

/**
 * 可枚举的存储接口。
 *
 * 为什么不用现成的 `StorageLike`：统计要「列出全部键名」，
 * 而 `StorageLike` 只有 get/set/remove——没有 `length` / `key(i)`，
 * 也就没法知道本机一共存了多少键。
 */
export interface EnumerableStorage extends StorageLike {
  readonly length: number;
  key(index: number): string | null;
}

/** 一个模块的占用。 */
export interface StorageModuleUsage {
  /** 模块中文名。 */
  name: string;
  /** 该模块占用的 UTF-8 字节数。 */
  bytes: number;
  /** 该模块占用的键数。 */
  keys: number;
}

/** 一次统计的快照。 */
export interface StorageUsageSnapshot {
  /** 全部键的 UTF-8 字节总和。 */
  totalBytes: number;
  /** 按模块分组、**按字节数降序**（用户先看到最占地方的那个）。 */
  modules: StorageModuleUsage[];
  /** 键总数。 */
  keyCount: number;
}

/** 配额信息。 */
export interface QuotaInfo {
  /** 配额字节数。 */
  bytes: number;
  /** true = 保守估计（尚未实测）；false = 实测值。 */
  estimated: boolean;
  /** 实测触顶了没（配额比探测上限还大）。 */
  capped?: boolean;
}

/**
 * 遍历键名统计字节数。
 *
 * ★ 模块分组与字节口径**单一真源在 `lib/storageUsage.ts`**：那张前缀表曾经在
 * 这里另抄过一份，很快就和主模块分了岔（通知该归哪组、`memory.usage` 算记忆还是账本）。
 * 统计口径只能有一处，界面只负责把结果排版。
 *
 * ★ 每个键只读一次值（`getItem` 一次即丢），不解析、不留副本——
 * 消息缓存里是解密后的消息正文，统计不该把它带出存储层。
 * ★ 坏数据不许抛：某个键读不出来（隐私模式、配额异常）就当它占 0 字节继续，
 * 统计失败不该让整个设置区打不开。
 */
export function readStorageUsage(
  storage: EnumerableStorage,
  onKey?: (key: string, raw: string | null) => void,
): StorageUsageSnapshot {
  const usage = measureStorageUsage(probeOfStorage(storage as unknown as Storage), undefined, onKey);
  return {
    totalBytes: usage.totalBytes,
    keyCount: usage.totalKeys,
    modules: usage.entries.map((entry) => ({
      name: entry.module,
      bytes: entry.bytes,
      keys: entry.keys,
    })),
  };
}

/** 一次渲染要用的快照：水位数字 + 消息缓存的落盘状态。 */
interface UsageSnapshot {
  usage: StorageUsageSnapshot;
  cacheStates: Array<{ convId: string; state: MsgCacheEncryptionState }>;
}

/**
 * 统计 + 消息缓存加密状态，**共用同一次 `getItem`**（不为了状态再读一遍缓存值）。
 *
 * 只把 `heming.msgCache.*` 的原始值暂存到局部 Map，交给 `msgCacheEncryptionStates`
 * 判外壳（容器/明文/坏数据），算完即丢——不解析明文、不进 React state。
 */
function readSnapshot(storage: EnumerableStorage): UsageSnapshot {
  const cacheRaws = new Map<string, string | null>();
  const usage = readStorageUsage(storage, (key, raw) => {
    if (key.startsWith("heming.msgCache.")) cacheRaws.set(key, raw);
  });
  return { usage, cacheStates: msgCacheEncryptionStates(cacheRaws) };
}

/**
 * 实测配额：往临时键写数据，写到 `QuotaExceededError` 为止。
 *
 * ★ 绝不抛：探测失败（隐私模式、配额已满到连探针都写不进）就回落到 5MB 估算值。
 * ★ 写完把临时键删干净——探测是一次性的脚手架，不能留在用户数据里。
 * ★ 只能在用户点了「重新检测」时调用：探测要写入几 MB，
 * 打开设置区就自动探测等于擅自占满用户的盘。
 */
export function probeStorageQuota(storage: EnumerableStorage, usedBytes: number): QuotaInfo {
  const tempKeys: string[] = [];
  const chunk = "x".repeat(PROBE_CHUNK_BYTES);
  let written = 0;
  let hitCap = false;

  try {
    for (let i = 0; written < PROBE_CAP_BYTES; i++) {
      const key = `${PROBE_KEY_PREFIX}.${i}`;
      try {
        storage.setItem(key, chunk);
      } catch {
        // 写不进去了：已写入的字节数 ≈ 剩余可用空间
        break;
      }
      tempKeys.push(key);
      written += PROBE_CHUNK_BYTES;
      if (written >= PROBE_CAP_BYTES) hitCap = true;
    }
  } catch {
    /* 探测本身抛了：当作测不出来 */
  } finally {
    // 无论成败都清掉临时键
    for (const key of tempKeys) {
      try {
        storage.removeItem(key);
      } catch {
        /* 删不掉就只能留着，下次统计会跳过它 */
      }
    }
  }

  if (written === 0) {
    // 一个 64KB 都写不进去：多半是隐私模式或配额已满，测不出来。
    return { bytes: ESTIMATED_QUOTA_BYTES, estimated: true };
  }
  // 配额是「同源总量」：应用自己占的那部分也在里面，所以要把已用加回去。
  const total = written + usedBytes;
  if (hitCap) {
    // 没触顶就写满了上限：只知道配额 > 32MB，用上限当**下限**展示。
    return { bytes: Math.max(total, PROBE_CAP_BYTES), estimated: false, capped: true };
  }
  return { bytes: total, estimated: false };
}

/** 字节数 → 人类可读（KB/MB 保留两位小数，字节以下原样）。 */
export function formatBytes(bytes: number): string {
  const n = Math.max(0, Math.round(bytes));
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** 精确字节数（千分位）：用户要能对上「多少字节」这个数本身。 */
export function formatExactBytes(bytes: number): string {
  return String(Math.max(0, Math.round(bytes))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 清空目标：只列**可再生**的两类。 */
type ClearTarget = {
  kind: "cache" | "tasks";
  /** 按钮与确认框用的名字。 */
  label: string;
  /** 该目标落在哪个模块（用来算释放了多少）。 */
  module: string;
  /** 键名匹配。 */
  match: (key: string) => boolean;
  /** 确认框里说清楚「删了什么、能不能回来」。 */
  explain: string;
};

const CLEAR_TARGETS: Record<ClearTarget["kind"], ClearTarget> = {
  cache: {
    kind: "cache",
    label: "消息缓存",
    module: "消息缓存",
    // ★ 备份键（`.__heming_plaintext_backup` / `.__heming_undecryptable`）**不在清理范围**：
    //   它们可能是唯一可恢复的旧明文/旧密文副本，删了就永久没了（与 d.31「不可再生不给入口」同口径）。
    match: (key) => key.startsWith("heming.msgCache.") && !isMsgCacheAuxKey(key),
    explain:
      "会删除本机保存的消息缓存（每个会话一份；有桌面安全存储时是密文，浏览器端是明文）。" +
      "注意：清理后**只有链窗口内的近期消息**能重新拉取并解密；更早的消息本机若已无缓存，会永久显示为「无法解密」——" +
      "自己发出的消息尤其不可再生（发送链已推进，旧密钥无法再派生）。" +
      "迁移期的旧明文/旧密文备份键不在本次清理范围内。",
  },
  tasks: {
    kind: "tasks",
    label: "任务记录",
    module: "任务",
    match: (key) => key === "heming.tasks.v1",
    explain:
      "会删除本机的任务流水记录。任务记录只是本机流水，重新投递一次任务就能重建历史。",
  },
};

/** 系统安全存储的名字（与 d.36「密钥存储」卡同一口径，不写死某平台）。 */
function secureStorageName(): string {
  const platform = typeof window !== "undefined" ? window.heming?.platform : undefined;
  if (platform === "win32") return "Windows DPAPI";
  if (platform === "darwin") return "macOS 钥匙串";
  return "系统安全存储";
}

/** 未加密原因的一句话口径（Q1/Q2：如实说明，不谎报）。 */
function reasonText(reason: MsgCacheEncryptionReason | undefined): string {
  switch (reason) {
    case "no-bridge":
      return "浏览器端没有可用的系统安全存储";
    case "unavailable":
      return "本机安全存储不可用";
    case "encrypt-failed":
      return "加密失败";
    case "quota":
      return "配额不足——为保住消息，本次以明文保存";
    case "unreadable":
      return "无法解密（密文仍在，可能来自其他设备或系统账户）";
    case "backup-failed":
      return "迁移备份写入失败，暂未加密";
    case "pending-migration":
      return "旧明文待迁移";
    default:
      return "原因未知";
  }
}

/**
 * 消息缓存加密状态行：**已加密 / 未加密（原因）/ 无法解密** 三种如实口径。
 *
 * 不能把「本机解不开」写成「未加密」——磁盘上确实是密文，用户换回原账户还能读。
 */
/** 纯函数版状态行（导出供单测直接钉文案口径，界面只负责排版）。 */
export function encryptionStatusLine(
  states: Array<{ convId: string; state: MsgCacheEncryptionState }>,
): { text: string; tone: string } | null {
  // 「读不到值」不是「未加密」：不算进任何一类，避免把存储异常说成明文缓存。
  const visible = states.filter((s) => s.state.form !== "absent");
  if (visible.length === 0) return null;
  const encrypted = visible.filter((s) => s.state.encrypted).length;
  const unreadable = visible.filter(
    (s) => s.state.form === "unreadable" || s.state.reason === "unreadable",
  ).length;
  const plaintext = visible.filter(
    (s) => !s.state.encrypted && s.state.form !== "unreadable" && s.state.reason !== "unreadable",
  );
  const reasons = [...new Set(plaintext.map((s) => s.state.reason))];

  if (encrypted > 0 && unreadable === 0 && plaintext.length === 0) {
    return { text: `消息缓存已加密（${secureStorageName()}），磁盘上是逐条密文。`, tone: "text-muted" };
  }
  const parts: string[] = [];
  if (encrypted > 0) parts.push(`${encrypted} 个已加密`);
  if (unreadable > 0) parts.push(`${unreadable} 个无法解密`);
  if (plaintext.length > 0) {
    parts.push(`${plaintext.length} 个未加密（原因：${reasons.map(reasonText).join("；")}）`);
  }
  return { text: `消息缓存：${parts.join("，")}。`, tone: "text-amber-700" };
}

/**
 * 存储图标：细线 1.5px，与 `icons.tsx` 同一套画法。
 *
 * 为什么内联而不是加进 `icons.tsx`：那个文件不在本轮改动范围内，
 * 改它会与并行改动撞在一起；内联一份同规格的更省事。
 */
function StorageIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </svg>
  );
}

/** localStorage 适配：访问 `window.localStorage` 本身就可能抛（隐私模式）。 */
function browserStorage(): EnumerableStorage {
  try {
    const ls = window.localStorage;
    if (ls) {
      // 探针：确认可写可删（隐私模式下 setItem 会抛）
      const probe = `${PROBE_KEY_PREFIX}.probe`;
      ls.setItem(probe, "1");
      ls.removeItem(probe);
      return ls;
    }
  } catch {
    /* 隐私模式等 → 走空存储兜底 */
  }
  return emptyStorage();
}

/** 空存储兜底：localStorage 完全不可用时保证界面不炸（读数恒为 0）。 */
function emptyStorage(): EnumerableStorage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

/**
 * 本机存储水位卡。
 *
 * `storage` 可注入：便于测试用假存储构造极端读数（超 95% 之类），
 * 生产环境走 `window.localStorage`。
 */
export function StorageUsageCard({ storage }: { storage?: EnumerableStorage }) {
  // 用 useState 惰性初始化而不是 useMemo：拿存储这一步会做「写探针再删」的探测
  // （判断 localStorage 是否可写），属副作用，不该在每次渲染里重跑。
  const [store] = useState<EnumerableStorage>(() => storage ?? browserStorage());
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(() => readSnapshot(store));
  const usage = snapshot.usage;
  const encryptionLine = encryptionStatusLine(snapshot.cacheStates);
  const [quota, setQuota] = useState<QuotaInfo>({
    bytes: ESTIMATED_QUOTA_BYTES,
    estimated: true,
  });
  const [probing, setProbing] = useState(false);
  const [pending, setPending] = useState<ClearTarget["kind"] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setSnapshot(readSnapshot(store));
  }, [store]);

  const ratio = quota.bytes > 0 ? usage.totalBytes / quota.bytes : 0;
  const percent = ratio * 100;
  const level: "ok" | "warn" | "danger" =
    ratio >= DANGER_RATIO ? "danger" : ratio >= WARN_RATIO ? "warn" : "ok";

  const barColor =
    level === "danger" ? "bg-[#b42318]" : level === "warn" ? "bg-[#d97706]" : "bg-muted";
  const statusColor =
    level === "danger" ? "text-[#b42318]" : level === "warn" ? "text-[#b45309]" : "text-muted";
  const statusText =
    level === "danger"
      ? "本机存储快满了。继续写入很可能失败，记忆权重、任务记录会悄悄回退或消失，请立刻清理。"
      : level === "warn"
        ? "本机存储已用掉八成以上。再涨下去新数据可能写不进去（各处会静默不落），建议先清理可再生的内容。"
        : "本机存储还有余量，暂不需要清理。";

  /**
   * 重新检测配额：实测 + 刷新读数（探测可能顺带改变了占用）。
   *
   * ★ 先让「检测中…」渲染出来，再跑探测：探测是同步写最多 32MB 的阻塞操作，
   * 同一次事件里 setProbing(true) 后紧跟着 setProbing(false)，浏览器根本来不及画中间帧——
   * 用户看到的是「按钮点了没反应」。推迟到下一轮事件循环，文案才真的可见。
   * 探测算法本身不动（见 `probeStorageQuota`）。
   */
  const onProbe = () => {
    if (probing) return;
    setProbing(true);
    setTimeout(() => {
      try {
        const info = probeStorageQuota(store, usage.totalBytes);
        setQuota(info);
        setNotice(
          info.estimated
            ? "实测失败（浏览器可能处于隐私模式，或配额已满到探针都写不进去），已回落到 5.00 MB 估算值。"
            : info.capped
              ? `实测已达探测上限，配额不低于 ${formatBytes(info.bytes)}（真实配额可能更大）。`
              : `配额已实测：${formatBytes(info.bytes)}（${formatExactBytes(info.bytes)} 字节）。`,
        );
        refresh();
      } finally {
        setProbing(false);
      }
    }, 0);
  };

  /** 执行清理：只删可再生的键，然后重新统计刷新显示。 */
  const runClear = (kind: ClearTarget["kind"]) => {
    const target = CLEAR_TARGETS[kind];
    const before = usage.modules.find((m) => m.name === target.module)?.bytes ?? 0;

    // 先把键名收齐再删：边遍历边删会让索引错位，漏删后面的键。
    let count = 0;
    try {
      count = store.length;
    } catch {
      count = 0;
    }
    const victims: string[] = [];
    for (let i = 0; i < count; i++) {
      let key: string | null = null;
      try {
        key = store.key(i);
      } catch {
        continue;
      }
      if (key && target.match(key)) victims.push(key);
    }
    for (const key of victims) {
      try {
        store.removeItem(key);
      } catch {
        /* 删不掉（配额/权限）：跳过，不影响其余键 */
      }
    }

    const next = readSnapshot(store);
    setSnapshot(next);
    setPending(null);
    const after = next.usage.modules.find((m) => m.name === target.module)?.bytes ?? 0;
    const freed = Math.max(0, before - after);
    setNotice(
      freed > 0
        ? `已清理${target.label} ${victims.length} 项，释放约 ${formatBytes(freed)}。`
        : `已清理${target.label} ${victims.length} 项（本次没有可释放的空间）。`,
    );
  };

  return (
    <section aria-label="本机存储" className="mt-3 rounded-xl border border-line bg-white p-4 shadow-card">
      <div className="flex items-center gap-1.5 text-[12px] font-bold text-muted">
        <StorageIcon className="text-[#999]" />
        本机存储
      </div>
      <div className="mt-1 ui-caption">
        本机存储（浏览器配额）是一条单源预算，写满后新数据会静默丢失。这条水位告诉你还剩多少、是谁占的。
      </div>

      {/* 水位条 */}
      <div className="mt-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 ui-caption">
          <span>
            已用 {formatBytes(usage.totalBytes)}（{formatExactBytes(usage.totalBytes)} 字节）
          </span>
          <span>
            配额 {formatBytes(quota.bytes)}（{formatExactBytes(quota.bytes)} 字节）
            {quota.estimated ? " · 估算" : " · 实测"}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="本机存储用量"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          aria-valuetext={`已用 ${formatExactBytes(usage.totalBytes)} 字节（${formatBytes(
            usage.totalBytes,
          )}），占配额 ${Math.round(percent)}%（配额 ${formatExactBytes(quota.bytes)} 字节）`}
          className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[#eee]"
        >
          <div
            className={`h-full rounded-full ${barColor}`}
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </div>
        <div role="status" aria-label="存储水位" className={`mt-1 text-[11px] ${statusColor}`}>
          {statusText}
          <span className="text-muted">（{Math.round(percent)}%）</span>
        </div>
      </div>

      {/* 明细：按字节数降序 */}
      <div className="mt-3 border-t border-line-soft pt-2">
        <div className="text-[11px] font-bold text-muted">
          按模块{usage.keyCount ? `（${usage.keyCount} 个键）` : ""}
        </div>
        {usage.modules.length === 0 ? (
          <div className="mt-1 ui-caption">本机还没有存储内容。</div>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {usage.modules.map((m) => (
              <li
                key={m.name}
                className="flex items-baseline justify-between gap-2 border-b border-line-soft pb-1 text-[11px] last:border-b-0"
              >
                <span className="min-w-0 truncate text-[#555]">
                  {m.name}
                  <span className="ml-1 text-[10px] text-muted">{m.keys} 键</span>
                </span>
                <span className="shrink-0 font-mono text-muted">
                  {formatBytes(m.bytes)}
                  <span className="ml-1 text-[10px] text-muted">{formatExactBytes(m.bytes)} 字节</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {/* 消息缓存的落盘形态（已加密 / 未加密+原因 / 无法解密）：不谎报、不把「解不开」说成「没加密」。 */}
        {encryptionLine && (
          <div
            role="status"
            aria-label="消息缓存加密状态"
            className={`mt-2 text-[11px] ${encryptionLine.tone}`}
          >
            {encryptionLine.text}
          </div>
        )}
      </div>

      {/* 清理入口：只给可再生的 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            setPending("cache");
          }}
          className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-red-600 shadow-card hover:bg-[#fafafa]"
        >
          清理消息缓存
        </button>
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            setPending("tasks");
          }}
          className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-red-600 shadow-card hover:bg-[#fafafa]"
        >
          清理任务记录
        </button>
        <button
          type="button"
          onClick={onProbe}
          disabled={probing}
          className="ui-btn ui-btn-sm ui-btn-ghost disabled:opacity-60"
        >
          {probing ? "检测中…" : "重新检测"}
        </button>
        <span className="ui-caption">
          「重新检测」会临时写入最多约 32MB 以实测配额，写完即删。
        </span>
      </div>

      {/* 不可再生的东西不给入口——这里说清楚为什么，否则用户会以为漏了功能。 */}
      <div className="mt-2 ui-caption">
        记忆条目与加密会话的私钥、棘轮不可再生（丢了就是永久丢），所以不提供清理入口；
        迁移期的旧明文/旧密文备份键也不提供清理入口（它们可能是唯一的可恢复副本）；
        上面两个按钮只清理能重新生成的内容。
      </div>

      {notice && (
        <div role="status" aria-label="操作结果" className="mt-2 ui-caption">
          {notice}
        </div>
      )}

      {pending && (
        <ConfirmDialog
          title={`清理${CLEAR_TARGETS[pending].label}`}
          onCancel={() => setPending(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setPending(null)}
                className="rounded-lg border border-line px-3 py-1.5 ui-caption hover:bg-[#f7f7f7]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => runClear(pending)}
                className="ui-btn ui-btn-sm ui-btn-danger"
              >
                清理
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">{CLEAR_TARGETS[pending].explain}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
