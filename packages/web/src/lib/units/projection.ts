import {
  LEGACY_ENGINES,
  enginesStatus,
  resolveUnits,
  type CapabilityUnit,
  type ContributionKind,
  type UnitBlockReason,
  type UnitSource,
  type UnitStatus,
} from "@heming/shared";
import { BUILTIN_MODULES, type BuiltinModule, type ModuleId } from "../modules/registry.js";
import { contentFingerprint } from "../plugins/integrity.js";
import type { InstalledPlugin } from "../plugins/store.js";
import type { SystemPlugin } from "../plugins/system.js";
import type { WidgetRecord } from "../../types/widgets.js";

/**
 * 能力单元只读投影（d.105 · 阶段 A）。
 *
 * 把四套并行机制拍成同一张 `CapabilityUnit` 表：
 * - `system`：`lib/plugins/system.ts` 的 `describeSystemPlugin()` 结果（`heming.core`）；
 * - `builtin`：`lib/modules/registry.ts` 的四个内置模块 + `heming.modules.v1` 开关；
 * - `package`：`pluginStore.list()`（声明式插件，v1–v4/v5 归一化后的 web 形状）；
 * - `bundle`：`lib/widgets/store.ts` 的已装界面插件（桌面端才有）。
 *
 * ★ 本文件**不 import 任何 store 单例**（`pluginStore` / `useModuleStore` / widgets store）：
 *   默认数据源由 `lib/units/registry.ts` 注入，避免 `modules/store → projection → plugins/store
 *   → 系统能力 → capability providers → infohub tools → modules/store` 这类环。
 *   因此本文件是纯函数，测试直接传夹具。
 *
 * ★ 投影不复制具体条目内容：技能正文/服务地址仍由各自 store 持有，这里只给
 *   `UnitContribution { kind, count, enabled }`（与 shared/plugin/unit.ts 的契约一致）。
 */

/** 投影输入：全部可注入；缺省时调用方（registry）从各 store 取当前值。 */
export interface UnitProjectionSources {
  /** 系统能力视图（`describeSystemPlugin()` 的结果）；缺省不产出系统单元。 */
  system?: SystemPlugin | null;
  /** 内置模块注册表（默认 `BUILTIN_MODULES`，测试可传子集）。 */
  modules?: readonly BuiltinModule[];
  /** 模块开关（`heming.modules.v1` 的 enabled，缺省全开）。 */
  moduleEnabled?: Partial<Record<ModuleId, boolean>>;
  /** 已装声明式插件（`pluginStore.list()`）。 */
  plugins?: readonly InstalledPlugin[];
  /** 已装界面插件（`useWidgetsStore().records`）。 */
  widgets?: readonly WidgetRecord[];
  /** 当前应用版本（`__APP_VERSION__`）；用于 `engines.heming` 兼容判定。 */
  appVersion?: string;
}

/** 读取构建期注入的应用版本；拿不到时如实回落到 `d.0`（会判不兼容而不是假装兼容）。 */
export function currentAppVersion(): string {
  try {
    if (typeof __APP_VERSION__ === "string" && __APP_VERSION__.trim()) return __APP_VERSION__.trim();
  } catch {
    /* 非 vite 注入环境（个别单测/脚本）：走回落 */
  }
  return "d.0";
}

/** 模块开关缺省值：与 `modules/store.ts` 的「默认全开」一致。 */
function moduleOn(
  enabled: Partial<Record<ModuleId, boolean>> | undefined,
  id: ModuleId,
): boolean {
  if (!enabled) return true;
  return enabled[id] !== false;
}

function contribution(
  kind: ContributionKind,
  count: number,
  enabled: boolean,
): { kind: ContributionKind; count: number; enabled: boolean } {
  return { kind, count, enabled };
}

/** 系统能力单元：置顶只读，不占插件数量上限。 */
export function projectSystemUnit(system: SystemPlugin): CapabilityUnit {
  const { skills, servers } = system.contributions;
  return {
    source: "system",
    id: system.id,
    name: system.name,
    version: system.version,
    description: system.description,
    enabled: true,
    readonly: true,
    contributions: [
      contribution("skills", skills.length, true),
      contribution("mcpServers", servers.length, true),
    ],
  };
}

/**
 * 内置模块单元：`page` / `homeCard` / `backgroundJob` 是它们真实贡献的运行时能力，
 * `requires` 直接映射模块依赖（automations → infohub）。开关来自 `heming.modules.v1`。
 */
