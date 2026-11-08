"use strict";
// 测试用开发公钥（正式包默认拒绝 dev-* 公钥，这里显式放开）。
process.env.HEMING_ALLOW_DEV_PLUGIN_KEYS = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createPrivateKey,
  generateKeyPairSync,
  sign: nodeSign,
} = require("node:crypto");
const {
  DEFAULT_KEYS_FILE,
  canonicalJsonText,
  canonicalManifestText,
  canonicalVersionOf,
  loadOfficialKeys,
  verifyOfficialSignature,
} = require("./plugin-signature");

/* ────────────────────────── 夹具 ────────────────────────── */

/** Ed25519 私钥原始种子的 PKCS#8 DER 前缀（后 32 字节即 raw seed）。 */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * 开发/测试用密钥对（与 `resources/official-keys.json` 的 `dev-test-2026-11` 对应）。
 * 私钥只存在于测试夹具，**绝不可用于真实发布**；正式私钥只在发布 CI/HSM。
 */
const DEV_PRIVATE_KEY = "eQpmY52b_n7e7rpNrJzr4jT5U5CUZuZCuVe08XRGc7Q";
const DEV_PUBLIC_KEY = "CwlX79Lc-Il4jvWK1sxhH-zxj9CLn5KD_CCpjp3rOl0";

/**
 * 被签名的 v4 清单（heming.pet 1.0.1 形状）。
 *
 * 这里的字段顺序/缩进都故意与线上 `plugin.json` 不同——签名文本是「规范化后」的，
 * 原文件排版不该影响验签结果。
 */
const PINNED_MANIFEST = {
  schemaVersion: 4,
  id: "heming.pet",
  name: "桌宠",
  version: "1.0.1",
  description: "桌面上的 Live2D 化身：关掉主窗口它还在，点它就能说话，有消息它会提醒。",
  author: "和鸣",
  distribution: "bundle",
  // 审计 P0-1：签名覆盖的 files/** 内容摘要（真实值由打包/签名工具计算）
  packageSha256: "ab".repeat(32),
  // d.113：events 加 theme（P1-5 门禁）与 chat 权限位（P0-1，受签名保护）
  permissions: {
    network: [],
    tools: "none",
    files: [],
    events: ["notify", "theme"],
    graphics: ["webgl", "wasm"],
    eval: true,
    chat: true,
  },
  contributions: {
    desktopWidgets: [
      {
        id: "pet",
        name: "桌宠",
        entry: "files/index.html",
        width: 300,
        height: 420,
        scales: [0.6, 0.8, 1, 1.25, 1.5],
        defaultScale: 1,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        clickThrough: "auto",
        position: { anchor: "bottom-right", margin: 24, remember: true },
        icon: "files/icon.png",
      },
    ],
    commands: [],
    skills: [],
    mcpServers: [],
    toolPacks: [],
  },
};

/**
 * ★ 交叉校验锚点：canonical-v1 文本与签名由 **web 侧算法**（`scripts/sign-plugin.mjs`
 * 的 `signedManifestText`，与 `packages/web/src/lib/plugins/signature.ts` 有逐字节相等测试）
 * 对上面这份清单生成。主进程的 canonicalizer 必须复现同一串字节。
 *
 * 生成方式（改动 canonical 规则时重新生成并同时改三处：
 * `integrity.ts` / `signature.ts` / 本文件）：
 *   node -e "import('./scripts/sign-plugin.mjs').then(...)" 见仓库 d.105 记录
 */
const FIXTURE_TEXT =
  '{"author":"和鸣","contributions":{"commands":[],"desktopWidgets":[{"alwaysOnTop":true,"clickThrough":"auto",' +
  '"defaultScale":1,"entry":"files/index.html","height":420,"icon":"files/icon.png","id":"pet","name":"桌宠",' +
  '"position":{"anchor":"bottom-right","margin":24,"remember":true},"resizable":false,' +
  '"scales":[0.6,0.8,1,1.25,1.5],"skipTaskbar":true,"transparent":true,"width":300}],' +
  '"llmPresets":[],"mcpServers":[],"skills":[],"toolPacks":[]},' +
  '"description":"桌面上的 Live2D 化身：关掉主窗口它还在，点它就能说话，有消息它会提醒。",' +
  '"id":"heming.pet","name":"桌宠",' +
  '"packageSha256":"abababababababababababababababababababababababababababababababab",' +
  '"permissions":{"chat":true,"eval":true,"events":["notify","theme"],"files":[],' +
  '"graphics":["webgl","wasm"],"network":[],"tools":"none"},' +
  '"publisher":{"id":"heming","publicKey":"CwlX79Lc-Il4jvWK1sxhH-zxj9CLn5KD_CCpjp3rOl0"},"version":"1.0.1"}';
