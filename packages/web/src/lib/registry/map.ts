/**
 * Registry 条目 → 内部 `McpServerConfig` 的映射，含**包名字符集白名单**（安全项）。
 *
 * 零 React、零 store、零 fetch：纯函数，全部可单测。
 *
 * ★ 本文件最重要的部分是 `validatePackage`。Registry 的 `identifier` / `version`
 * 是**外部输入**，而 npm 类服务器要用 `npx` 起（Windows 上是 `.cmd` 批处理），
 * 必须靠白名单挡掉命令注入——**它挡的是注入本身，不只是兼容性问题**。
 */

import type { McpServerConfig } from "../mcp/types.js";
import { slugPart } from "../mcp/bridge.js";
import type {
  InstallOption,
  RegistryEntry,
  RegistryItem,
  RegistryPackage,
  RegistryServer,
} from "./types.js";
import { titleOf } from "./types.js";

/* -------------------------------------------------------------- 包名白名单（安全） */

/**
 * 允许的包名字符集：字母、数字、`@ / . _ -`
 *
 * 为什么这么紧：npm 包名规范本身就只用这些字符，而 **shell 元字符
 * （空格 引号 `;` `&` `|` `>` `<` `` ` `` `$` `( )` `{ }` `[ ]`）一个都不在集合里**。
 *
 * 白名单通过 = **不可能构造出注入串**。这不是「转义干净」，是「根本没法构造」——
 * 前者依赖转义函数没有漏洞，后者只依赖一个正则。
 */
const SAFE_IDENTIFIER = /^[A-Za-z0-9@/._-]+$/;

/** 版本号额外允许 `+`（语义化版本的构建元数据，如 `1.0.0+build.1`）。 */
const SAFE_VERSION = /^[A-Za-z0-9.+-]+$/;

/**
 * 包名长度上限。
 *
 * 取 200 而不是 `mcp-stdio.js` 的 512：npm 包名规范本身限制在 **214** 以内，
 * 留一点余量即可。**这一条同时也是防超长参数的兜底**。
 */
const MAX_IDENTIFIER = 200;

/** 白名单拒绝的原因（**要能被用户看懂**，不能只说「安装失败」）。 */
export interface RejectReason {
  /** 哪个字段出的问题：`identifier` / `version`。 */
  field: string;
  /** 出问题的值（**截断到 40 字符**，避免把超长串刷到界面上）。 */
  value: string;
  /** 人话原因，直接可展示。 */
  reason: string;
}

