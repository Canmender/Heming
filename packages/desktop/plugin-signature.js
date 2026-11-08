"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createPublicKey, verify: nodeVerify } = require("node:crypto");

/**
 * 首方 bundle 签名的**规范化 + 验签**（d.105，规格 §7.1）。
 *
 * ## 为什么这里要复制一份 canonicalizer（而不是 require web/shared）
 * 主进程是 CommonJS、web 侧规范化是 TS/ESM，Electron 45 的 `require(esm)` 不能赌；
 * 而「渲染层算好文本传进来再验签」等于把可信字节交给不可信进程，等于没验。
 * 所以主进程保留**逐字节独立实现**，再用 pinned fixture 与 web 侧算法交叉校验
 * （见 `plugin-signature.test.js` 的 `FIXTURE`：canonical 文本与签名都由
 * `scripts/sign-plugin.mjs` 生成，而该脚本与 `signature.ts` 的
 * `signedManifestText` 有逐字节相等测试）。任何一边改算法都必须同时改这边，
 * 否则线上验签会集体失败。
 *
 * ## 签名覆盖哪些字节（版本化，别乱动）
 * - **canonical-v1**（`schemaVersion < 5`，即 v1–v4；bundle 目前只可能是 v4）：
 *   `{id,version,name,description,author,publisher,permissions,contributions,packageSha256}`。
 *   与 web 的 `signedManifestText` 一致：**含 publisher、不含 signature**；
 *   其中 `publisher` 为 `{id, publicKey}` 或 `null`（未签名时）。
 *   `packageSha256`（审计 P0-1）是 `files/**` 的内容摘要，让签名**间接覆盖代码字节**；
 *   声明式包没有该字段（序列化时丢弃，旧签名文本不变）。
 * - **canonical-v2**（`schemaVersion >= 5`）：在 v1 字段之外再加
 *   `{engines,meta,distribution}`（规格 §7.1：v5 包用 canonical-v2，
 *   否则旧签名会集体失效）。`packageSha256` 两版都覆盖。
 *
 * 字段值先按 web 的归一化规则处理（trim / 去重 / 默认值 / 桌面小组件默认值），
 * 再走 `canonicalJsonText`（递归键排序、无空白、丢弃 `undefined`、数组保序）。
 * 归一化规则**复制自 `scripts/sign-plugin.mjs` 的 `normalizeManifest`**——那是
 * 当前唯一在用的发布签名工具；不复制它，`heming.pet` 1.0.1 就会「签名有效但验不过」。
 *
 * ## 信任锚与失败关闭
 * 公钥只来自 `resources/official-keys.json`（`{ keyId: base64url(32B raw Ed25519 公钥) }`，
 * `_` 开头的键是注释）。**绝不**用 `manifest.publisher.publicKey` 验签：清单里的公钥
 * 是发布者自己填的展示信息，任何人都能自造一对密钥并自称官方。
 * 缺公钥表 / 表损坏 / 签名格式不对 / 没有任何一把钥匹配 → 一律 `ok: false`（失败关闭），
 * 调用方必须拒绝安装。
 *
 * ## 诚实边界
 * 签名只证明「这些字节由持有对应私钥的一方签过、且之后没被改」，**不证明**发布者身份
 * （无 CA/账号体系）、不保证代码无漏洞、也无法实时吊销私钥（吊销靠随应用发版下发
 * 新公钥表 / 最低版本，规格 §7.1/§7.2 明确不做在线吊销）。
 */

/** Ed25519 公钥 SPKI DER 头；拼上 raw 32 字节即合法 SPKI。 */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** 开发调试公钥的 keyId 前缀：私钥在仓库测试夹具里，打包版必须拒绝。 */
const DEV_KEY_PREFIX = "dev-";

/** 是否开发调试公钥。 */
function isDevKeyId(keyId) {
  return typeof keyId === "string" && keyId.startsWith(DEV_KEY_PREFIX);
}

/** 内置首方公钥表（electron-builder 需把该文件打进包，见 package.json build.files）。 */
const DEFAULT_KEYS_FILE = path.join(__dirname, "resources", "official-keys.json");

/* ────────────────────────── 规范化 JSON ────────────────────────── */

/** 递归规范化为「键排序、丢 undefined」的普通值（数组顺序保留）。 */
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

