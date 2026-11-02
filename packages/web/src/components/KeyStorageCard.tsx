import type { SVGProps } from "react";
import { PLAINTEXT_BACKUP_SUFFIX, UNDECRYPTABLE_BACKUP_SUFFIX, secureStorageStatus } from "../lib/secureStorage.js";
import { MSG_CACHE_LRU_KEY } from "../lib/e2eSession.js";

/** 三个 d.36 受保护键的中文名：状态提示要能点名，不能只说「部分密钥」。 */
const KEY_LABELS: Record<string, string> = {
  "heming.llmConfigs": "模型连接密钥",
  "heming.mcp.servers.v1": "MCP 服务请求头",
  "heming.e2e.identity": "设备身份私钥",
};

/** 消息缓存 / 链状态的键前缀（只用于显示命名，不参与存储逻辑）。 */
const MSG_CACHE_PREFIX = "heming.msgCache.";
const CHAINS_PREFIX = "heming.e2e.chains.";

/** 去掉备份后缀并记下类型（一个键最多带一层备份后缀）。 */
function stripBackupSuffix(key: string): { base: string; kind: "plaintext" | "undecryptable" | null } {
  if (key.endsWith(PLAINTEXT_BACKUP_SUFFIX)) {
    return { base: key.slice(0, -PLAINTEXT_BACKUP_SUFFIX.length), kind: "plaintext" };
  }
  if (key.endsWith(UNDECRYPTABLE_BACKUP_SUFFIX)) {
    return { base: key.slice(0, -UNDECRYPTABLE_BACKUP_SUFFIX.length), kind: "undecryptable" };
  }
  return { base: key, kind: null };
}

/**
 * 键名 → 中文名（P0-5b：链状态与消息缓存也进了状态卡，必须点名而不是甩原始键名）。
 *
 * 备份后缀单独说明：`….__heming_plaintext_backup` = 迁移前原样备份的旧明文，
 * `….__heming_undecryptable` = 已被原样备份、当前账户解不开的旧密文。
 * 都不认识才回退原始键名——宁可丑，也不能让用户看到「部分密钥」这种模糊说法。
 */
function labelOf(key: string): string {
  const { base, kind } = stripBackupSuffix(key);
  const baseLabel = labelOfKey(base);
  if (kind === "plaintext") return `${baseLabel} · 旧明文备份`;
  if (kind === "undecryptable") return `${baseLabel} · 无法解密的旧密文`;
  return baseLabel;
}

/** 没有备份后缀的键名 → 中文名。 */
function labelOfKey(key: string): string {
  const exact = KEY_LABELS[key];
  if (exact) return exact;
  if (key === MSG_CACHE_LRU_KEY) return "消息缓存会话账本";
  if (key.startsWith(CHAINS_PREFIX)) return `会话加密链（会话 ${key.slice(CHAINS_PREFIX.length)}）`;
  if (key.startsWith(MSG_CACHE_PREFIX)) return `消息缓存（会话 ${key.slice(MSG_CACHE_PREFIX.length)}）`;
  return key; // 兜底：原始键名总比「某个密钥」诚实
}

/** 系统安全存储的名字：文案要说清楚密钥交给了谁。 */
function platformStorageName(): string {
  const platform = typeof window !== "undefined" ? window.heming?.platform : undefined;
  if (platform === "win32") return "Windows DPAPI";
  if (platform === "darwin") return "macOS 钥匙串";
  return "系统密钥环";
}

function LockIcon(props: SVGProps<SVGSVGElement>) {
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
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/**
 * 设置区 · 密钥存储状态（d.36）。
 *
 * 文案是**承诺的边界**：只覆盖三把钥匙，不写成「所有数据都已加密」。
 * 承诺错的地方比不承诺更糟——用户会据此决定把什么交给这个应用。
 */
export function KeyStorageCard() {
  const status = secureStorageStatus();
  const plaintext = status.plaintextKeys.map(labelOf);
  const undecryptable = status.undecryptableKeys.map(labelOf);
  const backedUp = status.backedUpKeys.map(labelOf);

  let mainLine: string;
  let tone = "text-muted";
  if (!status.desktop) {
    mainLine = "浏览器端不落安全存储，密钥与本地消息缓存以明文保存在浏览器本地";
  } else if (!status.available) {
    // 不可用时磁盘上可能既有明文、也有解不开的旧密文；文案必须只说「新写入」，
    // 否则会和下面「密文仍在、本机解不开」的提示自相矛盾。
    mainLine = "注意：本机安全存储不可用，新写入的密钥与本地数据将以明文保存";
    if (plaintext.length > 0) mainLine += `（当前以明文保存：${plaintext.join("、")}）`;
    tone = "text-amber-700";
  } else if (plaintext.length > 0) {
    mainLine = `注意：以下内容未能加密，以明文保存：${plaintext.join("、")}`;
    tone = "text-amber-700";
  } else {
    mainLine = `密钥与本地数据已用系统安全存储加密（${platformStorageName()}）`;
  }

  return (
    <section
      aria-label="密钥存储"
      className="mt-3 max-w-[520px] rounded-xl border border-line bg-white p-4 shadow-card"
    >
      <div className="flex items-center gap-1.5 text-[12px] font-bold text-muted">
        <LockIcon className="text-[#999]" />
        密钥存储
      </div>
      <div className={`mt-1 text-[11px] ${tone}`}>{mainLine}</div>
      <div className="mt-1 text-[11px] text-muted">
        覆盖模型 Key、MCP 请求头、设备身份私钥、会话加密链与消息缓存（有桌面安全存储时加密；浏览器端为明文）。
      </div>
      {undecryptable.length > 0 && (
        <div className="mt-1 text-[11px] text-amber-700">
          以下内容无法在本机解密（密文仍在，可能来自其他设备或系统账户）：
          {undecryptable.join("、")}
        </div>
      )}
      {backedUp.length > 0 && (
        <div className="mt-1 text-[11px] text-amber-700">
          以下内容的旧密文无法在当前账户解密，已在本机原样备份：
          {backedUp.join("、")}
        </div>
      )}
    </section>
  );
}
