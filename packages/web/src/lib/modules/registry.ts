import type { Page } from "../../store/ui.js";

/**
 * 内置能力模块（d.70）：把「幕僚 / 信息中枢 / 自动化」从导航里写死的页面，
 * 改成**可插拔的能力模块**——插件区能看到它们的版本、贡献、依赖与本机数据，
 * 用「安装 / 启用 / 停用 / 删除」管理；停用或删除后入口、页面、首页卡、
 * 后台常驻任务与相关工具注入一起下线（删除不碰本机已有数据）。
 *
 * 安装包**默认不携带任何模块**：三个模块都只是「可安装项」，用户装过才有开关。
 * 系统能力（`heming.core`）不属于这一层，它由插件区的系统卡只读展示。
 *
 * 为什么不是第三方插件：
 * - 第三方插件清单（`plugin.json` v3）**只声明技能 / 远程 MCP / 命令 / 工具束**，
 *   不执行随包代码，也不贡献 React 页面（否则等于安装即执行任意 UI 代码）；
 * - 这三个模块的页面是本应用代码的一部分，能做的是「装配开关」而不是「装进来」。
 *   所以它们走**同一套插件区展示与启用语义**（卡片、版本、贡献、安装/启停/删除），
 *   但注册表与存储独立（`heming.modules.v1`），不写进 `heming.plugins.v1`。
 *
 * 边界：停用/删除**只下线入口与运行时挂载，不删除本机数据**（简报、归档配置、自动化任务仍在），
 * 重新安装/启用即恢复；也不改变 HITL / E2E / 数据出设备边界。
 *
 * 模型路由已不在这一层：本地模型路由页下线，路由组由 magpie 路由界面管理（`lib/llmRoute.ts`
 * 的候选链与 failover 照常工作）。
 */

/**
 * 可插拔的内置模块 id。新增模块时只加注册表项 + 页面 + 接线点。
 *
 * 首方模块的包 id 带 `heming.` 前缀（与目录里的 `module.json`、安装记录、`module-catalog/`
 * 目录名一致）；`staff` / `workflows` 是并入其它插件后只保留数据兼容的旧模块，沿用裸 id。
 */
export type ModuleId = "staff" | "heming.infohub" | "heming.automations" | "workflows";

/**
 * 旧版内置模块 id → 当前包 id。
 *
 * 只用于**读取**历史状态（localStorage `heming.modules.v1`）：包 id 统一加前缀后，旧安装
 * 不该被当成「未安装」而丢掉入口。写回一律用新 id，不做双向映射。
 */
export const LEGACY_MODULE_ID_MAP: Readonly<Record<string, ModuleId>> = {
  infohub: "heming.infohub",
  automations: "heming.automations",
};

/** 用户可见的「插件」：一个插件可以贡献多个页面/后台任务（d.133）。 */
export interface PluginGroup {
  id: "assistant" | "infohub";
  name: string;
  description: string;
  moduleIds: ModuleId[];
}

export const PLUGIN_GROUPS: readonly PluginGroup[] = [
  {
    id: "assistant",
    name: "自动化",
    description: "一个页面管定时任务、工作流与简报：快速创建普通定时任务，或完整创建工作流并指定时间与次数。",
    moduleIds: ["heming.automations"],
  },
  {
    id: "infohub",
    name: "信息",
    description: "在本机采集、浏览、检索聊天记录与日程；采集引擎与归档都由这个插件管理。",
    moduleIds: ["heming.infohub"],
  },
];

export function pluginGroupOf(moduleId: ModuleId): PluginGroup | null {
  return PLUGIN_GROUPS.find((group) => group.moduleIds.includes(moduleId)) ?? null;
}

export type ModuleHomeCard = "staff" | "infohub";
export type ModuleBackgroundLoop = "staff-loop" | "automation-scheduler" | "workflow-scheduler";

/** 模块贡献面：插件区卡片按这个展示「它到底带了什么」。 */
export interface ModuleContributions {
  /** 页面贡献（true = 有宿主页面；旧模块并入新插件后仍为 true，但 hidden 时不进导航）。 */
  page: boolean;
  /** 导航/命令面板不展示（页面已并入另一个插件）。 */
  hidden?: boolean;
  /** 首页卡片 id（HomePage 内嵌卡）。 */
  homeCard?: ModuleHomeCard;
  /** 登录后常驻的后台循环（幕僚巡检 / 自动化调度）。 */
  backgroundLoop?: ModuleBackgroundLoop;
  /** 注入给模型的工具名前缀（停用即不注入）。 */
  toolPrefixes?: string[];
}

/** 一个内置能力模块的声明式描述（与插件清单字段同风格：id / 版本 / 描述 / 贡献）。 */
export interface BuiltinModule {
  id: ModuleId;
  name: string;
  /** 展示用版本（与插件卡一致：`v1.0.0`；不参与应用版本比较）。 */
  version: string;
  description: string;
  /** 宿主页面 id（导航与 `setPage` 用的同一个 Page）。 */
  page: Page;
  contributions: ModuleContributions;
  /**
   * 依赖的其它模块：依赖项未安装/停用时本模块**实际不生效**（开关保留，卡片说明原因）。
   * 当前三个模块互不依赖——自动化已独立成插件，不再依赖信息中枢。
   */
  requires?: ModuleId[];
  /** 和鸣本机存储里的数据键（仅用于展示占用；停用不删除）。 */
  storageKeys: string[];
  /** 不在和鸣存储里的本机数据（说明用途；不展示字节、也不由和鸣清理）。 */
  externalData?: string[];
  /** 停用后会发生什么（卡片上直接写清楚，不靠用户猜）。 */
  disableNote: string;
}