const FIXTURE_SIGNATURE =
  "iACOHMlR37PLKrDs_mzzI5NHCokTUIgVAXS6LS-orDA3bJa1NHfAx5PWSooh_XfbHfQADzmW0lBOtKqvJaG2CQ";

/** 带 publisher（+ 可选签名）的清单。 */
function withPublisher(manifest, publisher = { id: "heming", publicKey: DEV_PUBLIC_KEY }) {
  return { ...manifest, publisher };
}

/** 用指定私钥给清单签名，返回带 publisher + signature 的完整清单。 */
function signForTest(manifest, privateKeyBase64Url = DEV_PRIVATE_KEY, publisher = { id: "heming", publicKey: DEV_PUBLIC_KEY }) {
  const withPub = { ...manifest, publisher };
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(privateKeyBase64Url, "base64url")]),
    format: "der",
    type: "pkcs8",
  });
  const value = nodeSign(null, Buffer.from(canonicalManifestText(withPub), "utf8"), privateKey).toString("base64url");
  return { ...withPub, signature: { alg: "ed25519", value } };
}

function tempKeysFile(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heming-official-keys-"));
  const file = path.join(dir, "official-keys.json");
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
  return file;
}

/** 生成一对与首方公钥表无关的密钥（模拟攻击者自造密钥对）。 */
function attackerKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
  const spki = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  return {
    privateKey: pkcs8.subarray(pkcs8.length - 32).toString("base64url"),
    publicKey: spki.subarray(spki.length - 32).toString("base64url"),
  };
}

/* ────────────────────────── canonical 文本 ────────────────────────── */

test("canonical-v1：与 web 侧算法逐字节一致（pinned fixture 交叉校验）", () => {
  const text = canonicalManifestText(withPublisher(PINNED_MANIFEST));
  assert.equal(text, FIXTURE_TEXT);
  assert.deepEqual(JSON.parse(text).publisher, { id: "heming", publicKey: DEV_PUBLIC_KEY });
});

test("canonical 文本不受字段顺序 / 空白 / signature / 未覆盖字段影响", () => {
  const reordered = JSON.parse(JSON.stringify(withPublisher(PINNED_MANIFEST)));
  const signed = { ...reordered, signature: { alg: "ed25519", value: FIXTURE_SIGNATURE } };
  const extra = { ...signed, engines: { heming: "d.105" }, meta: { category: "fun" } };
  assert.equal(canonicalManifestText(reordered), FIXTURE_TEXT);
  assert.equal(canonicalManifestText(signed), FIXTURE_TEXT);
  // v4 用 v1：engines/meta/distribution 不参与签名
  assert.equal(canonicalManifestText(extra), FIXTURE_TEXT);
  assert.equal(canonicalJsonText({ b: 1, a: undefined, c: [2, 1] }), '{"b":1,"c":[2,1]}');
});

test("canonical-v1：packageSha256 参与签名（审计 P0-1：签名绑定包内代码字节）", () => {
  const changed = { ...withPublisher(PINNED_MANIFEST), packageSha256: "cd".repeat(32) };
  assert.notEqual(canonicalManifestText(changed), FIXTURE_TEXT);
  assert.ok(canonicalManifestText(changed).includes(`"packageSha256":"${"cd".repeat(32)}"`));

  // 只改 packageSha256（保留原签名）→ 验签必须失败；反过来改动包内摘要无法逃过签名
  const signed = { ...withPublisher(PINNED_MANIFEST), signature: { alg: "ed25519", value: FIXTURE_SIGNATURE } };
  assert.equal(verifyOfficialSignature(signed).ok, true);
  const tampered = { ...signed, packageSha256: "cd".repeat(32) };
  assert.equal(verifyOfficialSignature(tampered).ok, false);
  assert.match(verifyOfficialSignature(tampered).reason, /不匹配/);

  // 声明式包没有该字段 → canonical 文本不变（旧签名不受影响）
  const declarative = { ...withPublisher(PINNED_MANIFEST) };
  delete declarative.packageSha256;
  assert.ok(!canonicalManifestText(declarative).includes("packageSha256"));
});

