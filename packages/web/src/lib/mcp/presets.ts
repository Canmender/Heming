/**
 * 系统内置 MCP 能力（Windows 桌面控制 / 网页抓取）的唯一定义表。
 *
 * 为什么从「预设服务」改成「系统能力」：这两条不是让用户自己找命令、填参数、
 * 再点连接的可选项，而是和鸣桌面端的一部分能力——用户不该为了「看屏幕」「抓网页」
 * 去手敲 `uvx windows-mcp serve`。stdio 的参数拼错时不会报错，只表现为
 * 「连上了但一个工具都没有」，排查成本很高。
 *
 * 改成系统能力之后：
 * - **落盘配置只是缓存**，这张表才是唯一事实来源（命令、参数、只读白名单）；
 * - 存储层保证它们始终存在（`ensureSystemServers()`），且不可删除、不可改配置；
 * - 私有 MCP 服务不受影响，仍可在「接口」页自由添加。
 *
 * 旧导出名（`McpPreset` / `MCP_PRESETS` / `DEFAULT_PRESET_SERVERS` /
 * `presetServerId` / `findMcpPreset` / `PRESET_*_ID`）都保留为别名，
 * 避免一次性改坏大量既有导入；语义都是「系统能力」，新代码请用带 System 的那一套。
 */

/** 一条系统内置 MCP 能力。`args` 仅 stdio 用；`url` 仅 http 用。 */
export interface SystemMcpServer {
  /** 定义 id（如 `windows-desktop`）；落盘服务 id 用 `systemMcpServerId()` 换算。 */
  id: string;
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  /** 界面上的说明：这条能力是干什么的、有什么前置条件。 */
  hint: string;
  /** 该服务在本机实测可用（true）或仅为参考（false）。 */
  verified?: boolean;
  /**
   * 「发现工具」后自动启用的只读工具白名单。
   *
   * 为什么要分这一层：MCP 工具**默认一律不启用**（可能有副作用），
   * 但系统能力又讲究「开箱可用」。折中是定义表登记好、
   * 工具发现后把**只读那一批**自动打开，写操作仍需逐个确认。
   * 比如 Windows-MCP 里 Screenshot/Snapshot 是只读的，
   * 而 PowerShell/Registry/Process.kill 是能造成不可逆后果的，绝不能自动开。
   */
  safeTools?: string[];
}

/** @deprecated 旧名，等价于 `SystemMcpServer`；新代码请用 `SystemMcpServer`。 */
export type McpPreset = SystemMcpServer;

export const SYSTEM_MCP_SERVERS: SystemMcpServer[] = [
  {
    id: "windows-desktop",
    name: "Windows 桌面控制",
    transport: "stdio",
    // Windows-MCP 依赖 Windows UI Automation，必须在 Windows 侧跑。
    // 用 uvx 会自动拉最新版，无需预装；命令路径按本机 uv 实际位置填。
    command: "uvx",
    args: ["windows-mcp", "serve"],
    hint: "键鼠、窗口、截图、文件、PowerShell、注册表等桌面操作。需 Windows 10/11 与 Python 3.14+；仅桌面端可用（stdio 会拉起本机进程）。",
    verified: true,
    // 只读的一批：看屏幕、查布局、等条件、抓网页。
    // **刻意不含** Process 与 Clipboard——它们的 list/get 是只读，
    // 但 kill/set 是写操作，而本白名单是「按工具名」匹配的，无法区分调用参数；
    // 与其赌模型不传 kill 参数，不如整个留给用户手动启用。
    // PowerShell / Registry / FileSystem / Click / Type / Move / App 同理，一律不开。
    safeTools: ["Screenshot", "Snapshot", "DisplayInventory", "Wait", "WaitFor", "Scrape"],
  },
  {
    id: "scrapling",
    name: "网页抓取（Scrapling）",
    transport: "stdio",
    // Scrapling 自带 MCP server：uvx 会自动拉最新版，无需预装 scrapling。
    // --from 必须带 [ai] extra，否则 mcp 子命令不存在（mcp 依赖装在 ai extra 里）。
    command: "uvx",
    args: ["--from", "scrapling[ai]", "scrapling", "mcp"],
    hint: "抓取网页：HTTP 直连、隐身浏览器渲染 JS、绕过 Cloudflare、CSS/XPath 提取、整页转 Markdown、查后台 API。浏览器类工具需先跑 scrapling install 下载浏览器；仅桌面端可用（stdio 会拉起本机进程）。",
    verified: true,
    // 只读的一批：读取网页内容，不改本机状态、不在目标站点产生副作用。
    //
    // **刻意排除**三类：
    // - browser_actions / browser_evaluate：能点击、填表、提交表单、执行任意 JS，
    //   在目标站点上会产生真实副作用（登录、下单、发消息）；
    // - browser_open / open_request_session：会话会常驻占资源，且需配套 close_session；
    // - browser_save_state / browser_load_state：往本机磁盘写/读登录态文件。
    // 这三类留给你在接口区逐个勾。
    safeTools: [
      "make_request",
      "browser_fetch_once",
      "browser_fetch",
      "browser_extract",
      "browser_screenshot",
      "browser_network_requests",
      "browser_network_request",
      "list_sessions",
    ],
  },
  // ★ 「文件系统（官方示例）」这条已删除，且不会随这次改造回来。
  //
  //   它从来没跑通过：Windows 上 `npx` 是 shell 脚本（实测 2073 字节），
  //   `spawn("npx")` 直接 ENOENT、`spawn("npx.cmd")` 抛 EINVAL
  //   （Node ≥18.20.2 对 shell:false 的 .cmd/.bat 直接拒绝执行）。
  //   而它的 `args` 里还硬编码了本机路径 `D:/Heming`——装到别的机器上必然是错的。
  //
  //   **一个必然失败的入口不只是「没用」，它在降低用户对整个功能的信任。**
  //   真正需要文件 MCP 的用户可以在接口区自己加，或从 Registry 装本地包
  //   （npx 在本机起不来的问题已在 d.25 解决：桌面端 `planStdioSpawn` 把 `npx`
  //   翻译成 `node <npm>/bin/npx-cli.js`，仍然 `shell:false`；
  //   但这条不该再放回来——`args` 里硬编码本机路径是另一个独立原因）。
  //   我们自带的文件能力（`self_mcp_*` + wiki-fs.js + chart-fs.js）不依赖它。
];

