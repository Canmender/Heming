import {
  CONTRIBUTION_LABELS,
  comparePluginVersions,
  enginesStatusText,
  type ContributionKind,
  type EnginesStatus,
  type PluginManifestV5,
} from "@heming/shared";
import {
  skillPool,
  MAX_POOL_CHARS,
  SKILLS_KEY,
  SKILL_BINDINGS_KEY,
  SKILL_ASSIGNMENTS_KEY,
  type SkillPool,
  type StorageLike,
} from "../skills/index.js";
import {
  mcpRegistry,
  MCP_SERVERS_KEY,
  MCP_TOOLS_KEY,
  MCP_ENABLED_TOOLS_KEY,
  type McpServerConfig,
  type ServerOrigin,
} from "../mcp/index.js";
import { DEFAULT_QUOTA_BYTES } from "../storageUsage.js";
import { utf8Length } from "../memory/storage.js";
import { discardPendingSecureWrite, pendingSecurePlain, readSecureValueAsync } from "../secureStorage.js";
import {
  currentAppVersion,
  parsePluginManifest,
  parsePluginManifestDetailed,
  pluginEnginesStatus,
  toPluginV5View,
  PluginManifestError,
  type PluginCommandSpec,
  type PluginManifest,
  type PluginToolRisk,
} from "./manifest.js";
import { normalizeNetworkHost, pluginIdFromServerId } from "./permissions.js";
import { contentFingerprint, FINGERPRINT_PREFIX } from "./integrity.js";
import { PublisherTrustStore, type SignatureStatus } from "./signature.js";

// 目录（catalog）与命令面板都从插件侧反解服务归属，统一从本模块导出，
// 避免两处各写一份 `plugin:` 前缀解析而漂移。
export { pluginIdFromServerId } from "./permissions.js";

/**
 * 已装插件的本机存储（`heming.plugins.v1`）。
 *
 * 插件是系统能力包，不是第二套技能/工具系统：
 * - 技能**物化进现有技能池**（`source: "imported"` + `pluginId`）；
 * - 远程 MCP 服务**登记进现有 MCP 注册表**（`origin: "plugin"`），连接、工具开关与 HITL 全沿用。
 * 本存储只记录「插件 → 技能 id / 服务 id」的归属与启用状态。
 *
 * ## 安装事务（d.105 / 规格 §5.1–§5.3）
 * localStorage 没有真正事务，所以安装走显式三段式：
 * `planInstall`（纯函数：差异 + engines + 权限扩张 + 体积预检，不写盘）→
 * `applyPlan`（快照受影响键 → 逐段落盘 → 写失败逐键恢复 + 三个单例 `reload()`）→
 * `changed` / `applied` 分开报告，回滚失败如实给 `rollback.ok=false`。
 *
 * 1. 插件记录这类关键写用 `saveOrThrow()`（配额失败必须可见）；
 * 2. 技能池/MCP 注册表的 `save()` 仍吞异常（历史行为，不改），所以事务里
 *    「读回校验」：预期会变的键若与快照逐字节相同，按写失败处理并回滚；
 * 3. `previous` / `history` / `highestVersion` 支撑「回滚到上一版」与防降级（§5.3）。
 */

export const PLUGINS_KEY = "heming.plugins.v1";
export const MAX_PLUGINS = 50;

/**
 * 安装事务写放大预算（规格 §5.2 体积预检）。
 *
 * 为什么是 4MB：localStorage 同源预算保守按 5MB（`DEFAULT_QUOTA_BYTES`）算，
 * 但插件记录之外还有消息缓存、记忆、任务等键——写满 5MB 时其它模块会先爆。
 * 留 1MB 余量，把「装完这个插件还剩多少给别的模块」提前算给用户看。
 */
export const INSTALL_WRITE_BUDGET_BYTES = Math.floor(DEFAULT_QUOTA_BYTES * 0.8);

/** 更新时保留上一版清单的单插件上限（规格 §5.3；最坏合法清单 1.2MB，超了就放弃回滚）。 */
export const PREVIOUS_MANIFEST_MAX_BYTES = 128 * 1024;

/** 全部插件 `previous` 的合计上限（规格 §5.3）。 */
export const PREVIOUS_TOTAL_MAX_BYTES = 512 * 1024;

/**
 * 技能池写入预算（P1-8，d.110）。
 *
 * 技能池自身有 1.2MB 单键硬上限（`MAX_POOL_CHARS`，见 `lib/skills/types.ts`），
 * 超限时 `SkillPool.evictToQuota()` 会**静默淘汰**技能（内置技能同样会被删且不复活）。
 * 插件安装的 4MB 预算管不到这件事，所以 plan 阶段单独预检：写后技能池超过 90%
 * 上限就把计划标 blocked，把「会淘汰已有技能」提前说清楚，而不是装完掉技能。
 *
 * 口径说明：用 UTF-8 字节估算（与体积预检一致），而技能池的硬上限按 JS 字符数
 * （`serialized.length`）判——中文技能正文下字节数 ≥ 字符数，所以这里是**偏保守**的
 * 守卫（宁可早一点提示，也不让用户装完才发现技能被删）。
 */
export const SKILLS_POOL_WRITE_BUDGET_BYTES = Math.floor(MAX_POOL_CHARS * 0.9);

/** 安装事务涉及的存储键（快照/恢复/体积预检的同一份清单）。 */
export const PLUGIN_TXN_KEYS: readonly string[] = [
  PLUGINS_KEY,
  SKILLS_KEY,
  SKILL_BINDINGS_KEY,
  SKILL_ASSIGNMENTS_KEY,
  MCP_SERVERS_KEY,
  MCP_TOOLS_KEY,
  MCP_ENABLED_TOOLS_KEY,
];

/** 插件依赖的 MCP 注册表面：窄接口让单测不必真的碰 localStorage 与预置服务。 */
export interface PluginMcpPort {
  get(id: string): McpServerConfig | undefined;
  add(input: {
    id?: string;
    name: string;
    transport: "http";
    url?: string;
    enabled?: boolean;
    origin?: ServerOrigin;
  }): McpServerConfig;
  update(id: string, patch: Partial<Omit<McpServerConfig, "id" | "createdAt">>): McpServerConfig;
  remove(id: string): void;
  /**
   * 列出全部服务（真注册表才有；注入的假端口不实现）。
   *
   * 健康修复要按 `origin: "plugin"` + `plugin:<id>:` 前缀重建 `serverIds`，
   * 没有这个能力时只能「删悬空引用」、发现不了记录里漏登的孤儿服务。
   */
  servers?(): McpServerConfig[];
  /**
   * 重新读存储并重建内存态（真注册表才有；注入的假端口不实现）。
   *
   * 安装事务回滚后必须调：存储回滚了、内存不重读就是半装态。
   */
  reload?(): void;
}

/**
 * 贡献类型（d.67 贡献级停用）：与清单的四个 `contributions` 键一一对应。
 */
export type PluginContributionKind = "skills" | "mcpServers" | "commands" | "toolPacks";

export const PLUGIN_CONTRIBUTION_KINDS: readonly PluginContributionKind[] = [
  "skills",
  "mcpServers",
  "commands",
  "toolPacks",
];

export interface InstalledPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  skillIds: string[];
  /** 本插件登记的服务 id（`plugin:<插件 id>:<key>`），卸载/停用按此收口。 */
  serverIds: string[];
  /**
   * 安装时的清单**内容指纹**（`fnv1a64b:…`，见 `integrity.ts`）。
   *
   * 只用来发现「同 id 同版本但内容被悄悄改过」，不是签名、不证明来源。
   * 旧版本应用留下的记录没有该字段，读取时补算并落盘（不视为损坏）。
   */
  fingerprint: string;
  /**
   * 已确认的发布者（TOFU，d.67）：只记 id 与公钥指纹；未签名/未确认时为 null。
   *
   * 公钥原文在清单里（`manifest.publisher`），这里存指纹方便展示与换钥排查。
   */
  publisher: { id: string; fingerprint: string } | null;
  /** 安装时的验签结果（d.67）；未签名为 null。绝不由本模块自行判定。 */
  signature: { status: SignatureStatus; alg?: "ed25519" } | null;
  /**
   * 贡献级停用（d.67）：总开关之外按类关掉部分贡献。
   *
   * 缺省 `[]`（旧记录兼容）；读口径一律走 `effectiveEnabled(plugin, kind)`。
   */
  disabledKinds: PluginContributionKind[];
  /**
   * 上一版清单（更新回滚用，规格 §5.3）。
   *
   * - 只在**更新成功**时写入；首装为 `undefined`；
   * - 单插件 ≤ `PREVIOUS_MANIFEST_MAX_BYTES`、全量 ≤ `PREVIOUS_TOTAL_MAX_BYTES`，
   *   超限放弃并如实标注「本插件未保留上一版」；
   * - 回滚只用本机留存的这份清单，不联网、不查目录。
   */
  previous?: { manifest: PluginManifest; fingerprint: string; installedAt: string };
  /** 版本历史（≤3 条，超限丢最旧；更新/回滚成功时追加）。 */
  history?: Array<{ version: string; at: string }>;
  /**
   * 本机见过的最高版本（防降级，规格 §5.3 / N7）。
   *
   * 安装/回滚到更旧版本时，若低于它且没有显式 `allowDowngrade` 一律拒绝。
   * 只在本机，不联网。
   */
  highestVersion?: string;
  /**
   * v5 记录读回失败（P1-7，d.110）：清单损坏但记录本身仍可管理。
   *
   * 为什么保留而不是丢弃：丢了记录就丢掉了 skillIds/serverIds，插件的技能/服务
   * 变成永远清不掉的孤儿；保留下来才能「显示损坏 + 允许卸载/覆盖重装」。
   * 判读口径：`invalidRecord === true` 时**不得**把它当「兼容」——`manifest` 是
   * 无 engines 的占位清单，`pluginEnginesStatus` 会返回 `invalidEngines`。
   */
  invalidRecord?: true;
  /** 损坏原因（中文，详情页/诊断直接展示）。 */
  invalidReason?: string;
  installedAt: string;
  updatedAt: string;
}

/** 安装事务的诊断条目（结果语义 §5.5：失败必须给出可读原因）。 */
export interface PluginDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
}

/** 回滚报告：`ok=false` 表示补偿写失败（配额/隐私模式），绝不谎报成功。 */
export interface InstallRollbackReport {
  ok: boolean;
  /** 参与补偿的键（快照覆盖的键全集）。 */
  keys: string[];
  error?: string;
}

export interface InstallResult {
  plugin: InstalledPlugin;
  /** true = 首次安装；false = 覆盖更新 */
  created: boolean;
  added: number;
  updated: number;
  removed: number;
  serversAdded: number;
  serversUpdated: number;
  serversRemoved: number;
  /** 存储是否真的变了（同清单重复安装为 false，规格 §5.2 幂等）。 */
  changed: boolean;
  /** 是否生效；`failed` 时由 `PluginInstallError` 携带完整回滚报告。 */
  applied: "applied" | "failed";
  mode: "install" | "update";
  rollback?: InstallRollbackReport;
  diagnostics: PluginDiagnostic[];
}

/** `applyPlan` 的结果：失败时没有 `InstalledPlugin`（已回滚），所以 `plugin` 可空。 */
export interface InstallApplyResult {
  changed: boolean;
  applied: "applied" | "failed";
  mode: "install" | "update";
  /** 成功时为落盘后的记录；失败（已回滚）为 null。 */
  plugin: InstalledPlugin | null;
  added: number;
  updated: number;
  removed: number;
  serversAdded: number;
  serversUpdated: number;
  serversRemoved: number;
  rollback?: InstallRollbackReport;
  diagnostics: PluginDiagnostic[];
}

/**
 * 删除/启停这类「单步事务」的结果（P0-2 / P1-3，d.110）。
 *
 * 为什么不再抛错：这些操作在 UI 上是开关/确认按钮，失败需要展示提示并保持
 * 界面状态与存储一致；返回结构化结果比让每个调用点 try/catch 更不容易漏。
 * `rollback.ok=false` 表示补偿也失败了——调用方必须如实提示「未能完全恢复」。
 */
export interface StoreMutationResult {
  ok: boolean;
  /** 失败原因（中文，可直接展示）。 */
  error?: string;
  rollback?: InstallRollbackReport;
}

/**
 * 修复结果（d.113）。
 *
 * - `repaired`：实际执行过的修复动作码（`manifest` / `skillIds` / `serverIds` / `fingerprint`）；
 * - `dropped`：从记录里摘掉的悬空引用，`skill:<id>` / `server:<id>`——**只摘引用，
 *   不删除技能/服务本身**（用户数据不动）；
 * - `remainingIssues`：修完之后仍然存在的问题（如清单依旧无法解析），UI 如实展示。
 */
export interface PluginRepairResult extends StoreMutationResult {
  repaired: string[];
  dropped: string[];
  remainingIssues: PluginHealthIssue[];
  /** 修复后的健康快照（失败时是回滚后的现状）。 */
  health?: PluginHealth;
}

/** 更新预览：按「物化后的真实状态」算差异，与实际安装语义一致。 */
export interface PluginSkillDiff {
  added: string[];
  changed: string[];
  unchanged: string[];
  removed: string[];
}

export interface PluginServerDiffEntry {
  key: string;
  name: string;
}

export interface PluginServerDiff {
  added: PluginServerDiffEntry[];
  changed: PluginServerDiffEntry[];
  unchanged: PluginServerDiffEntry[];
  removed: PluginServerDiffEntry[];
}

export interface PluginServerConflict {
  id: string;
  name: string;
}

