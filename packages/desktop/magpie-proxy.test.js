"use strict";
/** magpie 本地反代（d.91）：转发、CORS、Origin 拒绝、请求头清洗、流式。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { originAllowed, filterRequestHeaders, startMagpieProxy } = require("./magpie-proxy");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((done) => server.close(() => done()));
}

function startStubUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === "/v1/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"delta":"a"}\n\n');
        setTimeout(() => {
          res.write('data: {"delta":"b"}\n\n');
          res.end();
        }, 20);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url, method: req.method }));
    });
  });
  return { server, seen };
}

test("Origin 判定：本机页面放行，其它源拒绝，无 Origin 的进程调用放行", () => {
  assert.equal(originAllowed(undefined), true);
  assert.equal(originAllowed("app://heming"), true);
  assert.equal(originAllowed("http://localhost:5173"), true);
  assert.equal(originAllowed("http://127.0.0.1:5273"), true);
  assert.equal(originAllowed("https://evil.example.com"), false);
  assert.equal(originAllowed("https://localhost.evil.com"), false);
});

test("Origin 判定：widget origin 默认拒绝（fail-closed），未接线不能放行插件", () => {
  assert.equal(originAllowed("widget://heming.pet"), false);
  assert.equal(originAllowed("widget://a"), false);
  // 没接线 = 拒绝；接了但返回 false 也拒绝
  assert.equal(originAllowed("widget://heming.pet", {}), false);
  assert.equal(originAllowed("widget://heming.pet", { isWidgetOriginAllowed: () => false }), false);
  // 判定函数抛错也按拒绝处理（不能因为一个坏插件把整条策略带崩）
  assert.equal(originAllowed("widget://heming.pet", { isWidgetOriginAllowed: () => { throw new Error("x"); } }), false);
});

test("Origin 判定：已安装且启用的 widget 才放行（由主进程注入判定）", () => {
  const allowed = { isWidgetOriginAllowed: (origin) => origin === "widget://heming.pet" };
  assert.equal(originAllowed("widget://heming.pet", allowed), true);
  assert.equal(originAllowed("widget://other.plugin", allowed), false);
  // 形状不对的 origin 根本不会问判定函数（防绕过：带路径/大写/穿越都不算 origin）
  let asked = 0;
  const spy = { isWidgetOriginAllowed: () => { asked += 1; return true; } };
  assert.equal(originAllowed("widget://a/b", spy), false);
  assert.equal(originAllowed("widget://HEMING.pet", spy), false);
  assert.equal(originAllowed("widget://../etc", spy), false);
  assert.equal(originAllowed("widget://heming.pet:8080", spy), false);
  assert.equal(asked, 0);
  // app:// 主窗不受 widget 判定影响
  assert.equal(originAllowed("app://heming", allowed), true);
});

test("请求头清洗：去掉 Host/Origin/Referer，其它原样转发", () => {
  const headers = filterRequestHeaders({
    host: "127.0.0.1:9999",
    origin: "app://heming",
    referer: "app://heming/",
    authorization: "Bearer magpie-heming",
    "content-type": "application/json",
  });
  assert.equal(headers.host, undefined);
  assert.equal(headers.origin, undefined);
  assert.equal(headers.referer, undefined);
  assert.equal(headers.authorization, "Bearer magpie-heming");
  assert.equal(headers["content-type"], "application/json");
});

test("反代转发 GET：补 CORS、清洗请求头、路径与查询原样", async () => {
  const { server: upstream, seen } = startStubUpstream();
  const upstreamPort = await listen(upstream);
  const proxy = await startMagpieProxy({ upstreamPort, log: () => {} });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/models?format=text`, {
      headers: { origin: "app://heming", authorization: "Bearer magpie-heming" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "app://heming");
    const body = await response.json();
    assert.equal(body.path, "/v1/models?format=text");
    // 上游看到的是本机进程，不是网页
    const last = seen[seen.length - 1];
    assert.equal(last.headers.origin, undefined);
    assert.equal(last.headers.referer, undefined);
    assert.equal(last.headers.authorization, "Bearer magpie-heming");
    assert.match(last.headers.host, /^127\.0\.0\.1:/);
  } finally {
    await proxy.close();
    await close(upstream);
  }
});

test("反代转发 POST body", async () => {
  const { server: upstream, seen } = startStubUpstream();
  const upstreamPort = await listen(upstream);
  const proxy = await startMagpieProxy({ upstreamPort });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { origin: "http://localhost:5273", "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek/deepseek-chat", stream: true }),
    });
    assert.equal(response.status, 200);
    const last = seen[seen.length - 1];
    assert.equal(last.method, "POST");
    assert.equal(JSON.parse(last.body).stream, true);
  } finally {
    await proxy.close();
    await close(upstream);
  }
});

test("非本机来源 403；OPTIONS 预检 204 且带 CORS", async () => {
  const { server: upstream } = startStubUpstream();
  const upstreamPort = await listen(upstream);
  const proxy = await startMagpieProxy({ upstreamPort });
  try {
    const denied = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`, {
      headers: { origin: "https://evil.example.com" },
    });
    assert.equal(denied.status, 403);

    const preflight = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "OPTIONS",
      headers: { origin: "app://heming", "access-control-request-method": "POST" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "app://heming");
    assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
  } finally {
    await proxy.close();
    await close(upstream);
  }
});

test("上游不可用：502 且说明是 magpie 网关不可用", async () => {
  const proxy = await startMagpieProxy({ upstreamPort: 1 });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`, {
      headers: { origin: "app://heming" },
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error, /magpie 网关不可用/);
  } finally {
    await proxy.close();
  }
});

test("流式（SSE）逐块转发，不缓冲整段", async () => {
  const { server: upstream } = startStubUpstream();
  const upstreamPort = await listen(upstream);
  const proxy = await startMagpieProxy({ upstreamPort });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/stream`, {
      headers: { origin: "app://heming" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /"a"/);
    assert.match(text, /"b"/);
  } finally {
    await proxy.close();
    await close(upstream);
  }
});

test("HTTP：widget origin 未放行 403，已装插件放行后 200（对话链的关键闸）", async () => {
  const { server: upstream } = startStubUpstream();
  const upstreamPort = await listen(upstream);
  const denied = await startMagpieProxy({ upstreamPort });
  const allowed = await startMagpieProxy({
    upstreamPort,
    isWidgetOriginAllowed: (origin) => origin === "widget://heming.pet",
  });
  try {
    const blocked = await fetch(`http://127.0.0.1:${denied.port}/v1/models`, {
      headers: { origin: "widget://heming.pet" },
    });
    assert.equal(blocked.status, 403);

    const models = await fetch(`http://127.0.0.1:${allowed.port}/v1/models`, {
      headers: { origin: "widget://heming.pet" },
    });
    assert.equal(models.status, 200);
    assert.equal(models.headers.get("access-control-allow-origin"), "widget://heming.pet");

    const chat = await fetch(`http://127.0.0.1:${allowed.port}/v1/chat/completions`, {
      method: "POST",
      headers: { origin: "widget://heming.pet", "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek/deepseek-chat" }),
    });
    assert.equal(chat.status, 200);

    // 别的插件 origin 仍被拒（不放通配）
    const other = await fetch(`http://127.0.0.1:${allowed.port}/v1/models`, {
      headers: { origin: "widget://other.plugin" },
    });
    assert.equal(other.status, 403);
  } finally {
    await denied.close();
    await allowed.close();
    await close(upstream);
  }
});
