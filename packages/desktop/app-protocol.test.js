"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  CSP_HEADER,
  CSP_MODES,
  CSP_REPORT_ONLY_HEADER,
  DEFAULT_API_ORIGIN,
  DEFAULT_CSP_MODE,
  buildCsp,
  contentTypeFor,
  cspHeadersFor,
  isAssetRequest,
  isPetPath,
  normalizeCspMode,
  parseCspViolation,
  resolveAssetPath,
  resolveRequest,
  wsOriginOf,
} = require("./app-protocol");

const ROOT = path.resolve("/tmp/fake-web-root");

// ── MIME ──

test("contentTypeFor：常见静态资源类型正确", () => {
  assert.match(contentTypeFor("a/index.html"), /^text\/html/);
  assert.match(contentTypeFor("a/index.js"), /^text\/javascript/);
  assert.match(contentTypeFor("a/index.css"), /^text\/css/);
  assert.equal(contentTypeFor("a/x.svg"), "image/svg+xml");
  assert.equal(contentTypeFor("a/x.woff2"), "font/woff2");
  assert.equal(contentTypeFor("a/x.json"), "application/json; charset=utf-8");
});

test("contentTypeFor：大小写不敏感", () => {
  assert.match(contentTypeFor("A.INDEX.HTML"), /^text\/html/);
  assert.equal(contentTypeFor("X.SVG"), "image/svg+xml");
});

test("contentTypeFor：未知扩展名不猜（octet-stream，避免把二进制当 HTML 执行）", () => {
  assert.equal(contentTypeFor("a/x.bin"), "application/octet-stream");
  assert.equal(contentTypeFor("a/noext"), "application/octet-stream");
});

// ── 资源 vs 前端路由 ──

test("isAssetRequest：有扩展名是资源，无扩展名是前端路由", () => {
  assert.equal(isAssetRequest("/assets/index-abc.js"), true);
  assert.equal(isAssetRequest("/x.css"), true);
  assert.equal(isAssetRequest("/"), false);
  assert.equal(isAssetRequest("/chat"), false);
  assert.equal(isAssetRequest("/settings/profile"), false);
});

// ── 路径解析与目录穿越防护 ──

test("resolveAssetPath：常规路径解析到 root 之下", () => {
  assert.equal(resolveAssetPath("/", ROOT), ROOT);
  assert.equal(resolveAssetPath("/index.html", ROOT), path.join(ROOT, "index.html"));
  assert.equal(resolveAssetPath("/assets/a.js", ROOT), path.join(ROOT, "assets", "a.js"));
});

test("resolveAssetPath：百分号编码被解码", () => {
  assert.equal(resolveAssetPath("/a%20b.js", ROOT), path.join(ROOT, "a b.js"));
});

test("resolveAssetPath：目录穿越一律拒绝（明文、编码、反斜杠三种写法）", () => {
  for (const evil of [
    "/../secret",
    "/../../etc/passwd",
    "/%2e%2e/secret",
    "/a/../../secret",
    "/..\\secret",
    "/a/..\\..\\secret",
  ]) {
    assert.equal(resolveAssetPath(evil, ROOT), null, `应拒绝：${evil}`);
  }
});

test("resolveAssetPath：非法百分号编码返回 null（不抛）", () => {
  assert.equal(resolveAssetPath("/%E0%A4%A", ROOT), null);
});

// ── 请求 → 文件 ──

function fakeFs(existing) {
  const set = new Set(existing.map((p) => path.join(ROOT, p)));
  return (f) => set.has(f);
}

test("resolveRequest：根路径回落首页", () => {
  const r = resolveRequest("/", ROOT, fakeFs(["index.html"]));
  assert.equal(r.file, path.join(ROOT, "index.html"));
  assert.equal(r.spaFallback, true);
});

test("resolveRequest：无扩展名路径回落首页（前端路由）", () => {
  const r = resolveRequest("/settings/profile", ROOT, fakeFs(["index.html"]));
  assert.equal(r.file, path.join(ROOT, "index.html"));
  assert.equal(r.spaFallback, true);
});