/**
 * 安装前的信任预览（d.66 覆盖保护）。
 *
 * 只看**清单内容**，不碰文件/网络：作者变了、或同版本内容变了，才是需要人
 * 显式确认的覆盖更新；首次安装与正常的版本升级沿用既有差异预览。
 */
export interface PluginTrustPreview {
  /** 本次清单的指纹。 */
  fingerprint: string;
  /** 已装版本的指纹；首次安装为 null。 */
  previousFingerprint: string | null;
  /** 同 id 同 version 但内容变了（最需要人看一眼的情况）。 */
  sameVersionContentChanged: boolean;
  authorChanged: boolean;
  previousAuthor: string | null;
  versionChanged: boolean;
  /** 需要用户在安装弹窗显式勾选「我已确认这次覆盖更新」才能继续。 */
  needsConfirm: boolean;
  /**
   * 清单是否带签名：`none` 未签名；`unsupported` = 已签名但预览阶段还没验
   * （验签是异步 WebCrypto 调用，由 UI 完成后再决定放行；这里不谎报 valid）。
   */
  signatureStatus: SignatureStatus;
  /**
   * 本次清单的发布者公钥与已信任的同 id 公钥不一致（换钥，必须显式复核）。
   * 发布者未出现过 / 清单无发布者 → false（首次信任由 UI 走另一条确认）。
   */
  publisherKeyChanged: boolean;
}

/** 安装选项（d.67）：签名/信任是异步校验，由 UI 完成后把结论交进来，store 保持同步。 */
export interface PluginInstallOptions {
  /** 已确认的发布者（id + 公钥指纹）；未提供或未签名时记录为 null。 */
  publisher?: { id: string; fingerprint: string } | null;
  /** UI 异步验签结果；含签名清单未传时记录为 unsupported（未验证，绝不默认 valid）。 */
  signatureStatus?: SignatureStatus;
}

export interface PluginInstallPreview {
  manifest: PluginManifest;
  existing: InstalledPlugin | null;
  skills: PluginSkillDiff;
  servers: PluginServerDiff;
  /** 与手工/Registry 服务撞 id；非空时安装会被拒绝。 */
  conflicts: PluginServerConflict[];
  /** 网络访问主机（含端口），安装前展示；口径来自归一化后的 `permissions.network`。 */
  hosts: string[];
  /** 信任与覆盖保护提示（d.66）。 */
  trust: PluginTrustPreview;
  /** 新插件且已达数量上限；更新不受影响。 */
  limitReached: boolean;
}

/* ───────────────────────── 安装事务：plan → apply（规格 §5.1/§5.2） ───────────────────────── */

export interface InstallPlanOptions extends PluginInstallOptions {
  /**
   * 用户已确认「权限扩张」（规格 §5.3 / N4）。
   *
   * 更新若新增 `permissions.network` 主机、把 `tools` 上限从 read 放宽到 write、
   * 或新增贡献类别，预览必须进入「重新确认」态；未确认时 `applyPlan` 拒绝执行，
   * 绝不静默提权。
   */
  confirmPermissionExpansion?: boolean;
  /** 允许装回比 `highestVersion` 更旧的版本（规格 §5.3 / N7 防降级）。 */
  allowDowngrade?: boolean;
  /** 覆盖应用版本（默认 `__APP_VERSION__`；测试注入用）。 */
  appVersion?: string;
}

/** plan 里的一笔写入（只是报告：真正落盘仍走各 store 的既有写入口）。 */
export interface PlanWrite {
  key: string;
  action: "create" | "update" | "remove";
  /** 估算写入后该键的字节数（体积预检明细，不参与判定）。 */
  bytes?: number;
}

/** 计划被哪条硬规则挡住（非空则 `applyPlan` 不写任何存储）。 */
export interface InstallPlanBlock {
  code: "conflicts" | "engines" | "downgrade" | "size" | "skills-pool-budget";
  message: string;
}

/** 权限扩张检测结果（network 新增 host / tools 放宽 / 新贡献类别）。 */
export interface InstallPermissionUpgrade {
  expands: boolean;
  /** 新增的网络主机（按声明原文，已归一化去重）。 */
  networkAdded: string[];
  /** 工具风险上限放宽（只会是 read → write）。 */
  toolsWidened: { from: PluginToolRisk; to: PluginToolRisk } | null;
  /** 新增的贡献类别（上次没有该类贡献、这次有了）。 */
  newKinds: ContributionKind[];
  /** 中文原因（安装预览直接展示）。 */
  reasons: string[];
}

/** 体积预估（写入前算「受影响键写后总字节」，超阈值直接拒绝）。 */
export interface InstallSizeEstimate {
  /** 参与统计的键（`PLUGIN_TXN_KEYS` 里本次会写的部分）。 */
  keys: string[];
  /** 受影响键当前总字节。 */
  currentBytes: number;
  /** 估算写入后总字节。 */
  afterBytes: number;
  /** 本次写入的估算增量。 */
  deltaBytes: number;
  limitBytes: number;
  exceeded: boolean;
  /** 超限时的「先清理什么」建议。 */
  suggestion?: string;
  /** 技能池写入后估算字节（P1-8：技能池有独立 1.2MB 硬上限，超了会静默淘汰技能）。 */
  skillsPoolAfterBytes: number;
  /** 技能池预算（`MAX_POOL_CHARS * 0.9`）。 */
  skillsPoolLimitBytes: number;
  skillsPoolExceeded: boolean;
}

/**
 * 安装计划（纯函数产物，不写任何存储）。
 *
 * 页面用法：`plan = store.planInstall(manifest)` → 展示 `diff/permissions/engines/size` →
 * 用户确认后 `store.applyPlan(plan)`；不要绕过 plan 直接写。
 */
export interface InstallPlan {
  /** 将要落盘的 web 归一化清单。 */
  manifest: PluginManifest;
  /** shared 的 v5 读模型（v1–v4 由 `toPluginV5View` 投射；兼容性/贡献类别读它）。 */
  v5: PluginManifestV5;
  mode: "install" | "update";
  /** 安装前记录（首装为 null，供回滚对照）。 */
  existing: InstalledPlugin | null;
  /** 复用 `preview()` 的差异/冲突/信任提示。 */
  diff: PluginInstallPreview;
  conflicts: PluginServerConflict[];
  writes: PlanWrite[];
  warnings: string[];
  engines: EnginesStatus;
  permissionUpgrade: InstallPermissionUpgrade;
  size: InstallSizeEstimate;
  /** 非空则禁止 apply（冲突/不兼容/降级/超体积）。 */
  blocked: InstallPlanBlock[];
  /** 权限扩张且用户未确认（UI 应强制二次确认；applyPlan 会拒绝）。 */
  needsConfirmation: boolean;
  /** 将要写入的 `previous`（无更新/超限为 null）。 */
  previous: InstalledPlugin["previous"] | null;
  history: NonNullable<InstalledPlugin["history"]>;
  highestVersion: string;
  options: InstallPlanOptions;
  /** 同清单重复安装：apply 不写存储，`changed=false`。 */
  noop: boolean;
}

/**
 * 安装失败（写失败/回滚）时抛出：`message` 可直接展示，`result` 带诚实报告。
 *
 * 与 `PluginManifestError`（清单/规则问题）区分：这里代表「包没问题，但本机写不进去」，
 * UI 文案是「安装失败，已恢复到安装前状态」而不是「清单不合法」。
 */
export class PluginInstallError extends Error {
  readonly result: InstallApplyResult;
  constructor(message: string, result: InstallApplyResult) {
    super(message);
    this.name = "PluginInstallError";
    this.result = result;
  }
}

export interface PluginSkillInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface PluginServerInfo {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

/** 插件贡献计数（插件卡「贡献」行与安装弹窗摘要共用）。 */
export interface PluginContributionCounts {
  skills: number;
  servers: number;
  commands: number;
  /** 工具束数量（d.65 增补；老插件缺省 0）。 */
  toolPacks: number;
  /** 全部工具束里声明的工具名总数（按声明计，不代表已连接）。 */
  packTools: number;
}

/** 插件命令：命令面板用的执行入口（`id` 已加 `plugin:<插件 id>:` 前缀，全局唯一）。 */
export interface PluginCommandInfo {
  /** `plugin:<pluginId>:<commandId>`。 */
  id: string;
  pluginId: string;
  pluginName: string;
  title: string;
  description: string;
  keywords: string[];
  target: PluginCommandSpec["target"];
}

/** 稳定的服务 id；`key` 不含冒号，工具键 `serverId::toolName` 的分隔不受影响。 */
export function pluginServerId(pluginId: string, key: string): string {
  return `plugin:${pluginId}:${key}`;
}

/** 从旧记录的服务 id 反推 key；异常 id 原样返回，只用于展示。 */
function serverKeyFromId(pluginId: string, id: string): string {
  if (pluginIdFromServerId(id) === pluginId) {
    return id.slice(`plugin:${pluginId}:`.length);
  }
  return id;
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameSkill(
  spec: PluginManifest["contributions"]["skills"][number],
  skill: { description: string; instructions: string; triggers: string[]; tags: string[] },
): boolean {
  return (
    spec.description === skill.description &&
    spec.instructions === skill.instructions &&
    sameStringList(spec.triggers, skill.triggers) &&
    sameStringList(spec.tags, skill.tags)
  );
}

/* ───────────────────────── 事务辅助（纯函数） ───────────────────────── */

/**
 * 是否**已归一化**的 web 清单（`parsePluginManifest` 的产物）。
 *
 * 判据是 `contributions.llmPresets`：它是 web 解析器补的兼容字段，手写清单里永远没有
 * （v3/v4 的 superRefine 与 v5 的 strict 都会拒绝它）。回滚/重装走
 * `previous.manifest` 时不能再过一次解析——那份清单的 `schemaVersion` 是旧的原始值、
 * 结构却是当前形状，按旧规则重解析必然失败。
 */
function isNormalizedManifest(value: unknown): value is PluginManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.version !== "string") return false;
  const contributions = record.contributions as Record<string, unknown> | undefined;
  if (!contributions || typeof contributions !== "object") return false;
  return Array.isArray(contributions.llmPresets);
}

/** 接受原始清单或已归一化清单：前者走完整解析（拿 warning），后者直接复用。 */
function resolvePlanManifest(input: string | PluginManifest | unknown): {
  manifest: PluginManifest;
  warnings: string[];
} {
  if (isNormalizedManifest(input)) return { manifest: input, warnings: [] };
  return parsePluginManifestDetailed(input);
}

const TOOL_RISK_RANK: Record<PluginToolRisk, number> = { none: 0, read: 1, write: 2 };

/**
 * 权限扩张检测（规格 §5.3 / N4）：只判「比上次更宽」的三类。
 *
 * 收紧（删主机、read 降 none、删贡献类别）不拦——用户不会被缩权伤害。
 */
function diffPermissionUpgrade(
  before: PluginManifest | null,
  after: PluginManifest,
): InstallPermissionUpgrade {
  const reasons: string[] = [];
  // 首装没有「上一次」可比较：整份清单都已在安装弹窗展示过，不构成「扩张」。
  if (!before) {
    return { expands: false, networkAdded: [], toolsWidened: null, newKinds: [], reasons };
  }
  const beforeHosts = new Set(before.permissions.network.map(normalizeNetworkHostSafe));
  const networkAdded = after.permissions.network.filter(
    (host) => !beforeHosts.has(normalizeNetworkHostSafe(host)),
  );
  if (networkAdded.length > 0) {
    reasons.push(`新增网络主机：${networkAdded.join("、")}`);
  }

  let toolsWidened: InstallPermissionUpgrade["toolsWidened"] = null;
  if (TOOL_RISK_RANK[after.permissions.tools] > TOOL_RISK_RANK[before.permissions.tools]) {
    toolsWidened = { from: before.permissions.tools, to: after.permissions.tools };
    reasons.push(`工具权限上限从 ${before.permissions.tools} 放宽到 ${after.permissions.tools}`);
  }

  // 贡献类别按「上次没有任何该类条目、这次有了」判新增（条目增删属于常规更新）。
  const kinds: Array<[ContributionKind, unknown[]]> = [
    ["skills", after.contributions.skills],
    ["mcpServers", after.contributions.mcpServers],
    ["commands", after.contributions.commands],
    ["toolPacks", after.contributions.toolPacks],
    ["desktopWidgets", after.contributions.desktopWidgets],
  ];
  const newKinds: ContributionKind[] = [];
  for (const [kind, items] of kinds) {
    if (items.length === 0) continue;
    const beforeItems = (before.contributions as unknown as Record<string, unknown[]>)[kind] ?? [];
    if ((beforeItems?.length ?? 0) > 0) continue;
    newKinds.push(kind);
    reasons.push(`新增贡献类别「${CONTRIBUTION_LABELS[kind]}」`);
  }

  return {
    expands: networkAdded.length > 0 || toolsWidened !== null || newKinds.length > 0,
    networkAdded,
    toolsWidened,
    newKinds,
    reasons,
  };
}

/** 主机归一化：复用 `permissions.ts` 的口径（默认端口 80/443 视为同一个 host）。 */
function normalizeNetworkHostSafe(value: string): string {
  return normalizeNetworkHost(value);
}

