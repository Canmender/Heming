/**
 * 用户可见外链的协议白名单（d.111 审计 P1-4：可点击 XSS）。
 *
 * 为什么需要：React 19 只对 `form action` 做 `sanitizeURL`，**不会**拦
 * `<a href="javascript:…">`；而社区/市场索引里的 `homepage`、`repository`
 * 是第三方数据，发布者可任意填写。直接 `href={x}` 渲染等于把 `javascript:`
 * 交给用户点。
 *
 * 规则：trim 后非空、≤500 字符、`new URL` 可解析、协议仅 `http`/`https`；
 * 其余（`javascript:`/`data:`/`file:`/相对路径/非法/超长）一律 null，调用方
 * 应当**不渲染链接**（而不是渲染成文字链接，避免诱导点击）。
 */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * 图片地址白名单：`https:` 或 `data:image/…`（本地图标不允许 http 明文、禁止
 * `javascript:`/`file:`）。空/非法返回 null，调用方回落到默认占位。
 */
export function safeImageUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (/^data:image\/(png|jpeg|webp|svg\+xml);base64,/i.test(value)) {
    // 内联图限制在 48KB 字符（与清单 icon 上限一致），避免超长 data URL 拖慢渲染
    return value.length <= 48_000 ? value : null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}