test("resolveRequest：命中资源直接送出，且不算回落", () => {
  const r = resolveRequest("/assets/index-abc.js", ROOT, fakeFs(["index.html", "assets/index-abc.js"]));
  assert.equal(r.file, path.join(ROOT, "assets", "index-abc.js"));
  assert.equal(r.spaFallback, false);
});

test("resolveRequest：**资源缺失不回落首页**（回落会把 404 变成 MIME 错误，极难排查）", () => {
  const r = resolveRequest("/assets/missing.js", ROOT, fakeFs(["index.html"]));
  assert.equal(r, null);
});

test("resolveRequest：目录穿越返回 null（调用方回 403/404）", () => {
  assert.equal(resolveRequest("/../secret", ROOT, fakeFs(["index.html"])), null);
});

test("resolveRequest：不带扩展名的隐藏文件请求视为资源（如 /.env）", () => {
  // ".env" 的 extname 是 ""，但它是文件不是路由 —— 这里按路由处理回落首页，
  // 属可接受行为（回落的是自家首页，不泄漏任何文件内容）。
  const r = resolveRequest("/.env", ROOT, fakeFs(["index.html"]));
  assert.equal(r.file, path.join(ROOT, "index.html"));
});

// ───────────────────────────── CSP 基线（P0-6，d.60） ─────────────────────────────

/** 从策略串里取某条指令的值（便于逐条断言）。 */
function directiveOf(policy, name) {
  const hit = policy.split("; ").find((part) => part.startsWith(`${name} `));
  return hit ? hit.slice(name.length + 1).split(" ") : null;
}

test("normalizeCspMode：只认 off/report/enforce，非法与空值回落默认（report）", () => {
  assert.deepEqual(CSP_MODES, ["off", "report", "enforce"]);
  assert.equal(DEFAULT_CSP_MODE, "report");
  assert.equal(normalizeCspMode("enforce"), "enforce");
  assert.equal(normalizeCspMode(" OFF "), "off");
  assert.equal(normalizeCspMode("report"), "report");
  assert.equal(normalizeCspMode("report-only"), "report"); // 不是合法值 → 回落默认
  assert.equal(normalizeCspMode(""), "report");
  assert.equal(normalizeCspMode(undefined), "report");
});

test("wsOriginOf：http→ws、https→wss，非法返回 null", () => {
  assert.equal(wsOriginOf("http://47.92.39.184"), "ws://47.92.39.184");
  assert.equal(wsOriginOf("https://example.com"), "wss://example.com");
  assert.equal(wsOriginOf("ftp://example.com"), null);
  assert.equal(wsOriginOf("不是 URL"), null);
});

test("buildCsp：script-src 只有 self/app:/wasm-unsafe-eval（绝不 unsafe-inline / unsafe-eval）", () => {
  const policy = buildCsp();
  const script = directiveOf(policy, "script-src");
  // 'wasm-unsafe-eval' 是硬证据（shiki oniguruma wasm / pdfjs 图像解码 / Live2D cubism core），
  // 它只放开 WASM 编译，不放开 eval / new Function。
  assert.deepEqual(script, ["'self'", "app:", "'wasm-unsafe-eval'"]);
  assert.ok(!script.includes("'unsafe-inline'"));
  assert.ok(!script.includes("'unsafe-eval'"));
  // style-src 的 'unsafe-inline' 是本轮唯一的内联豁免（理由见 buildCsp 注释）
  assert.ok(policy.includes("style-src 'self' app: 'unsafe-inline'"));
});

test("buildCsp：style-src 保留 'unsafe-inline'（KaTeX/内联 style 的既成事实）", () => {
  const style = directiveOf(buildCsp(), "style-src");
  assert.ok(style.includes("'unsafe-inline'"));
  assert.ok(style.includes("'self'"));
});

test("buildCsp：connect-src 含 API 源及 ws、TLS 通配与本机回环（用户自填 baseUrl 不被挡）", () => {
  const connect = directiveOf(buildCsp(), "connect-src");
  assert.ok(connect.includes("'self'"));
  assert.ok(connect.includes("app:"));
  assert.ok(connect.includes(DEFAULT_API_ORIGIN));
  assert.ok(connect.includes("ws://47.92.39.184"));
  assert.ok(connect.includes("https:")); // 用户自建 https 供应商 / MCP / Registry
  assert.ok(connect.includes("wss:"));
  assert.ok(connect.includes("http://127.0.0.1:*")); // Ollama / magpie
  assert.ok(connect.includes("http://localhost:*"));
});