function clip(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

/**
 * 校验一个包能否安全地作为 stdio 服务启动。
 *
 * ★ **校验时机：映射阶段就拒，不是启动时才拒。**
 * 拒绝一个恶意包名**不应该以「安装失败」的形式出现**——用户已经装了一半，
 * 还可能以为是网络问题。应该在点安装之前就告诉他「这个包名不合法」。
 *
 * 返回 `null` 表示通过；否则返回可展示的拒绝原因。
 */
export function validatePackage(pkg: RegistryPackage): RejectReason | null {
  const id = typeof pkg.identifier === "string" ? pkg.identifier : "";
  if (!id) return { field: "identifier", value: "", reason: "包名为空" };
  if (id.length > MAX_IDENTIFIER) {
    return { field: "identifier", value: clip(id), reason: `包名过长（超过 ${MAX_IDENTIFIER} 字符）` };
  }
  // 逐字符也能过，但正则一次到位；这里用正则并把拒绝原因写具体。
  if (!SAFE_IDENTIFIER.test(id)) {
    return {
      field: "identifier",
      value: clip(id),
      reason: "包名含不允许的字符（只允许字母、数字与 @ / . _ -）",
    };
  }
  if (pkg.version != null) {
    if (pkg.version.length > MAX_IDENTIFIER) {
      return { field: "version", value: clip(pkg.version), reason: "版本号过长" };
    }
    if (!SAFE_VERSION.test(pkg.version)) {
      return {
        field: "version",
        value: clip(pkg.version),
        reason: "版本号含不允许的字符",
      };
    }
  }
  return null;
}

/* -------------------------------------------------------------- 本地包（★ 本轮不装） */

/**
 * ★ 本轮**不做本地包安装**（2026-10-22 主理人拍板）。
 *
 * 理由是**零依赖承诺**：我们的内置运行时里既没有 Node 也没有 uv
 * （`resources/runtime/mcp-env/Scripts/` 只有 `uvicorn.exe`，与 uv 无关）。
 * npm 类要 `npx`（用户机器上未必有 Node）、pypi 类要 `uvx`（没有 uv）。
 * 做它们等于要向用户说「请自己装 Node/uv」——这打破了本项目「零依赖内置运行时」的承诺。
 *
 * 而 Registry 实测 **82% 是 remote-only**（只有 `remotes`，没有 `packages`），
 * **只做 remote 分支就已经覆盖了绝大多数服务器**。
 *
 * 下轮放开本地包时要做的事（已确认可行）：npm 走
 * `node <npm>/bin/npx-cli.js -y <pkg>`（绕开 `.cmd`，完全不涉及 shell）；
 * pypi 需要把 uv 打进包（+30MB，需重新评估）。
 *
 * **为什么保留 `validatePackage`**：白名单是对的，下轮直接用。
 * 而且**白名单校验独立于「支不支持」**——不支持的类型直接标 unsupported（不查白名单），
 * 支持的类型才走白名单。下轮放开时只需改 `LOCAL_PACKAGES_SUPPORTED` 一个常量。
 */
export const LOCAL_PACKAGES_SUPPORTED = false;

/** 唯一一条白名单相关的对外说明，供 UI 显示「为什么装不了」。 */
export const LOCAL_UNSUPPORTED_REASON = "暂不支持本地包类型（该功能需要本机有 Node/uv，和鸣不内置）";

/**
 * Registry 包类型 → **逻辑命令名**。
 *
 * ★ **本轮没有调用方**（本地包不装，见上）。保留下轮放开时用。
 *
 * 只给**逻辑名**，不是 Windows 上的真实文件名——实际文件名由桌面端
 * `mcp-stdio.js` 的 `resolveExecutable` 按 PATHEXT 解析，**不能反过来**：
 * 解析顺序必须是 `.exe` → `.cmd` → `.bat` → 原名（兜底），
 * 因为实测 `npx`（无扩展名）是 **2073 字节的 shell 脚本**，Windows 跑不了。
 */
export function runnerFor(registryType: string): string {
  if (registryType === "npm") return "npx";
  if (registryType === "pypi") return "uvx";
  return "";                                   // oci / nuget / mcpb / 未知
}

/**
 * 由 Registry 的包构造一种 stdio 装法；不支持或包名不合法时返回带 `unsupported` 的项。
 *
 * **返回带 `unsupported` 而不是 `null`**：这样 UI 能显示「为什么装不了 + 具体哪个值不合法」，
 * 而不是静默隐藏（用户会以为自己错过了什么）。
 *
 * ★ **`packageArguments` 与 `environmentVariables` 本轮直接丢弃**，不映射进 args/env。
 * 理由见 `types.ts` 里这两个字段的注释。
 */
export function buildOption(pkg: RegistryPackage): InstallOption {
  const spec = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
  const label = `${pkg.registryType} · ${spec}`;

  // ★ 本轮所有本地包都标 unsupported（不生成 command/args）。
  //   注意顺序：**先判「支不支持」，再判白名单** —— 不支持的类型没必要查白名单，
  //   白名单留给下轮放开的类型用（见 LOCAL_PACKAGES_SUPPORTED 的说明）。
  if (!LOCAL_PACKAGES_SUPPORTED) {
    return {
      kind: "stdio",
      label,
      registryType: pkg.registryType,
      version: pkg.version,
      unsupported: LOCAL_UNSUPPORTED_REASON,
    };
  }

  // ↓↓↓ 以下分支本轮走不到，但保留：下轮把 LOCAL_PACKAGES_SUPPORTED 打开即可用。
  //     白名单校验的位置很关键——它在生成 command **之前**，不合法的包名拿不到可执行文件。
  if (!["npm", "pypi"].includes(pkg.registryType)) {
    // 字段名写错（如 snake_case 的 registry_type）会让 registryType 为 undefined。
    // ★ 这种情况下**绝不能**当默认类型处理 —— 一个「认不出来」的包必须被拒，
    //   猜一个类型去执行它等于把未知输入当可信输入。
    const shown = pkg.registryType ? `${pkg.registryType} 类型` : "类型（包类型字段缺失或无法识别）";
    return {
      kind: "stdio",
      label,
      registryType: pkg.registryType,
      version: pkg.version,
      unsupported: `暂不支持${shown}的包`,
    };
  }

  const bad = validatePackage(pkg);
  if (bad) {
    return {
      kind: "stdio",
      label,
      registryType: pkg.registryType,
      version: pkg.version,
      unsupported: `${bad.reason}：${bad.value}`,
    };
  }

  const command = runnerFor(pkg.registryType);
  // npx 需要 -y 跳过安装提示；uvx 不需要（也没有这个参数）。
  const args = pkg.registryType === "npm" ? ["-y", spec] : [spec];
  return {
    kind: "stdio",
    command,
    args,
    registryType: pkg.registryType,
    version: pkg.version,
    label,
  };
}

/* -------------------------------------------------------------- 远程选项 */

/** URL 模板变量（`{project_slug}` 这类）。实测极少（3/883），只提示不自动替换。 */
const URL_TEMPLATE_RE = /\{[^{}]+\}/;

/**
 * 由 `remotes[]` 构造装法。**远程优先**（`options` 里排前面）——
 * 远程不需要在本机装任何代码，供应链风险面小得多，断网也能用。
 *
 * ★ **刻意不按 `type` 过滤**（产品经理实测的结论）：
 * 有服务声明 `sse` 但实际是 streamable-http —— 对它发 GET 得 **405 Method Not Allowed**，
 * 发 POST（我们的模式）却 **200 正常返回 result**。
 * 我们的 `httpClient` 本来就同时声明 `Accept: application/json, text/event-stream`
 * （两种都试），**实际连一下才知道行不行**。
 * 按声明过滤会**错杀可连服务**，所以只做 URL 合法性检查。
 */
export function buildRemoteOptions(server: RegistryServer): InstallOption[] {
  const out: InstallOption[] = [];
  for (const r of server.remotes ?? []) {
    if (!r || typeof r.url !== "string" || !r.url) continue;
    // URL 必须是 http(s)：file:// / javascript: 之类一律不接。
    if (!/^https?:\/\//i.test(r.url)) continue;
    // headers 只做**展示与表单提示**；Registry 不提供值，值由用户填（实测 13% 的 remote 需要）。
    const headerHints = Array.isArray(r.headers) && r.headers.length ? r.headers : undefined;
    out.push({
      kind: "http",
      url: r.url,
      // 保留原始 type 只用于展示（实测它未必准），不参与任何过滤判断。
      label: `远程${r.type ? ` · ${r.type}` : ""}`,
      headerHints,
      urlHasVariables: URL_TEMPLATE_RE.test(r.url),
    });
  }
  return out;
}

/** 某项装法是否真的可装（`unsupported` 非空 = 不可装）。 */
export function isInstallable(option: InstallOption): boolean {
  return !option.unsupported;
}

/* -------------------------------------------------------------- 完整映射 */

/**
 * Registry 的 `server.name` → 内部 serverId。
 *
 * 前缀 `mcp-registry-` 与预置的 `mcp-`（`presetServerId`）区分开，
 * 避免与内置预置的 id 混淆。复用 `mcp/bridge.ts` 的 `slugPart()`——
 * 它对非 ASCII 会转稳定短哈希，与我们已有的工具命名规则一致，不重复造。
 */
export function registryServerId(key: string): string {
  return `mcp-registry-${slugPart(key)}`;
}

/** 由 `RegistryEntry` + 选中的装法构造内部配置。 */
export function toServerConfig(
  entry: RegistryEntry,
  option: InstallOption,
  now: () => string = () => new Date().toISOString(),
  /** 用户在安装向导里填的头部值。★ 敏感值由 UI 侧负责掩码与加密存储。 */
  headers?: Record<string, string>,
): McpServerConfig {
  const at = now();
  return {
    id: registryServerId(entry.key),
    name: entry.title,
    transport: option.kind,
    url: option.url,
    command: option.command,
    // ★ 只放我们自己生成的 args（白名单校验过的包名 + 固定前缀）。
    //   Registry 的 packageArguments / environmentVariables **一律不进这里**。
    args: option.args ? [...option.args] : undefined,
    // ★ 13% 的 remote 需要鉴权（实测），而 `mcp/httpClient.ts:58` 已经会带 `server.headers`。
    //   没有它这些服务器一律 401/403（实测 10/15 返回 401/403）。
    headers: headers && Object.keys(headers).length ? { ...headers } : undefined,
    // 新装的服务默认「启用服务」但工具全关——工具启用集合默认为空（现有行为）。
    enabled: true,
    origin: "registry",
    registryName: entry.key,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * 由原始 `RegistryItem` 构造去重后的 `RegistryEntry`。
 *
 * 装法排序：**远程在前**（`options.unshift`），其次 stdio。
 * 不可装的项也保留在数组里（带 `unsupported`），UI 据此显示「为什么装不了」。
 */
export function toEntry(item: RegistryItem): RegistryEntry {
  const server = item.server;
  const meta = item._meta?.["io.modelcontextprotocol.registry/official"];
  const options = buildRemoteOptions(server);
  for (const pkg of server.packages ?? []) {
    if (!pkg || typeof pkg.identifier !== "string" || !pkg.identifier) continue;
    options.push(buildOption(pkg));
  }
  return {
    key: server.name,
    title: titleOf(server),
    description: typeof server.description === "string" ? server.description : "",
    repoUrl: server.repository?.url,
    repoSource: server.repository?.source,
    websiteUrl: server.websiteUrl ?? undefined,
    status: typeof meta?.status === "string" ? meta.status : "unknown",
    options,
    latestVersion: server.version,
  };
}
