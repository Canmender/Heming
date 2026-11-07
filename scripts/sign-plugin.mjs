#!/usr/bin/env node
/**
 * 插件清单签名工具（d.67，自签名 / TOFU，不是公开 CA）。
 *
 * 用法：
 *   node scripts/sign-plugin.mjs --gen-key
 *       生成一对 Ed25519 密钥，打印私钥（base64url，离线保存）与 publisher 片段。
 *   node scripts/sign-plugin.mjs sign <plugin.json> <private-key.b64url> [--id <发布者 id>] [--write]
 *       读取清单、按统一规范化算法签名，打印 { publisher, signature } 片段；
 *       带 --write 时就地写回 plugin.json（publisher 的 id 取清单已有的或 --id）。
 *
 * ★ 规范化算法必须与 `packages/web/src/lib/plugins/signature.ts` 的
 *   `signedManifestText` **逐字节一致**（同一套字段集合、键排序、无空白）。
 *   改任何一边都要同步另一边，否则本机验签会一直 invalid。
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ 规范化 */

/** 与 integrity.ts 的 stableValue 同款：递归键排序、丢弃 undefined、数组保序。 */
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) out[key] = stableValue(item);
    }
    return out;
  }
  return value;
}

export function canonicalJsonText(value) {
  return JSON.stringify(stableValue(value));
}

/* -------------------------------------------------- 与 parsePluginManifest 对齐 */

/**
 * 把作者手写的清单归一化成**应用解析后的形状**再签名。
 *
 * 为什么脚本也要做这一步：应用验签时拿到的是 `parsePluginManifest` 归一化后的
 * `PluginManifest`（可选字段补默认值、字符串 trim、列表去重/去空），
 * 而 plugin.json 里作者往往省略 `description`/`triggers` 等默认项。
 * 若脚本直接对手写 JSON 签名，应用侧算出的文本必然对不上——所以两边必须
 * 用同一套「字段集合 + 默认值 + trim/去重」口径。改这里要同步
 * `packages/web/src/lib/plugins/manifest.ts` 的归一化逻辑。
 */
function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniq(items) {
  return [...new Set(items.filter(Boolean))];
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return uniq(value.map(trim).filter(Boolean));
}

function normalizeManifest(manifest) {
  const permissions = manifest.permissions ?? {};
  const contributions = manifest.contributions ?? {};
  const network = Array.isArray(permissions.network) ? permissions.network : [];
  const files = Array.isArray(permissions.files) ? permissions.files : [];

  return {
    schemaVersion: manifest.schemaVersion,
    id: trim(manifest.id),
    name: trim(manifest.name),
    version: trim(manifest.version),
    description: trim(manifest.description),
    author: trim(manifest.author),
    permissions: {
      network: uniq(network.map((host) => trim(host).toLowerCase()).filter(Boolean)),
      tools: permissions.tools ?? "read",
      files: stringList(files),
    },
    contributions: {
      skills: (Array.isArray(contributions.skills) ? contributions.skills : []).map((skill) => ({
        name: trim(skill.name),
        description: trim(skill.description),
        instructions: trim(skill.instructions),
        triggers: stringList(skill.triggers),
        tags: stringList(skill.tags),
      })),
      mcpServers: (Array.isArray(contributions.mcpServers) ? contributions.mcpServers : []).map(
        (server) => ({
          key: trim(server.key),
          name: trim(server.name),
          url: trim(server.url),
          description: trim(server.description),
        }),
      ),
      commands: (Array.isArray(contributions.commands) ? contributions.commands : []).map(
        (command) => ({
          id: trim(command.id),
          title: trim(command.title),
          description: trim(command.description),
          keywords: stringList(command.keywords),
          target: normalizeTarget(command.target),
        }),
      ),
      toolPacks: (Array.isArray(contributions.toolPacks) ? contributions.toolPacks : []).map(
        (pack) => ({
          id: trim(pack.id),
          name: trim(pack.name),
          description: trim(pack.description),
          tools: (Array.isArray(pack.tools) ? pack.tools : []).map(trim),
        }),
      ),
      // d.88：v4 的模型接入预设也必须进规范化文本，否则签名与验签两边对不上。
      // 旧清单没有该字段 → 空数组（应用归一化后也恒为空数组）。
      llmPresets: (Array.isArray(contributions.llmPresets) ? contributions.llmPresets : []).map(
        (preset) => ({
          id: trim(preset.id),
          label: trim(preset.label),
          provider: preset.provider,
          baseUrl: trim(preset.baseUrl),
          model: trim(preset.model),
          note: trim(preset.note),
        }),
      ),
    },
  };
}

function normalizeTarget(target) {
  const kind = target?.kind;
  if (kind === "page") return { kind, page: trim(target.page) };
  if (kind === "skill") return { kind, name: trim(target.name) };
  if (kind === "plugin") return { kind };
  return { kind };
}

