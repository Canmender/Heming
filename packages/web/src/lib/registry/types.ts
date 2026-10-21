/**
 * MCP 官方 Registry 的类型定义。
 *
 * 这一层是**纯类型 + 一层薄规整**（零 React、零 store），对齐 Registry v0.1 的实测响应。
 *
 * 两个必须记住的实测结论（详见 docs/research/2026-10-22-registry-architecture.md §0）：
 * 1. 字段是**驼峰**（`registryType`），不是 snake_case——按 snake_case 写会把所有包判成未知，列表直接空；
 * 2. **同一个 `server.name` 会重复出现多次**（每个版本一条），必须去重。
 */

/* -------------------------------------------------------------- 原始响应（实测字段） */

/**
 * Registry 里的一个包。
 *
 * 字段名逐字对照实测 JSON：**`registryType` 是驼峰**。
 */
export interface RegistryPackage {
  /**
   * 包类型。**驼峰，不是 `registry_type`**——这是最容易写错的字段。
   *
   * 实测样本里只出现过 `npm` / `pypi` / `oci`；`nuget` / `mcpb` 在规范里存在但少见。
   * 未知值按「不支持」处理（过滤掉），不做兜底尝试。
   */
  registryType: "npm" | "pypi" | "oci" | "nuget" | "mcpb" | (string & {});

  /** 包名，如 `@modelcontextprotocol/server-filesystem`。**外部输入，需白名单校验**。 */
  identifier: string;

  /** 版本号，如 `1.2.3`。可空（表示不固定版本）。**外部输入，需白名单校验**。 */
  version?: string;

  /** 传输方式。实测存在，但顶层 `remotes[]` 才是我们主要依据。 */
  transport?: { type?: "stdio" | "sse" | "streamable-http" };

  /**
   * 启动参数（实测 100 条里 4 个带值，结构未统一）。
   *
   * ★ **本轮直接丢弃，不映射进 args**（设计 §4.4）。
   * 理由：同样是外部输入且结构未定义；丢弃的代价是「少数包装不了」，
   * 放开的代价是「任意参数注入」。低频不等于安全——Registry 是开放注册中心。
   */
  packageArguments?: unknown;

  /**
   * 环境变量（同上，实测有值）。
   *
   * ★ **本轮直接丢弃，不映射进 env**。
   * 理由：它能注入任意变量（含 `PATH` / `NODE_OPTIONS`），**风险面比 args 更大**。
   */
  environmentVariables?: Record<string, string> | null;

  /** 运行提示（实测多为 null）。不参与任何判定。 */
  runtimeHint?: Record<string, unknown> | null;

  /** 包仓库地址（如 `https://registry.npmjs.org`）。仅展示。 */
  registryBaseUrl?: string | null;
}

/**
 * Registry 声明的**请求头需求**（实测字段：`name` / `description` /
 * `isRequired` / `isSecret` / `placeholder`）。
 *
 * ★ Registry **只提供「要哪个头、干什么用」**，不提供值——
 * 值必须由用户在安装向导里填。所以这一层是**展示与表单提示**，不是凭据。
 */
export interface RegistryHeaderSpec {
  /** 头名称，如 `Authorization`。 */
  name: string;
  /** 用途说明，如「Bearer <your API key>」。 */
  description?: string;
  /** 官方标注是否必填（实测有）。 */
  isRequired?: boolean;
  /** 官方标注是否为敏感值（实测 `Authorization` 全为 true）。→ UI 必须用密码框 + 掩码。 */
  isSecret?: boolean;
  /** 占位提示。 */
  placeholder?: string;
}

/** Registry 声明的远程端点（实测字段：`type` / `url` / `headers` / `variables`）。 */
export interface RegistryRemote {
  /**
   * 声明的传输类型。
   *
   * ★ **本项目不按这个字段过滤**。产品经理实测：有服务声明 `sse` 但实际是
   * streamable-http（对它发 GET 得 405，发 POST 正常返回 result）。
   * 我们的 `httpClient` 本来就同时声明 `Accept: application/json, text/event-stream`
   * （两种都试），**连一下才知道行不行**——按声明过滤会错杀可连服务。
   */
  type?: "streamable-http" | "sse" | (string & {});
  url: string;
  /**
   * 该端点需要的请求头。实测 **13%** 的 remote 带 headers（147 个里 19 个）。
   *
   * ★ 只有 `name` / `description` / `isSecret` / `isRequired` / `placeholder`，
   *   **没有 `value`** —— 值必须由用户在安装向导里填。
   */
  headers?: RegistryHeaderSpec[];
  /** URL 模板变量。★ **实测 0 例**；保留字段但本轮不做替换 UI。 */
  variables?: Record<string, { description?: string; default?: string }>;
}

/** Registry 里的一个服务端点声明。 */
export interface RegistryServer {
  /** 反向域名格式的**唯一标识**，如 `io.github.foo/mcp-bar`。去重与「已安装」判定都用它。 */
  name: string;

  /** 展示名。★ 实测**大量为 null**，所以必须回落 `name` 的尾段（见 `titleOf`）。 */
  title?: string;