/** 规范化 JSON 文本：键排序、无空白、丢弃 `undefined`（与 web `canonicalJsonText` 同语义）。 */
function canonicalJsonText(value) {
  return JSON.stringify(stableValue(value));
}

/* ─────────────────── 清单归一化（与发布签名工具逐字节一致） ─────────────────── */

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

/**
 * 桌面小组件声明（v4）→ 应用解析后的形状。
 *
 * 这些默认值必须与 `manifest.ts` 的 zod 默认值、`scripts/sign-plugin.mjs` 的
 * `normalizeDesktopWidget` 完全一致，否则 v4 bundle 的签名与验签对不上。
 */
function normalizeDesktopWidget(widget) {
  const position = (widget && widget.position) || {};
  const tray = widget && widget.tray;
  const settings = widget && widget.settings;
  return {
    id: trim(widget && widget.id),
    name: trim(widget && widget.name),
    entry: trim(widget && widget.entry),
    width: widget && widget.width,
    height: widget && widget.height,
    scales: (Array.isArray(widget && widget.scales) ? widget.scales : []).map(Number),
    defaultScale: typeof (widget && widget.defaultScale) === "number" ? widget.defaultScale : 1,
    transparent: (widget && widget.transparent) === true,
    alwaysOnTop: (widget && widget.alwaysOnTop) === true,
    skipTaskbar: (widget && widget.skipTaskbar) === true,
    resizable: (widget && widget.resizable) === true,
    clickThrough: (widget && widget.clickThrough) ?? "none",
    position: {
      anchor: trim(position.anchor) || "bottom-right",
      margin: typeof position.margin === "number" ? position.margin : 24,
      remember: position.remember !== false,
    },
    ...(widget && widget.icon ? { icon: trim(widget.icon) } : {}),
    ...(tray
      ? {
          tray: {
            icon: trim(tray.icon),
            items: Array.isArray(tray.items) ? tray.items.map(trim) : ["toggle", "settings"],
          },
        }
      : {}),
    ...(settings
      ? {
          settings: {
            ...(settings.title ? { title: trim(settings.title) } : {}),
            fields: (Array.isArray(settings.fields) ? settings.fields : []).map((field) => ({
              key: trim(field.key),
              label: trim(field.label),
              type: field.type,
              ...(field.default !== undefined ? { default: field.default } : {}),
              ...(Array.isArray(field.options)
                ? {
                    options: field.options.map((option) => ({
                      value: trim(option.value),
                      label: trim(option.label),
                    })),
                  }
                : {}),
            })),
          },
        }
      : {}),
  };
}

function normalizeCommandTarget(target) {
  const kind = target && target.kind;
  if (kind === "page") return { kind, page: trim(target.page) };
  if (kind === "skill") return { kind, name: trim(target.name) };
  if (kind === "plugin") return { kind };
  return { kind };
}

/** 清单 → 参与签名 v1 字段的归一化形状（复制自 sign-plugin.mjs，勿单独改）。 */
function normalizeManifest(manifest) {
  const permissions = (manifest && manifest.permissions) || {};
  const contributions = (manifest && manifest.contributions) || {};
  const network = Array.isArray(permissions.network) ? permissions.network : [];
  const files = Array.isArray(permissions.files) ? permissions.files : [];
  return {
    id: trim(manifest && manifest.id),
    version: trim(manifest && manifest.version),
    name: trim(manifest && manifest.name),
    description: trim(manifest && manifest.description),
    author: trim(manifest && manifest.author),
    permissions: {
      network: uniq(network.map((host) => trim(host).toLowerCase()).filter(Boolean)),
      tools: permissions.tools ?? "read",
      files: stringList(files),
      events: stringList(permissions.events),
      graphics: stringList(permissions.graphics),
      eval: permissions.eval === true,
      // 审计 P0-1：permissions.chat 是受签名保护的权限位。**只在 true 时进入文本**：
      // 声明式/未开通的包保持旧 canonical 字节（历史签名不失效），但任何人把
      // false 翻成 true 都会改变签名文本 → 验签失败（无法悄悄提权）。
      ...(permissions.chat === true ? { chat: true } : {}),
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
          target: normalizeCommandTarget(command.target),
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
      desktopWidgets: (Array.isArray(contributions.desktopWidgets)
        ? contributions.desktopWidgets
        : []
      ).map(normalizeDesktopWidget),
      // d.90：清单里的 llmPresets 会被应用丢弃，签名文本恒为空数组。
      llmPresets: [],
    },
  };
}

