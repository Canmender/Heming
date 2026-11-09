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

/** 可插拔的内置模块 id。新增模块时只加注册表项 + 页面 + 接线点。 */
export type ModuleId = "staff" | "infohub" | "automations";

export type ModuleHomeCard = "staff" | "infohub";
export type ModuleBackgroundLoop = "staff-loop" | "automation-scheduler";

/** 模块贡献面：插件区卡片按这个展示「它到底带了什么」。 */
export interface ModuleContributions {
  /** 导航入口 + 页面（当前三个模块都是 true；保留字段给未来「只带后台任务」的模块）。 */
  page: boolean;
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
    contributions: { page: true, homeCard: "staff", backgroundLoop: "staff-loop" },
    storageKeys: ["heming.staff.v1", "heming.staff.runs.v1", "heming.staff.seen.v1"],
    disableNote: "停用后不再后台巡检、首页幕僚卡与导航入口下线；已生成的简报仍保留在本机。",
  },
  {
    id: "infohub",
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
      "InfoHub 配置与归档数据库在本机由 InfoHub 管理（不在和鸣存储内，也不会被和鸣删除）",
      "采集引擎为选装模块：首次启用时按需从更新源下载官方签名引擎包（约 2MB），装在本机模块目录",
    ],
    disableNote:
      "停用后导航入口、首页归档卡与 infohub_* 工具下线；不会自动启动或删除任何本机归档。重新启用后会自动复用已安装的引擎。",
  },
  {
    id: "automations",
    name: "自动化",
    version: "v1.0.0",
    description:
      "定时同步归档、重扫日程；只跑两种固定动作，不执行脚本。",
    page: "automations",
    contributions: { page: true, backgroundLoop: "automation-scheduler" },
    storageKeys: ["heming.automations.v1", "heming.automations.runs.v1"],
    disableNote:
      "停用后不再到点执行、导航入口下线；任务与运行记录仍保留在本机。本插件独立安装/启停，不依赖信息中枢（运行时若信息中枢未连接，任务会如实报错）。",
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
