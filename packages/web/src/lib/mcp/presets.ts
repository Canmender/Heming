/**
 * 常用 MCP 服务预设：点一下自动填好「传输 / 地址或命令 / 参数」。
 *
 * 为什么要有预设：像 Windows-MCP 这类服务，命令与参数有固定写法
 * （`uvx windows-mcp serve`），每次手敲既慢又容易漏参数——而 stdio 的参数
 * 拼错时不会报错，只表现为「连上了但一个工具都没有」，很难排查。
 *
 * 预设不限制自由配置：私有部署、自建服务仍可直接手填。
 */

/** 预设条目。`args` 仅 stdio 用；`url` 仅 http 用。 */
export interface McpPreset {
  id: string;
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  /** 界面上的说明：这条预设是干什么的、有什么前置条件。 */
  hint: string;
  /** 该服务在本机实测可用（true）或仅为参考（false）。 */
  verified?: boolean;
  /**
   * 「发现工具」后自动启用的只读工具白名单。
   *
   * 为什么要分这一层：MCP 工具**默认一律不启用**（可能有副作用），
   * 但完全让用户手点又谈不上「默认接入」。折中是预置服务登记好、
   * 工具发现后把**只读那一批**自动打开，写操作仍需逐个确认。
   * 比如 Windows-MCP 里 Screenshot/Snapshot 是只读的，
   * 而 PowerShell/Registry/Process.kill 是能造成不可逆后果的，绝不能自动开。
   */
  safeTools?: string[];
}

export const MCP_PRESETS: McpPreset[] = [
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
  // ★ 「文件系统（官方示例）」这条已删除。
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
  //   但这条预置不该再放回来——`args` 里硬编码本机路径是另一个独立原因）。
  //   我们自带的文件能力（`self_mcp_*` + wiki-fs.js + chart-fs.js）不依赖它。
];

/** 按 id 找预设；未知 id 返回 null（界面据此忽略点击）。 */
export function findMcpPreset(id: string): McpPreset | null {
  return MCP_PRESETS.find((p) => p.id === id) ?? null;
}

/** 预置服务首次登记用的固定 id：便于识别「这条是预置的」，以及用户删除后不再自动补回。 */
export const PRESET_WINDOWS_DESKTOP_ID = "mcp-windows-desktop";
/** 网页抓取服务的预置 id（与上面的固定 id 规则一致）。 */
export const PRESET_SCRAPLING_ID = "mcp-scrapling";

/**
 * 预设 id → 落盘用的服务 id。
 *
 * 预置可能有多条，每条要**各自独立**的 id：删除记录（用户删过哪条）、
 * `isPreset` 判定、只读白名单自动启用都按 id 走。共用一个 id 的话，
 * 删掉其中一条会被当成删掉全部，或者两条互相覆盖。
 */
export function presetServerId(presetId: string): string {
  switch (presetId) {
    case "windows-desktop":
      return PRESET_WINDOWS_DESKTOP_ID;
    case "scrapling":
      return PRESET_SCRAPLING_ID;
    default:
      return `mcp-${presetId}`;
  }
}

/**
 * 首次使用时预置的服务（用户要求「默认接入」）。
 *
 * 预置只有两条：Windows 桌面控制与网页抓取（Scrapling）——
 * 都是与和鸣桌面端同平台、且在本机实测可用的服务。
 *
 * 原来的「文件系统（官方示例）」已删除（见上面 MCP_PRESETS 里的说明）：
 * 它在 Windows 上从来跑不通，且路径硬编码了本机目录。
 * 真正需要文件 MCP 的用户在接口区自己加。
 */
export const DEFAULT_PRESET_SERVERS: McpPreset[] = MCP_PRESETS.filter(
  (p) => p.id === "windows-desktop" || p.id === "scrapling",
);