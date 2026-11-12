"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createPipeline } = require("./pipeline");

const WORK_DIR = "C:\\Temp\\heming-setup";
const SETUP_DIR = "C:\\Temp\\setup";
const INSTALL_DIR = "C:\\Programs\\Heming";
const EXE_PATH = path.join(INSTALL_DIR, "Heming.exe");
const PAYLOAD_PATH = path.join(WORK_DIR, "payload", "inner-setup.exe");

const FEED_TEXT = [
  "version: 135.3.54",
  "files:",
  "  - url: 和鸣%20Setup%20d.140.0.1.0.exe",
  "    sha512: sha-ok",
  "    size: 1000",
  "  - url: 和鸣%20Setup%20d.140.0.1.0.exe.blockmap",
  "    sha512: other",
  "    size: 12",
  "path: 和鸣 Setup d.140.0.1.0.exe",
  "sha512: sha-ok",
  "size: 1000",
  "",
].join("\n");

function norm(target) {
  return String(target).replace(/\//g, "\\").toLowerCase();
}

function harness(overrides = {}) {
  const events = [];
  const logs = [];
  const calls = { startInstaller: null, statTree: 0, launch: [], downloadFile: null, downloadCount: 0, fetchText: null, sha512Calls: 0 };
  const existing = new Set((overrides.existing ?? []).map(norm));

  const services = {
    async exists(target) {
      return existing.has(norm(target));
    },
    async statFile() {
      return typeof overrides.statFile === "function" ? overrides.statFile() : null;
    },
    async removeFile() {},
    async listDir(dir) {
      return typeof overrides.listDir === "function" ? overrides.listDir(dir) : [];
    },
    async freeBytes() {
      return overrides.freeBytes ?? 10 * 1024 ** 3;
    },
    async statTree(dir, options) {
      calls.statTree += 1;
      return overrides.statTree ?? { files: 2, bytes: 300, complete: true };
    },
    startInstaller(command) {
      calls.startInstaller = command;
      return overrides.installResult ?? { child: { pid: 4321 }, done: Promise.resolve({ code: 0, signal: null }) };
    },
    killInstallerTree() {},
    async fetchText(url) {
      calls.fetchText = url;
      return overrides.feedText ?? "";
    },
    async downloadFile(url, dest, options) {
      calls.downloadCount += 1;
      calls.downloadFile = { url, dest, options };
      if (typeof overrides.downloadFile === "function") {
        return overrides.downloadFile(url, dest, options);
      }
      return { filePath: dest, bytes: 1000, sha512: "sha-ok", total: 1000 };
    },
    async sha512File() {
      calls.sha512Calls += 1;
      return overrides.sha512 ?? "sha-ok";
    },
    sha512Equals: (a, b) => a === b,
    // 必须是宏任务：安装期轮询是 while + await sleep 的循环，
    // 若 sleep 立刻 resolve，微任务队列会被这个循环占满，done 永远等不到。
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    async launch(exePath) {
      calls.launch.push(exePath);
    },
  };

  const config = {
    hemingVersion: "d.135.3.54.7",
    payloadMode: "embedded",
    payloadPath: PAYLOAD_PATH,
    payloadSha512: null,
    installedBytes: 1000,
    feedUrl: "http://host/updates",
    ...overrides.config,
  };

  const pipeline = createPipeline({
    config,
    paths: {
      workDir: overrides.workDir ?? WORK_DIR,
      setupDir: SETUP_DIR,
      setupExeName: "和鸣安装程序 d.135.3.54.7.exe",
    },
    services,
    emit: (event) => {
      events.push(event);
      if (typeof overrides.onEvent === "function") overrides.onEvent(event, pipeline);
    },
    log: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });

  return { pipeline, events, calls, logs };
}

test("内嵌安装包：校验后静默安装并确认主程序落地", async () => {
  const h = harness({ existing: [PAYLOAD_PATH, EXE_PATH] });
  const result = await h.pipeline.start({ installDir: INSTALL_DIR, launchAfter: false });

  assert.equal(result.ok, true);
  assert.equal(result.exePath, EXE_PATH);
  assert.equal(result.installDir, INSTALL_DIR);
  assert.equal(result.version, "d.135.3.54.7");
  assert.equal(result.launched, false);
  assert.equal(h.calls.launch.length, 0);

  const command = h.calls.startInstaller;
  assert.equal(command.file, PAYLOAD_PATH);
  assert.deepEqual(command.args, ["/S", "/NCRC", `/D=${INSTALL_DIR}`]);
  assert.equal(command.args[command.args.length - 1].includes('"'), false);
  assert.equal(command.options.windowsVerbatimArguments, true);
  assert.equal(command.options.windowsHide, true);
  assert.equal(command.options.cwd, WORK_DIR);

  assert.equal(h.events.some((e) => e.type === "phase" && e.phase === "install"), true);
  assert.equal(h.events.some((e) => e.type === "error"), false);
  const done = h.events.find((e) => e.type === "done");
  assert.equal(done.version, "d.135.3.54.7");
  // 完成事件带分段耗时：界面用它显示「用时 X 秒 · 安装 Y 秒」。
  assert.equal(Number.isFinite(done.elapsedMs), true);
  assert.equal(done.elapsedMs >= 0, true);
  assert.equal(Number.isFinite(done.timings.payloadMs), true);
  assert.equal(Number.isFinite(done.timings.installMs), true);
  assert.equal(done.timings.totalMs, done.elapsedMs);
});

test("没有内嵌包时从更新服务器下载并校验 sha512", async () => {
  const h = harness({
    existing: [EXE_PATH],
    config: { payloadMode: "network" },
    feedText: FEED_TEXT,
    downloadFile: async (url, dest, options) => {
      options.onProgress({ received: 500, total: 1000 });
      return { filePath: dest, bytes: 1000, sha512: "sha-ok", total: 1000 };
    },
  });

  const result = await h.pipeline.start({ installDir: INSTALL_DIR, launchAfter: false });

  assert.equal(result.ok, true);
  assert.equal(result.version, "d.140.0.1.0");
  assert.equal(h.calls.fetchText, "http://host/updates/latest.yml");
  assert.equal(h.calls.downloadFile.dest, path.join(WORK_DIR, "inner-setup.exe"));
  assert.equal(h.calls.downloadFile.options.expectedSize, 1000);
  // 断网重试要能接着上次的半截文件，下载器必须知道可以续传
  assert.equal(h.calls.downloadFile.options.resume, true);
  assert.equal(h.calls.downloadFile.url.endsWith("d.140.0.1.0.exe"), true);
  assert.equal(h.events.some((e) => e.type === "progress" && e.received === 500), true);
  assert.equal(h.events.some((e) => e.type === "phase" && e.phase === "verify"), true);
});

test("已下载但校验值对不上时报 hash-mismatch，不启动内层安装器", async () => {
  const h = harness({
    existing: [EXE_PATH],
    config: { payloadMode: "network" },
    feedText: FEED_TEXT,
    downloadFile: async (url, dest) => ({ filePath: dest, bytes: 1000, sha512: "tampered", total: 1000 }),
  });

  const result = await h.pipeline.start({ installDir: INSTALL_DIR, launchAfter: false });

  assert.equal(result.ok, false);
  assert.equal(result.code, "hash-mismatch");
  assert.equal(h.calls.startInstaller, null);
  assert.equal(h.events.some((e) => e.type === "error" && e.code === "hash-mismatch"), true);
});

test("latest.yml 里没有 Windows 安装包时报 feed-invalid", async () => {
  const h = harness({
    existing: [EXE_PATH],
    config: { payloadMode: "network" },
    feedText: "version: 1.0.0\n",
  });

  const result = await h.pipeline.start({ installDir: INSTALL_DIR, launchAfter: false });

  assert.equal(result.code, "feed-invalid");
  assert.equal(h.calls.downloadFile, null);
});

test("安装器退出码为 0 但主程序不存在时判 install-failed", async () => {
  const h = harness({ existing: [PAYLOAD_PATH] });
  const result = await h.pipeline.start({ installDir: INSTALL_DIR, launchAfter: false });

  assert.equal(result.ok, false);
  assert.equal(result.code, "install-failed");
  const error = h.events.find((e) => e.type === "error");
  assert.match(error.detail, /退出码 0/);
});

test("磁盘空间不够时在下载前拒绝", async () => {
  const h = harness({ existing: [PAYLOAD_PATH, EXE_PATH], freeBytes: 10 * 1024 * 1024 });
  const result = await h.pipeline.start({ installDir: INSTALL_DIR, launchAfter: false });

  assert.equal(result.code, "no-space");
  assert.equal(h.calls.startInstaller, null);
  assert.equal(h.calls.downloadFile, null);
});

test("下载阶段取消会发出 cancelled", async () => {
  const h = harness({
    existing: [EXE_PATH],
    config: { payloadMode: "network" },
    feedText: FEED_TEXT,
    downloadFile: async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });

  const result = await h.pipeline.start({ installDir: INSTALL_DIR, launchAfter: false });

  assert.equal(result.ok, false);
  assert.equal(result.code, "cancelled");
  assert.equal(h.events.some((e) => e.type === "cancelled"), true);
});

test("非法安装目录直接报 invalid-dir", async () => {
  const h = harness();
  const result = await h.pipeline.start({ installDir: "C:\\", launchAfter: false });

  assert.equal(result.code, "invalid-dir");
  assert.equal(h.events.some((e) => e.type === "error" && e.code === "invalid-dir"), true);
  assert.equal(h.calls.startInstaller, null);
});

test("安装阶段拒绝取消，busy 期间拒绝重复启动，装完仍然成功", async () => {
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  let installed = false;
  const h = harness({
    existing: [PAYLOAD_PATH, EXE_PATH],
    installResult: { child: { pid: 7 }, done },
    onEvent() {
      if (h.calls.startInstaller) installed = true;
    },
  });

  const startPromise = h.pipeline.start({ installDir: INSTALL_DIR, launchAfter: false });
  while (!h.calls.startInstaller) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(h.pipeline.cancel(), { ok: false, reason: "installing" });
  const second = await h.pipeline.start({ installDir: INSTALL_DIR, launchAfter: false });
  assert.equal(second.code, "busy");

  resolveDone({ code: 0, signal: null });
  const result = await startPromise;
  assert.equal(result.ok, true);
  assert.equal(installed, true);
});

test("预取：窗口一打开就在后台下好安装包，开始安装时不再重复下载", async () => {
  const h = harness({
    existing: [EXE_PATH],
    config: { payloadMode: "network" },
    feedText: FEED_TEXT,
    downloadFile: async (url, dest) => ({ filePath: dest, bytes: 1000, sha512: "sha-ok", total: 1000 }),
  });

  const prefetched = await h.pipeline.prefetch();
  assert.equal(prefetched.ok, true);
  assert.equal(prefetched.version, "d.140.0.1.0");
  assert.equal(h.calls.downloadCount, 1);
  const ready = h.events.find((e) => e.type === "prefetch" && e.stage === "ready");
  assert.equal(ready.version, "d.140.0.1.0");

  const result = await h.pipeline.start({ installDir: INSTALL_DIR, launchAfter: false });
  assert.equal(result.ok, true);
  assert.equal(h.calls.downloadCount, 1, "预取已经下好，开始安装不应该再下一次");
  assert.equal(h.calls.startInstaller.file, path.join(WORK_DIR, "inner-setup.exe"));
});

test("缓存命中：上次下好的安装包大小与 sha512 都对得上时跳过下载", async () => {
  const CACHE_PATH = path.join(WORK_DIR, "inner-setup.exe");
  const h = harness({
    existing: [CACHE_PATH, EXE_PATH],
    config: { payloadMode: "network" },
    feedText: FEED_TEXT,
    statFile: () => ({ isFile: () => true, size: 1000 }),
  });

  const result = await h.pipeline.start({ installDir: INSTALL_DIR, launchAfter: false });

  assert.equal(result.ok, true);
  assert.equal(result.version, "d.140.0.1.0");
  assert.equal(h.calls.downloadCount, 0);
  assert.equal(
    h.events.some((e) => e.type === "phase" && e.label === "使用已下载的安装包"),
    true,
  );
});

test("缓存不可信：大小对不上时重新下载而不是硬用", async () => {
  const CACHE_PATH = path.join(WORK_DIR, "inner-setup.exe");
  const h = harness({
    existing: [CACHE_PATH, EXE_PATH],
    config: { payloadMode: "network" },
    feedText: FEED_TEXT,
    statFile: () => ({ isFile: () => true, size: 512 }),
    downloadFile: async (url, dest) => ({ filePath: dest, bytes: 1000, sha512: "sha-ok", total: 1000 }),
  });

  const result = await h.pipeline.start({ installDir: INSTALL_DIR, launchAfter: false });

  assert.equal(result.ok, true);
  assert.equal(h.calls.downloadCount, 1);
});

test("缓存元数据一致时跳过整包 sha512 重算", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "heming-meta-"));
  const cachePath = path.join(workDir, "inner-setup.exe");
  fs.writeFileSync(cachePath, "cached");
  fs.writeFileSync(
    `${cachePath}.meta.json`,
    JSON.stringify({ version: "d.140.0.1.0", size: 1000, sha512: "sha-ok", mtimeMs: 1_700_000_000_000 }),
  );
  const h = harness({
    existing: [cachePath, EXE_PATH],
    workDir,
    config: { payloadMode: "network" },
    feedText: FEED_TEXT,
    statFile: () => ({ isFile: () => true, size: 1000, mtimeMs: 1_700_000_000_000 }),
  });

  const result = await h.pipeline.start({ installDir: INSTALL_DIR, launchAfter: false });

  assert.equal(result.ok, true);
  assert.equal(h.calls.downloadCount, 0);
  // 关键：元数据可信时不再读整包算 sha512（真实 300MB 那一次要几百毫秒）
  assert.equal(h.calls.sha512Calls, 0);
  fs.rmSync(workDir, { recursive: true, force: true });
});