test("canonical：permissions.chat 受签名保护（审计 P0-1，翻转权限位必须验签失败）", () => {
  const signed = signForTest(PINNED_MANIFEST);
  assert.equal(verifyOfficialSignature(signed).ok, true);
  // 把 chat 从 true 改 false（试图撤权）或反之都会改变 canonical 文本 → 验签失败
  const flipped = { ...signed, permissions: { ...signed.permissions, chat: false } };
  assert.equal(verifyOfficialSignature(flipped).ok, false);
  assert.match(verifyOfficialSignature(flipped).reason, /不匹配/);
  // 未开通（false/缺省）时不进 canonical 文本 → 旧签名不失效
  const noChat = { ...withPublisher(PINNED_MANIFEST) };
  noChat.permissions = { ...noChat.permissions, chat: false };
  assert.ok(!canonicalManifestText(noChat).includes('"chat"'));
});

test("canonical-v2：v5 清单额外覆盖 engines / meta / distribution / packageSha256", () => {
  const v5 = {
    schemaVersion: 5,
    id: "heming.pet",
    name: "桌宠",
    version: "2.0.0",
    description: "v5 清单",
    author: "和鸣",
    distribution: "bundle",
    engines: { heming: "d.105" },
    meta: { category: "fun", tags: ["pet"] },
    packageSha256: "ef".repeat(32),
    permissions: { network: [], tools: "none", files: [], events: [], graphics: [], eval: false },
    contributions: { desktopWidgets: [{ id: "pet", name: "桌宠", entry: "files/index.html", width: 300, height: 420 }] },
  };
  assert.equal(canonicalVersionOf(v5), 2);
  assert.equal(canonicalVersionOf(PINNED_MANIFEST), 1);
  const parsed = JSON.parse(canonicalManifestText(withPublisher(v5)));
  assert.deepEqual(parsed.engines, { heming: "d.105" });
  assert.deepEqual(parsed.meta, { category: "fun", tags: ["pet"] });
  assert.equal(parsed.distribution, "bundle");
  assert.equal(parsed.packageSha256, "ef".repeat(32));
  assert.equal(parsed.publisher.id, "heming");
});

/* ────────────────────────── 验签 ────────────────────────── */

test("验签：签名字节与内置公钥表匹配 → ok，并回报 keyId", () => {
  const manifest = signForTest(PINNED_MANIFEST);
  const keysFile = tempKeysFile({ _comment: "测试公钥表", "dev-test-2026-11": DEV_PUBLIC_KEY });
  const result = verifyOfficialSignature(manifest, { keysFile });
  assert.deepEqual(result, { ok: true, keyId: "dev-test-2026-11" });
  // 出厂 resources/official-keys.json 必须能验同一份签名（防止发版漏带/写错）
  assert.deepEqual(verifyOfficialSignature(manifest), { ok: true, keyId: "dev-test-2026-11" });
});

test("验签：pinned 签名（由 web 侧算法生成）可直接通过", () => {
  const manifest = {
    ...withPublisher(PINNED_MANIFEST),
    signature: { alg: "ed25519", value: FIXTURE_SIGNATURE },
  };
  assert.deepEqual(verifyOfficialSignature(manifest), { ok: true, keyId: "dev-test-2026-11" });
});

test("验签：签名后篡改清单 → 失败且提示不匹配", () => {
  const manifest = signForTest(PINNED_MANIFEST);
  const tampered = { ...manifest, description: "改过的描述" };
  const result = verifyOfficialSignature(tampered);
  assert.equal(result.ok, false);
  assert.match(result.reason, /不匹配/);
  // 改权限同样应失败（权限是最该防篡改的字段）
  const tamperedPerm = { ...manifest, permissions: { ...manifest.permissions, eval: false } };
  assert.equal(verifyOfficialSignature(tamperedPerm).ok, false);
});

test("验签：无签名 / 非 ed25519 / 坏 base64url / 长度不对 → 失败关闭", () => {
  const base = withPublisher(PINNED_MANIFEST);
  assert.match(verifyOfficialSignature(base).reason, /未签名/);
  assert.match(verifyOfficialSignature({ ...base, signature: { alg: "rsa", value: "A".repeat(86) } }).reason, /只支持 ed25519/);
  assert.match(verifyOfficialSignature({ ...base, signature: { alg: "ed25519", value: "A".repeat(86) } }).reason, /不匹配|64 字节/);
  assert.match(verifyOfficialSignature({ ...base, signature: { alg: "ed25519", value: "not base64url!" } }).reason, /不匹配|base64url|64 字节/);
  assert.match(verifyOfficialSignature({ ...base, signature: { alg: "ed25519", value: "AAAA" } }).reason, /64 字节/);
  assert.equal(verifyOfficialSignature(null).ok, false);
});

test("验签：攻击者自造密钥对 + 自称官方 → 失败（公钥只信内置表，不信 publisher）", () => {
  const attacker = attackerKeyPair();
  const manifest = signForTest(PINNED_MANIFEST, attacker.privateKey, { id: "heming", publicKey: attacker.publicKey });
  const result = verifyOfficialSignature(manifest);
  assert.equal(result.ok, false);
  assert.match(result.reason, /不匹配/);
});

