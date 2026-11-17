/**
 * 网络访问策略（d.238）：这个智能体到底能访问哪些域名。
 *
 * 为什么需要它：`net-guard.ts` 只挡内网/回环/保留段，**任何公网地址都能读**。
 * 用户对「它能上网」这件事其实没有边界可设——想做「只许读公司文档站和我信任的
 * 那几个站」是做不到的。Codex / Claude Code 那边这条是可配的（默认禁网 + 域名白名单），
 * 这是《对标 Codex / Claude Code》里「沙箱与权限」那节的第 1 条补法。
 *
 * 口径：
 * - 默认 `mode: "open"`，与以前完全一致（不改变既有行为，不搞突然收紧）。
 * - 切成 `"allowlist"` 后，只有列表里的域名（含其子域）能读，其余直接拒绝并说明去哪儿改。
 * - 规则只认域名，不认路径：`example.com/docs` 会被归一成 `example.com`
 *   （否则「白名单」会变成容易被误解的路径匹配）。
 * - `*.example.com` 表示只放行子域，不放行 `example.com` 本身；
 *   写 `example.com` 表示放行它自己和它的子域（用户心智里的「这个站」）。
 * - 存储用 localStorage（与 d.203 起的会话/界面偏好一致），坏数据静默丢弃，
 *   读不到就按默认「开放」——**宁可保持旧行为，也不因为存储坏了把用户锁在门外**。
 */

/** 存储键：与 `heming.*.v1` 的既有命名保持一致。 */
export const NET_POLICY_KEY = "heming.netPolicy.v1";

/** 上限：200 条足够覆盖「几个信任站点 + 若干文档站」，再多就是规则本身没设计好。 */
export const MAX_NET_ALLOW = 200;

/** 单条规则的最大长度（DNS 名上限 253）。 */
const MAX_RULE_CHARS = 253;

export type NetMode = "open" | "allowlist";

export interface NetPolicy {
  mode: NetMode;
  /** 归一化后的域名规则：`example.com` 或 `*.example.com`。 */
  allow: readonly string[];
}

export const DEFAULT_NET_POLICY: NetPolicy = { mode: "open", allow: [] };

/** 只允许 ASCII 主机名（IDN 请先写 punycode，避免「看起来一样」的域名绕过）。 */
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * 把用户输入的任意写法归一成一条域名规则。
 *
 * 接受：`example.com`、`Example.COM`、`https://example.com/a?b=1`、`example.com:8443`、
 * `*.example.com`、`user@example.com`（去掉账号）、`example.com.`（去掉尾点）。
 * 拒绝：空串、带空格、IP 地址、只写 `*`、单段名（`localhost`）、超长、非 ASCII。
 *
 * 返回 `null` 表示「这不是一条能用的规则」，调用方应当忽略它（写界面时提示原因）。
 */
