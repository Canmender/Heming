/**
 * 能力单元与贡献点：和鸣插件体系的统一读模型（d.104 地基）。
 *
 * ## 为什么需要这一层
 * d.98 之前，产品里其实有四套并行机制——声明式插件（技能/MCP/命令/工具束）、
 * 界面插件（桌面小组件）、内置能力模块（幕僚/信息中枢/自动化/模型路由）、
 * 系统能力（内置技能/预置服务）——它们只共享「插件区」这一个 UI 壳，
 * 模型、存储、生效点都不同。结果是每加一种能力要改四处（审计 G1–G7）。
 *
 * 本模块把四者统一成 `CapabilityUnit`：
 * - **唯一读模型**：插件页、诊断、命令面板、导航过滤都读它；
 * - **唯一准入表**：`CONTRIBUTION_ADMISSION` 决定「哪种来源能贡献什么」，
 *   第三方声明界面/后台能力会被明确拒绝，而不是静默不生效；
 * - **唯一生效判定**：总开关 × 贡献级开关 × 依赖单元 × 权限/兼容状态 → 一个 `UnitStatus`。
 *
 * ## 边界（不改存储、不碰 React）
 * - 存储键一个都不动（`heming.plugins.v1` / `heming.modules.v1` / `userData/plugins`），
 *   这里只做**投影**。写入口仍然在各自的 store；这样升级不需要数据迁移，旧版本也能回滚。
 * - 不做运行时挂载（React 组件/后台循环）：那是 web 侧 `lib/units/registry.ts` 的事。
 *   本模块只保证「谁能贡献什么、现在为什么没生效」有一套可测试的纯函数答案。
 */

/** 能力来源：系统内置 / 内置模块 / 声明式插件 / 界面插件（官方）。 */
export type UnitSource = "system" | "builtin" | "package" | "bundle";

export const UNIT_SOURCES: readonly UnitSource[] = ["system", "builtin", "package", "bundle"];

/** 来源的中文标签（插件页徽标与诊断文案共用，避免各处手写）。 */
export const UNIT_SOURCE_LABELS: Record<UnitSource, string> = {
  system: "系统",
  builtin: "内置模块",
  package: "插件",
  bundle: "界面插件",
};

/**
 * 贡献点全集。
 *
 * `skills` / `mcpServers` / `commands` / `toolPacks` / `desktopWidgets` 是**数据贡献**：
 * 物化进既有 store，不需要运行时挂载。
 * `page` / `homeCard` / `settingsCard` / `backgroundJob` 是**运行时贡献**：
 * 必须由可执行代码提供渲染或循环，按准入表目前只允许系统/内置单元（首方可执行包
 * 待阶段 D 另立规格）。`hook` 是界面插件的生命周期订阅（阶段 C）。
 */
export type ContributionKind =
  | "skills"
  | "mcpServers"
  | "commands"
  | "toolPacks"
  | "desktopWidgets"
  | "page"
  | "homeCard"
  | "settingsCard"
  | "backgroundJob"
  | "hook";

export const CONTRIBUTION_KINDS: readonly ContributionKind[] = [
  "skills",
  "mcpServers",
  "commands",
  "toolPacks",
  "desktopWidgets",
  "page",
  "homeCard",
  "settingsCard",
  "backgroundJob",
  "hook",
];

/** 贡献点中文名（诊断/详情页直接展示）。 */
export const CONTRIBUTION_LABELS: Record<ContributionKind, string> = {
  skills: "技能",
  mcpServers: "工具服务",
  commands: "命令",
  toolPacks: "工具束",
  desktopWidgets: "桌面小组件",
  page: "页面",
  homeCard: "首页卡片",
  settingsCard: "设置卡片",
  backgroundJob: "后台任务",
  hook: "生命周期钩子",
};

/**
 * 准入表：**来源 × 贡献点**。`true` = 允许声明，`false` = 解析期拒绝。
 *
 * 这张表就是「本阶段第三方能做什么」的唯一事实来源。要开放一项（例如阶段 D
 * 让首方 bundle 贡献设置卡），只改这里 + 对应解析器，不需要在四个机制里找。
 */
export const CONTRIBUTION_ADMISSION: Record<UnitSource, Record<ContributionKind, boolean>> = {
  system: {
    skills: true,
    mcpServers: true,
    commands: true,
    toolPacks: false,
    desktopWidgets: false,
    page: false,
    homeCard: false,
    settingsCard: false,
    backgroundJob: false,
    hook: false,
  },
  builtin: {
    skills: true,
    mcpServers: true,
    commands: true,
    toolPacks: false,
    desktopWidgets: false,
    page: true,
    homeCard: true,
    settingsCard: true,
    backgroundJob: true,
    hook: false,
  },
  package: {
    skills: true,
    mcpServers: true,
    commands: true,
    toolPacks: true,
    desktopWidgets: false,
    page: false,
    homeCard: false,
    settingsCard: false,
    backgroundJob: false,
    hook: false,
  },
  bundle: {
    skills: false,
    mcpServers: false,
    commands: true,
    toolPacks: false,
    desktopWidgets: true,
    page: false,
    homeCard: false,
    settingsCard: false,
    backgroundJob: false,
    hook: true,
  },
};