/** 清单用哪一版 canonical：v5 起用 v2（覆盖 engines/meta/distribution），否则 v1。 */
function canonicalVersionOf(manifest) {
  const version = Number(manifest && manifest.schemaVersion);
  return Number.isFinite(version) && version >= 5 ? 2 : 1;
}

/**
 * 参与签名的规范化文本（UTF-8 字节 = `Buffer.from(text)`）。
 *
 * v1 与 web `signedManifestText` 逐字节一致（含 publisher、不含 signature）；
 * v2 在其上追加 `engines` / `meta` / `distribution`（原样规范化，不做 v5 默认值补全）。
 */
function canonicalManifestText(manifest) {
  const normalized = normalizeManifest(manifest);
  const rawPublisher = manifest && manifest.publisher;
  const publisher =
    rawPublisher && typeof rawPublisher === "object"
      ? { id: trim(rawPublisher.id), publicKey: trim(rawPublisher.publicKey) }
      : null;
  const fields = {
    id: normalized.id,
    version: normalized.version,
    name: normalized.name,
    description: normalized.description,
    author: normalized.author,
    publisher,
    permissions: normalized.permissions,
    contributions: normalized.contributions,
    // 审计 P0-1：签名必须覆盖包内代码字节——`packageSha256` 是 files/** 的内容摘要，
    // 放进签名文本即「间接签全部代码」。声明式包没有该字段，键被 canonicalJsonText
    // 丢弃，旧签名文本不变（向后兼容）。
    packageSha256: typeof manifest.packageSha256 === "string" ? manifest.packageSha256.trim() : undefined,
  };
  if (canonicalVersionOf(manifest) === 2) {
    fields.engines = manifest.engines;
    fields.meta = manifest.meta;
    fields.distribution = manifest.distribution;
  }
  return canonicalJsonText(fields);
}

/* ────────────────────────── 公钥表与验签 ────────────────────────── */