export function normalizeDomainRule(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim().toLowerCase();
  if (!text || text.length > MAX_RULE_CHARS) return null;

  // 通配：只允许最左一段是 `*`。
  let wildcard = false;
  if (text.startsWith("*.")) {
    wildcard = true;
    text = text.slice(2);
  } else if (text.includes("*")) {
    return null;
  }

  // 去协议、去 userinfo、去路径/查询/片段、去端口、去尾点。
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  text = text.replace(/^\/\//, "");
  const at = text.lastIndexOf("@");
  if (at >= 0) text = text.slice(at + 1);
  text = text.split(/[/?#]/)[0] ?? "";
  if (text.startsWith("[")) {
    // IPv6 字面量：白名单里没有意义（内网/回环本来就被挡，公网 IPv6 也不该按域名写）。
    return null;
  }
  const colon = text.indexOf(":");
  if (colon >= 0) text = text.slice(0, colon);
  text = text.replace(/\.$/, "");
  if (!text || text.length > MAX_RULE_CHARS) return null;

  // IP 地址不做域名规则（要放行某个公网 IP 属于另一种需求，不在这里偷偷支持）。
  if (/^\d+$/.test(text) || /^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return null;

  if (!HOST_RE.test(text)) return null;
  return wildcard ? `*.${text}` : text;
}

/** 把一组原始输入归一、去重（保序），最多保留 `MAX_NET_ALLOW` 条。 */
export function normalizeDomainList(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const rule = normalizeDomainRule(item);
    if (rule === null || seen.has(rule)) continue;
    seen.add(rule);
    out.push(rule);
    if (out.length >= MAX_NET_ALLOW) break;
  }
  return out;
}

/**
 * 把一段文本切成规则列表：换行、逗号（半角/全角）、分号、空白都算分隔符。
 * 界面上「一次贴一串」比一条一条加顺手。
 */
export function parseDomainInput(text: unknown): string[] {
  if (typeof text !== "string") return [];
  const parts = text.split(/[\s,，;；]+/).filter((part) => part.trim().length > 0);
  return normalizeDomainList(parts);
}

/** 是否启用了白名单模式（有列表但模式是 open 时不算）。 */
export function hasNetAllowlist(policy: NetPolicy | null | undefined): boolean {
  return policy?.mode === "allowlist" && (policy.allow?.length ?? 0) > 0;
}

/**
 * 某个主机名是否被策略放行。
 *
 * - `mode: "open"` → 永远放行（调用方仍要先过内网/协议那些硬性检查）。
 * - 规则 `example.com` → 放行 `example.com` 与 `a.example.com`。
 * - 规则 `*.example.com` → 只放行 `a.example.com`，不放行 `example.com`。
 * - 主机名带端口/尾点时先归一；非法主机名一律不放行。
 */
export function domainAllowed(policy: NetPolicy | null | undefined, rawHost: unknown): boolean {
  if (!policy || policy.mode !== "allowlist") return true;
  let host = typeof rawHost === "string" ? rawHost.trim().toLowerCase() : "";
  if (!host) return false;
  if (host.startsWith("[")) return false;
  const colon = host.indexOf(":");
  if (colon >= 0) host = host.slice(0, colon);
  host = host.replace(/\.$/, "");
  if (!host) return false;
  const allow = policy.allow ?? [];
  for (const rule of allow) {
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1); // ".example.com"
      if (host.length > suffix.length && host.endsWith(suffix)) return true;
      continue;
    }
    if (host === rule || host.endsWith(`.${rule}`)) return true;
  }
  return false;
}

/** 给 `/status` 与设置卡用的一句人话。 */
export function describeNetPolicy(policy: NetPolicy | null | undefined): string {
  const mode = policy?.mode === "allowlist" ? "allowlist" : "open";
  if (mode === "open") return "网络访问：开放（能读任意公开网页，内网与本机地址始终被挡）";
  const rules = policy?.allow ?? [];
  if (rules.length === 0) {
    return "网络访问：仅允许列表里的域名（当前列表为空——所有网页都读不了，去「设置 → 网络访问」添加）";
  }
  const sample = rules.slice(0, 5).join("、");
  const more = rules.length > 5 ? ` 等 ${rules.length} 个` : "";
  return `网络访问：仅允许 ${rules.length} 个域名（${sample}${more}），其余网页会被拒绝`;
}

/* ------------------------------------------------------------------ *
 * 存储（内存 + localStorage，懒装载，坏数据静默降级）
 * ------------------------------------------------------------------ */

const listeners = new Set<() => void>();
let loaded = false;
let current: NetPolicy = DEFAULT_NET_POLICY;
/**
 * 对外快照：**引用稳定**。
 *
 * `useSyncExternalStore` 要求「没变化时 `getSnapshot()` 返回同一个引用」，
 * 否则 React 每次渲染都认为 store 变了，直接踩进 `Maximum update depth exceeded`。
 * 所以每次提交策略时新建一个冻结对象，其余时候原地复用。
 */
let snapshot: NetPolicy = DEFAULT_NET_POLICY;

/** 生成一个不可变快照（调用方拿到后改不动内部状态）。 */
function freezePolicy(policy: NetPolicy): NetPolicy {
  return Object.freeze({ mode: policy.mode, allow: Object.freeze([...policy.allow]) as readonly string[] });
}

/** 提交一次变更：更新内存、快照、持久化、通知订阅方。 */
function commit(next: NetPolicy): void {
  current = next;
  snapshot = freezePolicy(next);
  persist();
  emit();
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function sanitize(raw: unknown): NetPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { mode?: unknown; allow?: unknown };
  const mode: NetMode = record.mode === "allowlist" ? "allowlist" : "open";
  const allow = Array.isArray(record.allow) ? normalizeDomainList(record.allow) : [];
  return { mode, allow };
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const store = storage();
  if (!store) {
    snapshot = freezePolicy(current);
    return;
  }
  try {
    const raw = store.getItem(NET_POLICY_KEY);
    if (raw) current = sanitize(JSON.parse(raw) as unknown) ?? DEFAULT_NET_POLICY;
  } catch {
    current = DEFAULT_NET_POLICY;
  }
  snapshot = freezePolicy(current);
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 订阅方自己出错不该影响别的订阅方。
    }
  }
}