function bytesOf(value: string | null): number {
  return value ? utf8Length(value) : 0;
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isEmptySkillDiff(diff: PluginSkillDiff): boolean {
  return diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0;
}

function isEmptyServerDiff(diff: PluginServerDiff): boolean {
  return diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0;
}

/** 技能池是否真的会被写（「unchanged」也会被 update 写 version，但那不改变内容）。 */
function diffTouchedSkills(diff: PluginInstallPreview): boolean {
  return diff.skills.added.length + diff.skills.changed.length + diff.skills.removed.length > 0;
}

function diffTouchedServers(diff: PluginInstallPreview): boolean {
  return diff.servers.added.length + diff.servers.changed.length + diff.servers.removed.length > 0;
}

/** 从预览差异推导「旧口径」的计数（含 unchanged：旧的 install 对每个匹配项都算 updated）。 */
function countsFromDiff(diff: PluginInstallPreview): {
  added: number;
  updated: number;
  removed: number;
  serversAdded: number;
  serversUpdated: number;
  serversRemoved: number;
} {
  return {
    added: diff.skills.added.length,
    updated: diff.skills.changed.length + diff.skills.unchanged.length,
    removed: diff.skills.removed.length,
    serversAdded: diff.servers.added.length,
    serversUpdated: diff.servers.changed.length + diff.servers.unchanged.length,
    serversRemoved: diff.servers.removed.length,
  };
}

/** 版本历史（≤3，超限丢最旧）：补上旧版本与本次版本，连续重复只留一条。 */
function buildHistory(
  existing: InstalledPlugin | null,
  nextVersion: string,
  at: string,
): NonNullable<InstalledPlugin["history"]> {
  const base = existing
    ? existing.history
      ? existing.history.map((entry) => ({ ...entry }))
      : [{ version: existing.manifest.version, at: existing.installedAt }]
    : [];
  const next = [...base];
  const last = next[next.length - 1];
  if (!last || last.version !== nextVersion) next.push({ version: nextVersion, at });
  return next.slice(-3);
}

/** 本机见过的最高版本（防降级口径；都用 shared 的 `comparePluginVersions`）。 */
function highestPluginVersion(...versions: Array<string | undefined>): string {
  let best = "";
  for (const version of versions) {
    if (!version) continue;
    if (!best || comparePluginVersions(version, best) > 0) best = version;
  }
  return best;
}

interface PluginData {
  version: 1;
  plugins: InstalledPlugin[];
}

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function defaultStorage(): StorageLike {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch {
    // 个别环境访问 localStorage 本身即抛错 → 退回内存
  }
  return memoryStorage();
}

function uniq(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

/** 清单深拷贝（含 v5 的 engines/meta 与界面插件规格；安装记录与 previous 共用）。 */
function copyManifest(manifest: PluginManifest): PluginManifest {
  const { contributions, permissions } = manifest;
  return {
    ...manifest,
    contributions: {
      skills: contributions.skills.map((skill) => ({
        ...skill,
        triggers: [...skill.triggers],
        tags: [...skill.tags],
      })),
      mcpServers: contributions.mcpServers.map((server) => ({ ...server })),
      commands: contributions.commands.map((command) => ({
        ...command,
        keywords: [...command.keywords],
        target: { ...command.target },
      })),
      toolPacks: contributions.toolPacks.map((pack) => ({ ...pack, tools: [...pack.tools] })),
      // d.94：界面插件声明（deep copy；web 只展示，安装/执行在主进程）
      desktopWidgets: contributions.desktopWidgets.map((widget) => ({
        ...widget,
        scales: [...widget.scales],
        position: { ...widget.position },
        ...(widget.tray ? { tray: { ...widget.tray, items: [...widget.tray.items] } } : {}),
        ...(widget.settings
          ? {
              settings: {
                ...widget.settings,
                fields: widget.settings.fields.map((field) => ({
                  ...field,
                  ...(field.options
                    ? { options: field.options.map((option) => ({ ...option })) }
                    : {}),
                })),
              },
            }
          : {}),
      })),
      llmPresets: [],
    },
    permissions: {
      network: [...permissions.network],
      tools: permissions.tools,
      files: [...permissions.files],
      events: [...permissions.events],
      graphics: [...permissions.graphics],
      eval: permissions.eval,
      // d.113 的 v5 字段：漏拷会让 `list()` 的清单与落盘清单指纹不一致，
      // 所有 v5 插件一装完就被判「降级」。
      chat: permissions.chat,
    },
    // v5：engines/meta 是可选字段，只对 v5 清单出现。
    ...(manifest.engines ? { engines: { ...manifest.engines } } : {}),
    ...(manifest.meta
      ? {
          meta: {
            ...manifest.meta,
            ...(manifest.meta.tags ? { tags: [...manifest.meta.tags] } : {}),
            ...(manifest.meta.keywords ? { keywords: [...manifest.meta.keywords] } : {}),
            ...(manifest.meta.screenshots ? { screenshots: [...manifest.meta.screenshots] } : {}),
          },
        }
      : {}),
    publisher: manifest.publisher ? { ...manifest.publisher } : undefined,
    signature: manifest.signature ? { ...manifest.signature } : undefined,
  };
}

function copyPlugin(plugin: InstalledPlugin): InstalledPlugin {
  return {
    ...plugin,
    manifest: copyManifest(plugin.manifest),
    skillIds: [...plugin.skillIds],
    serverIds: [...plugin.serverIds],
    publisher: plugin.publisher ? { ...plugin.publisher } : null,
    signature: plugin.signature ? { ...plugin.signature } : null,
    disabledKinds: [...plugin.disabledKinds],
    ...(plugin.previous
      ? {
          previous: {
            manifest: copyManifest(plugin.previous.manifest),
            fingerprint: plugin.previous.fingerprint,
            installedAt: plugin.previous.installedAt,
          },
        }
      : {}),
    ...(plugin.history ? { history: plugin.history.map((entry) => ({ ...entry })) } : {}),
    ...(plugin.highestVersion ? { highestVersion: plugin.highestVersion } : {}),
  };
}

/**
 * 把存储里的归一化清单还原成「能再过一次 v5 解析」的形状。
 *
 * 两处 web/共享的写读差异必须在这里抹平，否则所有 v5 记录重启后都读不回来：
 * 1. web 内部形状恒定带 `contributions.llmPresets: []`（旧消费方兼容字段），
 *    而 v5 的 `contributions` 是 strict（未知键=报错）；
 * 2. shared 的 `trimmed()` 是 `min(1)`，但缺省值是 `""`（zod 的 `.default("")` 不跑校验）——
 *    归一化后的记录一定写有 `description: ""` / `author: ""`，显式传回去会被判「至少 1 个字」。
 *
 * ★ 这是 web 侧的自保，不是正确契约：shared 的 v5 schema 应该允许这两个字段为空串
 *   （或把缺省值改成不落盘）。shared 属只读范围，已在交付说明里提出。
 */
function stripWebCompatFields(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  if (out.description === "") delete out.description;
  if (out.author === "") delete out.author;
  const contributions = record.contributions;
  if (!contributions || typeof contributions !== "object" || Array.isArray(contributions)) {
    return out;
  }
  const { llmPresets: _ignored, ...rest } = contributions as Record<string, unknown>;
  const cleaned: Record<string, unknown> = { ...rest };
  for (const key of ["skills", "mcpServers", "commands", "toolPacks"]) {
    const list = cleaned[key];
    if (!Array.isArray(list)) continue;
    cleaned[key] = list.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const item = { ...(entry as Record<string, unknown>) };
      if (item.description === "") delete item.description;
      return item;
    });
  }
  out.contributions = cleaned;
  return out;
}

/**
 * 读回本机存储里的清单。
 *
 * 存的是**归一化后的当前形状**（`contributions` / `permissions`，含 v4 的
 * `desktopWidgets` / `events|graphics|eval` 与 v5 的 `engines/meta`），但 `schemaVersion`
 * 保留原始值（旧包要能在界面上标「旧版清单」）。直接按原始版本号解析会踩三条坑：
 * 旧版规则会去顶层找 `skills`；v3 规则会把归一化后的 v4 字段当成「v3 带新字段」拒绝；
 * v5 的 `engines` 是必填。所以：
 * v5 先按 v5 重读（判兼容性需要 engines），**失败即抛**（P1-7：绝不用 v4 兜底，
 * 否则 engines 丢失后会被误判「兼容」）；v1–v4 先按**当前形状**（v4）解析，
 * 再把版本号还原成存储里的原始值。
 */
function parseStoredManifest(raw: unknown): PluginManifest {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const version = record.schemaVersion;
    if (version === 5) {
      try {
        return parsePluginManifest(stripWebCompatFields(record));
      } catch (err) {
        // P1-7（d.110）：失败**关闭**。此前这里用 v4 重新解析并把 schemaVersion 回填 5，
        // 结果 engines 被 zod 剥掉 → `pluginEnginesStatus` 按「不限制」放行，
        // 损坏记录反而比正常记录更容易生效。现在交给 `coerce()` 标 invalidRecord。
        throw new PluginManifestError(`v5 清单记录损坏：${errorMessage(err)}`);
      }
    }
    if ("contributions" in record || "permissions" in record) {
      const parsed = parsePluginManifest({ ...record, schemaVersion: 4 });
      // 1/2/3 都只是「显示用的旧版本号」，归一化后的结构是当前形状。
      return version === 1 || version === 2 || version === 3
        ? { ...parsed, schemaVersion: version }
        : parsed;
    }
  }
  return parsePluginManifest(raw);
}

/**
 * 从损坏的 v5 记录里抢救出「还能展示/还能卸载」的最小清单（P1-7）。
 *
 * 只抢救 id/name/version/description/author 这类纯展示字段；贡献与权限一律清空
 * （损坏的权限声明不可信，宁可显示「无贡献」）。返回的清单**不带 engines**，
 * 所以 `pluginEnginesStatus` 对它会给出 `invalidEngines`（而不是「兼容」）。
 * id 都救不出来时返回 null（无法定位/卸载，只能丢）。
 */
function salvageCorruptManifest(
  raw: unknown,
  reason: string,
): { manifest: PluginManifest; reason: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id) return null;
  const text = (value: unknown, fallback: string): string =>
    typeof value === "string" && value.trim() ? value : fallback;
  return {
    manifest: {
      schemaVersion: 5,
      id: record.id,
      name: text(record.name, "（损坏的插件记录）"),
      version: text(record.version, "0.0.0"),
      description: text(record.description, ""),
      author: text(record.author, ""),
      distribution: "manifest",
      contributions: {
        skills: [],
        mcpServers: [],
        commands: [],
        toolPacks: [],
        desktopWidgets: [],
        llmPresets: [],
      },
      permissions: { network: [], tools: "read", files: [], events: [], graphics: [], eval: false },
    },
    reason,
  };
}

/**
 * 声明式安装管线只接受**不含代码**的清单（d.94）。
 *
 * 界面插件（`distribution: "bundle"` / 声明 `desktopWidgets`）的代码、窗口、签名校验
 * 全在主进程的 `widgets:install` 里；把它塞进这里只会物化出技能/MCP 记录而没有窗口，
 * 属于「半可用状态」。所以这里直接拒绝并指路到「桌面小组件」。
 */
function assertDeclarativeManifest(manifest: PluginManifest): void {
  if (manifest.distribution === "bundle" || manifest.contributions.desktopWidgets.length > 0) {
    throw new PluginManifestError(
      `「${manifest.name}」是界面插件包（包含可执行界面代码），请到插件区「桌面小组件」安装；当前安装入口只处理不含代码的清单`,
    );
  }
}

/**
 * 贡献是否生效：总开关 **且** 该贡献类未被单独停用。
 *
 * 纯函数，导出给目录/命令面板/页面读口径用；总开关关闭时恒为 false，
 * 且不受 `disabledKinds` 影响（先关总开关，再按类恢复也不生效）。
 */
export function effectiveEnabled(
  plugin: Pick<InstalledPlugin, "enabled" | "disabledKinds">,
  kind: PluginContributionKind,
): boolean {
  return plugin.enabled && !plugin.disabledKinds.includes(kind);
}

/* ───────────────────────── 插件健康度与修复（d.113） ───────────────────────── */

/**
 * 健康问题代码（d.113）。
 *
 * 前六项是审计要求的最小集；`signature-unverified` 是补充项：`unsupported`
 * （有签名但本机没验过）不等于 `invalid`，但同样值得在健康度里如实提示，
 * 不能混成「签名正常」。
 */
export type PluginHealthIssueCode =
  /** v5 清单解析失败被抢救出来的记录（P1-7）。 */
  | "invalid-record"
  /** `skillIds` 指向的技能已不在技能池（LRU 淘汰 / 手工删除 / 旧版本残留）。 */
  | "dangling-skill"
  /** `serverIds` 指向的服务已不在 MCP 注册表（或已被改成手填）。 */
  | "dangling-server"
  /** 记录里的内容指纹与清单实际内容不一致（手改存储）。 */
  | "fingerprint-mismatch"
  /** 签名验证失败（`status: "invalid"`）。 */
  | "signature-invalid"
  /** 有签名但本机未验证（`status: "unsupported"`，受限环境/旧记录）。 */
  | "signature-unverified"
  /** 插件已启用，但所有贡献类别都被单独停用（或清单根本没有贡献）。 */
  | "all-contributions-off"
  /** `engines.heming` 不满足当前应用版本（复用 `pluginEnginesStatus`）。 */
  | "incompatible";

/** 健康分级：`broken` 需要修复动作，`degraded` 只需提示。 */
export type PluginHealthLevel = "ok" | "degraded" | "broken";

export const PLUGIN_HEALTH_LABELS: Record<PluginHealthLevel, string> = {
  ok: "正常",
  degraded: "降级",
  broken: "损坏",
};

