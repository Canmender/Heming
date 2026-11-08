"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { packTarGz, writeTar, readTar, safeRelativePath } = require("./plugin-tar");
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

test("包的合法形状：根 plugin.json + files/**，roundtrip 后可安装", () => {
  const parsed = readPackage(packPackage(packageEntries()));
  assert.equal(parsed.ok, true, parsed.errors && parsed.errors.join("；"));
  assert.equal(parsed.manifest.id, "heming.pet");
  assert.equal(parsed.widget.id, "pet");
  assert.equal(parsed.signed, false);
  assert.ok(parsed.files.some((file) => file.path === "files/index.html"));
  assert.equal(parsed.sha256, sha256Hex(packPackage(packageEntries())));
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

test("签名可选：无签名可装（signed:false）；带坏结构直接拒；带合法结构记 signed:true", () => {
  const unsigned = readPackage(packPackage(packageEntries()));
  assert.equal(unsigned.ok, true);
  assert.equal(unsigned.signed, false);

  const signatureOnly = baseManifest({
    signature: { alg: "ed25519", value: "A".repeat(86) },
  });
  assert.equal(validateBundleManifest(signatureOnly).ok, false); // 有签名必须有 publisher

  const badAlg = baseManifest({
    publisher: { id: "heming", publicKey: "B".repeat(43) },
    signature: { alg: "rsa", value: "C".repeat(86) },
  });
  assert.match(validateBundleManifest(badAlg).errors.join("；"), /signature\.alg 只支持 ed25519/);

  const signedManifest = baseManifest({
    publisher: { id: "heming", publicKey: "B".repeat(43) },
    signature: { alg: "ed25519", value: "C".repeat(86) },
  });
  const signed = readPackage(packPackage(packageEntries(signedManifest)));
  assert.equal(signed.ok, true);
  assert.equal(signed.signed, true);
  assert.equal(signed.publisherId, "heming");
});

test("entry / icon 必须真的在包里（不存在的入口 = 一块打不开的透明窗）", () => {
  const noEntry = readPackage(
    packPackage([
      { path: "plugin.json", data: JSON.stringify(baseManifest()) },
      { path: "files/other.txt", data: "not the entry" },
    ]),
  );
  assert.equal(noEntry.ok, false);
  assert.match(noEntry.errors.join("；"), /entry 不存在/);

  const manifestWithIcon = baseManifest();
  manifestWithIcon.contributions.desktopWidgets[0].icon = "files/icon.png";
  const noIcon = readPackage(packPackage(packageEntries(manifestWithIcon)));
  assert.equal(noIcon.ok, false);
  assert.match(noIcon.errors.join("；"), /icon 不存在/);
});

test("sha256：给了 expectedSha256 就必须一致，不一致拒绝且不返回内容", () => {
  const bytes = packPackage(packageEntries());
  const wrong = readPackage(bytes, { expectedSha256: "0".repeat(64) });
  assert.equal(wrong.ok, false);
  assert.match(wrong.errors.join("；"), /指纹不一致/);
  const right = readPackage(bytes, { expectedSha256: sha256Hex(bytes) });
  assert.equal(right.ok, true);
});

test("坏包：不是 gzip / 空内容都拒绝，且不抛错", () => {
  assert.equal(readPackage(Buffer.from("not a tgz")).ok, false);
  assert.equal(readPackage(Buffer.alloc(0)).ok, false);
  assert.equal(readPackage(null).ok, false);
});