export function projectBuiltinUnits(
  enabled: Partial<Record<ModuleId, boolean>> = {},
  modules: readonly BuiltinModule[] = BUILTIN_MODULES,
): CapabilityUnit[] {
  return modules.map((mod) => {
    const on = moduleOn(enabled, mod.id);
    const contributions = [
      contribution("page", mod.contributions.page ? 1 : 0, on),
      contribution("homeCard", mod.contributions.homeCard ? 1 : 0, on),
      contribution(
        "backgroundJob",
        mod.contributions.backgroundLoop ? 1 : 0,
        on,
      ),
    ].filter((item) => item.count > 0);
    return {
      source: "builtin" as UnitSource,
      id: mod.id,
      name: mod.name,
      version: mod.version,
      description: mod.description,
      enabled: on,
      requires: mod.requires ? [...mod.requires] : undefined,
      contributions,
      storageKeys: mod.storageKeys.length > 0 ? [...mod.storageKeys] : undefined,
    };
  });
}

/* ─────────────────── 声明式插件：engines / 信任 / 指纹 ─────────────────── */

/** web 清单的可选 v5 字段（web-txn 接线前先按结构读取，不假设它一定存在）。 */
interface ManifestExtras {
  engines?: { heming?: unknown } | string;
  meta?: {
    icon?: unknown;
    homepage?: unknown;
    category?: unknown;
    tags?: unknown;
    keywords?: unknown;
  };
  requires?: unknown;
}

function manifestExtras(plugin: InstalledPlugin): ManifestExtras {
  return plugin.manifest as unknown as ManifestExtras;
}

function readStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string" && !!item) : [];
}

/** 取清单声明的 `engines.heming`（v1–v4 没有该字段；v5 才有）。 */
export function pluginEngines(plugin: InstalledPlugin): string | undefined {
  const raw = manifestExtras(plugin).engines;
  if (typeof raw === "string") return raw.trim() || undefined;
  if (raw && typeof raw === "object" && typeof raw.heming === "string") {
    return raw.heming.trim() || undefined;
  }
  return undefined;
}

