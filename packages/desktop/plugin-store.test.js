"use strict";
// 测试用开发公钥（正式包默认拒绝 dev-* 公钥，这里显式放开）。
process.env.HEMING_ALLOW_DEV_PLUGIN_KEYS = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPrivateKey, sign: nodeSign } = require("node:crypto");
const { createPluginStore } = require("./plugin-store");
const { packPackage, sha256Hex, computeFilesDigest } = require("./plugin-package");
const { canonicalManifestText } = require("./plugin-signature");

/* ────────────────────────── 夹具 ────────────────────────── */

function manifest(overrides = {}) {
  return {
    schemaVersion: 4,
    id: "heming.pet",
    name: "桌宠",
    version: "1.0.0",
    description: "桌面上的 Live2D 化身",
    author: "和鸣",
    distribution: "bundle",
    permissions: { network: [], tools: "none", files: [], events: ["notify"], graphics: ["webgl", "wasm"], eval: false },
    contributions: {
      desktopWidgets: [
        {
          id: "pet",
          name: "桌宠",
          entry: "files/index.html",
          width: 300,
          height: 420,
          scales: [0.6, 1, 1.5],
          clickThrough: "auto",
          transparent: true,
          alwaysOnTop: true,
          settings: {
            fields: [
              { key: "agentId", type: "agent", label: "对话绑定智能体", default: null },
              { key: "modelPath", type: "text", label: "模型路径", default: "pet/Hiyori/Hiyori.model3.json" },
              {
                key: "presence",
                type: "select",
                label: "打扰强度",
                default: "normal",
                options: [
                  { value: "quiet", label: "安静" },
                  { value: "normal", label: "正常" },
                ],
              },
              { key: "bubble", type: "boolean", label: "气泡", default: true },
            ],
          },
        },
      ],
    },
    ...overrides,
  };
}

function packageBytes(overrides) {
  // d.105：bundle 安装必须通过首方验签，所以夹具统一用开发/测试私钥签名
  // （公钥见 packages/desktop/resources/official-keys.json 的 dev-test-2026-11）。
  // d.111/P0-1：清单还要绑定 files/** 内容摘要（签名据此覆盖代码字节）。
  const files = [
    { path: "files/index.html", data: "<!doctype html><canvas></canvas>" },
    { path: "files/assets/app.js", data: `console.log(${JSON.stringify(overrides && overrides.version)})` },
  ];
  const digest = computeFilesDigest(files);
  const signed = signForTest(manifest({ ...overrides, packageSha256: digest }));
  return packPackage([{ path: "plugin.json", data: JSON.stringify(signed) }, ...files]);
}

/* ── 首方签名夹具：与 resources/official-keys.json 的 dev-test-2026-11 对应 ── */

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const DEV_PRIVATE_KEY = "eQpmY52b_n7e7rpNrJzr4jT5U5CUZuZCuVe08XRGc7Q";
const DEV_PUBLIC_KEY = "CwlX79Lc-Il4jvWK1sxhH-zxj9CLn5KD_CCpjp3rOl0";

function signForTest(rawManifest) {
  const withPublisher = { ...rawManifest, publisher: { id: "heming", publicKey: DEV_PUBLIC_KEY } };
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(DEV_PRIVATE_KEY, "base64url")]),
    format: "der",
    type: "pkcs8",
  });
  const value = nodeSign(null, Buffer.from(canonicalManifestText(withPublisher), "utf8"), privateKey).toString("base64url");
  return { ...withPublisher, signature: { alg: "ed25519", value } };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "heming-widgets-"));
}

function makeStore(overrides = {}) {
  const dir = tempDir();
  const store = createPluginStore({ dir, now: () => Date.parse("2026-11-07T00:00:00Z"), ...overrides });
  store.init();
  return store;
}

/* ────────────────────────── 注册表 ────────────────────────── */

test("init：空目录生成注册表；list 为空", () => {
  const store = makeStore();
  assert.deepEqual(store.list(), []);
  assert.ok(fs.existsSync(path.join(store.dir, "installed.json")));
});

test("install：包落盘到 <id>/<version>/，切 current 指针，list 给出 widget 与默认设置", () => {
  const store = makeStore();
  const bytes = packageBytes();
  const result = store.install({ bytes, expectedSha256: sha256Hex(bytes) });
  assert.equal(result.ok, true, result.error);

  const versionDir = path.join(store.dir, "heming.pet", "1.0.0");
  assert.ok(fs.existsSync(path.join(versionDir, "plugin.json")));
  assert.ok(fs.existsSync(path.join(versionDir, "files", "index.html")));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.dir, "heming.pet", "current.json"), "utf8")), {
    version: "1.0.0",
  });

  const [record] = store.list();
  assert.equal(record.id, "heming.pet");
  assert.equal(record.name, "桌宠");
  assert.equal(record.version, "1.0.0");
  assert.equal(record.enabled, true);
  assert.equal(record.widget.id, "pet");
  assert.equal(record.signed, true);
  assert.deepEqual(record.settings, {
    agentId: null,
    modelPath: "pet/Hiyori/Hiyori.model3.json",
    presence: "normal",
    bubble: true,
  });
  assert.equal(store.currentDir("heming.pet"), versionDir);
});