/** 单条健康问题。 */
export interface PluginHealthIssue {
  code: PluginHealthIssueCode;
  /** `broken` 会让整体变 broken；其余只降级。 */
  severity: "degraded" | "broken";
  /** 中文说明（UI 诊断区直接展示）。 */
  message: string;
  /** 关联 id（悬空技能/服务 id 等）。 */
  target?: string;
}

/** 健康判定输入的技能引用（纯函数不依赖 SkillPool 实例）。 */
export interface PluginHealthSkillRef {
  id: string;
  pluginId?: string;
}

/** 健康判定输入的服务引用（纯函数不依赖 McpRegistry 实例）。 */
export interface PluginHealthServerRef {
  id: string;
  origin?: ServerOrigin;
}

export interface PluginHealth {
  pluginId: string;
  level: PluginHealthLevel;
  issues: PluginHealthIssue[];
  /** 悬空技能引用条数（修复后进 `dropped`）。 */
  danglingSkills: number;
  /** 悬空服务引用条数。 */
  danglingServers: number;
}

export interface InspectPluginHealthOptions {
  /** 覆盖应用版本（默认 `__APP_VERSION__`；测试注入）。 */
  appVersion?: string;
}

/** 清单里某一类贡献的条目数（健康判定与投影同口径）。 */
function manifestContributionCount(manifest: PluginManifest, kind: PluginContributionKind): number {
  switch (kind) {
    case "skills":
      return manifest.contributions.skills.length;
    case "mcpServers":
      return manifest.contributions.mcpServers.length;
    case "commands":
      return manifest.contributions.commands.length;
    case "toolPacks":
      return manifest.contributions.toolPacks.length;
    default:
      return 0;
  }
}

/**
 * 插件健康度判定（纯函数，只读）。
 *
 * 分级口径：
 * - `broken`：`invalidRecord`（清单已不可信），或记录声称的贡献**全部**悬空
 *   （技能/服务引用一条都对不上）——这两种只能靠修复/重装/卸载，不能当正常插件用；
 * - `degraded`：其余问题（部分悬空、指纹不一致、签名异常/未验证、全部贡献级停用、
 *   engines 不兼容）——仍可用，但必须在诊断区说清楚；
 * - `ok`：没有任何问题。
 *
 * 注意：`all-contributions-off` 只在**已启用**时上报；用户主动停用的插件不该被报健康问题。
 */
export function inspectPluginHealth(
  plugin: InstalledPlugin,
  skills: readonly PluginHealthSkillRef[],
  servers: readonly PluginHealthServerRef[],
  options: InspectPluginHealthOptions = {},
): PluginHealth {
  const pluginId = plugin.manifest.id;
  const issues: PluginHealthIssue[] = [];
  const skillById = new Map(skills.map((skill) => [skill.id, skill] as const));
  const serverById = new Map(servers.map((server) => [server.id, server] as const));

  let danglingSkills = 0;
  for (const skillId of plugin.skillIds) {
    const skill = skillById.get(skillId);
    if (!skill) {
      danglingSkills += 1;
      issues.push({
        code: "dangling-skill",
        severity: "degraded",
        target: skillId,
        message: `技能引用悬空：${skillId} 已不在技能池（可能被淘汰或手工删除）`,
      });
      continue;
    }
    // 存在但归属不是本插件：同样不能算本插件的贡献（否则修复会互相抢技能）。
    if (skill.pluginId !== pluginId) {
      danglingSkills += 1;
      issues.push({
        code: "dangling-skill",
        severity: "degraded",
        target: skillId,
        message: `技能引用不属于本插件：${skillId}（归属 ${skill.pluginId ?? "用户"}）`,
      });
    }
  }

  let danglingServers = 0;
  for (const serverId of plugin.serverIds) {
    const server = serverById.get(serverId);
    if (!server) {
      danglingServers += 1;
      issues.push({
        code: "dangling-server",
        severity: "degraded",
        target: serverId,
        message: `MCP 服务引用悬空：${serverId} 已不在注册表（可能被手工删除）`,
      });
      continue;
    }
    if (server.origin !== "plugin") {
      danglingServers += 1;
      issues.push({
        code: "dangling-server",
        severity: "degraded",
        target: serverId,
        message: `MCP 服务引用已不属于插件：${serverId}（已被改成手填服务）`,
      });
    }
  }

  if (plugin.invalidRecord) {
    issues.push({
      code: "invalid-record",
      severity: "broken",
      message: `安装记录损坏：${plugin.invalidReason ?? "清单无法解析"}（可先尝试「修复记录」，否则建议重装或卸载）`,
    });
  } else {
    try {
      if (plugin.fingerprint && contentFingerprint(plugin.manifest) !== plugin.fingerprint) {
        issues.push({
          code: "fingerprint-mismatch",
          severity: "degraded",
          message: "记录里的内容指纹与清单不一致（清单可能被手工修改）；「修复记录」会按当前清单重算",
        });
      }
    } catch {
      /* 指纹/清单异常不应让健康检查本身抛错 */
    }

    const engines = pluginEnginesStatus(
      { schemaVersion: plugin.manifest.schemaVersion, engines: plugin.manifest.engines },
      options.appVersion ?? currentAppVersion(),
    );
    if (engines.status !== "compatible") {
      issues.push({
        code: "incompatible",
        severity: "degraded",
        message: enginesStatusText(engines),
      });
    }
  }

  if (plugin.signature?.status === "invalid") {
    issues.push({
      code: "signature-invalid",
      severity: "degraded",
      message: "清单签名未通过验证：插件仍处于启用状态，但内容不可信，建议重装官方签名版本",
    });
  } else if (plugin.signature?.status === "unsupported") {
    issues.push({
      code: "signature-unverified",
      severity: "degraded",
      message: "清单带签名但本机尚未验证（受限环境或旧记录）：无法确认来源",
    });
  }

  if (plugin.enabled) {
    const declared = PLUGIN_CONTRIBUTION_KINDS.filter(
      (kind) => manifestContributionCount(plugin.manifest, kind) > 0,
    );
    const active = declared.filter((kind) => !plugin.disabledKinds.includes(kind));
    if (active.length === 0) {
      issues.push({
        code: "all-contributions-off",
        severity: "degraded",
        message:
          declared.length > 0
            ? "插件已启用，但所有贡献类别都被单独停用，实际不生效"
            : "插件已启用，但清单没有任何贡献，实际不生效",
      });
    }
  }

  const totalRefs = plugin.skillIds.length + plugin.serverIds.length;
  const danglingRefs = danglingSkills + danglingServers;
  const broken = plugin.invalidRecord === true || (totalRefs > 0 && danglingRefs === totalRefs);
  return {
    pluginId,
    level: broken ? "broken" : issues.length > 0 ? "degraded" : "ok",
    issues,
    danglingSkills,
    danglingServers,
  };
}

export class PluginStore {
  private readonly storage: StorageLike;
  private readonly skills: SkillPool;
  private readonly now: () => number;
  private readonly mcp: PluginMcpPort;
  private readonly publishers: PublisherTrustStore;
  private data: PluginData;
  /** 读取时发现旧记录缺指纹 → 构造完成后补写一次（不视为错误）。 */
  private backfilledFingerprint = false;

  constructor(
    storage?: StorageLike,
    skills?: SkillPool,
    now?: () => number,
    mcp?: PluginMcpPort,
    publishers?: PublisherTrustStore,
  ) {
    this.storage = storage ?? defaultStorage();
    this.skills = skills ?? skillPool;
    this.now = now ?? (() => Date.now());
    this.mcp = mcp ?? mcpRegistry;
    // 发布者信任表与插件记录共用同一存储介质（测试可整体注入内存实现）。
    this.publishers = publishers ?? new PublisherTrustStore(this.storage);
    this.data = this.parse(this.read());
    if (this.backfilledFingerprint) this.save();
  }

  list(): InstalledPlugin[] {
    return this.data.plugins.map(copyPlugin);
  }

  get(id: string): InstalledPlugin | undefined {
    const found = this.data.plugins.find((p) => p.manifest.id === id);
    return found ? copyPlugin(found) : undefined;
  }

  /**
   * 只读预览：解析清单并对比**当前物化状态**，不写技能、不写服务、不落盘。
   *
   * 差异口径与 `install` 完全一致：按技能名匹配、按服务 key 匹配；
   * 服务 id 被非插件来源占用时只进 `conflicts`，不混进新增/变更。
   */
  preview(input: string | unknown): PluginInstallPreview {
    const manifest = parsePluginManifest(input);
    assertDeclarativeManifest(manifest);
    return this.previewOf(manifest);
  }

  /**
   * 差异预览的纯计算（差异/冲突/信任提示），不解析、不写盘。
   *
   * 抽出来是为了让 `planInstall` 复用同一套口径：预览里说「服务 +1」，
   * 计划与落盘就必须是同一件事——两处各算一遍是半装态的高发地。
   */
  private previewOf(manifest: PluginManifest): PluginInstallPreview {
    const existing = this.data.plugins.find((p) => p.manifest.id === manifest.id) ?? null;

    const owned = this.skills.list().filter((s) => s.pluginId === manifest.id);
    const byName = new Map(owned.map((s) => [s.name, s]));
    const skills: PluginSkillDiff = { added: [], changed: [], unchanged: [], removed: [] };
    for (const spec of manifest.contributions.skills) {
      const match = byName.get(spec.name);
      if (!match) skills.added.push(spec.name);
      else if (sameSkill(spec, match)) skills.unchanged.push(spec.name);
      else skills.changed.push(spec.name);
      byName.delete(spec.name);
    }
    for (const name of byName.keys()) skills.removed.push(name);

    const conflicts: PluginServerConflict[] = [];
    const servers: PluginServerDiff = { added: [], changed: [], unchanged: [], removed: [] };
    const nextIds = new Set<string>();
    for (const spec of manifest.contributions.mcpServers) {
      const id = pluginServerId(manifest.id, spec.key);
      nextIds.add(id);
      const current = this.mcp.get(id);
      if (current && current.origin !== "plugin") {
        conflicts.push({ id, name: current.name });
        continue;
      }
      const entry = { key: spec.key, name: spec.name };
      if (!current) servers.added.push(entry);
      else if (current.name !== spec.name || (current.url ?? "") !== spec.url) {
        servers.changed.push(entry);
      } else servers.unchanged.push(entry);
    }
    for (const oldId of existing?.serverIds ?? []) {
      if (nextIds.has(oldId)) continue;
      const current = this.mcp.get(oldId);
      if (!current || current.origin !== "plugin") continue;
      const key = serverKeyFromId(manifest.id, oldId);
      const oldName =
        existing?.manifest.contributions.mcpServers.find((server) => server.key === key)?.name ?? current.name;
      servers.removed.push({ key, name: oldName });
    }

    // 主机的「已声明」口径与解析期一致：v3 直接读 permissions.network，
    // v1/v2 归一化时已由服务 URL 推导并补全，这里不再二次推导，避免两套口径。
    const hosts = [...manifest.permissions.network];

    const fingerprint = contentFingerprint(manifest);
    const previousFingerprint = existing?.fingerprint || null;
    // 「同版本内容变了」只对同 id 同 version 有意义：正常升级的内容差异
    // 已经由技能/服务差异预览覆盖，再叠加一个红字只会制造噪声。
    const sameVersionContentChanged =
      existing != null &&
      existing.manifest.version === manifest.version &&
      previousFingerprint !== fingerprint;
    const authorChanged = existing != null && existing.manifest.author !== manifest.author;
    // TOFU 换钥判定：只比对已信任记录与本次清单的公钥原文。
    // 用原文而非指纹比对是等价的（指纹就是公钥的哈希），但省掉了异步哈希：
    // preview 必须同步，不能为了展示阻塞在 WebCrypto 上。
    const trustedPublisher = manifest.publisher
      ? this.publishers.get(manifest.publisher.id)
      : undefined;
    const publisherKeyChanged =
      manifest.publisher != null &&
      trustedPublisher != null &&
      trustedPublisher.publicKey !== manifest.publisher.publicKey;
    const trust: PluginTrustPreview = {
      fingerprint,
      previousFingerprint,
      sameVersionContentChanged,
      authorChanged,
      previousAuthor: existing ? existing.manifest.author : null,
      versionChanged: existing != null && existing.manifest.version !== manifest.version,
      needsConfirm: existing != null && (authorChanged || sameVersionContentChanged),
      // 预览不验签（WebCrypto 异步）：带签名时给 unsupported（= 未验证），
      // 真实结论由 UI `verifyManifestSignature` 得到；绝不在这里报 valid。
      signatureStatus: manifest.signature ? "unsupported" : "none",
      publisherKeyChanged,
    };

    return {
      manifest,
      existing: existing ? copyPlugin(existing) : null,
      skills,
      servers,
      conflicts,
      hosts,
      trust,
      limitReached: !existing && this.data.plugins.length >= MAX_PLUGINS,
    };
  }

  /** 插件已物化的技能（真实启用位），供详情页展示。 */
  skillsOf(pluginId: string): PluginSkillInfo[] {
    const plugin = this.data.plugins.find((p) => p.manifest.id === pluginId);
    if (!plugin) return [];
    // 读口径统一走 effectiveEnabled：即使底层技能池的开关因外部改动没同步，
    // 详情页也只会显示「按插件口径不生效」，不会把停用类显示成可用。
    const kindsOn = effectiveEnabled(plugin, "skills");
    const out: PluginSkillInfo[] = [];
    for (const id of plugin.skillIds) {
      const skill = this.skills.get(id);
      if (skill) {
        out.push({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          enabled: skill.enabled && kindsOn,
        });
      }
    }
    return out;
  }