/** 清单 v5 `meta` → 单元展示元信息（旧包没有，返回 undefined）。 */
function pluginMeta(plugin: InstalledPlugin): CapabilityUnit["meta"] | undefined {
  const meta = manifestExtras(plugin).meta;
  if (!meta || typeof meta !== "object") return undefined;
  const icon = typeof meta.icon === "string" ? meta.icon : undefined;
  const homepage = typeof meta.homepage === "string" ? meta.homepage : undefined;
  const category = typeof meta.category === "string" ? meta.category : undefined;
  const tags = readStringArray(meta.tags);
  const keywords = readStringArray(meta.keywords);
  if (!icon && !homepage && !category && tags.length === 0 && keywords.length === 0) return undefined;
  return {
    ...(icon ? { icon } : {}),
    ...(homepage ? { homepage } : {}),
    ...(category ? { category } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
  };
}

/**
 * 声明式插件的阻断原因：engines 不兼容 / 签名无效 / 内容指纹与安装记录不一致。
 *
 * 只把「确实说明这个单元不该再当作正常生效」的状态放进来：
 * 未签名（`none`）与验签环境不支持（`unsupported`）**不阻断**——旧包与受限环境
 * 本来就走这两态，阻断会让它们凭空失效（TOFU 语义见 `lib/plugins/signature.ts`）。
 */
export function pluginBlocks(
  plugin: InstalledPlugin,
  appVersion: string,
): UnitBlockReason[] {
  const blocks: UnitBlockReason[] = [];
  const engines = pluginEngines(plugin);
  if (engines) {
    const status = enginesStatus(engines, appVersion);
    if (status.status === "needsNewerApp") {
      blocks.push({ kind: "incompatible", required: status.required, actual: status.actual });
    } else if (status.status === "invalidEngines") {
      blocks.push({ kind: "invalidEngines", required: status.required });
    }
  }
  if (plugin.signature?.status === "invalid") {
    blocks.push({
      kind: "signature",
      detail: `「${plugin.manifest.name}」的清单签名未通过验证，已按不可信处理`,
    });
  }
  if (plugin.fingerprint) {
    try {
      if (contentFingerprint(plugin.manifest) !== plugin.fingerprint) {
        blocks.push({
          kind: "degraded",
          detail: `「${plugin.manifest.name}」存储中的清单与安装记录指纹不一致（可能被手工修改）`,
        });
      }
    } catch {
      // 指纹算法异常不应阻断投影（诊断本身是只读展示，不能反噬可用性）
    }
  }
  return blocks;
}

/** 声明式插件单元：贡献计数来自 manifest，贡献级停用来自 `disabledKinds`。 */
export function projectPackageUnits(
  plugins: readonly InstalledPlugin[],
  appVersion: string = currentAppVersion(),
): CapabilityUnit[] {
  return plugins.map((plugin) => {
    const manifest = plugin.manifest;
    const contributions: CapabilityUnit["contributions"] = [
      contribution("skills", manifest.contributions.skills.length, plugin.enabled),
      contribution("mcpServers", manifest.contributions.mcpServers.length, plugin.enabled),
      contribution("commands", manifest.contributions.commands.length, plugin.enabled),
      contribution("toolPacks", manifest.contributions.toolPacks.length, plugin.enabled),
    ].filter((item) => item.count > 0);

    const requires = readStringArray(manifestExtras(plugin).requires);
    const meta = pluginMeta(plugin);
    const searchKeywords = [
      ...manifest.contributions.skills.map((skill) => skill.name),
      ...manifest.contributions.mcpServers.map((server) => server.name),
      ...manifest.contributions.commands.map((command) => command.title),
    ];

    return {
      source: "package" as UnitSource,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      engines: pluginEngines(plugin) ?? LEGACY_ENGINES,
      enabled: plugin.enabled,
      disabledKinds: plugin.disabledKinds as ContributionKind[],
      contributions,
      blocks: pluginBlocks(plugin, appVersion),
      // 搜索要用技能/服务/命令名（插件卡一直支持按它们搜），但 Unit 不复制正文：
      // 放进 meta.keywords 只作展示与检索提示。
      ...(meta || searchKeywords.length > 0
        ? {
            meta: {
              ...(meta ?? {}),
              keywords: [...(meta?.keywords ?? []), ...searchKeywords].slice(0, 200),
            },
          }
        : {}),
      ...(requires.length > 0 ? { requires } : {}),
    };
  });
}

/** 界面插件单元：每包一个桌面小组件；记录损坏（`error`）按降级处理。 */
export function projectBundleUnits(
  widgets: readonly WidgetRecord[],
  _appVersion: string = currentAppVersion(),
): CapabilityUnit[] {
  return widgets.map((record) => {
    const blocks: UnitBlockReason[] = [];
    if (record.error) {
      blocks.push({ kind: "degraded", detail: record.error });
    }
    return {
      source: "bundle" as UnitSource,
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.widget?.name ? `桌面小组件：${record.widget.name}` : "界面插件",
      engines: LEGACY_ENGINES,
      enabled: record.enabled,
      contributions: [contribution("desktopWidgets", record.widget ? 1 : 0, record.enabled)],
      ...(blocks.length > 0 ? { blocks } : {}),
    };
  });
}

/**
 * 四类来源 → 单元列表（稳定顺序：系统 → 内置模块 → 声明式插件 → 界面插件）。
 *
 * 这就是插件页「已安装」区、诊断区与后续导航/命令面板的统一读模型；
 * 不含任何写入，也不改变各 store 的语义。
 */
export function projectUnits(sources: UnitProjectionSources = {}): CapabilityUnit[] {
  const units: CapabilityUnit[] = [];
  if (sources.system) units.push(projectSystemUnit(sources.system));
  units.push(
    ...projectBuiltinUnits(sources.moduleEnabled ?? {}, sources.modules ?? BUILTIN_MODULES),
  );
  const appVersion = sources.appVersion ?? currentAppVersion();
  if (sources.plugins && sources.plugins.length > 0) {
    units.push(...projectPackageUnits(sources.plugins, appVersion));
  }
  if (sources.widgets && sources.widgets.length > 0) {
    units.push(...projectBundleUnits(sources.widgets, appVersion));
  }
  return units;
}

/** 投影 + 生效判定（依赖/停用/阻断一次算完；测试与 UI 共用）。 */
export function projectUnitStatuses(sources: UnitProjectionSources = {}): UnitStatus[] {
  return resolveUnits(projectUnits(sources));
}

/** 类型再导出，避免消费方直接依赖 shared 的深层路径。 */
export type {
  CapabilityUnit,
  ContributionKind,
  UnitBlockReason,
  UnitStatus,
};