test("命令物化：安装记录带 commands；启动时从 plugin.json 回填旧记录（d.109）", () => {
  const store = makeStore();
  const commands = [
    {
      id: "open-plugins",
      title: "打开插件区",
      description: "去插件列表",
      keywords: ["插件"],
      target: { kind: "page", page: "plugins" },
    },
    { id: "open-pet", title: "打开桌宠详情", target: { kind: "plugin" } },
  ];
  const bytes = packageBytes({
    contributions: { desktopWidgets: manifest().contributions.desktopWidgets, commands },
  });
  const installed = store.install({ bytes });
  assert.equal(installed.ok, true, installed.error);
  assert.deepEqual(
    store.list()[0].commands.map((item) => item.target),
    [{ kind: "page", page: "plugins" }, { kind: "plugin" }],
  );

  // 旧安装记录（注册表里没有 commands）→ 重新 init 时从当前版本 plugin.json 回填
  const registryPath = path.join(store.dir, "installed.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  delete registry.plugins[0].commands;
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  const reopened = createPluginStore({ dir: store.dir, now: () => Date.parse("2026-11-07T00:00:00Z") });
  reopened.init();
  assert.equal(reopened.list()[0].commands.length, 2);
  assert.deepEqual(reopened.list()[0].commands[0].keywords, ["插件"]);
});

test("install：坏包/指纹不符都拒绝，且不产生半装状态", () => {
  const store = makeStore();
  const bad = store.install({ bytes: Buffer.from("nope") });
  assert.equal(bad.ok, false);
  assert.deepEqual(store.list(), []);
  const bytes = packageBytes();
  const mismatch = store.install({ bytes, expectedSha256: "0".repeat(64) });
  assert.equal(mismatch.ok, false);
  assert.deepEqual(store.list(), []);
});

test("升级：切到新版本、清掉旧版本目录、保留用户设置", () => {
  const store = makeStore();
  store.install({ bytes: packageBytes() });
  store.patchSettings("heming.pet", { presence: "quiet", bubble: false });

  const upgraded = store.install({ bytes: packageBytes({ version: "1.1.0" }) });
  assert.equal(upgraded.ok, true, upgraded.error);
  assert.equal(store.get("heming.pet").version, "1.1.0");
  assert.ok(fs.existsSync(path.join(store.dir, "heming.pet", "1.1.0", "files", "index.html")));
  assert.equal(fs.existsSync(path.join(store.dir, "heming.pet", "1.0.0")), false);
  assert.deepEqual(store.readSettings("heming.pet"), {
    agentId: null,
    modelPath: "pet/Hiyori/Hiyori.model3.json",
    presence: "quiet",
    bubble: false,
  });
});

test("卸载：删目录与记录；removeData:false 保留设置与状态", () => {
  const store = makeStore();
  store.install({ bytes: packageBytes() });
  store.writeState("heming.pet", { scale: 1.5, visible: true });
  store.patchSettings("heming.pet", { bubble: false });

  assert.deepEqual(store.uninstall("heming.pet", { removeData: false }), { ok: true });
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(path.join(store.dir, "heming.pet", "1.0.0")), false);
  assert.ok(fs.existsSync(path.join(store.dir, "heming.pet", "settings.json")));

  // 重装后用户设置还在（卸载只清代码，不删用户偏好）
  store.install({ bytes: packageBytes() });
  assert.equal(store.readSettings("heming.pet").bubble, false);

  store.uninstall("heming.pet");
  assert.equal(fs.existsSync(path.join(store.dir, "heming.pet")), false);
});

test("setEnabled：只改启用位，不动文件", () => {
  const store = makeStore();
  store.install({ bytes: packageBytes() });
  assert.equal(store.setEnabled("heming.pet", false).ok, true);
  assert.equal(store.get("heming.pet").enabled, false);
  assert.ok(fs.existsSync(path.join(store.dir, "heming.pet", "1.0.0", "files", "index.html")));
  assert.equal(store.setEnabled("nope", true).ok, false);
});

