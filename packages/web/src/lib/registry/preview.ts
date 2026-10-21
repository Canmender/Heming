/**
 * 安装确认卡的展示内容与请求头校验（纯函数，可单测）。
 *
 * 为什么单独一层：确认卡的文案与「哪些值能进 HTTP 头」都是安全相关逻辑，
 * 不能散在 JSX 里——UI 一改就可能把一行免责声明或一条校验顺手删掉。
 */

import type { InstallOption, RegistryEntry, RegistryHeaderSpec } from "./types.js";
import { rateInstall, type InstallVerdict } from "./risk.js";
import { RUNTIME_LABEL, runtimeRequirementFor } from "./runtime.js";

/** 确认卡上一行「标签 → 值」。空值行由调用方过滤。 */
export interface InstallPreviewRow {
  label: string;
  value: string;
}

/** 安装确认卡需要的全部信息。 */
export interface RegistryInstallPreview {
  /** Registry 的 `server.name`（唯一可信身份）。 */
  key: string;
  title: string;
  rows: InstallPreviewRow[];
  /** 供应链风险评级（`lib/registry/risk.ts`）。 */
  risk: InstallVerdict;
  /** 选中的装法（远程 URL 或本地包）。 */
  option: InstallOption;
  /** 声明需要的请求头（无则不渲染输入区）。 */
  headerHints: RegistryHeaderSpec[];
}

/** 用户对安装确认卡的裁决（经 `enqueueRaw` 回传给 store）。 */
export interface InstallDecision {
  approved: boolean;
  /** 用户填写的请求头值（仅包含 Registry 声明过的头名）。 */
  headers?: Record<string, string>;
}

/** 由条目 + 装法生成确认卡内容。 */
export function buildInstallPreview(entry: RegistryEntry, option: InstallOption): RegistryInstallPreview {
  const rows: InstallPreviewRow[] = [
    { label: "服务", value: entry.title },
    { label: "来源", value: entry.key },
    { label: "传输", value: option.kind === "http" ? option.url ?? option.label : option.label },
  ];
  if (option.kind === "stdio") {
    // ★ 把要在本机执行的命令原样摊到确认卡上。用户点「允许」时批准的是
    //   「用 npx 跑这个钉死版本的包」这句具体的话，不是一个抽象的「本地包」。
    //   这里显示的是**逻辑命令**，桌面端会把它翻译成本机真正执行的形态
    //   （Windows 上 `npx` → `node <npm>/bin/npx-cli.js`），翻译只换执行方式、不换要跑的东西。
    rows.push({ label: "本机命令", value: [option.command, ...(option.args ?? [])].join(" ").trim() });
    const req = runtimeRequirementFor(option);
    if (req) rows.push({ label: "运行时", value: `${RUNTIME_LABEL[req]}（本机已有，和鸣不内置）` });
  }
  if (entry.repoUrl) {
    rows.push({ label: "仓库", value: entry.repoSource ? `${entry.repoUrl}（${entry.repoSource}）` : entry.repoUrl });
  }
  if (entry.websiteUrl) rows.push({ label: "官网", value: entry.websiteUrl });
  rows.push({ label: "官方状态", value: entry.status });
  if (entry.latestVersion) rows.push({ label: "最新版本", value: entry.latestVersion });

  return {
    key: entry.key,
    title: entry.title,
    rows,
    risk: rateInstall(entry, option),
    option,
    headerHints: option.headerHints ?? [],
  };
}

/* -------------------------------------------------------------- 请求头校验 */

/** HTTP 头名只允许 token 字符（RFC 7230）。 */
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

/**
 * 浏览器/fetch 会拒绝或不应由页面设置的头。
 *
 * 这些不是「业务上不需要」，而是**设置了也不会按预期工作**，甚至可能被
 * 中间层用来做请求走私；统一拒绝，避免用户以为填了就生效。
 */
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "expect",
  "proxy-authorization",
]);

/** 单个头值的长度上限：超长值多半是误贴了整个文件。 */
const MAX_HEADER_VALUE = 8192;

/**
 * 把用户填的头值收敛成可发送的 `Record<string, string>`。
 *
 * 两个边界：
 * 1. **只接受 Registry 声明过的头名**——不让外部数据凭空新增头（如 `Cookie`）；
 * 2. 值里**不允许 CR/LF**——防止头注入（fetch 通常会拒，但这里先挡，错误信息也更清楚）。
 *
 * 返回 `error` 时调用方**不得安装**。
 */
export function sanitizeHeaders(
  hints: RegistryHeaderSpec[],
  values: Record<string, string>,
): { headers?: Record<string, string>; error?: string } {
  const headers: Record<string, string> = {};

  for (const hint of hints) {
    const name = hint.name?.trim() ?? "";
    if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      // 声明本身不合法：拒绝整个安装，而不是悄悄跳过——
      // 跳过会让用户以为鉴权已配置，实际请求却缺头。
      return { error: `该服务声明了不允许的请求头名称：${name || "（空）"}` };
    }
    const raw = values[name];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      if (hint.isRequired) return { error: `请填写必填请求头：${name}` };
      continue;
    }
    if (value.length > MAX_HEADER_VALUE) return { error: `请求头 ${name} 的值过长` };
    if (/[\r\n]/.test(value)) return { error: `请求头 ${name} 的值不能包含换行` };
    headers[name] = value;
  }

  return { headers: Object.keys(headers).length ? headers : undefined };
}
