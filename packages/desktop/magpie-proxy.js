"use strict";
/**
 * magpie 本地反代（d.91）：给渲染层一个**带 CORS** 的稳定入口。
 *
 * 为什么需要：
 * - magpie 网关的 Origin 策略默认拒绝「来自网页的跨源请求」；和鸣渲染层是 `app://heming`
 *   （开发态是 http://localhost:517x），直接 fetch `127.0.0.1:3425` 会被 magpie 拒；
 * - 渲染层也不能自己起 HTTP 服务（沙箱 + 安全上下文）。
 *
 * 做法：主进程在 127.0.0.1 上起一个只转发到本机 magpie 的反代：
 * - 只接受本机来源（app://heming / localhost / 127.0.0.1）的跨源请求，其它 Origin 直接 403；
 * - 转发前**去掉 Origin/Referer/Host**（magpie 看到的是本机进程，不是网页）；
 * - 响应补 CORS 头，流式（SSE）直接 pipe，不做缓冲；
 * - 只监听回环，端口随机（渲染层通过 IPC 拿 baseUrl）。
 *
 * 这不是鉴权层：magpie 的网关 Key 仍由渲染层带上并原样转发；反代只解决
 * 「本机回环 + CORS + Origin 策略」这三件事。
 */

const http = require("node:http");

const ALLOWED_ORIGIN_RE = /^(app:\/\/heming|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
/** 不往上游带的请求头：Host 要指向上游；Origin/Referer 是浏览器痕迹。 */
const DROP_REQUEST_HEADERS = new Set(["host", "origin", "referer", "connection", "proxy-connection"]);
/** 上游的 CORS/逐跳头不回给渲染层（由反代自己补）。 */
const DROP_RESPONSE_HEADERS = new Set([
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-allow-credentials",
  "connection",
  "transfer-encoding",
]);

function originAllowed(origin) {
  if (!origin) return true; // 非浏览器调用（本机进程）没有 Origin
  return ALLOWED_ORIGIN_RE.test(String(origin));
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, accept, x-requested-with, mcp-protocol-version, mcp-session-id",
    "access-control-expose-headers": "content-type, x-plugin-sha256",
    vary: "origin",
  };
}

function filterRequestHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (DROP_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    if (value === undefined) continue;
    out[name] = value;
  }
  return out;
}

/**
 * 启动反代；返回 `{ port, close }`。
 *
 * @param {{ upstreamPort?: number, upstreamHost?: string, log?: (line: string) => void }} opts
 */
function startMagpieProxy(opts = {}) {
  const upstreamPort = opts.upstreamPort ?? 3425;
  const upstreamHost = opts.upstreamHost ?? "127.0.0.1";
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      res.writeHead(403, { "content-type": "application/json", ...corsHeaders(null) });
      res.end(JSON.stringify({ error: "只接受和鸣本机页面访问 magpie 反代" }));
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(origin));
      res.end();
      return;
    }

    const headers = filterRequestHeaders(req.headers);
    headers.host = `${upstreamHost}:${upstreamPort}`;
    const upstream = http.request(
      { host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers },
      (upstreamRes) => {
        const out = { ...corsHeaders(origin) };
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase()) && value !== undefined) out[name] = value;
        }
        res.writeHead(upstreamRes.statusCode || 502, out);
        // SSE 要立刻把响应头推出去，否则浏览器会等到第一块数据才认为连上。
        res.flushHeaders?.();
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json", ...corsHeaders(origin) });
      }
      res.end(JSON.stringify({ error: `magpie 网关不可用：${err?.message ?? err}` }));
    });
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
    log(`[magpie-proxy] ${req.method} ${req.url}`);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

module.exports = { originAllowed, corsHeaders, filterRequestHeaders, startMagpieProxy };
