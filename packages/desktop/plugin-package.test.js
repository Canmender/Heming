"use strict";
// 测试用开发公钥（正式包默认拒绝 dev-* 公钥，这里显式放开）。
process.env.HEMING_ALLOW_DEV_PLUGIN_KEYS = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { createPrivateKey, sign: nodeSign } = require("node:crypto");
const { packTarGz, writeTar, readTar, safeRelativePath } = require("./plugin-tar");
const { canonicalManifestText } = require("./plugin-signature");
const {
  readPackage,
  packPackage,
  validateLayout,
  validateBundleManifest,
  sha256Hex,
} = require("./plugin-package");

/* ────────────────────────── 夹具 ────────────────────────── */

function baseManifest(overrides = {}) {
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
          scales: [0.6, 0.8, 1, 1.25, 1.5],
          defaultScale: 1,
          transparent: true,
          alwaysOnTop: true,
          skipTaskbar: true,
          clickThrough: "auto",
        },
      ],
    },
    ...overrides,
  };
}

function packageEntries(manifest = baseManifest(), files) {
  const extraFiles = files || [
    { path: "files/index.html", data: "<!doctype html><title>pet</title>" },
    { path: "files/assets/app.js", data: "console.log('pet')" },
  ];
  return [{ path: "plugin.json", data: JSON.stringify(manifest) }, ...extraFiles];
}

/* ── 首方签名夹具（d.105）：与 resources/official-keys.json 的 dev-test-2026-11 对应 ── */

/** Ed25519 私钥原始种子的 PKCS#8 DER 前缀。 */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const DEV_PRIVATE_KEY = "eQpmY52b_n7e7rpNrJzr4jT5U5CUZuZCuVe08XRGc7Q";
const DEV_PUBLIC_KEY = "CwlX79Lc-Il4jvWK1sxhH-zxj9CLn5KD_CCpjp3rOl0";

/** 用开发/测试私钥给清单签名（正式发布用 scripts/sign-plugin.mjs，算法逐字节同一套）。 */
function signManifestForTest(manifest, privateKeyBase64Url = DEV_PRIVATE_KEY) {
  const withPublisher = { ...manifest, publisher: { id: "heming", publicKey: DEV_PUBLIC_KEY } };
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(privateKeyBase64Url, "base64url")]),
    format: "der",
    type: "pkcs8",
  });
  const value = nodeSign(null, Buffer.from(canonicalManifestText(withPublisher), "utf8"), privateKey).toString("base64url");
  return { ...withPublisher, signature: { alg: "ed25519", value } };
}

/** 已签名的 baseManifest（bundle 安装用例的默认夹具）。 */
function signedBaseManifest(overrides = {}) {
  return signManifestForTest(baseManifest(overrides));
}

/** 手工拼一个带指定 typeflag 的 tar（用来构造符号链接/硬链接这类恶意条目）。 */
function tarEntry({ name, data = Buffer.alloc(0), typeflag = "0", linkname = "" }) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(typeflag, 156, 1, "ascii");
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const pad = data.length % 512 === 0 ? 0 : 512 - (data.length % 512);
  return Buffer.concat([header, data, Buffer.alloc(pad, 0)]);
}

function gzipTar(entries) {
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024, 0)]), { level: 9 });
}

/* ────────────────────────── tar 基础（plugin-tar） ────────────────────────── */

test("确定性：同一份内容不同顺序产出同一串字节（发布侧 sha256 依赖它）", () => {
  const a = [{ path: "files/b.js", data: "b" }, { path: "files/a.js", data: "a" }];
  const b = [{ path: "files/a.js", data: "a" }, { path: "files/b.js", data: "b" }];
  const tarA = writeTar(a);
  const tarB = writeTar(b);
  assert.deepEqual(tarA, tarB);
  assert.deepEqual(packTarGz(a), packTarGz(b));
  assert.equal(sha256Hex(packTarGz(a)), sha256Hex(packTarGz(b)));
});