/** 模块注册表：三个内置模块的唯一事实来源。 */
export const BUILTIN_MODULES: readonly BuiltinModule[] = [
  {
    id: "staff",
    name: "幕僚",
    version: "v1.0.0",
    description:
      "每天检查日程和任务，有要紧事才提醒；只读，不替你操作。",
    page: "staff",
    // 幕僚已并入「自动化」插件（同一页面内「简报」Tab），旧模块 id 只保留数据兼容。
    contributions: { page: true, hidden: true, backgroundLoop: "staff-loop" },
    storageKeys: ["heming.staff.v1", "heming.staff.runs.v1", "heming.staff.seen.v1"],
    disableNote: "停用后不再后台巡检、首页幕僚卡与导航入口下线；已生成的简报仍保留在本机。",
  },
  {
    id: "heming.infohub",
    name: "信息中枢",
    version: "v1.0.0",
    description:
      "在本机浏览、检索 QQ / 微信聊天记录和日程；归档不出本机。",
    page: "infohub",
    contributions: {
      page: true,
      homeCard: "infohub",
      toolPrefixes: ["infohub_"],
    },
    storageKeys: [],
    externalData: [
      "信息插件是独立的和鸣插件：采集引擎随插件安装与运行，不依赖用户电脑上另行安装的 InfoHub 或 Python",
      "归档数据库由信息插件在本机管理；停用/卸载只撤销入口，不会自动删除归档",
    ],
    disableNote:
      "停用后导航入口、首页归档卡与 infohub_* 工具下线；不会自动启动或删除任何归档。重新启用即恢复。",
  },
  {
    id: "heming.automations",
    name: "自动化",
    version: "v1.0.0",
    description:
      "一个页面管定时任务、工作流与简报：快速创建普通定时任务，或完整创建工作流并指定时间与次数。",
    page: "automations",
    contributions: { page: true, homeCard: "staff", backgroundLoop: "automation-scheduler" },
    storageKeys: [
      "heming.automations.v1",
      "heming.automations.runs.v1",
      "heming.workflows.v1",
      "heming.workflows.executions.v1",
      "heming.workflows.credentials.v1",
      "heming.workflows.vars.v1",
      "heming.workflows.static.v1",
      "heming.staff.v1",
      "heming.staff.runs.v1",
      "heming.staff.seen.v1",
    ],
    disableNote:
      "停用后不再到点执行/巡检、导航入口与首页卡下线；任务、工作流、执行记录与简报仍保留在本机，重新启用即恢复。",
  },
  {
    id: "workflows",
    name: "工作流",
    version: "v1.0.0",
    description:
      "节点式自动化：触发器、分支、HTTP、代码、大模型与子流程，把要做的事一步步接起来。",
    page: "workflows",
    // 工作流已并入「自动化」插件（同一页面内「工作流」Tab），旧模块 id 只保留数据兼容。
    contributions: { page: true, hidden: true, backgroundLoop: "workflow-scheduler" },
    storageKeys: [
      "heming.workflows.v1",
      "heming.workflows.executions.v1",
      "heming.workflows.credentials.v1",
      "heming.workflows.vars.v1",
      "heming.workflows.static.v1",
    ],
    disableNote:
      "停用后定时触发不再执行、导航入口下线；工作流、执行记录、凭据与变量都保留在本机，重新启用即恢复。",
  },
];

/** id → 模块。 */
export const MODULE_BY_ID: Readonly<Record<ModuleId, BuiltinModule>> = Object.fromEntries(
  BUILTIN_MODULES.map((m) => [m.id, m]),
) as Record<ModuleId, BuiltinModule>;

/** 所有模块 id（稳定顺序，用于卡片渲染与状态规整）。 */
export const MODULE_IDS: readonly ModuleId[] = BUILTIN_MODULES.map((m) => m.id);

/** 宿主页面 id 集合（判断某个 Page 是不是模块页）。 */
const MODULE_PAGE_SET: ReadonlySet<string> = new Set(BUILTIN_MODULES.map((m) => m.page));

/** 页面是否属于某个模块。 */
export function isModulePage(page: string): boolean {
  return MODULE_PAGE_SET.has(page);
}

/** 页面 → 模块（非模块页返回 undefined）。 */
export function moduleForPage(page: string): BuiltinModule | undefined {
  return BUILTIN_MODULES.find((m) => m.page === page);
}

/** 一组本机存储键的占用量（字节，按 UTF-16 字符数估算同 `storageUsage` 的既有口径）。 */
export function moduleStorageBytes(
  mod: BuiltinModule,
  storage: Pick<Storage, "getItem"> | null = typeof window !== "undefined"
    ? window.localStorage
    : null,
): number {
  if (!storage) return 0;
  let total = 0;
  for (const key of mod.storageKeys) {
    try {
      const value = storage.getItem(key);
      if (value) total += key.length + value.length;
    } catch {
      /* 隐私模式等读不到就按 0 算，不影响卡片渲染 */
    }
  }
  return total;
}