/** 与 signature.ts 的 signedManifestText 逐字节一致：含 publisher、排除 signature。 */
export function signedManifestText(manifest) {
  const normalized = normalizeManifest(manifest);
  return canonicalJsonText({
    id: normalized.id,
    version: normalized.version,
    name: normalized.name,
    description: normalized.description,
    author: normalized.author,
    publisher: manifest.publisher
      ? { id: trim(manifest.publisher.id), publicKey: trim(manifest.publisher.publicKey) }
      : null,
    permissions: normalized.permissions,
    contributions: normalized.contributions,
  });
}

/* ------------------------------------------------------------------- 密钥 */

/** Ed25519 私钥原始种子的 PKCS#8 DER 前缀（后 32 字节即 raw seed）。 */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** Ed25519 公钥 SPKI DER 前缀（后 32 字节即 raw public key）。 */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** 生成一对 Ed25519 密钥，返回 base64url 的 raw 私钥种子与 raw 公钥。 */
export function generateEd25519KeyPair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const spki = Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" }));
  const publicKey = spki.subarray(spki.length - 32);
  return {
    privateKey: seed.toString("base64url"),
    publicKey: publicKey.toString("base64url"),
  };
}

function privateKeyFromRawBase64Url(privateKeyBase64Url) {
  const raw = Buffer.from(String(privateKeyBase64Url), "base64url");
  if (raw.length !== 32) {
    throw new Error("私钥必须是 base64url 编码的 Ed25519 raw 32 字节种子");
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

/** 由私钥推导 raw 公钥（base64url），签名时生成/校验 publisher 公钥用。 */
export function publicKeyFromPrivate(privateKeyBase64Url) {
  const privateKey = privateKeyFromRawBase64Url(privateKeyBase64Url);
  const spki = Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" }));
  return spki.subarray(spki.length - 32).toString("base64url");
}

/**
 * 用私钥给清单签名，返回 `{ publisher, signature }`。
 * `publisherId` 必须给出（自签名的发布者 id 由作者决定，脚本不猜）。
 */
export function signManifest(manifest, privateKeyBase64Url) {
  if (!manifest || typeof manifest !== "object") throw new Error("清单必须是 JSON 对象");
  const publicKey = publicKeyFromPrivate(privateKeyBase64Url);
  const publisher = { id: trim(manifest.publisher?.id), publicKey };
  if (!publisher.id) {
    throw new Error("清单缺少 publisher.id，请先写入 publisher.id 或用 --id 指定发布者 id");
  }
  const signingInput = { ...manifest, publisher };
  const text = signedManifestText(signingInput);
  const privateKey = privateKeyFromRawBase64Url(privateKeyBase64Url);
  const value = nodeSign(null, Buffer.from(text, "utf8"), privateKey).toString("base64url");
  return { publisher, signature: { alg: "ed25519", value } };
}

/* -------------------------------------------------------------------- CLI */

const USAGE = `用法：
  node scripts/sign-plugin.mjs --gen-key
  node scripts/sign-plugin.mjs sign <plugin.json> <private-key.b64url> [--id <发布者 id>] [--write]

说明：
  --gen-key  生成 Ed25519 密钥对，打印私钥（base64url）与 publisher 片段
  sign       给清单签名；--write 就地写回，否则只打印 { publisher, signature } 片段`;

function runCli(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(USAGE);
    return;
  }
  if (args.includes("--gen-key")) {
    const pair = generateEd25519KeyPair();
    console.log("私钥（base64url，请离线保存，不要提交或分享）：");
    console.log(pair.privateKey);
    console.log("");
    console.log("publisher 片段（把 your-publisher-id 换成你的发布者 id）：");
    console.log(
      JSON.stringify(
        { publisher: { id: "your-publisher-id", publicKey: pair.publicKey } },
        null,
        2,
      ),
    );
    return;
  }

  if (args[0] !== "sign") throw new Error(`未知命令：${args[0]}\n\n${USAGE}`);
  const file = args[1];
  const privateKey = args[2];
  if (!file || !privateKey) throw new Error(`缺少参数\n\n${USAGE}`);

  const idFlag = args.indexOf("--id");
  const publisherId = idFlag >= 0 ? args[idFlag + 1] : undefined;
  const write = args.includes("--write");

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`读不到或解析不了清单 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (publisherId) manifest.publisher = { id: publisherId, publicKey: manifest.publisher?.publicKey ?? "" };
  const { publisher, signature } = signManifest(manifest, privateKey);
  const signed = { ...manifest, publisher, signature };
  if (write) {
    writeFileSync(file, `${JSON.stringify(signed, null, 2)}\n`, "utf8");
    console.log(`已签名并写回：${file}`);
    console.log(`发布者：${publisher.id} · 公钥指纹见应用内安装弹窗`);
    return;
  }
  console.log(JSON.stringify({ publisher, signature }, null, 2));
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    runCli(process.argv);
  } catch (error) {
    console.error(`签名失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