test("下载进度按 120ms 节流，但首帧与收尾帧一定送到", async () => {
  const h = harness({
    existing: [PAYLOAD_PATH, EXE_PATH],
    config: { payloadMode: "network" },
    feedText: FEED_TEXT,
    downloadFile: async (url, dest, options) => {
      // 模拟一次真实下载的回调密度：一个包会有成百上千次，这里取 15 次同一毫秒内到达。
      for (let received = 64; received < 1000; received += 64) {
        options.onProgress({ received, total: 1000 });
      }
      options.onProgress({ received: 1000, total: 1000 });
      return { filePath: dest, bytes: 1000, sha512: "sha-ok", total: 1000 };
    },
  });

  const result = await h.pipeline.start({ installDir: INSTALL_DIR, launchAfter: false });

  assert.equal(result.ok, true);
  const progress = h.events.filter((event) => event.type === "progress");
  assert.ok(progress.length <= 3, `同一毫秒内的进度应被合并，实际转发 ${progress.length} 次`);
  assert.equal(progress[0].received, 64, "首帧必须立刻转发，界面要知道开始了");
  assert.equal(progress[progress.length - 1].received, 1000, "收尾帧必须转发，进度要能到 100%");
});

test("预取失败只发 prefetch 事件，不弹错误屏", async () => {
  const h = harness({
    existing: [EXE_PATH],
    config: { payloadMode: "network" },
    feedText: "version: 1.0.0\n",
  });

  const prefetched = await h.pipeline.prefetch();

  assert.equal(prefetched.ok, false);
  assert.equal(prefetched.code, "feed-invalid");
  assert.equal(h.events.some((e) => e.type === "error"), false);
  assert.equal(
    h.events.some((e) => e.type === "prefetch" && e.stage === "failed" && e.code === "feed-invalid"),
    true,
  );
});

