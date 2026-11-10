"use strict";

const { createHash } = require("node:crypto");
const { packTarGz, unpackTarGz, LIMITS } = require("./plugin-tar");
const { normalizeWidgetSpec, normalizeRelativeAssetPath, MAX_WIDGETS_PER_PLUGIN } = require("./plugin-window");
const { verifyOfficialSignature } = require("./plugin-signature");

/**
 * 界面插件包（`package.tgz`）的读取、结构校验与清单守卫（纯函数 + node:crypto）。
 *
 * 分工（见规格 §2.1 / §2.2）：
 * - `plugin-tar.js` 只负责「tar/gzip 格式正确 + 单条边界安全」；
 * - **本文件**负责「这是不是一个合法的界面插件包」：包内结构（`plugin.json` 在根 +
 *   `files/**`）、清单里**宿主真正会用到**的字段（v4 / bundle / desktopWidgets / page /
 *   permissions / 第一方签名标记）、entry 与图标确实在包里。
 *
 * ★ 为什么不复用 web 侧的 zod 清单校验：`plugin.json` 落盘后是用户机器上的文件，
 *   第三方可以改；主进程建窗、放 CSP、决定 unsafe-eval 都依赖这份清单，所以必须在
 *   主进程里独立再判一次「我能拿它做什么」（纵深防御）。完整语义校验（安装预览、
 *   错误路径展示、信任弹窗）仍归 web 侧 `manifest.ts`——两边职责不同，不是重复。
 *
 * ★ d.105 起 bundle **必须通过首方验签**（`plugin-signature.js` + 内置
 *   `resources/official-keys.json` 公钥表）。旧口径「结构上带 publisher + signature 即可、
 *   验签归 web」已被证明是漏洞：web 对 bundle 清单一律拒绝、主进程又不验，
 *   等于任何拿到发布密钥或本地 `.tgz` 的人都能装进可执行界面插件（规格 §7.1）。
 *   现在验签在**主进程**做（本地 `.tgz` 与云端下载同一条路），失败关闭。
 *   纯声明式包不经过本文件（它们不执行代码，走 web 侧 TOFU，规格 §7.1 第 4 条）。
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

/**
 * 允许订阅的宿主事件。
 *
 * - `notify`：主窗通知（既有）；
 * - `lifecycle`（d.108）：安装/启停/更新/卸载的生命周期事件。**未声明就收不到任何
 *   生命周期事件**（规格 §5.4）；声明了也只表示「允许接收通知」，不带来任何新能力。
 * - `theme` / `tray`（d.113，审计 P1-5）：主题切换与托盘动作事件。此前宿主对这两类
 *   无条件广播，绕过 `permissions.events`；现在同样必须显式声明。
 */
const ALLOWED_EVENTS = new Set(["notify", "lifecycle", "theme", "tray"]);
const ALLOWED_GRAPHICS = new Set(["webgl", "webgl2", "wasm"]);
const ALLOWED_TOOLS = new Set(["none", "read", "write"]);
/**
 * bundle 命令允许的 target 集合（d.109，与声明式 v5 口径一致）。
 *
 * - `page` / `plugin`：既有；
 * - `settings` / `unit`：d.108 新增、d.109 对 bundle 放开（规格 §7.3 修订）；
 * - **仍不允许 `skill`**：界面插件不贡献技能，指向技能的命令没有可解析的目标。
 */
const BUNDLE_COMMAND_TARGET_KINDS = new Set(["page", "plugin", "settings", "unit"]);
const MAX_COMMANDS = 30;
const MAX_COMMAND_ID = 64;
const MAX_COMMAND_TITLE = 80;
const MAX_COMMAND_KEYWORDS = 10;