test("tar 往返：读回来的路径与内容一致", () => {
  const entries = [{ path: "plugin.json", data: "{}" }, { path: "files/a.bin", data: Buffer.from([0, 1, 2]) }];
  const restored = readTar(writeTar(entries));
  assert.deepEqual(restored.map((item) => item.path), ["files/a.bin", "plugin.json"]);
  assert.deepEqual(restored[0].data, Buffer.from([0, 1, 2]));
});

test("路径穿越：写与读都拒绝（safeRelativePath 是唯一口径）", () => {
  assert.equal(safeRelativePath("../evil.js"), null);
  assert.equal(safeRelativePath("files/../../evil.js"), null);
  assert.equal(safeRelativePath("/etc/passwd"), null);
  assert.equal(safeRelativePath("C:\\x\\y"), "C:/x/y"); // 盘符在 POSIX 视角是普通相对段，包内结构校验会再拒
  assert.throws(() => writeTar([{ path: "../evil.js", data: "x" }]), /非法路径/);
  const evil = gzipTar([tarEntry({ name: "../evil.js", data: Buffer.from("x") })]);
  assert.throws(() => readTar(zlib.gunzipSync(evil)), /非法路径/);
});

test("符号链接 / 硬链接条目一律拒绝（安装不允许指向包外）", () => {
  const symlink = gzipTar([tarEntry({ name: "files/link", typeflag: "2", linkname: "/etc/passwd" })]);
  assert.throws(() => readTar(zlib.gunzipSync(symlink)), /不允许的条目类型/);
  const hardlink = gzipTar([tarEntry({ name: "files/hard", typeflag: "1", linkname: "files/index.html" })]);
  assert.throws(() => readTar(zlib.gunzipSync(hardlink)), /不允许的条目类型/);
});

test("配额：单文件 / 文件数 / 总量超限都拒绝（可注入更小上限）", () => {
  const oneFile = gzipTar([tarEntry({ name: "files/a.bin", data: Buffer.alloc(64, 1) })]);
  assert.throws(() => readTar(zlib.gunzipSync(oneFile), { maxFileBytes: 32 }), /单文件超过上限/);
  const twoFiles = gzipTar([
    tarEntry({ name: "files/a.bin", data: Buffer.alloc(8, 1) }),
    tarEntry({ name: "files/b.bin", data: Buffer.alloc(8, 1) }),
  ]);
  assert.throws(() => readTar(zlib.gunzipSync(twoFiles), { maxFiles: 1 }), /文件数量超过上限/);
  assert.throws(() => readTar(zlib.gunzipSync(twoFiles), { maxTotalBytes: 10 }), /解包总量超过上限/);
});

test("截断：缺少结束块拒绝；头部校验和错拒绝", () => {
  const complete = zlib.gunzipSync(packTarGz([{ path: "files/a.txt", data: "hello" }]));
  const truncated = complete.subarray(0, complete.length - 1024);
  assert.throws(() => readTar(truncated), /缺少结束块/);

  const tampered = Buffer.from(complete);
  tampered[0] = tampered[0] === 0x66 ? 0x67 : 0x66; // 改文件名首字节，校验和必然不匹配
  assert.throws(() => readTar(tampered), /校验和/);

  assert.throws(() => readTar(Buffer.alloc(0)), /内容为空/);
});

/* ────────────────────────── 包结构与清单 ────────────────────────── */

test("包的合法形状：根 plugin.json + files/**，roundtrip 后可安装（bundle 需已签名）", () => {
  const entries = packageEntries(signedBaseManifest());
  const parsed = readPackage(packPackage(entries));
  assert.equal(parsed.ok, true, parsed.errors && parsed.errors.join("；"));
  assert.equal(parsed.manifest.id, "heming.pet");
  assert.equal(parsed.widget.id, "pet");
  assert.equal(parsed.signed, true);
  assert.equal(parsed.publisherId, "heming");
  assert.equal(parsed.signatureKeyId, "dev-test-2026-11");
  assert.ok(parsed.files.some((file) => file.path === "files/index.html"));
  assert.equal(parsed.sha256, sha256Hex(packPackage(entries)));
});