  /** 贡献计数（技能 / 服务 / 命令 / 工具束·工具）：插件卡与安装弹窗的摘要都用它。 */
  contributionCounts(pluginId: string): PluginContributionCounts {
    const plugin = this.data.plugins.find((p) => p.manifest.id === pluginId);
    if (!plugin) {
      return { skills: 0, servers: 0, commands: 0, toolPacks: 0, packTools: 0 };
    }
    const { skills, mcpServers, commands, toolPacks } = plugin.manifest.contributions;
    return {
      skills: skills.length,
      servers: mcpServers.length,
      commands: commands.length,
      toolPacks: toolPacks.length,
      packTools: toolPacks.reduce((sum, pack) => sum + pack.tools.length, 0),
    };
  }

  /**
   * 命令面板用的插件命令。
   *
   * 只列**总开关开启且 commands 未单独停用**的插件：停用 = 不可用，
   * 命令若还能触发就是绕过停用语义（面板入口必须和执行面同口径）。
   */
  commands(): PluginCommandInfo[] {
    const out: PluginCommandInfo[] = [];
    for (const plugin of this.data.plugins) {
      if (!effectiveEnabled(plugin, "commands")) continue;
      for (const command of plugin.manifest.contributions.commands) {
        out.push({
          id: pluginServerId(plugin.manifest.id, command.id),
          pluginId: plugin.manifest.id,
          pluginName: plugin.manifest.name,
          title: command.title,
          description: command.description,
          keywords: [...command.keywords],
          target: { ...command.target },
        });
      }
    }
    return out;
  }

  /** 插件登记且仍归插件所有的服务（真实启用位），供详情页展示。 */
  serversOf(pluginId: string): PluginServerInfo[] {
    const plugin = this.data.plugins.find((p) => p.manifest.id === pluginId);
    if (!plugin) return [];
    const kindsOn = effectiveEnabled(plugin, "mcpServers");
    const out: PluginServerInfo[] = [];
    for (const id of plugin.serverIds) {
      const server = this.mcp.get(id);
      if (server && server.origin === "plugin") {
        out.push({
          id: server.id,
          name: server.name,
          url: server.url ?? "",
          enabled: server.enabled && kindsOn,
        });
      }
    }
    return out;
  }

  /**
   * 安装或更新（旧入口，对外语义与此前一致）。
   *
   * 内部改为 `planInstall` + `applyPlan`，但保留两点旧语义：
   * 1. 该入口视为「用户已在安装弹窗确认过整份清单」（含权限扩张与降级），
   *    所以强制 `confirmPermissionExpansion / allowDowngrade`；
   * 2. 失败时抛错：清单/规则问题抛 `PluginManifestError`，写失败抛 `PluginInstallError`
   *    （带完整回滚报告，`applied: "failed"` 的信息不丢）。
   *
   * 新界面应走 `planInstall` → 展示差异/权限/兼容性/体积 → `applyPlan`，
   * 这样「权限扩张需要重新确认」「需要更新和鸣」才能展示给用户。
   */
  install(input: string | unknown, options: PluginInstallOptions = {}): InstallResult {
    const plan = this.planInstall(input, {
      ...options,
      confirmPermissionExpansion: true,
      allowDowngrade: true,
    });
    // 硬规则（冲突/不兼容/超体积）属「包或规则问题」，沿用旧入口的 PluginManifestError。
    const blocked = plan.blocked[0];
    if (blocked) throw new PluginManifestError(blocked.message);
    const result = this.applyPlan(plan);
    if (result.applied === "failed" || !result.plugin) {
      const error = result.diagnostics.find((item) => item.severity === "error");
      throw new PluginInstallError(
        error?.message ?? "安装失败，已恢复到安装前状态",
        result,
      );
    }
    return {
      plugin: result.plugin,
      created: plan.mode === "install",
      added: result.added,
      updated: result.updated,
      removed: result.removed,
      serversAdded: result.serversAdded,
      serversUpdated: result.serversUpdated,
      serversRemoved: result.serversRemoved,
      changed: result.changed,
      applied: "applied",
      mode: plan.mode,
      ...(result.rollback ? { rollback: result.rollback } : {}),
      diagnostics: result.diagnostics,
    };
  }

  /**
   * 生成安装计划（规格 §5.1）：**纯函数，不写任何存储**。
   *
   * 做四件事：① 复用 `preview()` 算差异与冲突；② `engines` 兼容判定；
   * ③ 权限扩张检测（network 新增 host / tools 放宽 / 新贡献类别）；
   * ④ 体积预估（写前算「这类键写后总字节」，超预算直接拦在写阶段之前）。
   *
   * 硬规则（冲突/不兼容/降级/超体积）只进 `blocked`，不抛错——UI 需要在同一屏
   * 把这些原因和差异一起展示；`applyPlan` 见到非空 `blocked` 会拒绝执行。
   *
   * @param input 原始清单（JSON 文本/对象，会完整校验并带回 warning），
   *              或已归一化的清单（`previous.manifest` 回滚场景，不再二次解析）。
   */
  planInstall(input: string | PluginManifest | unknown, options: InstallPlanOptions = {}): InstallPlan {
    const { manifest, warnings } = resolvePlanManifest(input);
    assertDeclarativeManifest(manifest);
    const index = this.data.plugins.findIndex((p) => p.manifest.id === manifest.id);
    if (index < 0 && this.data.plugins.length >= MAX_PLUGINS) {
      throw new PluginManifestError(
        `插件数量已达上限（${MAX_PLUGINS} 个），请先卸载不用的插件`,
      );
    }

    const existing = index >= 0 ? copyPlugin(this.data.plugins[index]) : null;
    const mode: InstallPlan["mode"] = existing ? "update" : "install";
    const diff = this.previewOf(manifest);
    const v5 = toPluginV5View(manifest);
    const appVersion = options.appVersion ?? currentAppVersion();
    const engines = pluginEnginesStatus(
      { schemaVersion: manifest.schemaVersion, engines: manifest.engines },
      appVersion,
    );
    // 损坏记录（P1-7）没有可信的权限基线：本次安装按「首装」重新确认整份清单。
    const permissionUpgrade = diffPermissionUpgrade(existing?.invalidRecord ? null : (existing?.manifest ?? null), manifest);
    const at = this.iso();
    const highestVersion = existing
      ? highestPluginVersion(existing.highestVersion, existing.manifest.version, manifest.version)
      : manifest.version;
    const previousInfo = existing
      ? existing.invalidRecord
        ? { previous: null as InstalledPlugin["previous"] | null }
        : this.buildPrevious(existing)
      : { previous: null as InstalledPlugin["previous"] | null };
    const history = buildHistory(existing, manifest.version, at);
    const size = this.estimateInstallSize(manifest, existing, previousInfo.previous);
    const blocked: InstallPlanBlock[] = [];
    if (diff.conflicts.length > 0) {
      blocked.push({
        code: "conflicts",
        message: `MCP 服务 id 冲突：${diff.conflicts[0].id} 已被其它来源的服务占用，请先在接口区删除或改名`,
      });
    }
    if (engines.status !== "compatible") {
      blocked.push({ code: "engines", message: enginesStatusText(engines) });
    }
    if (existing && comparePluginVersions(manifest.version, highestVersion) < 0 && !options.allowDowngrade) {
      blocked.push({
        code: "downgrade",
        message: `拒绝降级安装：本机见过的最高版本是 ${highestVersion}，本次要装 ${manifest.version}（如确需降级请显式确认）`,
      });
    }
    if (size.exceeded) {
      blocked.push({ code: "size", message: size.suggestion ?? "安装体积超限，请先清理本机存储" });
    }
    // P1-8：技能池有独立 1.2MB 硬上限，超限会静默淘汰技能（含内置且不复活）。
    // 必须在写之前拦住——装完再回滚也救不回被淘汰的技能。
    if (size.skillsPoolExceeded) {
      blocked.push({
        code: "skills-pool-budget",
        message: `技能池接近上限（写入后约 ${formatMiB(size.skillsPoolAfterBytes)}，上限 ${formatMiB(size.skillsPoolLimitBytes)}）：安装会淘汰已有技能；请先清理技能`,
      });
    }

    const planWarnings = [...warnings];
    if (manifest.schemaVersion < 5) {
      planWarnings.push(
        `清单未标注兼容性（schemaVersion ${manifest.schemaVersion}）：按「不限宿主版本」处理`,
      );
    }
    if (permissionUpgrade.expands) {
      planWarnings.push(...permissionUpgrade.reasons.map((reason) => `权限扩张：${reason}`));
    }
    if (previousInfo.warning) planWarnings.push(previousInfo.warning);
    if (existing?.invalidRecord) {
      planWarnings.push(
        `原插件记录已损坏（${existing.invalidReason ?? "清单无法解析"}）：本次安装会覆盖修复它；本次不保留 previous`,
      );
    }

    // 幂等：同清单重复安装不写存储（changed=false）；版本历史与 previous 也不动。
    // 损坏记录例外（P1-7）：必须重写一次才能把 invalidRecord 修掉。
    const noop =
      existing != null &&
      existing.invalidRecord !== true &&
      existing.fingerprint === diff.trust.fingerprint &&
      isEmptySkillDiff(diff.skills) &&
      isEmptyServerDiff(diff.servers) &&
      diff.conflicts.length === 0;

    return {
      manifest,
      v5,
      mode,
      existing,
      diff,
      conflicts: [...diff.conflicts],
      writes: noop ? [] : this.planWrites(manifest, existing, diff, previousInfo.previous),
      warnings: planWarnings,
      engines,
      permissionUpgrade,
      size,
      blocked,
      needsConfirmation:
        mode === "update" && permissionUpgrade.expands && !options.confirmPermissionExpansion,
      previous: previousInfo.previous,
      history,
      highestVersion,
      options,
      noop,
    };
  }

