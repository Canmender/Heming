"use strict";

const { createHash } = require("node:crypto");
const { packTarGz, unpackTarGz, LIMITS } = require("./plugin-tar");
const { normalizeWidgetSpec, MAX_WIDGETS_PER_PLUGIN } = require("./plugin-window");

/**
 * 界面插件包（`package.tgz`）的读取、结构校验与清单守卫（纯函数 + node:crypto）。
 *
 * 分工（见规格 §2.1 / §2.2）：
 * - `plugin-tar.js` 只负责「tar/gzip 格式正确 + 单条边界安全」；
 * - **本文件**负责「这是不是一个合法的界面插件包」：包内结构（`plugin.json` 在根 +
 *   `files/**`）、清单里**宿主真正会用到**的字段（v4 / bundle / desktopWidgets /
 *   permissions / 第一方签名标记）、entry 与图标确实在包里。
 *
 * ★ 为什么不复用 web 侧的 zod 清单校验：`plugin.json` 落盘后是用户机器上的文件，
 *   第三方可以改；主进程建窗、放 CSP、决定 unsafe-eval 都依赖这份清单，所以必须在
 *   主进程里独立再判一次「我能拿它做什么」（纵深防御）。完整语义校验（安装预览、
 *   错误路径展示、信任弹窗）仍归 web 侧 `manifest.ts`——两边职责不同，不是重复。
 *
 * ★ 本文件不校验 ed25519 签名本身（那是 web 侧 `signature.ts` + 官方公钥白名单的事）；
 *   主进程只要求 bundle **结构上带 publisher + signature**，并由可信主窗通道断言
 *   「已验签 / 第一方」。原因见 `docs/PLUGINS.md` 信任模型：主窗已经是安装流程的信任根。
 */

/** 包里允许的两种顶层路径：根清单与 files/ 下的资源。 */
const MANIFEST_PATH = "plugin.json";
const FILE_ROOT = "files/";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_DESCRIPTION = 200;
const MAX_NAME = 64;
const MAX_AUTHOR = 64;

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

const ALLOWED_EVENTS = new Set(["notify"]);
const ALLOWED_GRAPHICS = new Set(["webgl", "webgl2", "wasm"]);
const ALLOWED_TOOLS = new Set(["none", "read", "write"]);

/** sha256 十六进制（整包字节的完整性指纹；发布侧算的也是这个）。 */
function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return null;
}

/**
 * 包内结构校验：`plugin.json` 必须在根、其余全部在 `files/` 下。
 *
 * @param {Array<{path: string, data: Buffer}>} entries
 * @returns {{ ok: boolean, errors: string[], manifestEntry: object|null }}
 */
function validateLayout(entries) {
  const errors = [];
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, errors: ["插件包是空的"], manifestEntry: null };
  }
  let manifestEntry = null;
  for (const entry of entries) {
    const path = entry && entry.path;
    if (typeof path !== "string") {
      errors.push("插件包含非法条目");
      continue;
    }
    if (path === MANIFEST_PATH) {
      if (manifestEntry) errors.push("插件包根出现了重复的 plugin.json");
      else manifestEntry = entry;
      continue;
    }
    if (!path.startsWith(FILE_ROOT)) {
      errors.push(`插件包含非法路径：${path}（只允许根 plugin.json 与 files/**）`);
    }
  }
  if (!manifestEntry) errors.push("插件包根缺少 plugin.json");
  if (!entries.some((entry) => typeof entry.path === "string" && entry.path.startsWith(FILE_ROOT))) {
    errors.push("插件包没有 files/ 目录内容");
  }
  if (manifestEntry && manifestEntry.data.length > MAX_MANIFEST_BYTES) {
    errors.push(`plugin.json 超过 ${MAX_MANIFEST_BYTES} 字节`);
  }
  return { ok: errors.length === 0, errors, manifestEntry };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 主进程侧的清单守卫（v4 / bundle / desktopWidgets / permissions / 签名标记）。
 *
 * 返回 `{ ok, errors, manifest, widget, permissions, distribution }`；
 * `widget` 只有在 `ok` 时才可用（已过 `normalizeWidgetSpec`）。
 *
 * @param {unknown} raw 解析后的 plugin.json
 * @param {{}} [options] 预留（本轮无强制签名开关；信任门在主窗侧）
 */