test("包内结构：plugin.json 不在根 / 多余的顶层路径 / 没有 files/ 都拒绝", () => {
  const layout = validateLayout([
    { path: "nested/plugin.json", data: Buffer.from("{}") },
    { path: "readme.md", data: Buffer.from("x") },
  ]);
  assert.equal(layout.ok, false);
  assert.match(layout.errors.join("；"), /根缺少 plugin.json|非法路径/);

  const noFiles = validateLayout([{ path: "plugin.json", data: Buffer.from("{}") }]);
  assert.equal(noFiles.ok, false);
  assert.match(noFiles.errors.join("；"), /没有 files\//);
});

test("清单守卫：schemaVersion 必须 4、distribution 必须 bundle、不允许技能/服务/工具束", () => {
  assert.equal(validateBundleManifest(baseManifest()).ok, true);
  for (const bad of [
    baseManifest({ schemaVersion: 3 }),
    baseManifest({ distribution: undefined }),
    baseManifest({ contributions: { desktopWidgets: baseManifest().contributions.desktopWidgets, skills: [{ name: "x" }] } }),
    baseManifest({ contributions: {} }),
  ]) {
    assert.equal(validateBundleManifest(bad).ok, false);
  }
});

test("清单守卫：permissions 逐项受控（events/graphics/eval/network）", () => {
  const ok = validateBundleManifest(baseManifest());
  assert.deepEqual(ok.permissions.events, ["notify"]);
  assert.equal(ok.permissions.eval, false);

  const badEvents = baseManifest({ permissions: { ...baseManifest().permissions, events: ["exec"] } });
  assert.match(validateBundleManifest(badEvents).errors.join("；"), /events 含未知项/);
  const badGraphics = baseManifest({ permissions: { ...baseManifest().permissions, graphics: ["cuda"] } });
  assert.match(validateBundleManifest(badGraphics).errors.join("；"), /graphics 含未知项/);
  const noTool = baseManifest({ permissions: { ...baseManifest().permissions, tools: "admin" } });
  assert.equal(validateBundleManifest(noTool).ok, false);
});

test("清单守卫：permissions.events 接受 lifecycle（d.108），未知事件仍拒绝", () => {
  const withLifecycle = baseManifest({
    permissions: { ...baseManifest().permissions, events: ["notify", "lifecycle"] },
  });
  const ok = validateBundleManifest(withLifecycle);
  assert.equal(ok.ok, true, ok.errors.join("；"));
  assert.deepEqual(ok.permissions.events, ["notify", "lifecycle"]);

  // 未知事件（如 hook）仍然拒绝，且错误文案列出允许值
  const unknown = baseManifest({
    permissions: { ...baseManifest().permissions, events: ["lifecycle", "hook"] },
  });
  const bad = validateBundleManifest(unknown);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("；"), /events 含未知项：hook/);
  assert.match(bad.errors.join("；"), /允许：notify \/ lifecycle/);
});