/** 把 base64url 的 raw 32 字节公钥转成 KeyObject；非法返回 null。 */
function publicKeyFromRaw(rawBase64Url) {
  if (typeof rawBase64Url !== "string" || !rawBase64Url) return null;
  let raw;
  try {
    raw = Buffer.from(rawBase64Url, "base64url");
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

/**
 * 读取首方公钥表：`{ keyId: base64url(32B) }`，`_` 开头的键视为注释忽略。
 *
 * @returns {{ ok: true, keys: Array<{keyId: string, key: object}> } | { ok: false, reason: string }}
 */
function loadOfficialKeys(keysFile) {
  const file = typeof keysFile === "string" && keysFile ? keysFile : DEFAULT_KEYS_FILE;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, reason: `首方公钥表不可读：${file}（${(err && err.message) || err}）` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { ok: false, reason: `首方公钥表不是合法 JSON：${file}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: `首方公钥表必须是 { keyId: base64url } 对象：${file}` };
  }
  const keys = [];
  for (const [keyId, value] of Object.entries(parsed)) {
    if (keyId.startsWith("_")) continue; // `_comment` 之类的说明字段
    const key = publicKeyFromRaw(value);
    if (!key) {
      // 单个键损坏不静默跳过：那会让「换钥时写错一位」变成「签名莫名失效」。
      return { ok: false, reason: `首方公钥 ${keyId} 不是合法的 32 字节 base64url Ed25519 公钥` };
    }
    keys.push({ keyId, key });
  }
  if (keys.length === 0) return { ok: false, reason: `首方公钥表为空：${file}` };
  /**
   * 开发公钥 = keyId 以 `dev-` 开头的条目。这类密钥的私钥在仓库测试夹具里
   * （任何拿到仓库的人都能签出「首方」包），所以**打包后的应用必须拒绝**：
   * 只要公钥表里没有任何非 dev 键，就要求显式 `HEMING_ALLOW_DEV_PLUGIN_KEYS=1`
   * （本地 `electron .` 开发时由主进程设置；正式包不设）。
   */
  const hasProductionKey = keys.some((item) => !isDevKeyId(item.keyId));
  return { ok: true, keys, hasProductionKey };
}

/**
 * 验证 `manifest.signature` 是否由任一内置首方公钥签出。
 *
 * @param {object} manifest 解析后的 `plugin.json`
 * @param {{ keysFile?: string, allowDevKeys?: boolean }} [options] `keysFile`/`allowDevKeys` 仅测试与本地开发用，生产走默认路径且不放开 dev 公钥
 * @returns {{ ok: boolean, keyId?: string, reason?: string }}
 */
function verifyOfficialSignature(manifest, options = {}) {
  try {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return { ok: false, reason: "清单不是 JSON 对象，无法验签" };
    }
    const signature = manifest.signature;
    if (signature === undefined) return { ok: false, reason: "未签名" };
    if (!signature || typeof signature !== "object" || Array.isArray(signature)) {
      return { ok: false, reason: "signature 必须是对象" };
    }
    if (signature.alg !== "ed25519") {
      return { ok: false, reason: `不支持的签名算法：${String(signature.alg)}（只支持 ed25519）` };
    }
    if (typeof signature.value !== "string" || !signature.value) {
      return { ok: false, reason: "signature.value 缺失或不是文本" };
    }
    let signatureBytes;
    try {
      signatureBytes = Buffer.from(signature.value, "base64url");
    } catch {
      return { ok: false, reason: "signature.value 不是合法的 base64url" };
    }
    if (signatureBytes.length !== 64) {
      return { ok: false, reason: `signature.value 不是 64 字节 Ed25519 签名（收到 ${signatureBytes.length}）` };
    }

    const loaded = loadOfficialKeys(options.keysFile);
    if (!loaded.ok) return { ok: false, reason: loaded.reason };
    const allowDevKeys =
      options.allowDevKeys !== undefined
        ? options.allowDevKeys === true
        : process.env.HEMING_ALLOW_DEV_PLUGIN_KEYS === "1";
    if (!loaded.hasProductionKey && !allowDevKeys) {
      return {
        ok: false,
        reason:
          "首方公钥表里只有开发调试公钥（dev-*），正式版拒绝安装界面插件；" +
          "本地开发可设 HEMING_ALLOW_DEV_PLUGIN_KEYS=1（正式发版前必须换成正式公钥）",
      };
    }

    const data = Buffer.from(canonicalManifestText(manifest), "utf8");
    /**
     * 打包版**跳过 dev-* 公钥**：即使公钥表里同时有正式钥，也不能让「仓库里公开的
     * 测试私钥」签出的包被正式版接受（否则 dev 私钥 = 后门）。本地开发由
     * `main.js` 在未打包时设 HEMING_ALLOW_DEV_PLUGIN_KEYS=1 显式放开。
     */
    let triedKeys = 0;
    for (const { keyId, key } of loaded.keys) {
      if (!allowDevKeys && isDevKeyId(keyId)) continue;
      triedKeys += 1;
      let valid = false;
      try {
        valid = nodeVerify(null, data, key, signatureBytes);
      } catch {
        valid = false; // 单把公钥验签抛错按「这把不匹配」处理，继续试下一把
      }
      if (valid) return { ok: true, keyId };
    }
    if (triedKeys === 0) {
      return {
        ok: false,
        reason:
          "公钥表里只有开发调试公钥（dev-*），打包版不接受；本地开发可设 HEMING_ALLOW_DEV_PLUGIN_KEYS=1" +
          "（正式发版必须用 official-* 公钥签名）",
      };
    }
    const publisherId =
      manifest.publisher && typeof manifest.publisher.id === "string"
        ? manifest.publisher.id.trim()
        : "";
    return {
      ok: false,
      reason: `签名与任何首方公钥都不匹配${publisherId ? `（publisher: ${publisherId}）` : ""}`,
    };
  } catch (err) {
    return { ok: false, reason: `验签失败：${(err && err.message) || err}` };
  }
}

module.exports = {
  DEFAULT_KEYS_FILE,
  isDevKeyId,
  canonicalJsonText,
  canonicalManifestText,
  canonicalVersionOf,
  loadOfficialKeys,
  verifyOfficialSignature,
};
