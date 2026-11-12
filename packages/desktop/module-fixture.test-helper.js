"use strict";
/**
 * 模块包测试夹具：用临时生成的 Ed25519 密钥签一份 module.json，并打成 tgz。
 * 文件名不以 `.test.js` 结尾，`node --test` 不会把它当测试跑。
 *
 * 这里的「模块」只指信息中枢 Python 引擎包（web 模块体系已下线）；夹具供
 * module-package / module-store / module-download / infohub-engine 的用例复用。
 */

const { createHash, createPublicKey, generateKeyPairSync, sign } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { packTarGz } = require("./plugin-tar");
const { canonicalManifestText } = require("./plugin-signature");
const { computeFilesDigest } = require("./plugin-package");

const KEY_ID = "dev-test-fixture";

function rawPublicKey(privateKey) {
  const spki = Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" }));
  return spki.subarray(spki.length - 32).toString("base64url");
}

/**
 * @param {object} [options]
 * @param {Record<string, string|Buffer>} [options.files] 相对 `files/` 的文件表
 * @param {object} [options.manifest] 覆盖清单字段
 * @returns {{bytes: Buffer, keysFile: string, manifest: object, publicKey: string, privateKey: object}}
 */
function makeSignedModule({ files, manifest: overrides } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyRaw = rawPublicKey(privateKey);
  const fileMap = files ?? {
    "app/infohub/__init__.py": "__version__ = '0.0.0'\n",
    "lib/vendor/__init__.py": "",
  };
  const entries = Object.entries(fileMap).map(([rel, data]) => ({
    path: `files/${rel}`,
    data: Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"),
  }));

  const manifest = {
    schemaVersion: 4,
    id: "heming.infohub-engine",
    name: "信息中枢引擎",
    version: "1.0.0",
    description: "测试用引擎包",
    author: "和鸣",
    publisher: { id: "heming-test", publicKey: publicKeyRaw },
    permissions: { network: [], tools: "none", files: [] },
    contributions: {},
    distribution: "module",
    meta: { kind: "module", entry: "app", lib: "lib" },
    packageSha256: computeFilesDigest(entries),
    ...(overrides ?? {}),
  };
  manifest.signature = {
    alg: "ed25519",
    value: sign(null, Buffer.from(canonicalManifestText(manifest), "utf8"), privateKey).toString(
      "base64url",
    ),
  };

  const bytes = packTarGz([
    { path: "module.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") },
    ...entries,
  ]);

  const keysFile = join(
    require("node:os").tmpdir(),
    `heming-module-keys-${process.pid}-${createHash("sha256").update(publicKeyRaw).digest("hex").slice(0, 8)}.json`,
  );
  writeFileSync(keysFile, JSON.stringify({ [KEY_ID]: publicKeyRaw }), "utf8");
  return { bytes, keysFile, manifest, publicKey: publicKeyRaw, privateKey };
}

module.exports = { KEY_ID, makeSignedModule };
