import { buildChartToolBridge } from "../charts/tools.js";
import { fileRootsFor } from "../fileEdit/roots.js";
import { buildFileToolBridgeIfAvailable } from "../fileEdit/tools.js";
import { buildInfohubToolsIfConnected } from "../infohub/tools.js";
import { buildToolBridge } from "../mcp/index.js";
import { mcpRegistry } from "../mcp/store.js";
import { memoryStore } from "../memory/index.js";
import { buildPluginToolBridge } from "../plugins/tools.js";
import { makePluginToolFilter } from "../plugins/toolCeiling.js";
import { buildSelfToolBridge } from "../selfEdit/index.js";
import { skillPool } from "../skills/index.js";
import { buildShellToolBridgeIfAvailable } from "../shell/tool.js";
import { buildTodoToolBridge } from "../todo/tool.js";
import { buildToneToolBridge } from "../tone/tools.js";
import { buildVaultToolBridge } from "../vault/tools.js";
import { buildWebToolsBridgeIfAvailable } from "../webtools/tools.js";
import { buildWikiToolBridge } from "../wiki/tools.js";
import type { CapabilityProvider } from "./types.js";

/**
 * 内置能力提供者：原先散在 `ChatPage.buildToolsFor` 的五类来源。
 *
 * 顺序与改前一致（mcp → charts → tone → wiki → infohub → self）：工具名重复时前者胜出。
 */

/**
 * 插件声明的工具风险上限（d.77）：在**注入点**过滤，而不是只在能力目录里标「未注入」。
 * 目录与执行同源（同一份 `riskAllowed` 口径），否则工具页的承诺是假的。
 */
const pluginToolFilter = makePluginToolFilter();

export const mcpProvider: CapabilityProvider = {
  id: "mcp",
  origin: "mcp",
  build: () => buildToolBridge(mcpRegistry, { toolAllowed: pluginToolFilter }),
};

export const chartsProvider: CapabilityProvider = {
  id: "charts",
  origin: "builtin",
  build: () => buildChartToolBridge(),
};

export const toneProvider: CapabilityProvider = {
  id: "tone",
  origin: "builtin",
  build: () => buildToneToolBridge(),
};

export const wikiProvider: CapabilityProvider = {
  id: "wiki",
  origin: "builtin",
  build: () => buildWikiToolBridge(),
};

/**
 * 原生知识库（vault）工具：`vault_search` / `vault_read` / `vault_write`。
 *
 * 默认注入（与 wikiProvider 同口径，模型始终能看到知识库能力）：
 * - 只读优先：`vault_search` / `vault_read` 风险 `read`；
 * - 写只进库的 `writeDirs`（主进程 `vault:apply` 再判一次），风险 `write`，
 *   由既有工具桥在每次调用前走人工确认；
 * - 浏览器临时模式里 `vault_write` 会明确拒绝（内存改动不落盘，不能给假承诺）。
 */
export const vaultProvider: CapabilityProvider = {
  id: "vault",
  origin: "builtin",
  build: () => buildVaultToolBridge(),
};

/**
 * 文件工具（d.55 起 file_patch / file_read；d.153 扩到六个）。
 *
 * 注入条件（三条同时成立）：
 * 1. 桌面桥存在（浏览器端返回 null——绝不为「能用」造内存假桥，那会让用户
 *    以为文件真被改了）；
 * 2. 至少一条根可用——**会话工作区也算一条**：`ctx.workspace` 被派生为隐式写根
 *    （`mergeWorkspaceRoot`，只派生不落盘、手动配置的同路径根优先），
 *    这样用户给会话选过文件夹就有文件能力，不必再跑一趟设置区；
 * 3. 可见工具非空（有写根才有写工具；老安装包的桥没有 glob/grep 时按工具隐藏）。
 */
export const filesProvider: CapabilityProvider = {
  id: "files",
  origin: "builtin",
  build: (ctx) =>
    buildFileToolBridgeIfAvailable({
      // 根口径只在 roots.ts 里实现一次（含未分组会话的默认工作区兜底）：
      // ctx.workspace 优先，缺省才回落到 Chatter 记下的活动工作区。
      roots: () => fileRootsFor(ctx.workspace),
    }),
};

