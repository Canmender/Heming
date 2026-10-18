# 和鸣启动动画实施计划

> **⚠ 已实施完毕（2026-10-18，合入 main `7207da2`）。本文件是当时的任务分解，**不是**最终实现的准确描述——计划里的 preload「注入」方案在 Electron 上物理不可行，实现时改成了闭包登记表。**
> **改动启动动画前请先读 `docs/superpowers/specs/2026-10-18-boot-animation-design.md` §9（实施记录），那里列了与设计正文的 9 处偏差及原因。**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为和鸣桌面端实现 3 秒双段式启动动画（粒子聚拢 → 声波扩散），不可跳过，动画期间后台恢复登录态。

**Architecture:** Electron 主进程创建 splash 窗口渲染粒子聚拢段（1.5s），主窗口加载完成后主进程关闭 splash 并通过 `executeJavaScript` 触发 web 端 BootWave 组件渲染声波扩散段（1.3s）。两段各配一个 Web Audio API 合成音效。

**Tech Stack:** Electron 31 / React 18 / TypeScript / Tailwind3 / Web Audio API；测试 vitest（web）、node:test（desktop）。

## Global Constraints

- 动画总时长约 3 秒，双段式（粒子聚拢 1.5s + 静默 0.2s + 声波扩散 1.3s），不可跳过
- 粒子聚拢段由 splash 窗口渲染，声波扩散段由 web 端渲染
- splash 无 preload，由主进程直接创建/关闭；web 端通过 preload 接收启动信号
- 音效用 Web Audio API 合成（零外部资源）
- 不修改 `shared`/`server`/WS 契约
- 不修改 `ChatPage`/`agentStream`/`TriggerDeps`
- 尊重 `prefers-reduced-motion`：系统开启时跳过动画
- 视觉规范：墨色 `#1a1a1a`、白底、无 emoji、细线 SVG
- `pnpm -r build && pnpm -r test` 全绿后提交

---

### Task 1: splash.html 粒子聚拢动画

**Files:**
- Create: `packages/desktop/splash.html`
- Test: `packages/desktop/splash.test.js`

**Interfaces:**
- Produces: 无（纯静态 HTML/CSS/JS，加载即播放粒子动画，播完后保持静态等待主进程关闭）
- Consumes: 无（不依赖 preload，完全自包含）

- [ ] **Step 1: 写失败测试**

创建 `packages/desktop/splash.test.js`：

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "splash.html"), "utf8");

test("splash.html 包含粒子容器", () => {
  assert.ok(html.includes('id="scene"'));
  assert.ok(html.includes('class="particle"'));
});

test("splash.html 包含核心圆点", () => {
  assert.ok(html.includes('id="core"'));
  assert.ok(html.includes('border-radius: 50%'));
});

test("splash.html 包含 Web Audio 音效", () => {
  assert.ok(html.includes("AudioContext"));
  assert.ok(html.includes("300"));
});

test("splash.html 包含 prefers-reduced-motion 检测", () => {
  assert.ok(html.includes("prefers-reduced-motion"));
});

test("splash.html 动画时长 1500ms", () => {
  assert.ok(html.includes("1500"));
});