/** @deprecated 旧名，等价于 `SYSTEM_MCP_SERVERS`；仅为兼容既有导入保留。 */
export const MCP_PRESETS: SystemMcpServer[] = SYSTEM_MCP_SERVERS;

/** @deprecated 旧名，等价于 `SYSTEM_MCP_SERVERS`（两条都已收进系统能力）。 */
export const DEFAULT_PRESET_SERVERS: SystemMcpServer[] = SYSTEM_MCP_SERVERS;

/** 按定义 id 找系统能力；未知 id 返回 null。 */
export function findSystemMcpServer(id: string): SystemMcpServer | null {
  return SYSTEM_MCP_SERVERS.find((p) => p.id === id) ?? null;
}

/** @deprecated 旧名：`findSystemMcpServer`。 */
export function findMcpPreset(id: string): SystemMcpServer | null {
  return findSystemMcpServer(id);
}

/** Windows 桌面控制的落盘服务 id。 */
export const SYSTEM_WINDOWS_DESKTOP_ID = "mcp-windows-desktop";
/** 网页抓取的落盘服务 id。 */
export const SYSTEM_SCRAPLING_ID = "mcp-scrapling";

/** @deprecated 旧名：`SYSTEM_WINDOWS_DESKTOP_ID`。 */
export const PRESET_WINDOWS_DESKTOP_ID = SYSTEM_WINDOWS_DESKTOP_ID;
/** @deprecated 旧名：`SYSTEM_SCRAPLING_ID`。 */
export const PRESET_SCRAPLING_ID = SYSTEM_SCRAPLING_ID;

/**
 * 定义 id → 落盘服务 id。
 *
 * 为什么要分两层 id：定义 id 是简洁稳定的人读名（`windows-desktop`），
 * 落盘 id 带 `mcp-` 前缀，与历史上预置写进用户列表的 id 保持一致——
 * 升级后旧配置能原地对上，不会重复插入第二条。
 */
export function systemMcpServerId(systemId: string): string {
  switch (systemId) {
    case "windows-desktop":
      return SYSTEM_WINDOWS_DESKTOP_ID;
    case "scrapling":
      return SYSTEM_SCRAPLING_ID;
    default:
      return `mcp-${systemId}`;
  }
}

/** @deprecated 旧名：`systemMcpServerId`。 */
export function presetServerId(presetId: string): string {
  return systemMcpServerId(presetId);
}

/**
 * 这个**落盘服务 id** 是否属于系统能力（不看当前列表里是否真有这条）。
 *
 * 界面与存储层都用它做只读判定，所以它不依赖存储状态：即使本轮列表还没补齐，
 * 也不能把系统能力当成用户服务而允许删除。
 */
export function isSystemMcpServer(serverId: string): boolean {
  return SYSTEM_MCP_SERVERS.some((s) => systemMcpServerId(s.id) === serverId);
}