test("启动自检：版本目录被删的记录标 error 并停用（不去建一块打不开的透明窗）", () => {
  const store = makeStore();
  store.install({ bytes: packageBytes() });
  fs.rmSync(path.join(store.dir, "heming.pet", "1.0.0"), { recursive: true, force: true });

  const reopened = createPluginStore({ dir: store.dir });
  reopened.init();
  const [record] = reopened.list();
  assert.equal(record.enabled, false);
  assert.match(record.error, /文件缺失/);
});

/* ────────────────────────── 设置与状态 ────────────────────────── */

test("patchSettings：只接受清单声明的字段与合法取值（未知键/非法枚举一律丢弃）", () => {
  const store = makeStore();
  store.install({ bytes: packageBytes() });
  const next = store.patchSettings("heming.pet", {
    presence: "loud", // 不在 options 里
    bubble: "yes", // 类型不对
    evil: "x", // 未声明
    modelPath: "pet/Other.model3.json",
  });
  assert.equal(next.presence, "normal");
  assert.equal(next.bubble, true);
  assert.equal(next.evil, undefined);
  assert.equal(next.modelPath, "pet/Other.model3.json");
});

test("state：读写往返；seedLegacyState 幂等（已有 state 不覆盖）", () => {
  const store = makeStore();
  store.install({ bytes: packageBytes() });
  store.writeState("heming.pet", { scale: 1.25, visible: true, clickThrough: false });
  assert.deepEqual(store.readState("heming.pet"), { scale: 1.25, visible: true, clickThrough: false });

  assert.equal(store.seedLegacyState("heming.pet", { scale: 0.6, visible: false }), false);
  assert.equal(store.readState("heming.pet").scale, 1.25);

  const fresh = makeStore();
  fresh.install({ bytes: packageBytes() });
  assert.equal(fresh.seedLegacyState("heming.pet", { scale: 0.6, visible: true }), true);
  assert.deepEqual(fresh.readState("heming.pet"), { scale: 0.6, visible: true });
});

test("migrateLegacy：老 heming.pet.v1 并入 settings，幂等一次，不认识字段忽略", () => {
  const store = makeStore();
  store.install({ bytes: packageBytes() });
  const first = store.migrateLegacy({
    agentId: "agent-1",
    modelPath: "pet/Migrated.model3.json",
    presence: "quiet",
    unknownKey: "ignored",
    enabled: true,
  });
  assert.deepEqual(first, { ok: true, migrated: true });
  const settings = store.readSettings("heming.pet");
  assert.equal(settings.agentId, "agent-1");
  assert.equal(settings.modelPath, "pet/Migrated.model3.json");
  assert.equal(settings.presence, "quiet");
  assert.equal(settings.unknownKey, undefined);

  // 幂等：第二次不再覆盖用户后来改过的值
  store.patchSettings("heming.pet", { agentId: "agent-2" });
  assert.deepEqual(store.migrateLegacy({ agentId: "agent-1" }), { ok: true, migrated: false });
  assert.equal(store.readSettings("heming.pet").agentId, "agent-2");

  // 插件没装时也返回 ok（迁移不是错误路径）
  const empty = makeStore();
  assert.deepEqual(empty.migrateLegacy({ agentId: "x" }), { ok: true, migrated: false });
});

test("卸载：文件目录已缺失（自检标 error）的记录也能清掉，不抛错", () => {
  const store = makeStore();
  store.install({ bytes: packageBytes() });
  fs.rmSync(path.join(store.dir, "heming.pet"), { recursive: true, force: true });
  const reopened = createPluginStore({ dir: store.dir });
  reopened.init();
  assert.match(reopened.list()[0].error, /文件缺失/);
  assert.deepEqual(reopened.uninstall("heming.pet"), { ok: true });
  assert.deepEqual(reopened.list(), []);
});

test("migrateLegacy：旧 enabled:true 但 state 缺失/visible=false 时兜底可见（一次性）", () => {
  const store = makeStore();
  store.install({ bytes: packageBytes() });
  // 场景 A：pet-state.json 缺失（异常退出常见）
  store.migrateLegacy({ enabled: true, agentId: "a1" });
  assert.equal(store.readState("heming.pet").visible, true);

  // 场景 B：state 存在但 visible=false —— 老 enabled:true 说明用户是开着的
  const second = makeStore();
  second.install({ bytes: packageBytes() });
  second.writeState("heming.pet", { scale: 1.25, visible: false });
  second.migrateLegacy({ enabled: true });
  assert.equal(second.readState("heming.pet").visible, true);
  assert.equal(second.readState("heming.pet").scale, 1.25, "其它状态字段不能被覆盖");

  // 场景 C：用户明确关过（enabled:false）→ 不强行弹回来
  const third = makeStore();
  third.install({ bytes: packageBytes() });
  third.migrateLegacy({ enabled: false });
  assert.equal(third.readState("heming.pet"), null);
});
