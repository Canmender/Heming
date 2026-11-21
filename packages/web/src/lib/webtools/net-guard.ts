/**
 * 联网工具的地址守卫（d.150.4.95.11）。
 *
 * web_read 让模型读「任意 http(s) 链接」，但本机不应该因此变成内网探测器：
 * 渲染层发请求走的是桌面主进程代发桥（http-bridge），它能访问本机与局域网，
 * 所以「只读公开网页」这条边界必须在这里自己收——只允许公网 http/https，
 * 拒绝回环、私网、链路本地、CGNAT、保留段与常见内网域名。
 *
 * 这里只做**字面量**判断，不做 DNS 解析（渲染层没有 DNS，解析结果也可能被 DNS rebinding 换掉）；
 * 对十进制/十六进制/单段数字 IP 一律拒绝——`http://2130706433/` 就是 127.0.0.1。
 * 这是纵深防御的一层，不替代主进程桥本身的超时、方法白名单与响应体上限。
 */

import { domainAllowed, describeNetPolicy, type NetPolicy } from "./netPolicy.js";

export type HttpUrlVerdict = { ok: true; url: URL } | { ok: false; error: string };

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** 常见内网/保留后缀（小写比较，`endsWith` 语义）。 */
const PRIVATE_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home.arpa",
  ".corp",
  ".private",
];

/** 明确指向本机的单段名字。 */
const PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "localhost.",
  "intranet",
  "internal",
  "metadata",
  "metadata.google.internal",
]);

function ipv4ToBytes(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function isPrivateIpv4(bytes: number[]): boolean {
  const [a, b, c] = bytes;
  if (a === 0) return true; // 0.0.0.0/8「本网络」
  if (a === 10) return true; // 10/8 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // 回环
  if (a === 169 && b === 254) return true; // 链路本地（含云厂商 metadata）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 私网
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 协议保留
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168/16 私网
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 基准测试
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 组播 + 保留 + 广播
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "::" || host === "::1") return true;
  if (host.startsWith("::ffff:")) {
    // IPv4 映射地址：::ffff:127.0.0.1
    const mapped = host.slice("::ffff:".length);
    const bytes = ipv4ToBytes(mapped);
    if (bytes) return isPrivateIpv4(bytes);
    return true;
  }
  if (/^(fc|fd)/.test(host)) return true; // fc00::/7 唯一本地地址
  if (/^fe[89ab]/.test(host)) return true; // fe80::/10 链路本地
  if (host.startsWith("ff")) return true; // ff00::/8 组播
  if (host.startsWith("2001:db8")) return true; // 文档示例段
  return false;
}

/** 主机名是否指向本机/内网（只看字面量，不做 DNS）。 */
export function isPrivateHostname(rawHostname: string): boolean {
  const hostname = rawHostname.trim().toLowerCase();
  if (!hostname) return true;
  const bare = hostname.replace(/\.$/, "");
  if (PRIVATE_HOSTNAMES.has(bare) || PRIVATE_HOSTNAMES.has(hostname)) return true;
  // 后缀也要按去掉结尾点的裸主机名判：绝对 FQDN（`foo.local.`）与 `foo.local`
  // 解析到同一主机，若只查 hostname 就会放行 `http://foo.local.` 绕过内网拦截。
  if (PRIVATE_SUFFIXES.some((suffix) => bare.endsWith(suffix))) return true;

  // 单段数字 / 0x 十六进制：浏览器会把它当 IPv4 解析，直接拒绝
  if (/^\d+$/.test(bare)) return true;
  if (/^0x[0-9a-f]+$/.test(bare)) return true;

  if (bare.includes(":")) return isPrivateIpv6(bare);

  const bytes = ipv4ToBytes(bare);
  if (bytes) return isPrivateIpv4(bytes);
  return false;
}

/**
 * 校验一个可以安全交给桌面代发桥的公开 http(s) 地址。
 * 失败时 error 是给模型看的中文原因（不抛错）。
 */
export function checkPublicHttpUrl(raw: string, opts: { policy?: NetPolicy } = {}): HttpUrlVerdict {
  const input = String(raw ?? "").trim();
  if (!input) return { ok: false, error: "地址为空" };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: "不是合法的网址（需要 http:// 或 https:// 开头）" };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, error: `只支持 http/https，收到 ${url.protocol.replace(":", "")}` };
  }
  if (url.username || url.password) {
    return { ok: false, error: "网址里不能带账号密码" };
  }
  if (isPrivateHostname(url.hostname)) {
    return {
      ok: false,
      error: "不能访问本机或内网地址（只允许公开网页）",
    };
  }
  /*
   * 域名策略（d.238）：内网检查之后再问「这个域名在用户的允许列表里吗」。
   * 顺序有意为之——先报「本机/内网不能读」（这是绝对边界，改设置也放不开），
   * 再报「不在允许列表」（这是用户自己设的、可以改），避免用户以为改设置就能读内网。
   */
  if (opts.policy && !domainAllowed(opts.policy, url.hostname)) {
    return {
      ok: false,
      error: `这个域名不在允许列表里：${url.hostname}。${describeNetPolicy(opts.policy)}。要放行就去「设置 → 网络访问」把它加进列表，或把模式改回「开放」`,
    };
  }
  return { ok: true, url };
}