function validateBundleManifest(raw, options = {}) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ["plugin.json 必须是 JSON 对象"], manifest: null };

  if (raw.schemaVersion !== 4) {
    errors.push(`界面插件必须使用 schemaVersion: 4（收到 ${String(raw.schemaVersion)}）`);
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!ID_RE.test(id)) errors.push("id 只能用小写字母、数字、点、下划线和连字符（≤64）");
  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  if (!VERSION_RE.test(version)) errors.push("version 缺失或含非法字符（≤64）");
  if (raw.name !== undefined && (typeof raw.name !== "string" || raw.name.length > MAX_NAME)) {
    errors.push(`name 必须是不超过 ${MAX_NAME} 字的文本`);
  }
  if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > MAX_DESCRIPTION)) {
    errors.push(`description 必须是不超过 ${MAX_DESCRIPTION} 字的文本`);
  }
  if (raw.author !== undefined && (typeof raw.author !== "string" || raw.author.length > MAX_AUTHOR)) {
    errors.push(`author 必须是不超过 ${MAX_AUTHOR} 字的文本`);
  }

  const distribution = raw.distribution === undefined ? "manifest" : raw.distribution;
  if (distribution !== "bundle") {
    errors.push("界面插件清单必须声明 distribution: \"bundle\"（带文件）");
  }

  /* ── 来源：签名**可选**，带则做结构校验 ── */
  /*
   * 为什么不强制签名（P0 口径，规格 §6.7）：本轮没有官方密钥管理与签名分发链，
   * `lib/plugins/signature.ts` 是 TOFU（首次安装由主窗弹窗确认是否信任该发布者）。
   * 硬性要求签名会让 `heming.pet` 只能靠开发态开关安装，真机与发布链路都不成立。
   *
   * 信任门在**主窗侧**：只有「官方云端目录的 bundle」或「用户本地显式导入并二次确认」
   * 才允许调 `widgets:install`；主进程这条通道只认可信主窗（见文件头 trust root 说明），
   * 这里只负责「结构坏了直接拒」与「记录 signed 供 UI 展示」。
   */
  const publisher = raw.publisher;
  const signature = raw.signature;
  const signed = signature !== undefined;
  if (signed) {
    // 有签名必须有发布者：验签公钥只能来自 publisher，缺了就无法判断签名有效性
    if (!isPlainObject(publisher)) {
      errors.push("有 signature 时必须同时提供 publisher（否则无法确定验签公钥）");
    } else {
      if (typeof publisher.id !== "string" || !publisher.id.trim()) {
        errors.push("publisher.id 必须是非空文本");
      }
      if (typeof publisher.publicKey !== "string" || !BASE64URL_RE.test(publisher.publicKey)) {
        errors.push("publisher.publicKey 必须是 base64url 文本");
      }
    }
    if (!isPlainObject(signature)) {
      errors.push("signature 必须是对象");
    } else {
      if (signature.alg !== "ed25519") {
        errors.push("signature.alg 只支持 ed25519");
      }
      if (typeof signature.value !== "string" || !BASE64URL_RE.test(signature.value)) {
        errors.push("signature.value 必须是 base64url 文本");
      }
    }
  } else if (publisher !== undefined && !isPlainObject(publisher)) {
    errors.push("publisher 必须是对象");
  }

  /* ── permissions ── */
  const permissionsRaw = isPlainObject(raw.permissions) ? raw.permissions : {};
  const network = Array.isArray(permissionsRaw.network) ? permissionsRaw.network : [];
  if (network.length > 20) errors.push("permissions.network 最多 20 个主机");
  const networkHosts = [];
  for (const host of network) {
    if (typeof host !== "string" || !host.trim() || host.length > 253) {
      errors.push("permissions.network 每项必须是主机文本（≤253）");
      continue;
    }
    networkHosts.push(host.trim().toLowerCase());
  }
  const tools = permissionsRaw.tools === undefined ? "none" : permissionsRaw.tools;
  if (!ALLOWED_TOOLS.has(tools)) errors.push(`permissions.tools 只能是 ${[...ALLOWED_TOOLS].join(" / ")}`);
  const files = Array.isArray(permissionsRaw.files) ? permissionsRaw.files : [];
  if (files.length > 5) errors.push("permissions.files 最多 5 项（本轮仅展示）");
  const events = Array.isArray(permissionsRaw.events) ? permissionsRaw.events : [];
  const badEvents = events.filter((item) => !ALLOWED_EVENTS.has(item));
  if (badEvents.length > 0) errors.push(`permissions.events 含未知项：${badEvents.join(", ")}`);
  const graphics = Array.isArray(permissionsRaw.graphics) ? permissionsRaw.graphics : [];
  const badGraphics = graphics.filter((item) => !ALLOWED_GRAPHICS.has(item));
  if (badGraphics.length > 0) errors.push(`permissions.graphics 含未知项：${badGraphics.join(", ")}`);

  /* ── contributions：只允许 commands + desktopWidgets（界面插件不贡献技能/服务/工具束） ── */
  const contributionsRaw = isPlainObject(raw.contributions) ? raw.contributions : {};
  for (const kind of ["skills", "mcpServers", "toolPacks"]) {
    const value = contributionsRaw[kind];
    if (value !== undefined && (!Array.isArray(value) || value.length > 0)) {
      errors.push(`界面插件不允许声明 contributions.${kind}`);
    }
  }
  if (contributionsRaw.commands !== undefined && !Array.isArray(contributionsRaw.commands)) {
    errors.push("contributions.commands 必须是数组");
  }
  const widgetsRaw = contributionsRaw.desktopWidgets;
  let widget = null;
  if (!Array.isArray(widgetsRaw) || widgetsRaw.length === 0) {
    errors.push("界面插件必须声明 contributions.desktopWidgets（至少 1 个）");
  } else if (widgetsRaw.length > MAX_WIDGETS_PER_PLUGIN) {
    errors.push(`本轮一个插件最多声明 ${MAX_WIDGETS_PER_PLUGIN} 个 desktopWidget`);
  } else {
    const normalized = normalizeWidgetSpec(widgetsRaw[0], 0);
    if (!normalized.ok) errors.push(...normalized.errors);
    widget = normalized.spec;
  }

  const permissions = {
    network: networkHosts,
    tools,
    files: files.filter((item) => typeof item === "string"),
    events: events.filter((item) => ALLOWED_EVENTS.has(item)),
    graphics: graphics.filter((item) => ALLOWED_GRAPHICS.has(item)),
    eval: permissionsRaw.eval === true,
  };

  return {
    ok: errors.length === 0,
    errors,
    manifest: raw,
    widget,
    permissions,
    distribution,
    signed: signed === true,
    publisherId: isPlainObject(publisher) && typeof publisher.id === "string" ? publisher.id.trim() : null,
  };
}