test("首方验签：无签名 / 冒名密钥 / 签名后篡改都拒绝；合法签名通过并记 keyId", () => {
  // 1) 未签名 bundle → 拒绝（d.105 起不再「结构上带签名即可」）
  const unsigned = readPackage(packPackage(packageEntries(baseManifest())));
  assert.equal(unsigned.ok, false);
  assert.match(unsigned.errors.join("；"), /未通过首方签名（publisher: 未知）/);
  assert.match(unsigned.errors.join("；"), /未签名/);

  // 2) 结构不对的签名 → 清单守卫先给字段级错误（不进入密码学验签）
  const signatureOnly = baseManifest({
    signature: { alg: "ed25519", value: "A".repeat(86) },
  });
  assert.equal(validateBundleManifest(signatureOnly).ok, false); // 有签名必须有 publisher

  const badAlg = baseManifest({
    publisher: { id: "heming", publicKey: "B".repeat(43) },
    signature: { alg: "rsa", value: "C".repeat(86) },
  });
  assert.match(validateBundleManifest(badAlg).errors.join("；"), /signature\.alg 只支持 ed25519/);

  // 3) 用非首方私钥签名、却自称 heming → 拒绝（信任锚是内置公钥表，不是 publisher 字段）
  const attacker = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.alloc(32, 7)]), format: "der", type: "pkcs8" });
  const forged = { ...baseManifest(), publisher: { id: "heming", publicKey: DEV_PUBLIC_KEY } };
  forged.signature = {
    alg: "ed25519",
    value: nodeSign(null, Buffer.from(canonicalManifestText(forged), "utf8"), attacker).toString("base64url"),
  };
  const forgedPkg = readPackage(packPackage(packageEntries(forged)));
  assert.equal(forgedPkg.ok, false);
  assert.match(forgedPkg.errors.join("；"), /未通过首方签名（publisher: heming）/);
  assert.match(forgedPkg.errors.join("；"), /不匹配/);

  // 4) 签名后改内容 → 拒绝
  const signedManifest = signedBaseManifest();
  const tampered = { ...signedManifest, description: "签名之后被改过的描述" };
  const tamperedPkg = readPackage(packPackage(packageEntries(tampered)));
  assert.equal(tamperedPkg.ok, false);
  assert.match(tamperedPkg.errors.join("；"), /未通过首方签名/);

  // 5) 合法签名 → 通过，记录 signed / publisherId / keyId
  const signed = readPackage(packPackage(packageEntries(signedManifest)));
  assert.equal(signed.ok, true, signed.errors && signed.errors.join("；"));
  assert.equal(signed.signed, true);
  assert.equal(signed.publisherId, "heming");
  assert.equal(signed.signatureKeyId, "dev-test-2026-11");
});

test("entry / icon 必须真的在包里（不存在的入口 = 一块打不开的透明窗）", () => {
  const noEntry = readPackage(
    packPackage([
      { path: "plugin.json", data: JSON.stringify(signedBaseManifest()) },
      { path: "files/other.txt", data: "not the entry" },
    ]),
  );
  assert.equal(noEntry.ok, false);
  assert.match(noEntry.errors.join("；"), /entry 不存在/);

  const iconManifest = baseManifest();
  iconManifest.contributions.desktopWidgets[0].icon = "files/icon.png";
  const noIcon = readPackage(packPackage(packageEntries(signManifestForTest(iconManifest))));
  assert.equal(noIcon.ok, false);
  assert.match(noIcon.errors.join("；"), /icon 不存在/);
});

test("sha256：给了 expectedSha256 就必须一致，不一致拒绝且不返回内容", () => {
  const bytes = packPackage(packageEntries(signedBaseManifest()));
  const wrong = readPackage(bytes, { expectedSha256: "0".repeat(64) });
  assert.equal(wrong.ok, false);
  assert.match(wrong.errors.join("；"), /指纹不一致/);
  const right = readPackage(bytes, { expectedSha256: sha256Hex(bytes) });
  assert.equal(right.ok, true, right.errors && right.errors.join("；"));
});