/** 某来源可以声明哪些贡献点（按稳定顺序）。 */
export function admittedKinds(source: UnitSource): ContributionKind[] {
  return CONTRIBUTION_KINDS.filter((kind) => CONTRIBUTION_ADMISSION[source][kind]);
}

/** 该来源声明这个贡献点是否被允许；不允许时返回中文原因（给解析器直接用）。 */
export function contributionBlockedReason(
  source: UnitSource,
  kind: ContributionKind,
): string | null {
  if (CONTRIBUTION_ADMISSION[source][kind]) return null;
  const who = UNIT_SOURCE_LABELS[source];
  const what = CONTRIBUTION_LABELS[kind];
  if (kind === "page" || kind === "homeCard" || kind === "settingsCard" || kind === "backgroundJob") {
    return `${who}不能声明「${what}」：界面/后台能力需要可执行代码，目前只允许内置单元（第三方界面插件另立规格）`;
  }
  return `${who}不能声明「${what}」`;
}

/* ───────────────────────── 单元与状态 ───────────────────────── */

/**
 * 一条贡献的**现状**：条目数 + 是否在生效。
 *
 * `items` 不承载具体内容（技能正文/服务地址可能很大，且各自 store 已有一份），
 * 只给计数与展示名，避免投影层复制数据、也避免两处真源。
 */
export interface UnitContribution {
  kind: ContributionKind;
  /** 条目数（技能 3 条 / 服务 1 个 / 页面 1 个…）。 */
  count: number;
  /** 总开关与贡献级开关都打开后才为 true。 */
  enabled: boolean;
}

/** 单元被什么挡住（`resolveUnit` 输出；诊断区直接展示）。 */
export type UnitBlockReason =
  | { kind: "disabled" }
  | { kind: "kindDisabled"; contribution: ContributionKind }
  | { kind: "missingRequirement"; unitId: string }
  | { kind: "incompatible"; required: string; actual: string }
  | { kind: "invalidEngines"; required: string }
  | { kind: "signature"; detail: string }
  | { kind: "orphan"; detail: string }
  | { kind: "degraded"; detail: string };

/** 单元声明（投影层把四类存储拍成这个形状）。 */
export interface CapabilityUnit {
  source: UnitSource;
  id: string;
  name: string;
  version: string;
  description: string;
  /** 展示用元信息（v5 `meta`；内置模块没有）。 */
  meta?: {
    icon?: string;
    homepage?: string;
    category?: string;
    tags?: string[];
    keywords?: string[];
  };
  /** 依赖的其它单元 id：依赖未生效 ⇒ 本单元 `effective=false`，但开关保留。 */
  requires?: string[];
  /** 清单声明的 `engines.heming`（v1–v4 归一化为 `d.0`）。 */
  engines?: string;
  contributions: UnitContribution[];
  /** 总开关（存储里的 enabled）。 */
  enabled: boolean;
  /** 贡献级停用（声明式插件的 `disabledKinds`）。 */
  disabledKinds?: ContributionKind[];
  /** 其它阻断状态（签名失败/不兼容/孤儿记录…），由投影层在构造时带上。 */
  blocks?: UnitBlockReason[];
  /** 本机数据键（模块卡展示占用用）。 */
  storageKeys?: string[];
  /** 是否可停用/卸载（系统能力只读）。 */
  readonly?: boolean;
}

/** 单元的运行状态（插件页一行/详情页诊断的输入）。 */
export interface UnitStatus {
  unit: CapabilityUnit;
  /** 是否真正在生效（有贡献在跑）。 */
  effective: boolean;
  /** 生效的贡献类别（按 CONTRIBUTION_KINDS 顺序）。 */
  activeKinds: ContributionKind[];
  /** 第一条阻断原因（列表行展示用；详情页用 `diagnostics`）。 */
  reason?: UnitBlockReason;
  /** 全部原因（含贡献级逐条）。 */
  diagnostics: UnitBlockReason[];
}

const KIND_ORDER: ReadonlyMap<ContributionKind, number> = new Map(
  CONTRIBUTION_KINDS.map((kind, index) => [kind, index]),
);

function sortedContributions(contributions: readonly UnitContribution[]): UnitContribution[] {
  return [...contributions]
    .filter((item) => item.count > 0)
    .sort((a, b) => (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99));
}