/* ── d.124 插件页面（B 路径：界面插件自带 HTML） ── */
/** 页面标题上限（规格 §3.2，与导航项同一口径）。 */
const PAGE_TITLE_MAX = 40;
/** 页面副标题上限。 */
const PAGE_SUMMARY_MAX = 200;
/** 宿主图标词表 id 的形状（与 shared `PAGE_ICON_RE` 同源；未知 id 由 web 侧回落 package）。 */
const PAGE_ICON_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** sha256 十六进制（整包字节的完整性指纹；发布侧算的也是这个）。 */
function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `files/**` 内容摘要（审计 P0-1：让首方签名间接覆盖代码字节）。
 *
 * 首方签名只覆盖 `canonicalManifestText(manifest)`，不含 `files/**` 的代码字节；
 * 只保留官方清单 + 签名、替换包内 JS 就能过验签。把**包内容摘要**写进清单
 * `packageSha256` 后，签名即覆盖全部代码字节；安装端解包后重算并比对。
 *
 * ★ 为什么不是「整个 tgz 字节的 sha256」：`plugin.json` 在 tgz 里，而清单又要写
 *   自己的 tgz 摘要，会构成自引用（不存在不动点）。所以摘要只覆盖**清单之外**的
 *   `files/**`：排序后的 `path`、字节长度、内容 sha256 的确定性流——
 *   换任意一个文件（含同内容换路径）都会变，且与 tar/gzip 时间戳无关。
 *
 * @param {Array<{path: string, data: Buffer|string}>} entries 解包/打包用的条目表
 * @returns {string} 64 位小写 hex
 */
function computeFilesDigest(entries) {
  const hash = createHash("sha256");
  const files = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry.path === "string" && entry.path.startsWith(FILE_ROOT))
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of files) {
    const data = toBuffer(entry.data) || Buffer.from(entry.data == null ? "" : String(entry.data), "utf8");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(String(data.length));
    hash.update("\0");
    hash.update(createHash("sha256").update(data).digest());
    hash.update("\n");
  }
  return hash.digest("hex");
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
 * 归一化界面插件的页面贡献（`contributions.page`，d.124 §3.2）。
 *
 * 页面在**独立 origin 的沙箱视图**里跑插件的 HTML：宿主只把它当成一个入口地址，
 * 所以这里只校验「宿主敢加载什么」——标题/图标/副标题用于导航展示，`entry` 必须落在
 * 包内 `files/**` 且是 `.html`（真正的存在性检查在 `readPackage` 里对着文件清单比对）。
 *
 * ★ 与声明式页的区别：bundle 页面只能写 `entry`，出现 `blocks` 直接拒绝
 *   （同一份清单不能在「宿主渲染」与「插件自带 HTML」两条路之间摇摆）。
 * ★ 错误一律中文 + 字段路径 `contributions.page.*`，可直接展示给插件作者。
 *
 * @param {unknown} raw 清单里的 `contributions.page`
 * @returns {{ ok: boolean, errors: string[], page: {title:string,icon:string,summary:string,entry:string}|null }}
 */
function normalizePageSpec(raw) {
  const errors = [];
  const at = "contributions.page";
  if (!isPlainObject(raw)) return { ok: false, errors: [`${at} 必须是对象`], page: null };

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title || title.length > PAGE_TITLE_MAX) {
    errors.push(`${at}.title 必须是 1–${PAGE_TITLE_MAX} 字的文本`);
  }

  // 图标只做「形状」校验：具体词表在 web 侧 `lib/pages/icons.ts`，未知 id 回落 package 默认图标。
  let icon = "";
  if (raw.icon !== undefined) {
    if (typeof raw.icon !== "string" || !PAGE_ICON_RE.test(raw.icon.trim())) {
      errors.push(`${at}.icon 只接受宿主图标 id（小写字母/数字/连字符，≤32）`);
    } else {
      icon = raw.icon.trim();
    }
  }

  let summary = "";
  if (raw.summary !== undefined) {
    if (typeof raw.summary !== "string" || raw.summary.trim().length > PAGE_SUMMARY_MAX) {
      errors.push(`${at}.summary 必须是不超过 ${PAGE_SUMMARY_MAX} 字的文本`);
    } else {
      summary = raw.summary.trim();
    }
  }

  const entry = normalizeRelativeAssetPath(raw.entry);
  if (!entry || !entry.endsWith(".html")) {
    errors.push(
      `${at}.entry 必须是包内相对 .html 入口（禁绝对路径 / .. / 反斜杠 / 协议前缀，≤200 字符）`,
    );
  }

  // bundle 页面由插件自己的 HTML 渲染；再写 blocks 会让「谁来渲染」变得不确定。
  if (raw.blocks !== undefined && (!Array.isArray(raw.blocks) || raw.blocks.length > 0)) {
    errors.push(`${at} 是界面插件页面，只能写 entry，不能再写 blocks（声明式页请用 distribution: "manifest"）`);
  }

  if (errors.length > 0) return { ok: false, errors, page: null };
  return { ok: true, errors: [], page: { title, icon, summary, entry } };
}