  description?: string;
  version?: string;

  /** 仓库地址。`source` 是来源（如 `github`），**仅展示，不参与风险判定**。 */
  repository?: { url: string; source?: string; subfolder?: string };

  /**
   * 官网。
   *
   * ★ 字段名已实测核对（`websiteUrl` 确实存在于 server 对象内，
   * 且实测 60 条里 **46 条有值**，比我最初判定的「大量为 null」高得多）。
   */
  websiteUrl?: string | null;

  icons?: { src: string; mimeType?: string }[] | null;

  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
}

/** Registry 的官方元数据。 */
export interface RegistryOfficialMeta {
  /** 实测 120 条全为 `active`。表示「未被下架」，**不是安全审核通过**。 */
  status: string;
  statusChangedAt?: string;
  publishedAt?: string;
  updatedAt?: string;
  /** ★ 去重的关键：同一 `name` 的多条里通常只有一条是 true。 */
  isLatest?: boolean;
}

/** Registry 列表里的一项 = 服务端点 + 官方元数据。 */
export interface RegistryItem {
  server: RegistryServer;
  _meta?: { "io.modelcontextprotocol.registry/official"?: RegistryOfficialMeta };
}

/** Registry 列表响应。 */
export interface RegistryPage {
  servers?: RegistryItem[];
  /** ★ 分页是**游标式**，下一页用 `?cursor=<nextCursor>`；实测没有 offset/页码。 */
  metadata?: { nextCursor?: string; count?: number };
}

/* -------------------------------------------------------------- 内部类型 */

/** 安装方式。远程不需要在本机装任何代码。 */
export type InstallTransport = "http" | "stdio";

/** 一种具体装法。 */
export interface InstallOption {
  kind: InstallTransport;

  /** 面向用户的一行说明，如 `pypi · mcp-server-fetch@0.6.2`。 */
  label: string;

  /** stdio：**逻辑名**（如 `uvx` / `npx`），实际可执行文件由桌面端按 PATHEXT 解析。 */
  command?: string;
  args?: string[];

  /** http：服务地址。 */
  url?: string;

  /**
   * http：这个端点**声明需要的请求头**（名称 + 用途 + 是否必填/敏感）。
   *
   * ★ Registry 不提供值，值由用户在安装向导里填 → T08 的表单用这个渲染。
   * 实测 **13%** 的 remote 声明了 headers（口径：按 remote 条目算，147 个里 19 个），
   * 且 `Authorization` 全部标 `isSecret`。
   *
   * ★ 为什么是「有就用、没有就隐藏这个区块」而**不是「假定有」**：
   * Registry 当前的 `server` 顶层字段里**没有 headers**，它只出现在 `remotes[]` 元素里。
   * 若假定「远程服务器总要 API Key」，界面上就会出现一个**永远空的输入框**——
   * 87% 的用户点了没反应，更糟的是会让人以为「不填就连不上」。
   * 「有就用、没有就隐藏」天然覆盖两种情况，将来 Registry 加了字段也不用改代码。
   */
  headerHints?: RegistryHeaderSpec[];

  /**
   * http：URL 里有未替换的模板变量。★ **实测 0 例**（schema 里有定义，实际没人用）。
   * 保留字段是为了将来不用改代码；**本轮不做变量替换 UI** —— 为实测为 0 的功能做界面是浪费。
   */
  urlHasVariables?: boolean;

  /** npm / pypi；oci 等不支持的类型为 undefined。 */
  registryType?: string;
  version?: string;

  /**
   * 为什么装不了（如「包名含不允许的字符」）。
   * 非空时 UI **不要**提供安装按钮——映射阶段就该拒，不能等到启动失败。
   */
  unsupported?: string;
}

/** 去重后的一个可安装服务。 */
export interface RegistryEntry {
  /** 用 `server.name` 作稳定 key（装过的服务据此判「已安装」）。 */
  key: string;

  /** 展示名（`title` 回落 `name` 尾段）。 */
  title: string;

  description: string;

  /** 仓库地址（仅展示）。 */
  repoUrl?: string;
  /** 仓库来源（如 `github`，仅展示）。 */
  repoSource?: string;
  /** 官网（实测大量 null，无则不显示）。 */
  websiteUrl?: string;

  /** 官方状态（实测几乎全是 active）。**只用于「要不要展示」，不参与风险评级。** */
  status: string;

  /** 可选装法；空数组 = 暂不支持安装，但条目仍要展示。 */
  options: InstallOption[];

  /** 最新版本（展示用）。 */
  latestVersion?: string;
}

/** 拉取结果。**永不 reject** —— 断网/超时都归为 `ok:false`，让调用方能显示缓存与提示。 */
export type FetchResult<T> =
  | { ok: true; value: T; nextCursor?: string }
  | { ok: false; error: string };

/** 展示名回落：实测 `title` 大量为 null。 */
export function titleOf(server: RegistryServer): string {
  if (server.title) return server.title;
  const name = server.name ?? "";
  const tail = name.split("/").pop() ?? name;   // "io.github.foo/mcp-bar" → "mcp-bar"
  return tail || name || "未命名服务";
}