test("bundle 命令 target：允许 page/plugin/settings/unit，拒绝 skill 并给字段路径（d.109）", () => {
  const command = (target) => ({ id: "open", title: "打开", target });
  const withCommands = (targets) =>
    baseManifest({ contributions: { ...baseManifest().contributions, commands: targets.map(command) } });

  // 合法：四种目标（settings 带 card、unit 带合法 unitId）
  const ok = validateBundleManifest(
    withCommands([
      { kind: "page", page: "plugins" },
      { kind: "plugin" },
      { kind: "settings", card: "appearance" },
      { kind: "unit", unitId: "heming.pet" },
    ]),
  );
  assert.equal(ok.ok, true, ok.errors.join("；"));

  // bundle 不贡献技能 → skill 目标没有可解析对象，拒绝（带字段路径）
  const skill = validateBundleManifest(withCommands([{ kind: "skill", name: "x" }]));
  assert.equal(skill.ok, false);
  assert.match(skill.errors.join("；"), /target\.kind 只允许 page \/ plugin \/ settings \/ unit/);
  assert.match(skill.errors.join("；"), /收到 skill/);

  const missingKind = validateBundleManifest(withCommands([{ page: "plugins" }]));
  assert.equal(missingKind.ok, false);
  assert.match(missingKind.errors.join("；"), /contributions\.commands\[0\]\.target 必须是/);

  const pageNoPath = validateBundleManifest(withCommands([{ kind: "page" }]));
  assert.match(pageNoPath.errors.join("；"), /target\.page 必须是非空文本/);

  // settings 缺 card / unitId 非法 → 字段路径级错误
  const settingsNoCard = validateBundleManifest(withCommands([{ kind: "settings" }]));
  assert.match(settingsNoCard.errors.join("；"), /contributions\.commands\[0\]\.target\.card 必须是非空文本/);
  const badUnit = validateBundleManifest(withCommands([{ kind: "unit", unitId: "Heming.Pet" }]));
  assert.match(badUnit.errors.join("；"), /contributions\.commands\[0\]\.target\.unitId/);

  // 命令 id / title 缺失 → 面板无法展示，直接拒绝
  const noTitle = withCommands([]);
  noTitle.contributions.commands = [{ id: "open", target: { kind: "plugin" } }];
  assert.match(validateBundleManifest(noTitle).errors.join("；"), /commands\[0\]\.title 必须是非空文本/);

  const pluginWithName = validateBundleManifest(withCommands([{ kind: "plugin", name: "x" }]));
  assert.match(pluginWithName.errors.join("；"), /不应再带 name/);

  // 合法命令 + 已签名 → 可安装，且 readPackage 返回规范化后的命令（供命令面板物化）
  const manifest = withCommands([
    { kind: "settings", card: "appearance" },
    { kind: "unit", unitId: "heming.pet" },
    { kind: "page", page: "plugins" },
    { kind: "plugin" },
  ]);
  const pkg = readPackage(packPackage(packageEntries(signManifestForTest(manifest))));
  assert.equal(pkg.ok, true, pkg.errors && pkg.errors.join("；"));
  assert.deepEqual(
    pkg.commands.map((item) => item.target),
    [
      { kind: "settings", card: "appearance" },
      { kind: "unit", unitId: "heming.pet" },
      { kind: "page", page: "plugins" },
      { kind: "plugin" },
    ],
  );
  assert.equal(pkg.commands[0].id, "open");
  assert.equal(pkg.commands[0].title, "打开");
});

test("纯声明式包不要求首方签名（bundle 专属要求；声明式走 web 侧 TOFU，不进这条链路）", () => {
  const declarative = baseManifest({ distribution: "manifest" });
  const check = validateBundleManifest(declarative);
  assert.equal(check.ok, false);
  assert.match(check.errors.join("；"), /必须声明 distribution: "bundle"/);
  assert.doesNotMatch(check.errors.join("；"), /首方签名|signature/);

  // 安装链路同样只报 distribution 错误，不会要求签名（防止把纯声明式包误伤）
  const pkg = readPackage(packPackage(packageEntries(declarative)));
  assert.equal(pkg.ok, false);
  assert.doesNotMatch(pkg.errors.join("；"), /未通过首方签名/);
});

test("坏包：不是 gzip / 空内容都拒绝，且不抛错", () => {
  assert.equal(readPackage(Buffer.from("not a tgz")).ok, false);
  assert.equal(readPackage(Buffer.alloc(0)).ok, false);
  assert.equal(readPackage(null).ok, false);
});