/** 引擎入口/依赖目录的最大长度（清单是落盘文件，别让它把环境变量撑爆）。 */
const ENGINE_PATH_MAX = 200;

/**
 * 归一化插件自带引擎（`contributions.engine`）。
 *
 * ★ 只允许 `.py` 入口并强制落在 `files/**`：解释器由宿主固定为内置运行时，
 *   清单里**没有命令字符串**可写——即使 plugin.json 落盘后被改，也拼不出 `cmd /c …`。
 * ★ `lib` 是随包分发的 site-packages 目录（可缺省）：只进 PYTHONPATH，不是新的命令面。
 * ★ 存在性在 `readPackage` 里对着包内文件清单再查一次；这里只做形状与路径约束。
 */
function normalizeEngineSpec(raw) {
  const at = "contributions.engine";
  if (!isPlainObject(raw)) return { ok: false, errors: [`${at} 必须是对象`], engine: null };
  const errors = [];

  const entry = typeof raw.entry === "string" ? raw.entry.trim() : "";
  if (!entry) {
    errors.push(`${at}.entry 必须是非空文本（包内 .py 入口，如 files/engine/bridge.py）`);
  } else if (entry.length > ENGINE_PATH_MAX) {
    errors.push(`${at}.entry 过长（≤${ENGINE_PATH_MAX} 字符）`);
  } else if (entry.includes("\\") || entry.includes("\0") || entry.split("/").includes("..")) {
    errors.push(`${at}.entry 不能含反斜杠 / NUL / ..`);
  } else if (!entry.startsWith("files/") || !/\.py$/i.test(entry)) {
    errors.push(`${at}.entry 必须是 files/ 下的 .py 文件`);
  }

  let lib = "";
  if (raw.lib !== undefined) {
    lib = typeof raw.lib === "string" ? raw.lib.trim() : "";
    if (!lib) {
      errors.push(`${at}.lib 必须是非空文本（随包分发的依赖目录，可省略）`);
    } else if (lib.length > ENGINE_PATH_MAX) {
      errors.push(`${at}.lib 过长（≤${ENGINE_PATH_MAX} 字符）`);
    } else if (lib.includes("\\") || lib.includes("\0") || lib.split("/").includes("..")) {
      errors.push(`${at}.lib 不能含反斜杠 / NUL / ..`);
    } else if (!lib.startsWith("files/")) {
      errors.push(`${at}.lib 必须在 files/ 下`);
    } else if (lib === entry || entry.startsWith(lib + "/")) {
      errors.push(`${at}.lib 不能是入口文件或其上级目录`);
    }
  }

  if (errors.length > 0) return { ok: false, errors, engine: null };
  return { ok: true, errors: [], engine: { entry, ...(lib ? { lib } : {}) } };
}

/**
 * 主进程侧的清单守卫（v4 / bundle / desktopWidgets / page / permissions / 签名标记）。
 *
 * 返回 `{ ok, errors, manifest, widget, permissions, distribution }`；
 * `widget` 只有在 `ok` 时才可用（已过 `normalizeWidgetSpec`）。
 *
 * @param {unknown} raw 解析后的 plugin.json
 * @param {{}} [options] 预留（本轮无强制签名开关；信任门在主窗侧）
 */
/**
 * @param {object} raw 解析后的清单对象
 * @param {{ dev?: boolean }} [options] `dev: true` 用于**打包/签名之前**的本地校验
 *   （`scripts/plugin-lint.mjs --kind bundle` 走这条）：此时 `packageSha256` 尚未由
 *   打包脚本写入，缺失不算错误；格式一旦给出仍然严格校验。
 *   安装链路（`readPackage`）永远不传 dev，所以「能否安装」的判定不变。
 */
