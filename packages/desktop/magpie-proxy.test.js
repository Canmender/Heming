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