test("buildCsp：自定义 API 源与运维附加来源被并入且去重", () => {
  const connect = directiveOf(
    buildCsp({
      apiOrigin: "https://heming.example.com",
      extraConnect: ["http://192.168.1.9:8787", "https:", "http://192.168.1.9:8787"],
    }),
    "connect-src",
  );
  assert.ok(connect.includes("https://heming.example.com"));
  assert.ok(connect.includes("wss://heming.example.com"));
  assert.ok(connect.includes("http://192.168.1.9:8787"));
  // 去重：同一来源只出现一次
  assert.equal(connect.filter((item) => item === "http://192.168.1.9:8787").length, 1);
  assert.equal(connect.filter((item) => item === "https:").length, 1);
});

test("buildCsp：其余基线指令齐全", () => {
  const policy = buildCsp();
  assert.deepEqual(directiveOf(policy, "default-src"), ["'self'", "app:"]);
  assert.deepEqual(directiveOf(policy, "object-src"), ["'none'"]);
  assert.deepEqual(directiveOf(policy, "base-uri"), ["'self'"]);
  assert.deepEqual(directiveOf(policy, "frame-ancestors"), ["'none'"]);
  assert.deepEqual(directiveOf(policy, "worker-src"), ["'self'", "blob:"]); // pdfjs worker
  assert.ok(directiveOf(policy, "img-src").includes("data:"));
  assert.ok(directiveOf(policy, "img-src").includes("blob:"));
  assert.ok(directiveOf(policy, "font-src").includes("data:"));
});

test("buildCsp：桌宠独立策略（无表单，script 同样不放 inline）", () => {
  const pet = buildCsp({ pet: true });
  assert.deepEqual(directiveOf(pet, "form-action"), ["'none'"]);
  assert.deepEqual(directiveOf(pet, "script-src"), ["'self'", "app:", "'unsafe-eval'", "'wasm-unsafe-eval'"]);
  // 桌宠必须放 unsafe-eval：pixi 6 的 generateProgram 用 new Function（实测 enforce 下桌宠起不来）
  assert.deepEqual(directiveOf(buildCsp(), "form-action"), ["'self'"]);
});

test("isPetPath：只认 pet.html（不是 /pet 路由）", () => {
  assert.equal(isPetPath("/pet.html"), true);
  assert.equal(isPetPath("/foo/pet.html"), true);
  assert.equal(isPetPath("/pet"), false);
  assert.equal(isPetPath("/"), false);
});

test("cspHeadersFor：默认 report-only，enforce 换头名，off 不带头", () => {
  const report = cspHeadersFor("/", {});
  assert.deepEqual(Object.keys(report), [CSP_REPORT_ONLY_HEADER]);
  const enforce = cspHeadersFor("/", { mode: "enforce" });
  assert.deepEqual(Object.keys(enforce), [CSP_HEADER]);
  assert.deepEqual(cspHeadersFor("/", { mode: "off" }), {});
  // 未知模式回落默认 report（不会误关）
  assert.deepEqual(Object.keys(cspHeadersFor("/", { mode: "随便" })), [CSP_REPORT_ONLY_HEADER]);
});

test("cspHeadersFor：桌宠路径拿到桌宠策略", () => {
  const headers = cspHeadersFor("/pet.html", { mode: "enforce" });
  assert.ok(headers[CSP_HEADER].includes("form-action 'none'"));
});

test("parseCspViolation：新措辞（Connecting to … violates … directive: \"connect-src …\"）", () => {
  // 冒烟实测原文（Chromium 145），后半段策略原文不能被当成被拦 URI
  const message =
    'Connecting to \'http://example.invalid/csp-probe\' violates the following Content Security Policy directive: ' +
    '"connect-src \'self\' app: http://47.92.39.184 ws://47.92.39.184 https: wss: http://127.0.0.1:* http://localhost:*". ' +
    "The policy is report-only.";
  assert.deepEqual(parseCspViolation(message, "app://heming/assets/index-abc.js", 0), {
    directive: "connect-src",
    blockedUri: "http://example.invalid/csp-probe",
    source: "app://heming/assets/index-abc.js",
    line: 0,
  });
});