test("还停在安装位置时取消，取消的是后台预取", async () => {
  const h = harness({
    existing: [EXE_PATH],
    config: { payloadMode: "network" },
    feedText: FEED_TEXT,
    downloadFile: (url, dest, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });

  const prefetchPromise = h.pipeline.prefetch();
  while (h.calls.downloadCount === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(h.pipeline.cancel(), { ok: true, scope: "prefetch" });
  const prefetched = await prefetchPromise;
  assert.equal(prefetched.ok, false);
  assert.equal(prefetched.code, "cancelled");
});

// —— 通用外壳：启动时只读探测「服务器现在最新是哪一版」 ——

test("probeLatest：在线形态读 latest.yml，返回最新版本/大小/下载地址", async () => {
  const h = harness({ config: { payloadMode: "network" }, feedText: FEED_TEXT });
  const latest = await h.pipeline.probeLatest();
  assert.equal(h.calls.fetchText, "http://host/updates/latest.yml");
  assert.equal(latest.version, "d.140.0.1.0");
  assert.equal(latest.size, 1000);
  assert.equal(latest.url, "http://host/updates/%E5%92%8C%E9%B8%A3%20Setup%20d.140.0.1.0.exe");
  assert.equal(h.calls.downloadCount, 0, "探测不下载");
});

test("probeLatest：内嵌/本地形态不联网，直接用包内版本", async () => {
  const h = harness({});
  const latest = await h.pipeline.probeLatest();
  assert.equal(latest.version, "d.135.3.54.7");
  assert.equal(h.calls.fetchText, null);
});

test("probeLatest：latest.yml 里没有 Windows 安装包时报 feed-invalid", async () => {
  const h = harness({ config: { payloadMode: "network" }, feedText: "version: 1.0.0\nfiles: []\n" });
  await assert.rejects(
    () => h.pipeline.probeLatest(),
    (error) => error.code === "feed-invalid",
  );
});