/**
 * 读取并校验一个 `package.tgz`（安装端唯一入口）。
 *
 * 顺序（任一步失败都不产生半可用状态）：
 * sha256（调用方先做）→ gunzip/tar 配额 → 包内结构 → plugin.json 解析 → 清单守卫 →
 * entry/图标存在性。
 *
 * @param {Buffer|ArrayBuffer|Uint8Array} bytes
 * @param {{ expectedSha256?: string, limits?: object }} [options]
 */
function readPackage(bytes, options = {}) {
  const buffer = toBuffer(bytes);
  if (!buffer || buffer.length === 0) {
    return { ok: false, errors: ["插件包内容为空"], sha256: null };
  }
  const sha256 = sha256Hex(buffer);
  const expected = typeof options.expectedSha256 === "string" ? options.expectedSha256.trim().toLowerCase() : "";
  if (expected && expected !== sha256) {
    return { ok: false, errors: ["插件包内容指纹不一致，已拒绝安装"], sha256 };
  }

  let entries;
  try {
    entries = unpackTarGz(buffer, options.limits || LIMITS);
  } catch (err) {
    return { ok: false, errors: [`插件包解包失败：${(err && err.message) || err}`], sha256 };
  }

  const layout = validateLayout(entries);
  if (!layout.ok) return { ok: false, errors: layout.errors, sha256 };

  let manifestRaw;
  try {
    manifestRaw = JSON.parse(layout.manifestEntry.data.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    return { ok: false, errors: ["plugin.json 不是合法 JSON"], sha256 };
  }

  const manifestCheck = validateBundleManifest(manifestRaw);
  if (!manifestCheck.ok) return { ok: false, errors: manifestCheck.errors, sha256, manifest: manifestRaw };

  const paths = new Set(entries.map((entry) => entry.path));
  const manifest = manifestCheck.manifest;
  const widget = manifestCheck.widget;
  const errors = [];
  // entry 必须存在于包里（规格 §2.1）：一个不存在的 entry 会变成一块打不开的透明窗
  if (!paths.has(widget.entry)) errors.push(`entry 不存在于插件包：${widget.entry}`);
  if (widget.icon && !paths.has(widget.icon)) errors.push(`icon 不存在于插件包：${widget.icon}`);
  if (widget.tray.icon && !paths.has(widget.tray.icon)) errors.push(`tray.icon 不存在于插件包：${widget.tray.icon}`);
  if (errors.length > 0) return { ok: false, errors, sha256, manifest };

  return {
    ok: true,
    errors: [],
    sha256,
    bytes: buffer,
    manifest,
    widget,
    permissions: manifestCheck.permissions,
    signed: manifestCheck.signed === true,
    publisherId: manifestCheck.publisherId,
    files: entries.map((entry) => ({ path: entry.path, data: entry.data })),
    totalBytes: entries.reduce((sum, entry) => sum + entry.data.length, 0),
  };
}

/**
 * 打一个确定性包（发布脚本 `scripts/pack-plugin.mjs` 用；安装端测试也用）。
 *
 * @param {Array<{path: string, data: Buffer|string}>} entries
 * @returns {Buffer}
 */
function packPackage(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("打包至少要有一个文件");
  return packTarGz(entries);
}

module.exports = {
  MANIFEST_PATH,
  FILE_ROOT,
  LIMITS,
  sha256Hex,
  toBuffer,
  validateLayout,
  validateBundleManifest,
  readPackage,
  packPackage,
};
