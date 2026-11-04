import type { Page } from "../../store/ui.js";

/**
 * 内置能力模块（d.70）：把「幕僚 / 信息中枢 / 自动化」从导航里写死的页面，
 * 改成**可插拔的能力模块**——插件区能看到它们的版本、贡献、依赖与本机数据，
 * 用开关启用/停用；停用后入口、页面、首页卡、后台常驻任务与相关工具注入一起下线。
 *
 * 为什么不是第三方插件：
 * - 第三方插件清单（`plugin.json` v3）**只声明技能 / 远程 MCP / 命令 / 工具束**，
 *   不执行随包代码，也不贡献 React 页面（否则等于安装即执行任意 UI 代码）；
 * - 这三个模块的页面是本应用代码的一部分，能做的是「装配开关」而不是「装进来」。
 *   所以它们走**同一套插件区展示与启用语义**（卡片、版本、贡献、启用/停用），
 *   但注册表与存储独立（`heming.modules.v1`），不写进 `heming.plugins.v1`。
 *
 * 边界：停用**只下线入口与运行时挂载，不删除本机数据**（简报、归档配置、自动化任务仍在），
 * 重新启用即恢复；也不改变 HITL / E2E / 数据出设备边界。
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
  /** 依赖的其它模块：依赖项停用时本模块**实际不生效**（开关保留，卡片说明原因）。 */
  requires?: ModuleId[];
  /** 本机数据键（仅用于卡片说明「停用不删数据」）。 */
  dataKeys: string[];
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
      "常驻主动简报：巡检本机日程与任务，只在需要你决定时递一份摘要；只读采集，不代你执行操作。",
    page: "staff",
    contributions: { page: true, homeCard: "staff", backgroundLoop: "staff-loop" },
    dataKeys: ["heming.staff.v1"],
    disableNote: "停用后不再后台巡检、首页幕僚卡与导航入口下线；已生成的简报仍保留在本机。",
  },
  {
    id: "infohub",
    name: "信息中枢",
    version: "v1.0.0",
    description:
      "把本机 QQ / 微信归档接进和鸣：桌面端用 stdio 拉起本机进程，只读浏览、全文检索与议程都在本机完成。",
    page: "infohub",
    contributions: {
      page: true,
      homeCard: "infohub",
      toolPrefixes: ["infohub_"],
    },
    dataKeys: ["InfoHub 配置文件（仓库外）", "本机归档数据库（只读打开）"],
    disableNote:
      "停用后导航入口、首页归档卡与 infohub_* 工具下线；不会自动启动或删除任何本机归档。重新启用后可再连接。",
  },
  {
    id: "automations",
    name: "自动化",
    version: "v1.0.0",
    description:
      "为本机归档建定时任务：按每天定时或间隔执行归档同步 / 重扫日程；只识别两个白名单动作，不执行任意脚本。",
    page: "automations",
    contributions: { page: true, backgroundLoop: "automation-scheduler" },
    requires: ["infohub"],
    dataKeys: ["heming.automations.v1", "heming.automations.runs.v1"],
    disableNote:
      "停用后不再到点执行、导航入口下线；任务与运行记录仍保留在本机。依赖「信息中枢」启用后才生效。",
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