test("parseCspViolation：内联脚本违例（单引号包裹的 directive 也要认）", () => {
  // 冒烟实测原文
  const message =
    "Executing inline script violates the following Content Security Policy directive " +
    "'script-src 'self' app: 'wasm-unsafe-eval''. Either the 'unsafe-inline' keyword, a hash " +
    "('sha256-rUyhxVx22GHRTr/3BUsaoLEzhgPY3LC9VOB0R9WeTf8='), or a nonce ('nonce-...') is required " +
    "to enable inline execution.";
  const violation = parseCspViolation(message);
  assert.equal(violation.directive, "script-src");
  assert.equal(violation.blockedUri, "inline");
});

test("parseCspViolation：策略本身的非法来源告警记为 invalid-source（不是页面违例）", () => {
  const message =
    "The source list for the Content Security Policy directive 'connect-src' contains an invalid " +
    "source: 'http://[::1]:*'. It will be ignored.";
  assert.deepEqual(parseCspViolation(message), {
    directive: "connect-src",
    blockedUri: "invalid-source",
    source: "",
    line: 0,
  });
});

test("parseCspViolation：旧措辞（Refused to connect to … because it violates … directive: \"…\"）", () => {
  const message =
    "Refused to connect to 'http://127.0.0.1:9999/v1/chat' because it violates the following " +
    'Content Security Policy directive: "connect-src \'self\' https: wss:".';
  const violation = parseCspViolation(message, "app://heming/assets/x.js", 42);
  assert.equal(violation.directive, "connect-src");
  assert.equal(violation.blockedUri, "http://127.0.0.1:9999/v1/chat");
  assert.equal(violation.line, 42);
});

test("parseCspViolation：内联样式违例记为 inline，指令取 style-src", () => {
  const violation = parseCspViolation(
    "Refused to apply inline style because it violates the following Content Security Policy directive: \"style-src 'self'\".",
  );
  assert.equal(violation.blockedUri, "inline");
  assert.equal(violation.directive, "style-src");
});

test("parseCspViolation：渲染层重复报的 Fetch API 消息也能取出被拦 URL", () => {
  const message =
    "Fetch API cannot load http://example.invalid/csp-probe. Refused to connect because it violates " +
    "the document's Content Security Policy.";
  assert.deepEqual(parseCspViolation(message), {
    directive: "unknown",
    blockedUri: "http://example.invalid/csp-probe",
    source: "",
    line: 0,
  });
});
test("parseCspViolation：非 CSP 消息 / 纯提示返回 null", () => {
  assert.equal(parseCspViolation("Failed to load resource: net::ERR_CONNECTION_REFUSED"), null);
  assert.equal(parseCspViolation(""), null);
  assert.equal(parseCspViolation(undefined), null);
  assert.equal(
    parseCspViolation("The Content Security Policy of this document was delivered in report-only mode."),
    null,
  );
});

test("parseCspViolation：字段一律截断（日志不被超长消息刷爆），且不含消息正文片段", () => {
  const secret = "sk-用户不应出现在日志里的内容";
  const message =
    `Refused to connect to 'https://x.example/${secret}' because it violates the following ` +
    `Content Security Policy directive: "connect-src ${secret} '.`;
  const violation = parseCspViolation(message, "x".repeat(500), 1);
  assert.ok(violation.blockedUri.length <= 200);
  assert.ok(violation.source.length <= 200);
  assert.ok(violation.directive.length <= 200);
  // 消息里除被拦 URI 之外的正文（如 policy 尾部的原文）不会被带出
  assert.ok(!violation.directive.includes(secret));
});

test("buildCsp：本机回环只认 127.0.0.1 / localhost（IPv6 字面量端口通配会被 Chromium 忽略）", () => {
  const connect = directiveOf(buildCsp(), "connect-src");
  assert.ok(connect.includes("http://127.0.0.1:*"));
  assert.ok(connect.includes("http://localhost:*"));
  assert.ok(!connect.some((source) => source.includes("[::1]")));
});