function validateBundleManifest(raw, options = {}) {
  const dev = options.dev === true;
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

  /* ── packageSha256（审计 P0-1）：bundle 必填，签名据此覆盖 files/** 代码字节 ── */
  const packageSha256 = raw.packageSha256;
  if (distribution === "bundle") {
    if (packageSha256 === undefined) {
      // 打包前（dev 校验）这个字段由 pack-plugin 回写，缺失不是清单错误；
      // 安装链路不传 dev，仍然强制要求。
      if (!dev) {
        errors.push("distribution: \"bundle\" 必须提供 packageSha256（files/** 内容摘要，用于让首方签名覆盖包内代码字节）");
      }
    } else if (typeof packageSha256 !== "string" || !/^[0-9a-f]{64}$/.test(packageSha256)) {
      errors.push("packageSha256 必须是 64 位小写 hex（files/** 内容摘要）");
    }
  } else if (packageSha256 !== undefined) {
    errors.push("packageSha256 只对界面插件（distribution: \"bundle\"）有意义");
  }

  if (distribution !== "bundle") {
    errors.push("界面插件清单必须声明 distribution: \"bundle\"（带文件）");
  }

  /* ── 来源：bundle **必须**有 publisher + signature；这里只做结构校验，密码学验签在 readPackage ── */
  /*
   * 结构校验与验签分开的原因：
   * - 结构错（缺 publisher、alg 不是 ed25519、base64url 非法）要给用户**字段级**错误，
   *   比「签名不匹配」可行动得多；
   * - 真实验签要读公钥表，属于安装链路（readPackage）职责，且失败关闭。
   * 注意 publisher.publicKey 只是「发布者自称的公钥」，**验签不用它**（用内置首方公钥表），
   * 否则任何人都能自造密钥对冒充官方。
   */
  const publisher = raw.publisher;
  const signature = raw.signature;
  const signed = signature !== undefined;
  if (signed) {
    // 有签名必须有发布者：用于错误文案与后续展示，不是验签输入
    if (!isPlainObject(publisher)) {
      errors.push("有 signature 时必须同时提供 publisher（发布者 id 用于错误文案与展示）");
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
  if (badEvents.length > 0) {
    errors.push(`permissions.events 含未知项：${badEvents.join(", ")}（允许：${[...ALLOWED_EVENTS].join(" / ")}）`);
  }
  const graphics = Array.isArray(permissionsRaw.graphics) ? permissionsRaw.graphics : [];
  const badGraphics = graphics.filter((item) => !ALLOWED_GRAPHICS.has(item));
  if (badGraphics.length > 0) errors.push(`permissions.graphics 含未知项：${badGraphics.join(", ")}`);
  // 审计 P0-1：对话上下文（网关地址 + 智能体 id/name）改成声明制；只有 bundle 有意义。
  if (permissionsRaw.chat !== undefined && typeof permissionsRaw.chat !== "boolean") {
    errors.push("permissions.chat 必须是 boolean（默认 false）");
  }
  if (permissionsRaw.chat === true && distribution !== "bundle") {
    errors.push("permissions.chat 只对界面插件（distribution: \"bundle\"）有意义");
  }
  const chat = permissionsRaw.chat === true;
  // d.125：写和鸣知识库（`permissions.kb`）。只有随插件分发的本机引擎会用得上，
  // 但这里仍按「声明制」收口：没写就是 false，引擎环境里不会出现知识库路径。
  if (permissionsRaw.kb !== undefined && typeof permissionsRaw.kb !== "boolean") {
    errors.push("permissions.kb 必须是 boolean（默认 false）");
  }
  if (permissionsRaw.kb === true && distribution !== "bundle") {
    errors.push("permissions.kb 只对界面插件（distribution: \"bundle\"）有意义");
  }
  const kb = permissionsRaw.kb === true;

  /* ── contributions：只允许 commands + desktopWidgets + page（界面插件不贡献技能/服务/工具束） ── */
  const contributionsRaw = isPlainObject(raw.contributions) ? raw.contributions : {};
  for (const kind of ["skills", "mcpServers", "toolPacks"]) {
    const value = contributionsRaw[kind];
    if (value !== undefined && (!Array.isArray(value) || value.length > 0)) {
      errors.push(`界面插件不允许声明 contributions.${kind}`);
    }
  }
  if (contributionsRaw.commands !== undefined && !Array.isArray(contributionsRaw.commands)) {
    errors.push("contributions.commands 必须是数组");
  } else if (Array.isArray(contributionsRaw.commands)) {
    const commands = contributionsRaw.commands;
    if (commands.length > MAX_COMMANDS) errors.push(`contributions.commands 最多 ${MAX_COMMANDS} 条`);
    commands.forEach((command, index) => {
      const at = `contributions.commands[${index}]`;
      if (!isPlainObject(command)) {
        errors.push(`${at} 必须是对象`);
        return;
      }
      // id / title 是命令面板的展示与去重依据，缺了这条命令等于不存在
      if (typeof command.id !== "string" || !command.id.trim() || command.id.trim().length > MAX_COMMAND_ID) {
        errors.push(`${at}.id 必须是非空文本（≤${MAX_COMMAND_ID}）`);
      }
      if (typeof command.title !== "string" || !command.title.trim() || command.title.trim().length > MAX_COMMAND_TITLE) {
        errors.push(`${at}.title 必须是非空文本（≤${MAX_COMMAND_TITLE}）`);
      }
      const target = command.target;
      const allowedText = [...BUNDLE_COMMAND_TARGET_KINDS].join(" / ");
      if (!isPlainObject(target) || typeof target.kind !== "string" || !target.kind) {
        errors.push(`${at}.target 必须是 { kind: "${allowedText.split(" / ").join('" | "')}" }`);
        return;
      }
      if (!BUNDLE_COMMAND_TARGET_KINDS.has(target.kind)) {
        errors.push(
          `${at}.target.kind 只允许 ${allowedText}（界面插件不贡献技能，skill 目标没有可解析对象），收到 ${target.kind}`,
        );
        return;
      }
      if (target.kind === "page" && (typeof target.page !== "string" || !target.page.trim())) {
        errors.push(`${at}.target.page 必须是非空文本`);
      }
      if (target.kind === "settings" && (typeof target.card !== "string" || !target.card.trim())) {
        errors.push(`${at}.target.card 必须是非空文本（设置卡 id）`);
      }
      if (target.kind === "unit" && (typeof target.unitId !== "string" || !ID_RE.test(target.unitId.trim()))) {
        errors.push(`${at}.target.unitId 必须是小写字母/数字/点/下划线/连字符的能力单元 id`);
      }
      if (target.kind === "plugin" && target.name !== undefined) {
        errors.push(`${at}.target 为 plugin 时不应再带 name（bundle 命令只能指向自身）`);
      }
    });
  }
  const widgetsRaw = contributionsRaw.desktopWidgets;
  let widget = null;
  if (widgetsRaw !== undefined && !Array.isArray(widgetsRaw)) {
    errors.push("contributions.desktopWidgets 必须是数组");
  } else if (Array.isArray(widgetsRaw) && widgetsRaw.length > MAX_WIDGETS_PER_PLUGIN) {
    errors.push(`本轮一个插件最多声明 ${MAX_WIDGETS_PER_PLUGIN} 个 desktopWidget`);
  } else if (Array.isArray(widgetsRaw) && widgetsRaw.length > 0) {
    const normalized = normalizeWidgetSpec(widgetsRaw[0], 0);
    if (!normalized.ok) errors.push(...normalized.errors);
    widget = normalized.spec;
  }

  // d.124：页面（B 路径）。bundle 可以是「只有页面」的插件——没有浮窗，只有导航入口。
  let page = null;
  if (contributionsRaw.page !== undefined) {
    const normalized = normalizePageSpec(contributionsRaw.page);
    if (!normalized.ok) errors.push(...normalized.errors);
    else page = normalized.page;
  }
  if (!widget && !page) {
    errors.push(
      'distribution: "bundle" 必须声明至少 1 个 contributions.desktopWidgets 或 contributions.page（否则就是纯声明式包）',
    );
  }

  // d.125：插件自带本机引擎（第一方签名 bundle 专用，见 plugin-engine.js）。
  let engine = null;
  if (contributionsRaw.engine !== undefined) {
    const normalized = normalizeEngineSpec(contributionsRaw.engine);
    if (!normalized.ok) errors.push(...normalized.errors);
    else engine = normalized.engine;
  }
  // 知识库写入没有引擎就无处落地：把「声明了能力却没人用」当成清单错误，早报比运行时空转好。
  if (kb && !engine) {
    errors.push('permissions.kb 需要同时声明 contributions.engine（写入由插件自带引擎执行）');
  }

  const permissions = {
    network: networkHosts,
    tools,
    files: files.filter((item) => typeof item === "string"),
    events: events.filter((item) => ALLOWED_EVENTS.has(item)),
    graphics: graphics.filter((item) => ALLOWED_GRAPHICS.has(item)),
    eval: permissionsRaw.eval === true,
    chat,
    kb,
  };

  return {
    ok: errors.length === 0,
    errors,
    manifest: raw,
    widget,
    page,
    engine,
    permissions,
    distribution,
    signed: signed === true,
    publisherId: isPlainObject(publisher) && typeof publisher.id === "string" ? publisher.id.trim() : null,
  };
}

/**
 * 从清单里提取「命令面板可物化」的 bundle 命令（d.109）。
 *
 * 纯函数、失败即丢：安装时清单已过 `validateBundleManifest`，但这里仍逐项收紧
 * （长度/类型/目标字段），因为它也会被 `plugin-store.init()` 用来回填旧安装记录——
 * 磁盘上的 `plugin.json` 可能被外部改过，不能假设一定合法。
 *
 * @param {unknown} manifest 解析后的 `plugin.json`
 * @returns {Array<{id: string, title: string, description: string, keywords: string[], target: object}>}
 */
function normalizeBundleCommands(manifest) {
  const contributions = isPlainObject(manifest) && isPlainObject(manifest.contributions)
    ? manifest.contributions
    : {};
  const commands = Array.isArray(contributions.commands) ? contributions.commands : [];
  const out = [];
  for (const command of commands) {
    if (!isPlainObject(command)) continue;
    if (typeof command.id !== "string" || !command.id.trim()) continue;
    if (typeof command.title !== "string" || !command.title.trim()) continue;
    const targetRaw = isPlainObject(command.target) ? command.target : null;
    if (!targetRaw || typeof targetRaw.kind !== "string" || !BUNDLE_COMMAND_TARGET_KINDS.has(targetRaw.kind)) {
      continue;
    }
    let target;
    if (targetRaw.kind === "page") {
      if (typeof targetRaw.page !== "string" || !targetRaw.page.trim()) continue;
      target = { kind: "page", page: targetRaw.page.trim().slice(0, 64) };
    } else if (targetRaw.kind === "settings") {
      if (typeof targetRaw.card !== "string" || !targetRaw.card.trim()) continue;
      target = { kind: "settings", card: targetRaw.card.trim().slice(0, 64) };
    } else if (targetRaw.kind === "unit") {
      const unitId = typeof targetRaw.unitId === "string" ? targetRaw.unitId.trim() : "";
      if (!ID_RE.test(unitId)) continue;
      target = { kind: "unit", unitId };
    } else {
      target = { kind: "plugin" };
    }
    const keywords = Array.isArray(command.keywords)
      ? command.keywords
          .filter((item) => typeof item === "string" && item.trim())
          .map((item) => item.trim().slice(0, 32))
          .slice(0, MAX_COMMAND_KEYWORDS)
      : [];
    out.push({
      id: command.id.trim().slice(0, MAX_COMMAND_ID),
      title: command.title.trim().slice(0, MAX_COMMAND_TITLE),
      description: typeof command.description === "string" ? command.description.trim().slice(0, MAX_DESCRIPTION) : "",
      keywords,
      target,
    });
    if (out.length >= MAX_COMMANDS) break;
  }
  return out;
}

/**
 * 读取并校验一个 `package.tgz`（安装端唯一入口）。
 *
 * 顺序（任一步失败都不产生半可用状态）：
 * sha256（调用方先做）→ gunzip/tar 配额 → 包内结构 → plugin.json 解析 → 清单守卫 →
 * **首方验签（失败关闭）** → entry/图标存在性。
 *
 * @param {Buffer|ArrayBuffer|Uint8Array} bytes
 * @param {{ expectedSha256?: string, limits?: object, keysFile?: string, allowDevKeys?: boolean }} [options]
 *   `keysFile` 仅测试/换钥排障用；生产走 `plugin-signature.js` 的默认路径。
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

  // 首方验签（规格 §7.1 第 3/5 条）：bundle 必须由内置公钥表验过，失败关闭。
  // 放在 entry/图标存在性检查之前：真实性不过关的包不必再谈结构完整性。
  // 纯声明式包走 web 侧 TOFU，不经过本文件（validateBundleManifest 已要求 distribution: bundle）。
  const signatureCheck = verifyOfficialSignature(manifestRaw, {
    keysFile: options.keysFile,
    allowDevKeys: options.allowDevKeys,
  });
  if (!signatureCheck.ok) {
    const who = manifestCheck.publisherId
      ? `publisher: ${manifestCheck.publisherId.slice(0, 64)}`
      : "publisher: 未知";
    return {
      ok: false,
      errors: [`未通过首方签名（${who}），已拒绝安装：${signatureCheck.reason}`],
      sha256,
      manifest: manifestRaw,
    };
  }

  // 包内容摘要校验（审计 P0-1）：签名覆盖的是清单里的 packageSha256，这里再算**实际
  // files/** 摘要**比对——只保留官方清单+签名、替换包内 JS 的「借壳包」会在这里被拒。
  const filesDigest = computeFilesDigest(entries);
  if (manifestRaw.packageSha256 !== filesDigest) {
    return {
      ok: false,
      errors: [
        `packageSha256 与插件包内容不一致（清单声明 ${String(manifestRaw.packageSha256).slice(0, 16)}…，实际 ${filesDigest.slice(0, 16)}…）：files/** 可能被替换，已拒绝安装`,
      ],
      sha256,
      manifest: manifestRaw,
    };
  }

  const paths = new Set(entries.map((entry) => entry.path));
  const manifest = manifestCheck.manifest;
  const widget = manifestCheck.widget;
  const page = manifestCheck.page;
  const errors = [];
  // entry 必须存在于包里（规格 §2.1）：一个不存在的 entry 会变成一块打不开的透明窗
  if (widget && !paths.has(widget.entry)) errors.push(`entry 不存在于插件包：${widget.entry}`);
  if (widget && widget.icon && !paths.has(widget.icon)) errors.push(`icon 不存在于插件包：${widget.icon}`);
  if (widget && widget.tray.icon && !paths.has(widget.tray.icon)) {
    errors.push(`tray.icon 不存在于插件包：${widget.tray.icon}`);
  }
  // d.124：页面入口同样必须在包内——安装时校验，别等到用户点进页面才白屏。
  if (page && !paths.has(page.entry)) errors.push(`页面入口不存在于插件包：${page.entry}`);
  // d.125：引擎入口必须在包内（解释器由宿主固定，缺文件只会让页面永久「引擎启动失败」）。
  const engine = manifestCheck.engine;
  if (engine && !paths.has(engine.entry)) errors.push(`引擎入口不存在于插件包：${engine.entry}`);
  // 依赖目录同理：写了 lib 却一个文件都没打进包，引擎起来后 import 必失败。
  if (
    engine &&
    engine.lib &&
    !entries.some((item) => item.path === engine.lib || item.path.startsWith(engine.lib + "/"))
  ) {
    errors.push(`引擎依赖目录不存在于插件包：${engine.lib}`);
  }
  if (errors.length > 0) return { ok: false, errors, sha256, manifest };

  return {
    ok: true,
    errors: [],
    sha256,
    bytes: buffer,
    manifest,
    widget,
    page,
    engine,
    permissions: manifestCheck.permissions,
    signed: manifestCheck.signed === true,
    publisherId: manifestCheck.publisherId,
    signatureKeyId: signatureCheck.keyId,
    // 已核对的 files/** 内容摘要（与清单 packageSha256 一致）
    filesDigest,
    // 命令面板物化用（d.109）：已按 bundle 允许的 target 收紧，web 侧直接消费
    commands: normalizeBundleCommands(manifest),
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
  PAGE_TITLE_MAX,
  PAGE_SUMMARY_MAX,
  sha256Hex,
  computeFilesDigest,
  toBuffer,
  validateLayout,
  validateBundleManifest,
  normalizeBundleCommands,
  normalizePageSpec,
  normalizeEngineSpec,
  readPackage,
  packPackage,
};
