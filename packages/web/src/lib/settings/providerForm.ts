/**
 * 来源表单的纯函数（d.138）：Key 格式检查、地址规范化、可达性结论。
 *
 * 为什么单独放 lib：ModelPage 只负责接线，校验规则要能被单测钉住。
 * 原则是「能自动补的自动补，不能确定只提醒」——Key 长度可疑只给 warning
 *（各厂商格式差异大，硬拦会把合法 Key 挡在门外），只有明确错位才报 error。
 */

export interface KeyCheck {
  /** 明确错用（地址当 Key、带 Bearer 前缀等）：报错并阻止保存。 */
  error: string | null;
  /** 可疑但可能是合法格式：只提示，不阻止保存。 */
  warning: string | null;
}

const URL_LIKE = /^(?:https?|ftp):\/\//i;
const AUTH_PREFIX = /^(?:bearer|authorization)\b/i;

/** 检查粘贴进来的 Key：去空白后再判断，避免把首尾空格当成格式错误。 */
export function checkApiKey(raw: string): KeyCheck {
  const value = raw.trim();
  if (!value) return { error: "请先粘贴 API Key。", warning: null };
  if (AUTH_PREFIX.test(value)) {
    return { error: "只粘贴 Key 本身，不要带「Bearer」或「Authorization」前缀。", warning: null };
  }
  if (/\s/.test(value)) {
    return { error: "Key 里混进了空格或换行，只粘贴 Key 本身。", warning: null };
  }
  if (URL_LIKE.test(value)) {
    return { error: "这看起来是接口地址，不是 Key；地址请填到上方的地址栏。", warning: null };
  }
  if (value.length < 8) {
    return { error: null, warning: "Key 比较短，确认是否只复制了一部分。" };
  }
  return { error: null, warning: null };
}

export interface UrlCheck {
  /** 规范化后的地址（去掉尾部斜杠、补全 scheme）。 */
  url: string;
  /** 不能自动修的错误。 */
  error: string | null;
  /** 「帮你做了什么」的说明，只提示不阻止保存。 */
  hint: string | null;
}

/** 本机/局域网地址默认走 http，其余补 https。 */
const LOCAL_HOST =
  /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])$/i;

/**
 * 规范化用户填的接口地址：
 * - 没写 scheme 时按主机名补（本机/局域网 → http，其余 → https）；
 * - 去尾部斜杠；
 * - 误填到 /chat/completions 时提示只填到 /v1（不擅自截断，避免猜错路径）。
 */
export function normalizeProviderUrl(raw: string): UrlCheck {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { url: "", error: "请填写接口地址，例如 https://api.deepseek.com/v1。", hint: null };
  }

  let candidate = trimmed;
  let addedScheme = false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const host = candidate.split("/")[0]?.replace(/:\d+$/, "") ?? "";
    candidate = `${LOCAL_HOST.test(host) ? "http" : "https"}://${candidate}`;
    addedScheme = true;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { url: candidate, error: "地址格式不对：检查是否少了域名，或中间夹了空格。", hint: null };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { url: candidate, error: "只支持 http / https 地址。", hint: null };
  }
  if (!parsed.hostname) {
    return { url: candidate, error: "地址里没有主机名，例如 https://api.deepseek.com/v1。", hint: null };
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  const url = `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;

  if (/\/chat\/completions$/i.test(path)) {
    return {
      url,
      error: null,
      hint: "只填到 /v1 就够了；/chat/completions 和鸣会自己拼。",
    };
  }
  if (addedScheme) {
    return {
      url,
      error: null,
      hint: `没写 http(s)，已按${parsed.protocol === "http:" ? "本机" : "公网"}规则补成 ${parsed.protocol}//。`,
    };
  }
  return { url, error: null, hint: null };
}

/** 把 `provider test` 的结果压成一句人话（成功/失败都不糊）。 */
export function providerTestVerdict(
  ok: boolean,
  text: string | null | undefined,
): string {
  const detail = (text ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const tail = detail.length > 140 ? `${detail.slice(0, 140)}…` : detail;
  if (ok) return tail ? `连通正常：${tail}` : "连通正常，模型已读入。";
  return tail ? `连不上：${tail}` : "连不上：没有输出，检查地址与 Key 是否匹配。";
}