/**
 * 计算一个单元的生效状态（纯函数）。
 *
 * 判定顺序（**短路**，第一条原因即列表行的 reason）：
 * 1. 无贡献 → 不算生效（孤单元不占「已生效」）；
 * 2. 总开关关 → disabled；
 * 3. 依赖未生效 → missingRequirement（开关保留，依赖恢复后自动恢复）；
 * 4. 自身阻断（不兼容/签名/孤儿）→ 对应原因；
 * 5. 逐类贡献判定：贡献级停用 → kindDisabled；否则计入 activeKinds。
 *
 * `unitsById` 只需包含「可能被依赖」的单元；递归带 seen 防环（误配成环时返回
 * `missingRequirement` 而不是栈溢出）。
 */
export function resolveUnit(
  unit: CapabilityUnit,
  unitsById: ReadonlyMap<string, CapabilityUnit>,
  seen: ReadonlySet<string> = new Set(),
): UnitStatus {
  const contributions = sortedContributions(unit.contributions);
  const diagnostics: UnitBlockReason[] = [];

  if (contributions.length === 0) {
    return { unit, effective: false, activeKinds: [], reason: undefined, diagnostics };
  }

  if (!unit.enabled) {
    return { unit, effective: false, activeKinds: [], reason: { kind: "disabled" }, diagnostics: [{ kind: "disabled" }] };
  }

  if (seen.has(unit.id)) {
    const loop: UnitBlockReason = { kind: "degraded", detail: `依赖成环：${[...seen, unit.id].join(" → ")}` };
    return { unit, effective: false, activeKinds: [], reason: loop, diagnostics: [loop] };
  }

  for (const block of unit.blocks ?? []) diagnostics.push(block);

  const nextSeen = new Set(seen);
  nextSeen.add(unit.id);
  if (!(unit.blocks ?? []).some((block) => block.kind === "incompatible" || block.kind === "invalidEngines")) {
    for (const requiredId of unit.requires ?? []) {
      const required = unitsById.get(requiredId);
      if (!required) {
        diagnostics.push({ kind: "missingRequirement", unitId: requiredId });
        continue;
      }
      const requiredStatus = resolveUnit(required, unitsById, nextSeen);
      if (!requiredStatus.effective) {
        // 把依赖方的「成环/降级」原因原样带上来，否则 UI 只会显示「需要 X 启用」，
        // 而 X 明明已经启用（成环时这是最误导的一种文案）。
        const degraded = requiredStatus.diagnostics.find((reason) => reason.kind === "degraded");
        diagnostics.push(degraded ?? { kind: "missingRequirement", unitId: requiredId });
      }
    }
  }

  const disabledKinds = new Set(unit.disabledKinds ?? []);
  const activeKinds: ContributionKind[] = [];
  for (const contribution of contributions) {
    if (disabledKinds.has(contribution.kind) || !contribution.enabled) {
      diagnostics.push({ kind: "kindDisabled", contribution: contribution.kind });
      continue;
    }
    activeKinds.push(contribution.kind);
  }

  const blocking = diagnostics.find((reason) => reason.kind !== "kindDisabled");
  const effective = activeKinds.length > 0 && !blocking;
  return {
    unit,
    effective,
    activeKinds,
    reason: blocking ?? (diagnostics[0] as UnitBlockReason | undefined),
    diagnostics,
  };
}

/** 一组单元的状态（保持输入顺序；依赖解析需要全量 map）。 */
export function resolveUnits(units: readonly CapabilityUnit[]): UnitStatus[] {
  const byId = new Map(units.map((unit) => [unit.id, unit] as const));
  return units.map((unit) => resolveUnit(unit, byId));
}

/** 某贡献点在整个产品里是否「有东西在生效」（导航/命令面板过滤用）。 */
export function hasActiveContribution(statuses: readonly UnitStatus[], kind: ContributionKind): boolean {
  return statuses.some((status) => status.effective && status.activeKinds.includes(kind));
}

/** 阻断原因 → 中文一句话（列表行/诊断区共用；测试钉死措辞）。 */
export function blockReasonText(reason: UnitBlockReason): string {
  switch (reason.kind) {
    case "disabled":
      return "已停用";
    case "kindDisabled":
      return `${CONTRIBUTION_LABELS[reason.contribution]}已单独关闭`;
    case "missingRequirement":
      return `需要「${reason.unitId}」启用后才生效`;
    case "incompatible":
      return `需要和鸣 ${reason.required} 或更高，当前 ${reason.actual}`;
    case "invalidEngines":
      return `engines.heming 不合法：${reason.required}`;
    case "signature":
      return reason.detail;
    case "orphan":
      return reason.detail;
    case "degraded":
      return `降级：${reason.detail}`;
  }
}