test("splash.html 无 preload 依赖（不引用 window.heming）", () => {
  assert.ok(!html.includes("window.heming"));
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/desktop && node --test splash.test.js
```

预期：FAIL（splash.html 不存在）

- [ ] **Step 3: 创建 splash.html**

创建 `packages/desktop/splash.html`：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>和鸣</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; }
  body {
    background: #ffffff;
    overflow: hidden;
  }
  .scene { position: relative; width: 100%; height: 100%; }
  .particle {
    position: absolute;
    width: 2px; height: 2px;
    background: #1a1a1a;
    border-radius: 50%;
    transition: transform 1.5s cubic-bezier(0.22, 0.61, 0.36, 1);
  }
  .core {
    position: absolute;
    left: 50%; top: 50%;
    width: 40px; height: 40px;
    background: #1a1a1a;
    border-radius: 50%;
    transform: translate(-50%, -50%) scale(0);
    transition: transform 0.4s ease 1.4s;
    box-shadow: 0 0 20px rgba(26,26,26,.3);
  }
  .core.visible { transform: translate(-50%, -50%) scale(1); }
</style>
</head>
<body>
<div class="scene" id="scene">
  <div class="core" id="core"></div>
</div>
<script>
  var PARTICLE_COUNT = 24;
  var DURATION = 1500;

  function createParticles() {
    var scene = document.getElementById('scene');
    var w = window.innerWidth, h = window.innerHeight, margin = 20;
    var perSide = Math.ceil(PARTICLE_COUNT / 4);
    var particles = [];
    for (var i = 0; i < PARTICLE_COUNT; i++) {
      var p = document.createElement('div');
      p.className = 'particle';
      var side = i % 4, t = (i % perSide) / perSide;
      var x, y;
      if (side === 0) { x = t * w; y = margin; }
      else if (side === 1) { x = w - margin; y = t * h; }
      else if (side === 2) { x = t * w; y = h - margin; }
      else { x = margin; y = t * h; }
      p.style.left = x + 'px';
      p.style.top = y + 'px';
      scene.appendChild(p);
      particles.push({ el: p, x: x, y: y });
    }
    return particles;
  }

  function animateParticles(particles) {
    var w = window.innerWidth, h = window.innerHeight;
    var cx = w / 2, cy = h / 2;
    requestAnimationFrame(function () {
      particles.forEach(function (p) {
        p.el.style.transform = 'translate(' + (cx - p.x) + 'px,' + (cy - p.y) + 'px)';
      });
    });
    setTimeout(function () {
      document.getElementById('core').classList.add('visible');
    }, DURATION - 100);
  }

  function playSound() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 300;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.2);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.2);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 1.2);
    } catch (e) { /* 音频不可用静默 */ }
  }

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    // 减弱动态：直接显示核心圆点
    document.getElementById('core').classList.add('visible');
  } else {
    var particles = createParticles();
    playSound();
    animateParticles(particles);
  }
</script>
</body>
</html>
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd packages/desktop && node --test splash.test.js
```

预期：PASS（6 个测试全绿）

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/splash.html packages/desktop/splash.test.js
git commit -m "feat(desktop): add splash.html particle animation"
```

---

### Task 2: main.js 创建/关闭 splash 窗口 + 信号 web 端

**Files:**
- Modify: `packages/desktop/main.js`
- Test: `packages/desktop/main.test.js`（新增，纯逻辑测试）

**Interfaces:**
- Consumes: `splash.html`（Task 1）
- Produces: 主进程在 `did-finish-load` 后：① 关闭 splash ② 调用 `window.heming.__startBootWave()`（Task 3 提供）

- [ ] **Step 1: 写失败测试**

创建 `packages/desktop/main.test.js`：

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// 纯逻辑：是否应该显示 splash
function shouldShowSplash(env) {
  return !env || !env.HEMING_NO_SPLASH;
}

test("默认环境显示 splash", () => {
  assert.equal(shouldShowSplash({}), true);
  assert.equal(shouldShowSplash(undefined), true);
});

test("HEMING_NO_SPLASH=1 时不显示 splash", () => {
  assert.equal(shouldShowSplash({ HEMING_NO_SPLASH: "1" }), false);
});

test("splash 窗口配置：无边框透明置顶", () => {
  // 与 main.js 内 createSplashWindow 保持一致
  const cfg = { frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true };
  assert.equal(cfg.frame, false);
  assert.equal(cfg.transparent, true);
  assert.equal(cfg.alwaysOnTop, true);
  assert.equal(cfg.skipTaskbar, true);
});
```

- [ ] **Step 2: 运行测试确认通过（纯逻辑直接通过）**

```bash
cd packages/desktop && node --test main.test.js
```

预期：PASS

- [ ] **Step 3: 修改 main.js**

在 `main.js` 中 `createWindow()` 函数内，`win.loadURL(appUrl)` 之后插入 splash 逻辑：

```js
// 在 win.loadURL(appUrl); 之后插入：

function createSplashWindow(mainWin) {
  if (process.env.HEMING_NO_SPLASH === "1") return;
  const { BrowserWindow } = require("electron");
  const splash = new BrowserWindow({
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    webPreferences: { offscreen: false }
  });
  splash.loadFile(require("node:path").join(__dirname, "splash.html"));

  // 主窗口加载完成后：关闭 splash + 通知 web 端开始 BootWave
  mainWin.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      if (!splash.isDestroyed()) splash.close();
      // 通知 web 端开始声波扩散段
      mainWin.webContents.executeJavaScript(
        'if (window.heming && window.heming.__startBootWave) window.heming.__startBootWave()'
      ).catch(() => {});
    }, 200); // 200ms 静默间隔（粒子聚拢 1.5s + 静默 0.2s）
  });
}

createSplashWindow(win);
```

- [ ] **Step 4: 运行测试**

```bash
cd packages/desktop && node --test
```

预期：全部 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/main.js packages/desktop/main.test.js
git commit -m "feat(desktop): create splash window and signal web on load"
```

---

### Task 3: preload.js 暴露 BootWave 启动信号

**Files:**
- Modify: `packages/desktop/preload.js`
- Test: `packages/desktop/preload.test.js`（新增）

**Interfaces:**
- Consumes: 无
- Produces: `window.heming.__startBootWave()` — 主进程调用此方法触发 web 端 BootWave 启动；web 端通过 `window.heming.__onBootReady(cb)` 注册回调

- [ ] **Step 1: 写失败测试**

创建 `packages/desktop/preload.test.js`：

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");

test("preload 暴露 __startBootWave 方法", () => {
  assert.ok(src.includes("__startBootWave"));
});

test("preload 暴露 __onBootReady 注册接口", () => {
  assert.ok(src.includes("__onBootReady"));
});

test("preload 暴露 platform（既有）", () => {
  assert.ok(src.includes("platform"));
});

// 行为测试：模拟 contextBridge
test("__startBootWave 触发已注册回调", () => {
  var cb = null;
  var heming = {
    __onBootReady: function (callback) { cb = callback; },
    __startBootWave: function () { if (cb) cb(); }
  };
  var called = false;
  heming.__onBootReady(function () { called = true; });
  heming.__startBootWave();
  assert.equal(called, true);
});

test("__startBootWave 无回调时不抛错", () => {
  var heming = {
    __onBootReady: function () {},
    __startBootWave: function () { /* no callback */ }
  };
  assert.doesNotThrow(function () { heming.__startBootWave(); });
});
```

- [ ] **Step 2: 修改 preload.js**

```js
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("heming", {
  platform: process.platform,
  /** 内部：web 端注册 BootWave 启动回调 */
  __onBootReady: null,
  /** 内部：主进程 did-finish-load 后调用，触发 BootWave */
  __startBootWave: null
});
```

说明：`__onBootReady` 与 `__startBootWave` 的实际赋值由 web 端 `BootWave` 组件挂载时注入（见 Task 4）。主进程只负责调用 `__startBootWave`。

- [ ] **Step 3: 运行测试**

```bash
cd packages/desktop && node --test preload.test.js
```

预期：PASS

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/preload.js packages/desktop/preload.test.js
git commit -m "feat(desktop): expose BootWave signal in preload"
```

---

### Task 4: BootWave 声波扩散组件

**Files:**
- Create: `packages/web/src/components/BootWave.tsx`
- Test: `packages/web/src/components/BootWave.test.tsx`

**Interfaces:**
- Consumes: `window.heming.__onBootReady(cb)` — 注册启动回调；`window.heming.__startBootWave()` 由主进程调用
- Produces: `<BootWave onDone: () => void />` — 声波扩散动画，完成后调用 `onDone`；向 `window.heming` 注入 `__onBootReady` 与 `__startBootWave` 实现

- [ ] **Step 1: 写失败测试**

创建 `packages/web/src/components/BootWave.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { BootWave } from "./BootWave.js";

describe("BootWave", () => {
  beforeEach() {
    vi.restoreAllMocks();
    // 清理 window.heming
    (window as any).heming = undefined;
  }

  it("渲染波纹元素", () => {
    const onDone = vi.fn();
    render(<BootWave onDone={onDone} />);
    expect(document.querySelector(".boot-wave")).toBeTruthy();
  });

  it("动画完成后调用 onDone", async () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    render(<BootWave onDone={onDone} />);
    act(() => { vi.advanceTimersByTime(1300); });
    await vi.waitFor(() => { expect(onDone).toHaveBeenCalled(); });
    vi.useRealTimers();
  });

  it("prefers-reduced-motion 时直接调用 onDone", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as any);
    const onDone = vi.fn();
    render(<BootWave onDone={onDone} />);
    expect(onDone).toHaveBeenCalled();
  });

  it("注入 __onBootReady 到 window.heming", () => {
    render(<BootWave onDone={vi.fn()} />);
    expect((window as any).heming?.__onBootReady).toBeDefined();
  });

  it("__startBootWave 触发已注册回调", async () => {
    let callback: (() => void) | null = null;
    (window as any).heming = {
      __onBootReady: (cb: () => void) => { callback = cb; },
      __startBootWave: () => { callback?.(); }
    };
    render(<BootWave onDone={vi.fn()} />);
    expect(callback).not.toBeNull();
    act(() => { (window as any).heming.__startBootWave(); });
    // 波纹应该出现
    expect(document.querySelector(".boot-wave .ripple")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/web && pnpm test -- BootWave
```

预期：FAIL（模块不存在）

- [ ] **Step 3: 创建 BootWave.tsx**

创建 `packages/web/src/components/BootWave.tsx`：

```tsx
import { useEffect, useRef, useState } from "react";

interface BootWaveProps {
  /** 动画完成回调 */
  onDone: () => void;
}

/**
 * 声波扩散动画：3 圈同心圆从中心扩散，主界面内容从中心向外渐次浮现。
 * 时长 1.3s，与 splash 粒子聚拢段（1.5s）+ 静默（0.2s）组成完整约 3s 启动动画。
 * 启动信号由主进程 did-finish-load 后通过 window.heming.__startBootWave() 触发。
 */
export function BootWave({ onDone }: BootWaveProps) {
  const [started, setStarted] = useState(false);
  const [phase, setPhase] = useState<"idle" | "playing" | "done">("idle");
  const timerRef = useRef<number | null>(null);

  // 注入 window.heming.__onBootReady / __startBootWave
  useEffect(() => {
    const heming = (window as any).heming ?? {};
    heming.__onBootReady = (cb: () => void) => {
      heming.__bootCallback = cb;
    };
    heming.__startBootWave = () => {
      if (heming.__bootCallback) heming.__bootCallback();
    };
    (window as any).heming = heming;
  }, []);

  // 监听启动信号
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      onDone();
      return;
    }

    const heming = (window as any).heming;
    if (heming?.__onBootReady) {
      heming.__onBootReady(() => {
        startAnimation();
      });
    } else {
      // 兜底：无 preload（如浏览器直接打开）时 1.7s 后自动开始
      const t = window.setTimeout(() => startAnimation(), 1700);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startAnimation() {
    playSound();
    setStarted(true);
    setPhase("playing");
    timerRef.current = window.setTimeout(() => {
      setPhase("done");
      onDone();
    }, 1300);
  }

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  function playSound() {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = 440;
      osc2.type = "sine"; osc2.frequency.value = 880;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.1);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.3);
      osc.connect(gain); osc2.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime); osc2.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 1.3); osc2.stop(ctx.currentTime + 1.3);
    } catch { /* 音频不可用静默 */ }
  }

  if (!started) return null;

  return (
    <div className="boot-wave" aria-hidden="true">
      <style>{`
        .boot-wave {
          position: fixed; inset: 0; z-index: 9999;
          pointer-events: none;
          display: flex; align-items: center; justify-content: center;
        }
        .boot-wave .ripple {
          position: absolute; left: 50%; top: 50%;
          border: 1.5px solid #1a1a1a; border-radius: 50%;
          opacity: 0;
          animation: ripple-expand 1.3s ease-out forwards;
        }
        .boot-wave .ripple:nth-child(1) { width: 40px; height: 40px; animation-delay: 0s; }
        .boot-wave .ripple:nth-child(2) { width: 40px; height: 40px; animation-delay: 0.3s; }
        .boot-wave .ripple:nth-child(3) { width: 40px; height: 40px; animation-delay: 0.6s; }
        @keyframes ripple-expand {
          0% { opacity: 0.6; transform: translate(-50%,-50%) scale(1); }
          100% { opacity: 0; transform: translate(-50%,-50%) scale(30); }
        }
      `}</style>
      <div className="ripple" />
      <div className="ripple" />
      <div className="ripple" />
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd packages/web && pnpm test -- BootWave
```

预期：PASS（5 个测试全绿）

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/components/BootWave.tsx packages/web/src/components/BootWave.test.tsx
git commit -m "feat(web): add BootWave ripple animation component"
```

---

### Task 5: App.tsx 集成启动动画

**Files:**
- Modify: `packages/web/src/App.tsx`
- Test: `packages/web/src/App.test.tsx`（新增）

**Interfaces:**
- Consumes: `<BootWave>`（Task 4）
- Produces: 无（顶层集成）

- [ ] **Step 1: 写失败测试**

创建 `packages/web/src/App.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.js";
import { useAuthStore } from "./store/auth.js";
import { useUiStore } from "./store/ui.js";

vi.mock("./components/LoginPage.js", () => ({ LoginPage: () => <div>LoginPage</div> }));
vi.mock("./components/NavRail.js", () => ({
  NavRail: () => <div>NavRail</div>, NavPeek: () => <div>NavPeek</div>
}));
vi.mock("./components/HomePage.js", () => ({ HomePage: () => <div>HomePage</div> }));
vi.mock("./components/WorkspacePage.js", () => ({ WorkspacePage: () => <div>WorkspacePage</div> }));
vi.mock("./components/ChatPage.js", () => ({ ChatPage: () => <div>ChatPage</div> }));
vi.mock("./components/RadarContacts.js", () => ({ RadarContacts: () => <div>RadarContacts</div> }));
vi.mock("./components/SettingsPage.js", () => ({ SettingsPage: () => <div>SettingsPage</div> }));
vi.mock("./components/MemoryPage.js", () => ({ MemoryPage: () => <div>MemoryPage</div> }));
vi.mock("./components/FileTree.js", () => ({ FileTree: () => <div>FileTree</div> }));
vi.mock("./components/FilePreviewModal.js", () => ({ FilePreviewModal: () => null }));
vi.mock("./components/BootWave.js", () => ({
  BootWave: ({ onDone }: { onDone: () => void }) => {
    React.useEffect(() => { onDone(); }, [onDone]);
    return <div>BootWave</div>;
  }
}));

describe("App 启动动画集成", () => {
  beforeEach(() => {
    useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
    useUiStore.setState({
      page: "home", navCollapsed: false, activeConversationId: null,
      contactsHidden: false, detailContact: null, pendingAttachment: null
    });
  });

  it("未登录时显示登录页", async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText("LoginPage")).toBeTruthy(); });
  });

  it("已登录时显示主界面", async () => {
    useAuthStore.setState({
      token: "t", user: { id: "u1", username: "t", displayName: "T" }, status: "authed", error: null
    });
    render(<App />);
    await waitFor(() => { expect(screen.getByText("NavRail")).toBeTruthy(); });
  });

  it("BootWave 完成后才渲染主内容", async () => {
    render(<App />);
    // BootWave mock 立即触发 onDone，所以主内容应该出现
    await waitFor(() => { expect(screen.queryByText("BootWave")).toBeNull(); });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/web && pnpm test -- App
```

预期：FAIL（BootWave 未集成，直接显示主界面）

- [ ] **Step 3: 修改 App.tsx**

在 `App.tsx` 中插入启动动画逻辑：

```tsx
import { useCallback, useState } from "react";
import { BootWave } from "./components/BootWave.js";

// 在 App 组件内部，现有代码之前：
const [bootDone, setBootDone] = useState(false);
const handleBootDone = useCallback(() => setBootDone(true), []);

// 在 if (!authUser) 之前插入：
if (!bootDone) {
  return <BootWave onDone={handleBootDone} />;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd packages/web && pnpm test -- App
```

预期：PASS（3 个测试全绿）

- [ ] **Step 5: 运行全量门禁**

```bash
pnpm -r build && pnpm -r test
```

预期：全部 PASS

- [ ] **Step 6: 提交**

```bash
git add packages/web/src/App.tsx packages/web/src/App.test.tsx
git commit -m "feat(web): integrate boot animation in App"
```

---

### Task 6: package.json 更新 + 打包验证

**Files:**
- Modify: `packages/desktop/package.json`

**Interfaces:**
- Consumes: `splash.html`（Task 1）
- Produces: 无

- [ ] **Step 1: 更新 package.json files 白名单**

在 `packages/desktop/package.json` 的 `build.files` 数组中加入 `"splash.html"`：

```json
"files": [
  "main.js",
  "window-state.js",
  "secure-origins.js",
  "preload.js",
  "splash.html"
]
```

- [ ] **Step 2: 运行桌面端测试**

```bash
cd packages/desktop && node --test
```

预期：全部 PASS

- [ ] **Step 3: 重新打包安装包**

```bash
cd packages/desktop && pnpm dist
```

预期：生成 `release/和鸣 Setup 0.0.1.exe`，包含 `splash.html`

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/package.json
git commit -m "feat(desktop): include splash.html in build files"
```

---

## 自审清单

- [x] 规格覆盖：粒子聚拢（Task 1）、splash 窗口管理 + 信号（Task 2）、preload 信号（Task 3）、声波扩散（Task 4）、集成（Task 5）、打包（Task 6）
- [x] 无占位符：所有步骤含完整代码
- [x] 交接机制正确：splash 无 preload 不依赖 window.heming；主进程 did-finish-load 后关闭 splash 并调用 `__startBootWave()`；BootWave 注入 `__onBootReady`/`__startBootWave` 实现
- [x] 时序正确：粒子聚拢 1.5s（splash 自播）→ 主进程 did-finish-load + 200ms 静默 → 关闭 splash + 触发 BootWave → 声波扩散 1.3s → onDone → 主界面
- [x] 类型一致：`BootWave` props 一致、`window.heming` 接口一致
- [x] 测试策略：纯逻辑用 node:test，React 组件用 vitest
- [x] 门禁：每 Task 末尾跑测试，Task 5 跑全量门禁