test("验签：换钥语义——旧钥签的包在新公钥表下失败，新钥通过", () => {
  const next = attackerKeyPair(); // 模拟「新一把正式钥」
  const keysFile = tempKeysFile({ "official-2026-11": next.publicKey });
  const oldSigned = signForTest(PINNED_MANIFEST);
  assert.equal(verifyOfficialSignature(oldSigned, { keysFile }).ok, false);
  const newSigned = signForTest(PINNED_MANIFEST, next.privateKey, { id: "heming", publicKey: next.publicKey });
  assert.deepEqual(verifyOfficialSignature(newSigned, { keysFile }), { ok: true, keyId: "official-2026-11" });
  // 双钥过渡：新旧都留在表里时两者都能验
  const both = tempKeysFile({ "dev-test-2026-11": DEV_PUBLIC_KEY, "official-2026-11": next.publicKey });
  assert.equal(verifyOfficialSignature(oldSigned, { keysFile: both }).ok, true);
  assert.equal(verifyOfficialSignature(newSigned, { keysFile: both }).ok, true);
});

test("公钥表：缺失 / 非 JSON / 公钥损坏 / 空表 都失败关闭", () => {
  const missing = path.join(os.tmpdir(), `heming-no-such-keys-${Date.now()}.json`);
  assert.match(verifyOfficialSignature(signForTest(PINNED_MANIFEST), { keysFile: missing }).reason, /公钥表不可读/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heming-bad-keys-"));
  const notJson = path.join(dir, "a.json");
  fs.writeFileSync(notJson, "{ nope");
  assert.match(verifyOfficialSignature(signForTest(PINNED_MANIFEST), { keysFile: notJson }).reason, /不是合法 JSON/);

  const badKey = path.join(dir, "b.json");
  fs.writeFileSync(badKey, JSON.stringify({ "official-x": "AAAA" }));
  assert.match(verifyOfficialSignature(signForTest(PINNED_MANIFEST), { keysFile: badKey }).reason, /不是合法的 32 字节/);

  const empty = path.join(dir, "c.json");
  fs.writeFileSync(empty, JSON.stringify({ _comment: "只有注释" }));
  assert.match(verifyOfficialSignature(signForTest(PINNED_MANIFEST), { keysFile: empty }).reason, /为空/);
});

test("公钥表：loadOfficialKeys 跳过 `_` 注释键，出厂文件可加载", () => {
  const loaded = loadOfficialKeys(DEFAULT_KEYS_FILE);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.keys.map((item) => item.keyId), ["official-2026-11", "dev-test-2026-11"]);
  assert.equal(loaded.hasProductionKey, true);
});

test("开发公钥保护：打包版忽略 dev-* 公钥，显式放开/正式钥才通过", () => {
  const manifest = signForTest(PINNED_MANIFEST);

  // 出厂表里同时有 official 与 dev：dev 签名在正式环境必须**不匹配**（不能因表里有正式钥就接受 dev 签名）
  const refused = verifyOfficialSignature(manifest, { allowDevKeys: false });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /签名与任何首方公钥都不匹配/);

  assert.equal(verifyOfficialSignature(manifest, { allowDevKeys: true }).ok, true);

  // 只有 dev 键的表 + 正式环境：明确报「只有开发调试公钥」
  const onlyDevDir = fs.mkdtempSync(path.join(os.tmpdir(), "heming-dev-only-keys-"));
  const onlyDev = path.join(onlyDevDir, "keys.json");
  const devPublic = JSON.parse(fs.readFileSync(DEFAULT_KEYS_FILE, "utf8"))["dev-test-2026-11"];
  fs.writeFileSync(onlyDev, JSON.stringify({ "dev-only-x": devPublic }));
  const onlyDevRefused = verifyOfficialSignature(manifest, {
    keysFile: onlyDev,
    allowDevKeys: false,
  });
  assert.equal(onlyDevRefused.ok, false);
  assert.match(onlyDevRefused.reason, /只有开发调试公钥|签名与任何首方公钥都不匹配/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heming-mixed-keys-"));
  const mixed = path.join(dir, "keys.json");
  const devKey = JSON.parse(fs.readFileSync(DEFAULT_KEYS_FILE, "utf8"))["dev-test-2026-11"];
  fs.writeFileSync(mixed, JSON.stringify({ "official-test": devKey }));
  assert.equal(verifyOfficialSignature(manifest, { keysFile: mixed, allowDevKeys: false }).ok, true);
});