  /**
   * 执行安装计划（规格 §5.2 的三段式）：`prepare`（快照受影响键）→ `persist`（按计划写）
   * → 失败 `rollback`（逐键恢复 + 三个单例 `reload()`）。
   *
   * 关键约束：
   * - 写失败**必须可见**：插件记录用 `saveOrThrow()`；技能池/MCP 注册表的 `save()`
   *   会吞配额异常（历史行为，不改），所以这里读回校验「该变的键确实变了」；
   * - 回滚失败如实报 `rollback.ok=false`，绝不谎报成功；
   * - `changed`（存储是否变）与 `applied`（是否生效）分开报告。
   */
  applyPlan(plan: InstallPlan): InstallApplyResult {
    const mode = plan.mode;
    const diagnostics: PluginDiagnostic[] = plan.warnings.map((message) => ({
      severity: "warning",
      code: "plan-warning",
      message,
    }));
    for (const block of plan.blocked) {
      diagnostics.push({ severity: "error", code: block.code, message: block.message });
    }
    if (plan.needsConfirmation) {
      diagnostics.push({
        severity: "error",
        code: "confirm",
        message: "本次更新扩大了权限（新增主机/放宽工具上限/新增贡献类别），需要重新确认后才能安装",
      });
    }
    const fail = (rollback?: InstallRollbackReport): InstallApplyResult => ({
      changed: false,
      applied: "failed",
      mode,
      plugin: null,
      added: 0,
      updated: 0,
      removed: 0,
      serversAdded: 0,
      serversUpdated: 0,
      serversRemoved: 0,
      ...(rollback ? { rollback } : {}),
      diagnostics,
    });
    if (plan.blocked.length > 0 || plan.needsConfirmation) return fail();

    // 计划与现状不一致（预览后插件被别处装/卸/改过）：拒绝执行，让 UI 重新预览。
    const live = this.data.plugins.find((p) => p.manifest.id === plan.manifest.id) ?? null;
    const stale =
      plan.mode === "install"
        ? live !== null
        : live === null || (plan.existing != null && live.fingerprint !== plan.existing.fingerprint);
    if (stale) {
      diagnostics.push({
        severity: "error",
        code: "stale",
        message: "安装计划已过期（插件状态在预览后发生了变化），请重新预览后再安装",
      });
      return fail();
    }

    // 幂等：同清单重复安装直接返回，不碰存储。
    if (plan.noop && plan.existing) {
      return {
        changed: false,
        applied: "applied",
        mode,
        plugin: live ? copyPlugin(live) : copyPlugin(plan.existing),
        ...countsFromDiff(plan.diff),
        diagnostics,
      };
    }

    const manifest = plan.manifest;
    const existing = plan.existing;
    const snapshot = this.snapshotTransactionKeys();
    const enabled = existing?.enabled ?? true;
    // 覆盖更新保留贡献级停用选择；新装插件默认全部生效。
    const disabledKinds: PluginContributionKind[] = [...(existing?.disabledKinds ?? [])];
    const skillsEnabled = enabled && !disabledKinds.includes("skills");
    const serversEnabled = enabled && !disabledKinds.includes("mcpServers");
    const nextServerIds = manifest.contributions.mcpServers.map((spec) =>
      pluginServerId(manifest.id, spec.key),
    );

    try {
      /* ── persist：先写「被依赖方」（技能/服务），最后写插件记录 ── */
      const owned = this.skills.list().filter((s) => s.pluginId === manifest.id);
      const byName = new Map(owned.map((s) => [s.name, s]));
      const nextNames = new Set(manifest.contributions.skills.map((s) => s.name));
      let added = 0;
      let updated = 0;
      let removed = 0;
      const skillIds: string[] = [];
      const createdIds: string[] = [];

      for (const spec of manifest.contributions.skills) {
        const match = byName.get(spec.name);
        if (match) {
          this.skills.update(match.id, {
            description: spec.description,
            instructions: spec.instructions,
            triggers: [...spec.triggers],
            tags: [...spec.tags],
            version: manifest.version,
            source: "imported",
            enabled: skillsEnabled,
          });
          skillIds.push(match.id);
          updated += 1;
        } else {
          const created = this.skills.create({
            name: spec.name,
            description: spec.description,
            instructions: spec.instructions,
            triggers: [...spec.triggers],
            tags: [...spec.tags],
            enabled: skillsEnabled,
            version: manifest.version,
            source: "imported",
            pluginId: manifest.id,
          });
          skillIds.push(created.id);
          createdIds.push(created.id);
          added += 1;
        }
      }

      for (const skill of owned) {
        if (!nextNames.has(skill.name)) {
          this.skills.remove(skill.id);
          removed += 1;
        }
      }

      // 技能池的 save() 吞配额异常：读回校验「该变的键确实变了」，
      // 否则会把「技能没写进去」当成装成功（当前半装态的根因之一）。
      if (diffTouchedSkills(plan.diff)) {
        this.assertKeyChanged(SKILLS_KEY, snapshot, "技能");
      }

      // 新技能追加给已有显式分配记录的智能体；无记录者由默认分配（内置 + 插件）覆盖。
      if (createdIds.length > 0) this.skills.assignToAllWithAssignments(createdIds);

      // 服务随包登记：只覆盖名称/地址/启用位，**保留用户在接口区补的请求头**
      // 与已启用的工具集合——那是用户配置，不属于清单。
      let serversAdded = 0;
      let serversUpdated = 0;
      let serversRemoved = 0;
      for (const spec of manifest.contributions.mcpServers) {
        const id = pluginServerId(manifest.id, spec.key);
        if (this.mcp.get(id)) {
          this.mcp.update(id, {
            name: spec.name,
            transport: "http",
            url: spec.url,
            enabled: serversEnabled,
            origin: "plugin",
          });
          serversUpdated += 1;
        } else {
          this.mcp.add({
            id,
            name: spec.name,
            transport: "http",
            url: spec.url,
            enabled: serversEnabled,
            origin: "plugin",
          });
          serversAdded += 1;
        }
      }

      const nextServerSet = new Set(nextServerIds);
      for (const oldId of existing?.serverIds ?? []) {
        if (nextServerSet.has(oldId)) continue;
        const current = this.mcp.get(oldId);
        if (current && current.origin === "plugin") {
          this.mcp.remove(oldId);
          serversRemoved += 1;
        }
      }

      // MCP 注册表同样会吞写异常；只有真注册表（实现了 reload）才做读回校验，
      // 注入的假端口不落这个键，拿它做校验会误报。
      if (diffTouchedServers(plan.diff) && typeof this.mcp.reload === "function") {
        this.assertKeyChanged(MCP_SERVERS_KEY, snapshot, "MCP 服务");
      }

      const at = this.iso();
      // 签名/信任结论由 UI 异步校验后通过 options 交进来；store 自身不验签。
      // 有发布者才记录信任（否则 null）；已签名但没传验签结果时记 unsupported，
      // 绝不默认 valid——「没验过」和「验过有效」必须能区分。
      const publisher =
        manifest.publisher && plan.options.publisher ? { ...plan.options.publisher } : null;
      const signature = manifest.signature
        ? {
            status: plan.options.signatureStatus ?? ("unsupported" as SignatureStatus),
            alg: manifest.signature.alg,
          }
        : null;
      const plugin: InstalledPlugin = {
        manifest,
        enabled,
        skillIds,
        serverIds: nextServerIds,
        fingerprint: contentFingerprint(manifest),
        publisher,
        signature,
        disabledKinds,
        ...(plan.previous ? { previous: plan.previous } : {}),
        history: plan.history,
        highestVersion: plan.highestVersion,
        installedAt: existing?.installedAt ?? at,
        updatedAt: at,
      };
      const index = this.data.plugins.findIndex((p) => p.manifest.id === manifest.id);
      if (index >= 0) this.data.plugins[index] = plugin;
      else this.data.plugins.push(plugin);
      // 关键路径用 saveOrThrow：配额/隐私模式失败必须冒泡到回滚，不能吞。
      this.saveOrThrow();

      return {
        changed: true,
        applied: "applied",
        mode,
        plugin: copyPlugin(plugin),
        added,
        updated,
        removed,
        serversAdded,
        serversUpdated,
        serversRemoved,
        diagnostics,
      };
    } catch (err) {
      const rollback = this.rollbackTransaction(snapshot);
      diagnostics.push({
        severity: "error",
        code: "apply-failed",
        message: `安装失败${rollback.ok ? "，已恢复到安装前状态" : "，回滚未能完全恢复"}：${errorMessage(err)}`,
      });
      return fail(rollback);
    }
  }

  /**
   * 回滚到上一版（规格 §5.3）：用本机留存的旧清单走同一 `planInstall` + `applyPlan`。
   *
   * - 不联网、不校验目录；旧清单的内容指纹只用于提示「与记录不同」，不阻断；
   * - 「回滚」本身就是用户显式发起的降级动作，因此默认 `allowDowngrade: true`
   *   （普通安装路径仍受 `highestVersion` 防降级约束）；
   * - 成功后 `applyPlan` 会把「刚被替换掉的较新清单」写成新的 `previous`，
   *   等于完成了 previous 的交换。
   */
  rollbackToPrevious(id: string, options: InstallPlanOptions = {}): InstallResult {
    const plugin = this.data.plugins.find((p) => p.manifest.id === id);
    if (!plugin) throw new Error(`插件不存在：${id}`);
    if (!plugin.previous) {
      throw new Error(`「${plugin.manifest.name}」没有保留上一版，无法回滚`);
    }
    const previous = plugin.previous;
    const plan = this.planInstall(previous.manifest, {
      ...options,
      allowDowngrade: options.allowDowngrade ?? true,
      confirmPermissionExpansion: options.confirmPermissionExpansion ?? true,
    });
    const warnings = [...plan.warnings];
    // 内容指纹只做提示（旧清单可能被手改过），不阻断回滚。
    const currentFingerprint = contentFingerprint(previous.manifest);
    if (previous.fingerprint && previous.fingerprint !== currentFingerprint) {
      warnings.push("上一版清单的内容指纹与安装记录不同（可能被手动改过），仍按本机留存内容回滚");
    }
    const result = this.applyPlan({ ...plan, warnings });
    if (result.applied === "failed" || !result.plugin) {
      const error = result.diagnostics.find((item) => item.severity === "error");
      throw new PluginInstallError(
        error?.message ?? "回滚失败，已恢复到回滚前状态",
        result,
      );
    }
    return {
      plugin: result.plugin,
      created: false,
      added: result.added,
      updated: result.updated,
      removed: result.removed,
      serversAdded: result.serversAdded,
      serversUpdated: result.serversUpdated,
      serversRemoved: result.serversRemoved,
      changed: result.changed,
      applied: "applied",
      mode: "update",
      ...(result.rollback ? { rollback: result.rollback } : {}),
      diagnostics: result.diagnostics,
    };
  }

  /**
   * 重新读本机存储里的插件记录（安装事务回滚后必须调；与构造期读取同口径）。
   */
  reload(): void {
    this.backfilledFingerprint = false;
    this.data = this.parse(this.read());
    if (this.backfilledFingerprint) this.save();
  }

  /** 取 `previous` 候选（带 §5.3 的 128KB/512KB 限额判定）。 */
  private buildPrevious(existing: InstalledPlugin): {
    previous: InstalledPlugin["previous"] | null;
    warning?: string;
  } {
    const candidate: NonNullable<InstalledPlugin["previous"]> = {
      manifest: copyManifest(existing.manifest),
      fingerprint: existing.fingerprint,
      installedAt: existing.installedAt,
    };
    const bytes = utf8Length(JSON.stringify(candidate));
    if (bytes > PREVIOUS_MANIFEST_MAX_BYTES) {
      return {
        previous: null,
        warning: `本插件未保留上一版：旧清单 ${formatMiB(bytes)} 超过单插件上限 ${formatMiB(PREVIOUS_MANIFEST_MAX_BYTES)}`,
      };
    }
    let total = bytes;
    for (const other of this.data.plugins) {
      if (other.manifest.id === existing.manifest.id || !other.previous) continue;
      total += utf8Length(JSON.stringify(other.previous));
    }
    if (total > PREVIOUS_TOTAL_MAX_BYTES) {
      return {
        previous: null,
        warning: `本插件未保留上一版：全部插件的回滚清单合计 ${formatMiB(total)} 超过上限 ${formatMiB(PREVIOUS_TOTAL_MAX_BYTES)}`,
      };
    }
    return { previous: candidate };
  }

  /** 体积预估（规格 §5.2 步骤 0）：受影响键当前总字节 + 本次写入增量。 */
  private estimateInstallSize(
    manifest: PluginManifest,
    existing: InstalledPlugin | null,
    previous: InstalledPlugin["previous"] | null,
  ): InstallSizeEstimate {
    const keys = [...PLUGIN_TXN_KEYS];
    let currentBytes = 0;
    for (const key of keys) {
      try {
        currentBytes += bytesOf(this.storage.getItem(key));
      } catch {
        /* 读不到按 0 算：预检只是守卫，不因为读异常拒绝安装 */
      }
    }

    // 插件记录：整份清单 + 记录外壳（时间戳/指纹/信任/历史）；更新时扣掉旧清单。
    let delta = utf8Length(JSON.stringify(manifest)) + 512;
    if (existing) delta -= utf8Length(JSON.stringify(existing.manifest));

    // 技能池：按名字对齐新增/更新/删除（记录外壳约 160B：id/时间戳/启用位等）。
    // 单独累计 `skillsDelta`：技能池还有自己的 1.2MB 硬上限（P1-8），要单独预检。
    const owned = this.skills.list().filter((s) => s.pluginId === manifest.id);
    const byName = new Map(owned.map((skill) => [skill.name, skill] as const));
    let skillsDelta = 0;
    let assignmentsDelta = 0;
    for (const spec of manifest.contributions.skills) {
      const cost = utf8Length(JSON.stringify(spec)) + 160;
      const match = byName.get(spec.name);
      if (match) {
        skillsDelta += cost - (utf8Length(JSON.stringify(match)) + 160);
        byName.delete(spec.name);
      } else {
        skillsDelta += cost;
        // 新技能还会追加进「已有显式分配记录」的智能体（按 1 个智能体粗估）；
        // 这部分落在 skillAssignments 键，不属于技能池 JSON。
        assignmentsDelta += 64;
      }
    }
    for (const leftover of byName.values()) {
      skillsDelta -= utf8Length(JSON.stringify(leftover)) + 160;
    }
    delta += skillsDelta + assignmentsDelta;

    // 技能池现状：直接读存储原始 JSON 的字节数（不解析，避免把大池再展开一次）。
    let skillsPoolCurrentBytes = 0;
    try {
      skillsPoolCurrentBytes = bytesOf(this.storage.getItem(SKILLS_KEY));
    } catch {
      /* 读不到按 0 算：预检只是守卫 */
    }
    const skillsPoolAfterBytes = Math.max(0, skillsPoolCurrentBytes + skillsDelta);
    const skillsPoolExceeded = skillsPoolAfterBytes > SKILLS_POOL_WRITE_BUDGET_BYTES;

    // MCP 服务：按 key 对齐增改删。
    const existingServers = new Map(
      (existing?.manifest.contributions.mcpServers ?? []).map((server) => [server.key, server] as const),
    );
    for (const spec of manifest.contributions.mcpServers) {
      const cost = utf8Length(JSON.stringify(spec)) + 200;
      const old = existingServers.get(spec.key);
      delta += old ? cost - (utf8Length(JSON.stringify(old)) + 200) : cost;
      existingServers.delete(spec.key);
    }
    for (const leftover of existingServers.values()) {
      delta -= utf8Length(JSON.stringify(leftover)) + 200;
    }

    // 回滚清单 + 历史/最高版本等新字段外壳。
    if (previous) delta += utf8Length(JSON.stringify(previous));
    delta += 96;

    const deltaBytes = Math.max(0, delta);
    const afterBytes = currentBytes + deltaBytes;
    const exceeded = afterBytes > INSTALL_WRITE_BUDGET_BYTES;
    return {
      keys,
      currentBytes,
      afterBytes,
      deltaBytes,
      limitBytes: INSTALL_WRITE_BUDGET_BYTES,
      exceeded,
      skillsPoolAfterBytes,
      skillsPoolLimitBytes: SKILLS_POOL_WRITE_BUDGET_BYTES,
      skillsPoolExceeded,
      ...(exceeded
        ? {
            suggestion: `插件体系写后约 ${formatMiB(afterBytes)}，超过预算 ${formatMiB(INSTALL_WRITE_BUDGET_BYTES)}（本次新增约 ${formatMiB(deltaBytes)}）：请先清理消息缓存或卸载不用的插件`,
          }
        : {}),
    };
  }