/**
 * 内置联网与本地只读工具（d.149.4.95.11 起：web_search / web_read / now；
 * d.150.4.95.11 扩到 7 个，见 `lib/webtools/tools.ts`）：
 * 只在**有主进程 HTTP 桥**时注入（浏览器端返回 null）。
 *
 * 为什么要桥：渲染层 origin 是 `app://heming`，直连第三方会被同源策略拦下；
 * 主进程的通用代发桥（`workflow:http`）已做安全收口，在这里复用比新开一条 IPC
 * 通道更小也更安全。联网两个工具只读，web_read 另有私网地址守卫（`net-guard.ts`）；
 * calculator / json_query / encoding / date_calc 是纯本地计算，同样只读，
 * 由 `guarded + floor=read` 默认放行。
 */
export const webToolsProvider: CapabilityProvider = {
  id: "webtools",
  origin: "builtin",
  build: () => buildWebToolsBridgeIfAvailable(),
};

/**
 * 本机归档工具：只在桌面端且用户已连接信息中枢时注入。
 * 未连接时返回 null——绝不为了「能用」而替用户拉起 Python 进程。
 */
export const infohubProvider: CapabilityProvider = {
  id: "infohub",
  origin: "builtin",
  build: () => buildInfohubToolsIfConnected(),
};

/**
 * 插件市场只读工具（d.108 · 规格 §9）：`plugin_market_search` / `plugin_install_preview`。
 *
 * 免批：两者都只读索引/清单，不写存储、不碰主进程安装器；写路径（`plugin_install`）
 * 留给 HITL，不在此提供。始终注入——市场索引不可用时工具自己降级为
 * `{ unavailable: true, reason }`，不需要按连接状态决定是否出现。
 */
export const pluginMarketProvider: CapabilityProvider = {
  id: "plugin-market",
  origin: "plugin",
  build: () => buildPluginToolBridge(),
};

/**
 * 自我修改工具：默认开启（d.148.4.95 起不再有页面开关）。
 * 只有旧版本里显式关掉过的智能体才不注入；关掉时 `allowed()` 为 false。
 */
export const selfProvider: CapabilityProvider = {
  id: "self",
  origin: "self",
  build: (ctx) => {
    const selfEdit = ctx.selfEdit;
    if (!selfEdit || !selfEdit.policy.allowed(ctx.agentId)) return null;
    return buildSelfToolBridge(
      {
        memory: memoryStore,
        skills: skillPool,
        mcp: mcpRegistry,
        policy: selfEdit.policy,
        budget: selfEdit.budget,
      },
      { agentId: ctx.agentId, conversationId: ctx.conversationId },
    );
  },
};
/**
 * 任务清单（	odo_write，d.154）。
 *
 * 唯一一个**不需要任何外部依赖就默认注入**的写类工具：它只改会话级的计划状态，
 * 不碰文件、不碰配置、不出本机，因此浏览器端也有（长任务不该只有桌面端能做）。
 * 计划按 conversationId 隔离，注册表每次 build 传进来的是当前会话。
 */
export const todoProvider: CapabilityProvider = {
  id: "todo",
  origin: "builtin",
  build: (ctx) => buildTodoToolBridge({ conversationId: ctx.conversationId }),
};

/**
 * 本机命令（`run_command`，d.164）。
 *
 * 与 files 并列而不是并进去：文件工具的语义是「改哪个文件」，命令的语义是「做一件事」，
 * 两者的权限模型不同（前者按路径前缀授权，后者只能每次问）。没有桌面命令桥或没有可写根时
 * 返回 null，注册表自动跳过——浏览器端永远不会出现一个点了没反应的「运行命令」。
 */
export const shellProvider: CapabilityProvider = {
  id: "shell",
  origin: "builtin",
  build: (ctx) =>
    buildShellToolBridgeIfAvailable({
      roots: () => fileRootsFor(ctx.workspace),
    }),
};