function persist(): void {
  const store = storage();
  if (!store) return;
  try {
    if (current.mode === "open" && current.allow.length === 0) {
      store.removeItem(NET_POLICY_KEY);
      return;
    }
    store.setItem(NET_POLICY_KEY, JSON.stringify(current));
  } catch {
    // 存储写失败（隐私模式/配额满）：内存里的策略仍然生效，不打断用户。
  }
}

/**
 * 当前策略（引用稳定的冻结快照）。
 *
 * 传给 `useSyncExternalStore` 的 `getSnapshot` 必须满足「没变化时同一引用」；
 * 返回值本身不可变，需要改就调用下面的 set/add/remove。
 */
export function getNetPolicy(): NetPolicy {
  ensureLoaded();
  return snapshot;
}

/** 覆盖式写入；`allow` 会重新归一化并去重。非法 mode 按 `"open"` 处理。 */
export function setNetPolicy(next: Partial<{ mode: NetMode; allow: readonly unknown[] }>): NetPolicy {
  ensureLoaded();
  const mode: NetMode = next.mode === "allowlist" ? "allowlist" : next.mode === "open" ? "open" : current.mode;
  const allow = next.allow === undefined ? current.allow : normalizeDomainList(next.allow);
  commit({ mode, allow });
  return getNetPolicy();
}

/** 追加一批规则（去重）。返回是否真的加了新规则。 */
export function addNetAllow(raw: unknown): { added: string[]; rejected: string[]; policy: NetPolicy } {
  ensureLoaded();
  const items = typeof raw === "string" ? parseDomainInput(raw) : normalizeDomainList(Array.isArray(raw) ? raw : [raw]);
  const rejected: string[] = [];
  if (typeof raw === "string") {
    // 逐个报出被拒的写法，界面才能说清「哪一条没加进去」。
    const parts = raw.split(/[\s,，;；]+/).filter((part) => part.trim().length > 0);
    for (const part of parts) {
      if (normalizeDomainRule(part) === null) rejected.push(part);
    }
  }
  const existing = new Set(current.allow);
  const added: string[] = [];
  const merged = [...current.allow];
  for (const item of items) {
    if (existing.has(item)) continue;
    if (merged.length >= MAX_NET_ALLOW) break;
    existing.add(item);
    merged.push(item);
    added.push(item);
  }
  if (added.length > 0) {
    commit({ ...current, allow: merged });
  }
  return { added, rejected, policy: getNetPolicy() };
}

/** 删掉一条规则（按已归一化的写法匹配）。返回是否删到了。 */
export function removeNetAllow(rule: unknown): boolean {
  ensureLoaded();
  const normalized = normalizeDomainRule(rule);
  if (normalized === null) return false;
  const next = current.allow.filter((item) => item !== normalized);
  if (next.length === current.allow.length) return false;
  commit({ ...current, allow: next });
  return true;
}

/** 订阅变化（返回退订函数）。 */
export function subscribeNetPolicy(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 恢复默认（测试与「重置」按钮用）。 */
export function resetNetPolicy(): void {
  loaded = true;
  current = DEFAULT_NET_POLICY;
  snapshot = freezePolicy(DEFAULT_NET_POLICY);
  const store = storage();
  try {
    store?.removeItem(NET_POLICY_KEY);
  } catch {
    // 与 persist 一致：存储出错不影响内存态。
  }
  emit();
}