  /** 计划里将要写的键（只是报告；真正落盘仍走各 store 的既有写入口）。 */
  private planWrites(
    manifest: PluginManifest,
    existing: InstalledPlugin | null,
    diff: PluginInstallPreview,
    previous: InstalledPlugin["previous"] | null,
  ): PlanWrite[] {
    const actionOf = (key: string): PlanWrite["action"] => {
      try {
        return this.storage.getItem(key) === null ? "create" : "update";
      } catch {
        return "update";
      }
    };
    const recordBytes =
      utf8Length(JSON.stringify(manifest)) + 512 + (previous ? utf8Length(JSON.stringify(previous)) : 0);
    const writes: PlanWrite[] = [
      { key: PLUGINS_KEY, action: existing ? "update" : "create", bytes: recordBytes },
    ];
    if (diffTouchedSkills(diff)) {
      writes.push({ key: SKILLS_KEY, action: actionOf(SKILLS_KEY) });
    }
    if (diff.skills.removed.length > 0) {
      writes.push({ key: SKILL_BINDINGS_KEY, action: actionOf(SKILL_BINDINGS_KEY) });
    }
    if (diff.skills.added.length > 0) {
      writes.push({ key: SKILL_ASSIGNMENTS_KEY, action: actionOf(SKILL_ASSIGNMENTS_KEY) });
    }
    if (diffTouchedServers(diff)) {
      writes.push({ key: MCP_SERVERS_KEY, action: actionOf(MCP_SERVERS_KEY) });
    }
    if (diff.servers.removed.length > 0) {
      writes.push({ key: MCP_TOOLS_KEY, action: actionOf(MCP_TOOLS_KEY) });
      writes.push({ key: MCP_ENABLED_TOOLS_KEY, action: actionOf(MCP_ENABLED_TOOLS_KEY) });
    }
    return writes;
  }

  /**
   * 事务键的「当前值」：**按读路径取**，而不是裸读 localStorage。
   *
   * `heming.mcp.servers.v1` 走安全存储（`secureStorageFor`），桌面桥默认异步加密落盘：
   * `setItem` 只排队，底层 raw 这一刻还是旧值（见 `secureStorage.pendingSecurePlain`）。
   * 快照与读回都按同一口径取，才能比出「这笔写有没有被接受」；
   * 只读 raw 会把已排队的写误判成写失败并整笔回滚（d.119 真实缺陷）。
   *
   * 代价（如实记下）：异步桥下这一校验只能证明「写已入队」，不能证明「已落盘」。
   * 落盘失败由安全层自己的 fail-open（加密失败退明文、明文也失败才算丢）负责，
   * 「读回一致」不再是它与配额之间的唯一防线。
   */
  private readTransactionKey(key: string): string | null {
    const pending = pendingSecurePlain(key);
    return pending !== null ? pending : this.storage.getItem(key);
  }

  /** 快照事务涉及的存储键原值（prepare 阶段；回滚逐键恢复的依据）。 */
  private snapshotTransactionKeys(): Map<string, string | null> {
    const snapshot = new Map<string, string | null>();
    for (const key of PLUGIN_TXN_KEYS) {
      try {
        snapshot.set(key, this.readTransactionKey(key));
      } catch {
        snapshot.set(key, null);
      }
    }
    return snapshot;
  }

  /**
   * 读回校验：预期会变的键若与快照逐字节相同，说明底层 store 的 `save()` 把写异常吞了。
   *
   * 这是 localStorage 无法真正事务下的次优检测；读不到（读也抛）时不做判断，
   * 交给 `saveOrThrow` 的插件记录写入兜底。
   */
  private assertKeyChanged(
    key: string,
    before: Map<string, string | null>,
    label: string,
  ): void {
    let next: string | null;
    try {
      next = this.readTransactionKey(key);
    } catch {
      return;
    }
    if (next === (before.get(key) ?? null)) {
      throw new Error(`${label}写入失败：${key} 读回与写入前相同（存储可能已满或被禁用）`);
    }
  }

  /** 失败补偿：逐键恢复快照 + 三个单例 reload；恢复失败如实报 `ok=false`。 */
  private rollbackTransaction(before: Map<string, string | null>): InstallRollbackReport {
    const keys = [...before.keys()];
    const writeErrors: string[] = [];
    for (const [key, value] of before) {
      try {
        // 安全存储的写是排队的：先丢弃在途那一笔，否则它落盘时会把刚恢复的旧值
        // 再盖回新值——界面说「已回滚」、重启却变回去，正是这类鬼影。
        discardPendingSecureWrite(key);
        if (value === null) this.storage.removeItem(key);
        else this.storage.setItem(key, value);
      } catch (err) {
        writeErrors.push(`${key}：${errorMessage(err)}`);
      }
    }
    // 存储回滚了、内存不重读就是半装态：三个单例都按存储重建。
    const memoryErrors: string[] = [];
    this.reloadInMemoryAfterRollback(before, memoryErrors);
    const ok = writeErrors.length === 0 && memoryErrors.length === 0;
    return {
      ok,
      keys,
      ...(ok ? {} : { error: [...writeErrors, ...memoryErrors].join("；") }),
    };
  }

  /**
   * 回滚后的内存重读。
   *
   * 异步安全存储上有一处时序不对称：刚恢复回去的 `heming.mcp.servers.v1` 是**旧信封**，
   * 而异步桥不支持同步解密（首次读会返回 null），直接 reload 会让服务列表在内存里
   * 短暂变空。所以先按既有读路径重建一次（普通键立即正确），再异步把旧信封解密
   * 回填缓存、重读一次 MCP 注册表——用户看到的最终状态必须是「回滚前那样」。
   */
  private reloadInMemoryAfterRollback(
    before: Map<string, string | null>,
    memoryErrors: string[],
  ): void {
    try {
      this.reload();
    } catch (err) {
      memoryErrors.push(`插件记录 reload：${errorMessage(err)}`);
    }
    try {
      this.skills.reload();
    } catch (err) {
      memoryErrors.push(`技能池 reload：${errorMessage(err)}`);
    }
    const reloadMcp = (): void => {
      try {
        this.mcp.reload?.();
      } catch (err) {
        memoryErrors.push(`MCP 注册表 reload：${errorMessage(err)}`);
      }
    };
    reloadMcp();
    // 只有恢复出来的旧值存在时才需要补读；被删掉的键（null）不该被重新造出来。
    if (before.get(MCP_SERVERS_KEY) == null) return;
    void readSecureValueAsync(MCP_SERVERS_KEY, this.storage)
      .then(() => reloadMcp())
      .catch(() => {
        /* 解不开就保持同步读的结果：不谎报、也不再抛 */
      });
  }

  /**
   * 单步事务（P0-2 / P1-3，d.110）：快照 → 执行 → `saveOrThrow()`；异常逐键恢复 + 三单例 reload。
   *
   * 与 `applyPlan` 共用同一套 `snapshotTransactionKeys`/`rollbackTransaction`：
   * 卸载、总开关、贡献级停用这类「改一处存储 + 可能联动技能/服务」的操作，
   * 写失败时必须整笔回退，否则会留下半卸载（删了技能、记录还在）或
   * 「UI 显示已停用、重载又弹回来」。
   *
   * `run` 拿到快照，可在写后做读回校验——技能池/MCP 注册表的 `save()` 会吞配额异常，
   * 只靠 `saveOrThrow()` 只能发现插件记录本身的写失败。
   */
  private transactionalMutation(
    run: (snapshot: Map<string, string | null>) => void,
  ): StoreMutationResult {
    const snapshot = this.snapshotTransactionKeys();
    try {
      run(snapshot);
      this.saveOrThrow();
      return { ok: true };
    } catch (err) {
      const rollback = this.rollbackTransaction(snapshot);
      return { ok: false, error: errorMessage(err), rollback };
    }
  }

  /**
   * 启停插件（主开关）：同步其全部技能与 MCP 服务的启用位。
   *
   * 总开关关闭 = 全部贡献不生效；重新打开时**仍尊重贡献级停用**——
   * 之前单独停用的技能/服务不会因为总开关一开就偷偷恢复。
   *
   * P1-3（d.110）：写入走 `saveOrThrow()` + 事务回滚。此前末尾是吞异常的 `save()`，
   * 配额满时界面显示已停用、重载后回弹；现在失败会回滚内存并返回 `ok=false`。
   */
  setEnabled(id: string, enabled: boolean): StoreMutationResult {
    const plugin = this.data.plugins.find((p) => p.manifest.id === id);
    if (!plugin) return { ok: false, error: `插件不存在：${id}` };
    const skillsOn = enabled && !plugin.disabledKinds.includes("skills");
    const serversOn = enabled && !plugin.disabledKinds.includes("mcpServers");
    // 真实会发生变化的键（值本来就相同的不该被读回校验误判成写失败）。
    const willChangeSkills = plugin.skillIds.some((skillId) => {
      const skill = this.skills.get(skillId);
      return skill !== undefined && skill.enabled !== skillsOn;
    });
    const willWriteServers = plugin.serverIds.some((serverId) => {
      const current = this.mcp.get(serverId);
      return current !== undefined && current.origin === "plugin" && current.enabled !== serversOn;
    });
    return this.transactionalMutation((snapshot) => {
      plugin.enabled = enabled;
      plugin.updatedAt = this.iso();
      for (const skillId of plugin.skillIds) {
        // 技能可能已被用户在技能区单独删除；缺了就跳过，不让插件页卡死
        if (this.skills.get(skillId)) this.skills.setEnabled(skillId, skillsOn);
      }
      for (const serverId of plugin.serverIds) {
        const current = this.mcp.get(serverId);
        if (current && current.origin === "plugin") {
          this.mcp.update(serverId, { enabled: serversOn });
        }
      }
      if (willChangeSkills) this.assertKeyChanged(SKILLS_KEY, snapshot, "技能启用位");
      if (willWriteServers && typeof this.mcp.reload === "function") {
        this.assertKeyChanged(MCP_SERVERS_KEY, snapshot, "MCP 服务启用位");
      }
    });
  }

  /**
   * 贡献级启停（d.67）：只影响这一类贡献，落入 `disabledKinds`。
   *
   * - `skills`：同步到技能池的真实启用位；
   * - `mcpServers`：同步到服务启用位（连接/工具开关/HITL 全部沿用原逻辑）；
   * - `commands` / `toolPacks`：没有物化实体，只落盘，读口径经 `effectiveEnabled` 过滤。
   *
   * 主开关关闭时调用也只会写 `disabledKinds`（不会把东西偷偷打开）。
   *
   * P1-3（d.110）：与 `setEnabled` 同一套事务语义（失败回滚 + `ok=false`）。
   */
  setKindEnabled(pluginId: string, kind: PluginContributionKind, on: boolean): StoreMutationResult {
    const plugin = this.data.plugins.find((p) => p.manifest.id === pluginId);
    if (!plugin) return { ok: false, error: `插件不存在：${pluginId}` };
    const disabled = new Set(plugin.disabledKinds);
    if (on) disabled.delete(kind);
    else disabled.add(kind);
    const active = plugin.enabled && !disabled.has(kind);
    const willChangeSkills =
      kind === "skills" &&
      plugin.skillIds.some((skillId) => {
        const skill = this.skills.get(skillId);
        return skill !== undefined && skill.enabled !== active;
      });
    const willWriteServers =
      kind === "mcpServers" &&
      plugin.serverIds.some((serverId) => {
        const current = this.mcp.get(serverId);
        return current !== undefined && current.origin === "plugin" && current.enabled !== active;
      });
    return this.transactionalMutation((snapshot) => {
      plugin.disabledKinds = [...disabled];
      plugin.updatedAt = this.iso();
      if (kind === "skills") {
        for (const skillId of plugin.skillIds) {
          if (this.skills.get(skillId)) this.skills.setEnabled(skillId, active);
        }
      } else if (kind === "mcpServers") {
        for (const serverId of plugin.serverIds) {
          const current = this.mcp.get(serverId);
          if (current && current.origin === "plugin") {
            this.mcp.update(serverId, { enabled: active });
          }
        }
      }
      if (willChangeSkills) this.assertKeyChanged(SKILLS_KEY, snapshot, "技能启用位");
      if (willWriteServers && typeof this.mcp.reload === "function") {
        this.assertKeyChanged(MCP_SERVERS_KEY, snapshot, "MCP 服务启用位");
      }
    });
  }

  /**
   * 卸载插件：删除其全部技能（含使用统计与绑定）与 MCP 服务，再删记录。
   *
   * P0-2（d.110）：整笔走事务。此前是「先删技能/MCP、再改内存、最后 saveOrThrow」，
   * 而 `skills.remove` 的落盘会吞配额异常 → 可能留下「技能已从内存删掉、存储还在」
   * 或「记录删了、技能没删」的半卸载，且悬空 skillIds 不可恢复。现在：
   * 快照 → 删除 → 读回校验（技能/MCP 真的写进去了）→ 改记录 → saveOrThrow；
   * 任一异常逐键恢复并 reload 三个单例，返回结构化的 `ok/rollback`。
   *
   * 幂等：插件不存在时返回 `ok=true`（卸载一个已经不在的插件不是错误）。
   */
  remove(id: string): StoreMutationResult {
    const plugin = this.data.plugins.find((p) => p.manifest.id === id);
    if (!plugin) return { ok: true };
    const willWriteSkills = plugin.skillIds.some((skillId) => this.skills.get(skillId) !== undefined);
    const willWriteServers = plugin.serverIds.some((serverId) => {
      const current = this.mcp.get(serverId);
      return current !== undefined && current.origin === "plugin";
    });
    return this.transactionalMutation((snapshot) => {
      for (const skillId of plugin.skillIds) this.skills.remove(skillId);
      for (const serverId of plugin.serverIds) {
        const current = this.mcp.get(serverId);
        // 只删仍标记为插件来源的服务：用户若把它改成手填，视为用户资产。
        if (current && current.origin === "plugin") this.mcp.remove(serverId);
      }
      if (willWriteSkills) this.assertKeyChanged(SKILLS_KEY, snapshot, "技能删除");
      if (willWriteServers && typeof this.mcp.reload === "function") {
        this.assertKeyChanged(MCP_SERVERS_KEY, snapshot, "MCP 服务删除");
      }
      this.data.plugins = this.data.plugins.filter((p) => p.manifest.id !== id);
    });
  }

