#!/usr/bin/env node
/**
 * 设计门禁（运行时版）。把 docs/DESIGN-AUDIT-2026-11-14.md §7.4 的验收指标做成可执行检查。
 *
 * 为什么要它：2026-11-13 那轮审计修掉的 S1（对比度、按钮收口、空态、动效口径）在两个月里
 * 又慢慢长回来了 —— 因为「口径」只写在文档里，没有一条会红的检查。静态口径（字号字面量、
 * font-bold、手写 kbd）已经由 packages/web/src/lib/designScales.test.ts 守住；这里补的是
 * 只能在实际渲染后才知道的部分：字号分布、对比度、有效命中区、横向溢出、标题层级。
 *
 * 用法：
 *   node scripts/design-audit.mjs                 # 自己起 server + web + headless Chrome，跑完清理
 *   node scripts/design-audit.mjs --base http://localhost:5175   # 复用已在跑的前端（不启服务）
 *   node scripts/design-audit.mjs --json out.json --shots .tmp/shots
 *   node scripts/design-audit.mjs --theme dark    # 深色巡检（默认浅色）
 *
 * 需要：packages/server/dist 已构建（pnpm build）、本机装了 Chrome、Node ≥ 22（用到全局 WebSocket）。
 * 退出码 0 = 全部门槛通过，1 = 有指标越界（CI 里直接红）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = arg("base");
const THEME = arg("theme", "light");
const JSON_OUT = arg("json");
const SHOTS = arg("shots");
const SERVER_PORT = Number(arg("server-port", "8789"));
const WEB_PORT = Number(arg("web-port", "5177"));
const CDP_PORT = Number(arg("cdp-port", "9334"));
const USER = "design";
const PASS = "design1234";

// ---------- 门槛（§7.4） ----------
// 每页独立判定；数字都是「越小越好」，0 表示不允许出现。
const THRESHOLDS = {
  docOverflowX: 0, // 页面不得有横向溢出（B2 的老问题）
  contrastFail: 0, // 低于 WCAG AA 的文本节点数
  body11: 0, // 11px 且文本 >12 字的「正文冒充元信息」节点
  hitUnder32: 0, // 有效命中区（含 ::after）小于 32×32 的可点元素
  emoji: 0, // 用 emoji 当图标/装饰
  fontTiers: 7, // 单页字号档位上限（现网 5–7，收口目标 5）
  headingLevels: 2, // 至少两级标题（h1 + h2/h3，级别不限字号；字号由静态守卫管）
};

const PAGES = [
  ["主页", "home"],
  ["团队", "team"],
  ["智能体", "chat"],
  ["插件", "plugins"],
  ["记忆", "memory"],
  ["知识库", "vault"],
  ["模型", "model"],
  ["设置", "settings"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------- 极简 CDP 客户端（Node ≥22 的全局 WebSocket，不引依赖） ----------
class CDP {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();

  async connect(wsUrl) {
    this.#ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      this.#ws.addEventListener("open", () => res(), { once: true });
      this.#ws.addEventListener("error", (e) => rej(e), { once: true });
    });
    this.#ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      if (msg.id && this.#pending.has(msg.id)) {
        const { resolve, reject } = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  once(method, timeoutMs = 15000, sessionId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting ${method}`)), timeoutMs);
      const list = this.#listeners.get(method) ?? [];
      const fn = (params, sid) => {
        if (sessionId && sid !== sessionId) return;
        clearTimeout(timer);
        this.#listeners.set(method, (this.#listeners.get(method) ?? []).filter((x) => x !== fn));
        resolve(params);
      };
      this.#listeners.set(method, [...list, fn]);
    });
  }

  close() {
    try { this.#ws.close(); } catch {}
  }
}

const httpGet = (url) =>
  new Promise((resolve, reject) => {
    import("node:http").then(({ default: http }) => {
      const req = http.get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    });
  });

// 前端首页是 HTML，不是 JSON；这里只要求「能连上且返回 2xx/3xx」。
const httpJson = async (url) => {
  const { status, body } = await httpGet(url);
  if (status >= 400) throw new Error(`HTTP ${status}`);
  try { return JSON.parse(body); } catch { return { ok: true, status }; }
};

async function waitHttp(url, timeoutMs = 40000, label = url) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { return await httpJson(url); } catch (e) { last = e; await sleep(400); }
  }
  throw new Error(`${label} 在 ${timeoutMs}ms 内没有起来：${last?.message ?? ""}`);
}

// ---------- 起服务 / Chrome ----------
const children = [];
function track(child, name) {
  children.push({ child, name });
  child.on("exit", (code, sig) => {
    if (!flag("verbose") && code && code !== 0) log(`[audit] ${name} 退出 code=${code} sig=${sig}`);
  });
  return child;
}

function startServer() {
  const dbDir = path.join(ROOT, ".tmp", "design-audit");
  fs.mkdirSync(dbDir, { recursive: true });
  const db = path.join(dbDir, `gate-${Date.now()}.db`);
  const child = spawn(process.execPath, [path.join(ROOT, "packages/server/dist/index.js")], {
    cwd: path.join(ROOT, "packages/server"),
    env: { ...process.env, PORT: String(SERVER_PORT), HEMING_DB_PATH: db, HEMING_SEED_USERS: `${USER}:${PASS}` },
    stdio: flag("verbose") ? "inherit" : "ignore",
  });
  return track(child, "server");
}

function startWeb() {
  const child = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", String(WEB_PORT), "--strictPort"], {
    cwd: path.join(ROOT, "packages/web"),
    env: {
      ...process.env,
      // vite 的 /api 代理默认指 8787（vite.config.ts:32）；server 换端口时必须显式覆盖，
      // 否则登录页报「服务器暂时不可用」，量测会卡在导航轨上超时。
      HEMING_DEV_API: `http://127.0.0.1:${SERVER_PORT}`,
    },
    stdio: flag("verbose") ? "inherit" : "ignore",
  });
  return track(child, "vite");
}

function startChrome() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const bin = candidates.find((p) => fs.existsSync(p));
  if (!bin) throw new Error("找不到 Chrome，可设 CHROME_PATH 环境变量指向可执行文件");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "heming-audit-"));
  const child = spawn(
    process.env.CHROME_PATH || bin,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  return track(child, "chrome");
}

// ---------- 页面内量测（注入后立即求值；不依赖页面里的任何全局） ----------
function pageAudit() {
  const parseColor = (value) => {
    const m = /^rgba?\(([^)]+)\)$/.exec(value || "");
    if (!m) return null;
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const blend = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const contrast = (a, b) => {
    const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
    return (hi + 0.05) / (lo + 0.05);
  };
  const effectiveBg = (el) => {
    let node = el;
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    const stack = [];
    while (node && node !== document.documentElement) {
      const bg = parseColor(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) stack.push(bg);
      node = node.parentElement;
    }
    while (stack.length) acc = blend(stack.pop(), acc);
    return acc;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };
  const isIconOnly = (el) => {
    const text = (el.innerText || "").trim();
    const hasIcon = !!el.querySelector("svg,img");
    return hasIcon && text.length === 0;
  };

  const main = document.querySelector("main") || document.body;
  const textNodes = [];
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest("script,style,svg")) return NodeFilter.FILTER_REJECT;
      return visible(p) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    const text = n.nodeValue.trim();
    const fg = parseColor(cs.color) || { r: 26, g: 26, b: 26, a: 1 };
    const bg = effectiveBg(el);
    const ratio = contrast(fg.a < 1 ? blend(fg, bg) : fg, bg);
    const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    textNodes.push({
      text: text.slice(0, 60),
      size,
      weight: cs.fontWeight,
      ratio: Math.round(ratio * 100) / 100,
      fail: !large && ratio < 4.5,
    });
  }

  const tierCount = new Map();
  for (const t of textNodes) tierCount.set(t.size, (tierCount.get(t.size) || 0) + 1);
  const fontTiers = [...tierCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([size, count]) => ({ size, count }));

  // 可点元素：可见按钮/链接，命中区 = 自身盒子与 ::after 伪元素取大者
  const clickables = [];
  for (const el of main.querySelectorAll("button, a[href], [role=button], [role=tab], [role=menuitem]")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const after = getComputedStyle(el, "::after");
    let w = r.width;
    let h = r.height;
    if (after && (after.position === "absolute" || after.content !== "none")) {
      const aw = parseFloat(after.width);
      const ah = parseFloat(after.height);
      if (Number.isFinite(aw) && Number.isFinite(ah)) { w = Math.max(w, aw); h = Math.max(h, ah); }
    }
    clickables.push({
      label: (el.getAttribute("aria-label") || el.innerText || "").trim().slice(0, 30),
      w: Math.round(w),
      h: Math.round(h),
      iconOnly: isIconOnly(el),
      hasLabel: !!(el.getAttribute("aria-label") || (el.innerText || "").trim() || el.getAttribute("title")),
    });
  }

  const headings = [...main.querySelectorAll("h1,h2,h3")].filter(visible).map((el) => ({
    level: el.tagName.toLowerCase(),
    size: Math.round(parseFloat(getComputedStyle(el).fontSize)),
    text: (el.innerText || "").trim().slice(0, 30),
  }));

  const emoji = [...main.querySelectorAll("body *")].length >= 0 ? (main.innerText.match(/\p{Extended_Pictographic}/gu) || []).length : 0;

  return {
    docOverflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    fontTiers,
    fontTierCount: fontTiers.length,
    contrastFail: textNodes.filter((t) => t.fail).length,
    contrastWorst: textNodes.slice().sort((a, b) => a.ratio - b.ratio)[0] || null,
    body11: textNodes.filter((t) => t.size <= 11 && t.text.length > 12).length,
    body11Sample: textNodes.filter((t) => t.size <= 11 && t.text.length > 12).slice(0, 4).map((t) => t.text),
    hitUnder32: clickables.filter((c) => c.w < 32 || c.h < 32),
    iconOnlyNoLabel: clickables.filter((c) => c.iconOnly && !c.hasLabel).length,
    clickableCount: clickables.length,
    headings,
    emoji,
    textNodeCount: textNodes.length,
  };
}

// ---------- 流程 ----------
async function ensureLogin(cdp, sid, base) {
  const state = await evalJs(
    cdp,
    sid,
    `(() => {
      if (document.querySelector('nav[aria-label="主导航"]')) return 'logged';
      const inputs = [...document.querySelectorAll('input')];
      return inputs.length >= 2 ? 'login-form' : 'blank';
    })()`,
  );
  if (state === "logged") return;
  await waitFor(cdp, sid, `document.querySelectorAll('input').length >= 2`, 25000, "登录表单");
  await evalJs(
    cdp,
    sid,
    `(async () => {
      const setValue = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const inputs = [...document.querySelectorAll("input")];
      setValue(inputs[0], ${JSON.stringify(USER)});
      setValue(inputs[1], ${JSON.stringify(PASS)});
      const btn = [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "登录");
      if (!btn) return "no-button";
      btn.click();
      return "clicked";
    })()`,
  );
  // 登录成功后还有一次启动波光（≤3s）和首屏渲染：必须等导航轨挂载，否则切页会失败。
  await waitFor(cdp, sid, `!!document.querySelector('nav[aria-label="主导航"]')`, 30000, "导航轨");
  await sleep(900);
}

async function goPage(cdp, sid, label) {
  const clicked = await evalJs(
    cdp,
    sid,
    `(() => {
      const nav = document.querySelector('nav[aria-label="主导航"]');
      if (!nav) return false;
      const btn = [...nav.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!btn) return false;
      btn.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`导航项不存在：${label}`);
  await waitFor(cdp, sid, `(() => { const m = document.querySelector('main'); return !!m && m.innerText.trim().length > 10; })()`, 15000, label);
  await sleep(500);
}

async function setTheme(cdp, sid, theme) {
  await goPage(cdp, sid, "设置");
  await evalJs(
    cdp,
    sid,
    `(() => { const t = [...document.querySelectorAll('[role=tab]')].find((x) => x.innerText.trim() === '外观'); if (t) t.click(); return !!t; })()`,
  );
  await sleep(500);
  const label = theme === "dark" ? "主题模式 深色" : "主题模式 浅色";
  const ok = await evalJs(
    cdp,
    sid,
    `(async () => {
      const b = [...document.querySelectorAll('button[aria-label]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!b) return "no-button";
      b.click();
      await new Promise((r) => setTimeout(r, 700));
      return document.documentElement.dataset.theme || "unset";
    })()`,
  );
  return ok;
}

async function evalJs(cdp, sid, expression) {
  const { result, exceptionDetails } = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    sid,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.text || "evaluate failed");
  return result.value;
}

async function waitFor(cdp, sid, expression, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJs(cdp, sid, expression)) return true;
    } catch {}
    await sleep(250);
  }
  throw new Error(`等待「${label}」超时`);
}

async function shoot(cdp, sid, file) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
}

async function run() {
  let webBase = BASE;
  if (!webBase) {
    log(`[audit] 构建检查：packages/server/dist 存在=${fs.existsSync(path.join(ROOT, "packages/server/dist/index.js"))}`);
    if (!fs.existsSync(path.join(ROOT, "packages/server/dist/index.js"))) {
      throw new Error("没有 packages/server/dist，先跑 pnpm build（或 pnpm --filter @heming/server build）");
    }
    log("[audit] 启动 server + vite …");
    startServer();
    startWeb();
    await waitHttp(`http://127.0.0.1:${SERVER_PORT}/api/health`, 45000, "server /api/health");
    await waitHttp(`http://localhost:${WEB_PORT}/`, 60000, "vite dev");
    webBase = `http://localhost:${WEB_PORT}`;
  }

  log("[audit] 启动 headless Chrome …");
  startChrome();
  await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 30000, "chrome devtools");

  const version = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const cdp = new CDP();
  await cdp.connect(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sid);
  await cdp.send("Runtime.enable", {}, sid);
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
    sid,
  );

  const loaded = cdp.once("Page.loadEventFired", 30000, sid);
  await cdp.send("Page.navigate", { url: webBase }, sid);
  await loaded;

  await ensureLogin(cdp, sid, webBase);
  if (THEME !== "light") {
    const applied = await setTheme(cdp, sid, THEME);
    log(`[audit] 主题=${applied}`);
  }

  const report = { base: webBase, theme: THEME, at: new Date().toISOString(), pages: {}, failures: [] };

  /*
   * 每一页下面还有二级页签（团队 5 个、模型 3 个、插件 3 个、设置 5 个……），
   * 合计 20 个视图。只量每页第一个页签会漏掉后面那些——审计报告里「设置/高级」
   * 的 16px 一次性字号、插件「技能」页最密的命中区，都是只在子视图里才暴露的问题。
   * 这里把 main 里的 [role=tab] 逐个点开各量一遍，slug 记成 `settings~外观`。
   */
  const auditView = async (slug, tabLabel) => {
    const metrics = await evalJs(cdp, sid, `(${pageAudit.toString()})()`);
    report.pages[slug] = { label: tabLabel || slug, metrics };
    log(
      `[audit] ${slug.padEnd(14)} 字号档=${String(metrics.fontTierCount).padEnd(2)} 11px正文=${metrics.body11} ` +
        `对比度不合格=${metrics.contrastFail} 命中区<32=${metrics.hitUnder32.length} 横向溢出=${metrics.docOverflowX}`,
    );
    return metrics;
  };
  const clickTab = async (index) => {
    const ok = await evalJs(
      cdp,
      sid,
      `(() => {
        const tabs = [...document.querySelectorAll('main [role="tab"]')];
        if (!tabs[${index}]) return null;
        tabs[${index}].click();
        return tabs[${index}].textContent.trim();
      })()`,
    );
    await sleep(450);
    return ok;
  };

  for (const [label, slug] of PAGES) {
    await goPage(cdp, sid, label);
    await auditView(slug, label);
    if (SHOTS) await shoot(cdp, sid, path.join(SHOTS, `${slug}-${THEME}.png`));

    let tabCount = 0;
    try {
      tabCount = await evalJs(cdp, sid, `document.querySelectorAll('main [role="tab"]').length`);
    } catch {
      tabCount = 0;
    }
    // 0/1 个页签没有额外视图；第一个页签通常就是默认视图，从下标 1 开始点。
    for (let i = 1; i < tabCount; i += 1) {
      const tabLabel = await clickTab(i);
      if (!tabLabel) continue;
      await auditView(`${slug}~${tabLabel}`, `${label}·${tabLabel}`);
    }
  }

  // ---------- 判定 ----------
  const rows = [];
  for (const [slug, page] of Object.entries(report.pages)) {
    const m = page.metrics;
    const checks = [
      ["横向溢出", m.docOverflowX, THRESHOLDS.docOverflowX, "="],
      ["对比度不合格", m.contrastFail, THRESHOLDS.contrastFail, "="],
      ["11px 正文", m.body11, THRESHOLDS.body11, "="],
      ["有效命中区<32", m.hitUnder32.length, THRESHOLDS.hitUnder32, "="],
      ["emoji", m.emoji, THRESHOLDS.emoji, "="],
      ["字号档位", m.fontTierCount, THRESHOLDS.fontTiers, "<="],
      // 判「有二级标题」而不是「有 16px 的标题」：h2 用 .ui-section-title（14px）也合法，
      // 关键是屏幕阅读器能拿到 >1 级的大纲。字号本身由 designScales 的「h2 不得用 ui-micro」守卫。
      ["标题层级", new Set(m.headings.map((h) => h.level)).size, THRESHOLDS.headingLevels, ">="],
    ];
    for (const [name, actual, limit, op] of checks) {
      const ok = op === "=" ? actual === limit : op === "<=" ? actual <= limit : actual >= limit;
      rows.push({ slug, name, actual, limit, op, ok });
      if (!ok) report.failures.push({ slug, name, actual, limit });
    }
  }

  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(path.resolve(ROOT, JSON_OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(ROOT, JSON_OUT), JSON.stringify(report, null, 1));
  }

  const pad = (s, n) => String(s).padEnd(n);
  log("\n指标".padEnd(18) + PAGES.map(([, s]) => pad(s, 9)).join(""));
  for (const name of ["横向溢出", "对比度不合格", "11px 正文", "有效命中区<32", "字号档位"]) {
    log(
      pad(name, 16) +
        PAGES.map(([, slug]) => {
          const r = rows.find((x) => x.slug === slug && x.name === name);
          return pad((r ? r.actual : 0) + (r && r.ok ? " ✓" : " ✗"), 9);
        }).join(""),
    );
  }

  if (JSON_OUT) log(`\n[audit] 明细写入 ${JSON_OUT}`);

  if (report.failures.length) {
    log(`\n[audit] ✗ ${report.failures.length} 项越界：`);
    for (const f of report.failures) log(`  - ${f.slug} / ${f.name}: 实际 ${f.actual}，要求 ${f.limit}`);
    return 1;
  }
  log("\n[audit] ✓ 全部门槛通过");
  return 0;
}

function cleanup() {
  for (const { child } of children.reverse()) {
    if (child && child.exitCode === null) {
      try { child.kill("SIGTERM"); } catch {}
    }
  }
}

let exitCode = 1;
try {
  exitCode = await run();
} catch (e) {
  console.error("[audit] 失败：" + (e?.message ?? e));
  exitCode = 1;
} finally {
  cleanup();
}
process.exit(exitCode);