  /**
   * 读取某个插件的健康度（只读，不写存储）。
   *
   * 与 `inspectPluginHealth` 同口径，只是替调用方把技能池/MCP 注册表拍成引用数组；
   * 插件不存在返回 null。UI 用它算徽标，测试可直接用纯函数夹具。
   */
  health(id: string, options: InspectPluginHealthOptions = {}): PluginHealth | null {
    const plugin = this.data.plugins.find((p) => p.manifest.id === id);
    if (!plugin) return null;
    return this.healthOf(plugin, options);
  }

  /**
   * 修复插件记录（d.113，整笔事务：snapshot → 改记录 → saveOrThrow，失败逐键回滚）。
   *
   * 修复动作（只动**记录**，不动用户数据）：
   * 1. `invalidRecord`：重新读存储里的原始清单，能被当前解析器完整解析才清标记，
   *    否则保持并写进 `remainingIssues` 说明原因；
   * 2. `skillIds`：按技能池里 `pluginId === id` 的技能重建（补回漏登、摘掉悬空）；
   * 3. `serverIds`：按 MCP 注册表 `origin: "plugin"` + `plugin:<id>:` 前缀重建
   *    （真注册表才有 `servers()`；假端口只能摘悬空引用）；
   * 4. `fingerprint`：清单可解析时按当前内容重算。
   *
   * 返回 `repaired`（做过的动作）、`dropped`（只摘掉的引用，`skill:<id>`/`server:<id>`）、
   * `remainingIssues`（修完仍存在的问题）。
   */
  repairPlugin(id: string, options: InspectPluginHealthOptions = {}): PluginRepairResult {
    const plugin = this.data.plugins.find((p) => p.manifest.id === id);
    if (!plugin) {
      return {
        ok: false,
        error: `插件不存在：${id}`,
        repaired: [],
        dropped: [],
        remainingIssues: [],
      };
    }
    const snapshot = this.snapshotTransactionKeys();
    const repaired: string[] = [];
    const dropped: string[] = [];
    const markRepaired = (code: string) => {
      if (!repaired.includes(code)) repaired.push(code);
    };
    try {
      // 1) 清单恢复：只有原始清单能被完整解析时才清 invalidRecord。
      if (plugin.invalidRecord) {
        const recovered = this.recoverManifestFromStorage(id);
        if (recovered) {
          plugin.manifest = recovered;
          delete plugin.invalidRecord;
          delete plugin.invalidReason;
          markRepaired("manifest");
        }
      }

      // 2) skillIds：以技能池为准重建（含补回漏登 / 摘掉悬空与错归属）。
      const liveSkillIds = this.skills
        .list()
        .filter((skill) => skill.pluginId === id)
        .map((skill) => skill.id);
      for (const oldId of plugin.skillIds) {
        if (!liveSkillIds.includes(oldId)) dropped.push(`skill:${oldId}`);
      }
      if (!sameStringList(plugin.skillIds, liveSkillIds)) {
        plugin.skillIds = liveSkillIds;
        markRepaired("skillIds");
      }

      // 3) serverIds：以 MCP 注册表为准重建（真注册表能补回漏登；假端口只摘悬空）。
      const prefix = `plugin:${id}:`;
      const listedServers =
        typeof this.mcp.servers === "function" ? this.mcp.servers() : null;
      const liveServerIds = listedServers
        ? listedServers
            .filter((server) => server.origin === "plugin" && server.id.startsWith(prefix))
            .map((server) => server.id)
        : plugin.serverIds.filter((serverId) => {
            if (!serverId.startsWith(prefix)) return false;
            const current = this.mcp.get(serverId);
            return current !== undefined && current.origin === "plugin";
          });
      for (const oldId of plugin.serverIds) {
        if (!liveServerIds.includes(oldId)) dropped.push(`server:${oldId}`);
      }
      if (!sameStringList(plugin.serverIds, liveServerIds)) {
        plugin.serverIds = liveServerIds;
        markRepaired("serverIds");
      }

      // 4) fingerprint：清单可解析时按当前内容重算（损坏记录留给重装）。
      if (!plugin.invalidRecord) {
        const expected = contentFingerprint(plugin.manifest);
        if (plugin.fingerprint !== expected) {
          plugin.fingerprint = expected;
          markRepaired("fingerprint");
        }
      }

      if (repaired.length > 0 || dropped.length > 0) {
        plugin.updatedAt = this.iso();
        this.saveOrThrow();
      }
    } catch (err) {
      const rollback = this.rollbackTransaction(snapshot);
      return {
        ok: false,
        error: errorMessage(err),
        rollback,
        repaired: [],
        dropped: [],
        remainingIssues: this.healthOf(plugin, options).issues,
      };
    }

    const health = this.healthOf(plugin, options);
    return {
      ok: true,
      repaired,
      dropped,
      remainingIssues: health.issues,
      health,
    };
  }

  /** 健康判定：把技能池/MCP 注册表拍成引用数组后调纯函数。 */
  private healthOf(plugin: InstalledPlugin, options: InspectPluginHealthOptions): PluginHealth {
    const skills = this.skills.list().map((skill) => ({ id: skill.id, pluginId: skill.pluginId }));
    const servers: PluginHealthServerRef[] =
      typeof this.mcp.servers === "function"
        ? this.mcp.servers().map((server) => ({ id: server.id, origin: server.origin }))
        : // 假端口没有列出能力：只能按记录声称的插件服务当作「存在但未验证」，
          // 避免把真实存在的服务误报成悬空。
          plugin.serverIds.map((serverId) => ({ id: serverId, origin: "plugin" as ServerOrigin }));
    return inspectPluginHealth(plugin, skills, servers, options);
  }

  /**
   * 从存储原始 JSON 里找该插件的清单并重解析（修复 `invalidRecord` 用）。
   *
   * 为什么回存储读而不是用内存里的清单：内存里已经是抢救出来的占位清单；
   * 只有存储里的原始内容「能被当前解析器完整解析」时才可以清损坏标记。
   */
  private recoverManifestFromStorage(id: string): PluginManifest | null {
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(PLUGINS_KEY);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const list = (parsed as Record<string, unknown>).plugins;
      if (!Array.isArray(list)) return null;
      for (const item of list) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const manifestRaw = record.manifest;
        if (!manifestRaw || typeof manifestRaw !== "object" || Array.isArray(manifestRaw)) continue;
        if ((manifestRaw as Record<string, unknown>).id !== id) continue;
        try {
          return parseStoredManifest(manifestRaw);
        } catch {
          return null; // 找到这条但仍解析失败：不可修复，保持损坏标记
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private read(): string | null {
    try {
      return this.storage.getItem(PLUGINS_KEY);
    } catch {
      return null;
    }
  }

  /**
   * 非关键路径的写：返回 `{ ok, error }`，不抛（启停等操作失败只影响持久化，
   * 不该让界面崩掉）。**安装/更新/卸载一律用 `saveOrThrow()`**。
   */
  private save(): { ok: boolean; error?: string } {
    try {
      this.storage.setItem(PLUGINS_KEY, JSON.stringify(this.data));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  /**
   * 关键路径的写：配额/隐私模式失败必须冒泡，让安装事务回滚而不是谎报成功。
   *
   * 这正是旧 `save()` 吞异常留下的半装态根因（规格 §5.2 第 3 条）。
   */
  saveOrThrow(): void {
    this.storage.setItem(PLUGINS_KEY, JSON.stringify(this.data));
  }

  private parse(raw: string | null): PluginData {
    if (!raw) return { version: 1, plugins: [] };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("bad");
      }
      const list = (parsed as Record<string, unknown>).plugins;
      if (!Array.isArray(list)) throw new Error("bad");
      const plugins: InstalledPlugin[] = [];
      for (const item of list) {
        const plugin = this.coerce(item);
        if (plugin && !plugins.some((p) => p.manifest.id === plugin.manifest.id)) {
          plugins.push(plugin);
        }
      }
      return { version: 1, plugins };
    } catch {
      // 整体损坏视为空表；技能池里的插件技能仍可用，用户重装即可恢复归属
      return { version: 1, plugins: [] };
    }
  }

  private coerce(raw: unknown): InstalledPlugin | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    let manifest: PluginManifest;
    let invalidReason: string | undefined;
    try {
      manifest = parseStoredManifest(r.manifest);
    } catch (err) {
      // P1-7：v5 记录坏掉时不再「降级按 v4 读」，而是抢救展示字段 + 标 invalidRecord，
      // 让兼容性判定走 invalidEngines（失败关闭），同时保留 skillIds/serverIds 以便卸载。
      const salvaged = salvageCorruptManifest(r.manifest, errorMessage(err));
      if (!salvaged) return null; // id 都救不出来：无法定位/卸载，只能丢这一条
      manifest = salvaged.manifest;
      invalidReason = salvaged.reason;
    }
    const invalidRecord = invalidReason !== undefined;
    const at = this.iso();
    // 指纹算法版本：只有 `fnv1a64b:` 前缀才算当前算法。旧前缀（含 d.64.2.23.0
    // 的 `fnv1a64:`）按新算法重算并落盘——否则算法升级会让所有已装插件在下次
    // 安装预览里假告警「内容与上次不同」。用户手工改过存储里的清单仍会被抓到：
    // 重算基于存储中的真实清单，改过的内容自然对不上安装记录里的清单。
    const rawFingerprint =
      typeof r.fingerprint === "string" && r.fingerprint.startsWith(FINGERPRINT_PREFIX)
        ? r.fingerprint
        : null;
    if (!rawFingerprint && !invalidRecord) this.backfilledFingerprint = true;
    const previous = coercePrevious(r.previous, at);
    const history = coerceHistory(r.history);
    return {
      manifest,
      enabled: r.enabled !== false,
      fingerprint: rawFingerprint ?? contentFingerprint(manifest),
      publisher: coercePublisher(r.publisher),
      signature: coerceSignature(r.signature),
      disabledKinds: coerceKinds(r.disabledKinds),
      skillIds: Array.isArray(r.skillIds)
        ? uniq(r.skillIds.filter((x): x is string => typeof x === "string"))
        : [],
      serverIds: Array.isArray(r.serverIds)
        ? uniq(r.serverIds.filter((x): x is string => typeof x === "string"))
        : [],
      ...(previous ? { previous } : {}),
      ...(history ? { history } : {}),
      ...(typeof r.highestVersion === "string" && r.highestVersion
        ? { highestVersion: r.highestVersion }
        : {}),
      ...(invalidRecord ? { invalidRecord: true as const, invalidReason } : {}),
      installedAt: typeof r.installedAt === "string" ? r.installedAt : at,
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : at,
    };
  }
}

/**
 * 读回「上一版清单」：坏数据按 undefined（不丢整条插件记录）。
 *
 * 指纹缺失时按清单重算——它只用于提示「与记录不同」，不是安全边界。
 */
function coercePrevious(raw: unknown, fallbackAt: string): InstalledPlugin["previous"] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (!record.manifest) return undefined;
  let manifest: PluginManifest;
  try {
    manifest = parseStoredManifest(record.manifest);
  } catch {
    return undefined;
  }
  return {
    manifest,
    fingerprint:
      typeof record.fingerprint === "string" && record.fingerprint
        ? record.fingerprint
        : contentFingerprint(manifest),
    installedAt: typeof record.installedAt === "string" ? record.installedAt : fallbackAt,
  };
}

/** 读回版本历史：只留 `{version, at}` 都合法的条目，最多 3 条（超限丢最旧）。 */
function coerceHistory(raw: unknown): InstalledPlugin["history"] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<InstalledPlugin["history"]> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.version !== "string" || !record.version) continue;
    out.push({
      version: record.version,
      at: typeof record.at === "string" ? record.at : "",
    });
  }
  return out.length > 0 ? out.slice(-3) : undefined;
}

/** 读回发布者记录：只接受完整字段，坏数据按 null（不丢整条插件记录）。 */
function coercePublisher(raw: unknown): InstalledPlugin["publisher"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof record.fingerprint !== "string" || !record.fingerprint) return null;
  return { id: record.id, fingerprint: record.fingerprint };
}

/** 读回验签结果：status 不在白名单内按 null（宁可显示「未记录」也不编造结论）。 */
function coerceSignature(raw: unknown): InstalledPlugin["signature"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const status = record.status;
  if (status !== "none" && status !== "valid" && status !== "invalid" && status !== "unsupported") {
    return null;
  }
  return record.alg === "ed25519" ? { status, alg: "ed25519" } : { status };
}

/** 读回贡献级停用：未知取值直接丢弃（旧记录缺字段 = 全部生效）。 */
function coerceKinds(raw: unknown): PluginContributionKind[] {
  if (!Array.isArray(raw)) return [];
  const kinds = new Set<PluginContributionKind>();
  for (const item of raw) {
    if (PLUGIN_CONTRIBUTION_KINDS.includes(item as PluginContributionKind)) {
      kinds.add(item as PluginContributionKind);
    }
  }
  return [...kinds];
}

/**
 * 模块级单例：插件记录只本机存储（`heming.plugins.v1`），
 * 技能物化到共用的 `skillPool`，与技能区/聊天路由同一份技能事实。
 *
 * ★ 单例放在 store 而不是 `index.ts`：能力目录（`catalog.ts`）也要读它，
 * 若从 `index.ts` 取会形成 index → catalog → index 的循环导入——
 * 循环在 ESM 里能跑，但初始化顺序一变 `pluginStore` 就可能是 undefined。
 */
export const pluginStore = new PluginStore();
