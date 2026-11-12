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
 *       **bundle（界面插件）会先把 files/** 的内容摘要写进 `packageSha256` 再签**
 *       （审计 P0-1：让签名覆盖包内代码字节；默认从 plugin.json 同级的 files/ 算，
 *       也可用 --package <tgz> 或 --dir <包根> 指定）。
 *
 * ★ 规范化算法必须与 `packages/web/src/lib/plugins/signature.ts` 的
 *   `signedManifestText` **逐字节一致**（同一套字段集合、键排序、无空白）。
 *   改任何一边都要同步另一边，否则本机验签会一直 invalid。
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
} from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

/* ------------------------------------------------- 包内容摘要（审计 P0-1） */

/**
 * `files/**` 内容摘要，必须与 `packages/desktop/plugin-package.js` 的
 * `computeFilesDigest` **逐字节一致**（同一条流：排序后的 path + 长度 + 内容 sha256）。
 *
 * 为什么不是整个 tgz 的 sha256：plugin.json 在 tgz 里、清单又要写自己的 tgz 摘要，
 * 构成自引用；摘要只覆盖清单之外的代码字节，效果等价（换任何文件都会变）。
 */
export function computeFilesDigest(entries) {
  const hash = createHash("sha256");
  const files = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry.path === "string" && entry.path.startsWith("files/"))
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of files) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ""), "utf8");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(String(data.length));
    hash.update("\0");
    hash.update(createHash("sha256").update(data).digest());
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** 递归读取目录下所有文件（返回 `{path, data}`，path 带传入的前缀）。 */
function walkFiles(dir, base = "") {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const info = statSync(full);
    if (info.isSymbolicLink()) throw new Error(`包内不允许符号链接：${rel}`);
    if (info.isDirectory()) out.push(...walkFiles(full, rel));
    else if (info.isFile()) out.push({ path: rel, data: readFileSync(full) });
  }
  return out;
}

/** 从包根（含 files/）计算摘要。 */
export function digestFromPackageRoot(root) {
  const filesDir = join(root, "files");
  if (!existsSync(filesDir)) throw new Error(`包根缺少 files/ 目录：${filesDir}`);
  return computeFilesDigest(walkFiles(filesDir, "files"));
}

/** 从已打好的 tgz 计算摘要（复用桌面侧 tar 解包；缺位时要求改用 --dir）。 */
export function digestFromTgz(tgzPath) {
  const requireFromRoot = createRequire(import.meta.url);
  let tar;
  try {
    tar = requireFromRoot("../packages/desktop/plugin-tar.js");
  } catch {
    throw new Error("找不到 packages/desktop/plugin-tar.js，无法从 tgz 计算摘要（改用 --dir <包根>）");
  }
  const entries = tar.unpackTarGz(readFileSync(tgzPath), tar.LIMITS);
  return computeFilesDigest(entries);
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

/**
 * 桌面小组件声明（d.94 / v4）：按 `manifest.ts` 的 zod 默认值归一化。
 *
 * 这些默认值必须与应用解析完全一致（`transparent: false`、`defaultScale: 1`、
 * `position` 缺省、`tray.items` 缺省……），否则 v4 bundle 的签名与验签对不上。
 */
function normalizeDesktopWidget(widget) {
  const position = widget.position ?? {};
  const tray = widget.tray;
  const settings = widget.settings;
  return {
    id: trim(widget.id),
    name: trim(widget.name),
    entry: trim(widget.entry),
    width: widget.width,
    height: widget.height,
    scales: (Array.isArray(widget.scales) ? widget.scales : []).map(Number),
    defaultScale: typeof widget.defaultScale === "number" ? widget.defaultScale : 1,
    transparent: widget.transparent === true,
    alwaysOnTop: widget.alwaysOnTop === true,
    skipTaskbar: widget.skipTaskbar === true,
    resizable: widget.resizable === true,
    clickThrough: widget.clickThrough ?? "none",
    position: {
      anchor: trim(position.anchor) || "bottom-right",
      margin: typeof position.margin === "number" ? position.margin : 24,
      remember: position.remember !== false,
    },
    ...(widget.icon ? { icon: trim(widget.icon) } : {}),
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
      // d.94（v4）：未声明时为 [] / false，与应用归一化一致
      events: stringList(permissions.events),
      graphics: stringList(permissions.graphics),
      eval: permissions.eval === true,
      // d.113 审计 P0-1：chat 是受签名保护的权限位；只在 true 时进入文本，
      // 未开通的包保持旧 canonical 字节（历史签名不失效），翻成 true 则签名必坏。
      ...(permissions.chat === true ? { chat: true } : {}),
      // d.125：permissions.kb（写和鸣知识库）同 chat 口径——只在 true 时入文本。
      ...(permissions.kb === true ? { kb: true } : {}),
      // d.138：沙箱桥新权限位（本机归档只读 / 桌面通知）沿用同一口径：归一化清单恒有
      // 这两个 false 字段，若原样签进去，所有历史签名会一起失效。
      ...(permissions.infohub === true ? { infohub: true } : {}),
      ...(permissions.notify === true ? { notify: true } : {}),
    },
    ...(normalizeModuleWeb(manifest.web) ? { web: normalizeModuleWeb(manifest.web) } : {}),
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
      // d.94：界面插件声明（v3 及更旧没有该字段 → 空数组；应用归一化后也恒为数组）。
      desktopWidgets: (Array.isArray(contributions.desktopWidgets)
        ? contributions.desktopWidgets
        : []
      ).map(normalizeDesktopWidget),
      // d.124：插件页面。**只在声明时进入签名文本**——没有页面的旧包 canonical 字节
      // 逐字不变、历史签名不失效；有页面时 title/icon/summary/entry/blocks 全部受签，
      // 不能只靠包里「entry 文件存在」兜底（换标题/换入口地址本身就该让验签失败）。
      ...(normalizePage(contributions.page) ? { page: normalizePage(contributions.page) } : {}),
      // d.125：插件自带引擎。只在声明时进文本；否则「签名后改 engine.entry 指向包内
      // 另一个 .py」不会改变签名（files 摘要没变），等于绕过验签换入口。
      ...(normalizeEngine(contributions.engine) ? { engine: normalizeEngine(contributions.engine) } : {}),
      // d.138：首页卡片与后台页。同样只在声明了内容时才进文本——归一化清单恒有
      // `homeCards: []`，空数组入文本会让所有既有签名失效。
      ...(normalizeHomeCards(contributions.homeCards).length > 0
        ? { homeCards: normalizeHomeCards(contributions.homeCards) }
        : {}),
      ...(normalizeBackground(contributions.background)
        ? { background: normalizeBackground(contributions.background) }
        : {}),
      // d.90：模型预设已收回——清单里写 llmPresets 会被应用丢弃，签名文本同样恒为空数组。
      llmPresets: [],
    },
  };
}

/**
 * 引擎声明 → 签名用的确定性形状（d.125）。
 *
 * 只在声明时进入文本（旧包 canonical 字节不变）。entry/lib 都受签：否则「签名后把
 * engine.entry 指到包内另一个 .py」不改变签名（files 摘要没变），等于绕过验签换入口。
 * 与 packages/desktop/plugin-signature.js 的 normalizeEngine 逐字段一致。
 */
function normalizeEngine(engine) {
  if (!engine || typeof engine !== "object" || Array.isArray(engine)) return null;
  const entry = trim(engine.entry);
  if (!entry) return null;
  const lib = trim(engine.lib);
  return { entry, ...(lib ? { lib } : {}) };
}

/**
 * 首页卡片 → 签名用的确定性形状（d.138）。
 *
 * 卡片是插件声明给主窗口的入口数据（标题、说明、跳转页），改这些属于可感知变更，
 * 必须绑进签名；空 summary/icon/primary 不进文本，与 web 侧 signature.ts 逐字段一致。
 */
function normalizeHomeCard(card) {
  if (!card || typeof card !== "object" || Array.isArray(card)) return null;
  const id = trim(card.id);
  const title = trim(card.title);
  const page = trim(card.page);
  if (!id || !title || !page) return null;
  const summary = trim(card.summary);
  const icon = trim(card.icon);
  const primary = trim(card.primary);
  return {
    id,
    title,
    page,
    ...(summary ? { summary } : {}),
    ...(icon ? { icon } : {}),
    ...(primary ? { primary } : {}),
  };
}

/** 首页卡片数组 → canonical 列表（丢弃非法项，空数组入文本无意义）。 */
function normalizeHomeCards(cards) {
  return (Array.isArray(cards) ? cards : []).map(normalizeHomeCard).filter(Boolean);
}

/** 后台页入口 → 签名用的确定性形状（d.138）：入口换了等于换了要执行的页面。 */
function normalizeBackground(background) {
  if (!background || typeof background !== "object" || Array.isArray(background)) return null;
  const entry = trim(background.entry);
  return entry ? { entry } : null;
}

/** 宿主加载式模块 web 贡献（d.131）→ canonical 形状；与 plugin-signature.js 逐字段一致。 */
function normalizeModuleWeb(web) {
  if (!web || typeof web !== "object" || Array.isArray(web)) return null;
  const entry = trim(web.entry);
  if (!entry) return null;
  const contributions = Array.isArray(web.contributions) ? web.contributions.map(trim).filter(Boolean) : [];
  return { entry, contributions };
}

function normalizeTarget(target) {
  const kind = target?.kind;
  if (kind === "page") return { kind, page: trim(target.page) };
  if (kind === "skill") return { kind, name: trim(target.name) };
  // v5 扩展的两类 target（d.108）：页面动作块与命令共用同一形状，签名必须一起覆盖，
  // 否则「签名后把 settings 卡改成别的」不会被发现。
  if (kind === "settings") return { kind, card: trim(target.card) };
  if (kind === "unit") return { kind, unitId: trim(target.unitId) };
  if (kind === "plugin") return { kind };
  return { kind };
}

/**
 * 页面块 → 签名用的确定性形状（d.124）。
 *
 * 必须与应用归一化（shared `PageSchema`）后的形状一致：web 侧验签拿到的清单已经过
 * zod 归一化（trim、`list.items[].description` 缺省 "" 等），这里对原始清单补同一套
 * 默认值，三份 canonicalizer（本文件 / 桌面端 / web）才能逐字节相等。
 */
function normalizePageBlock(block) {
  const raw = block && typeof block === "object" ? block : {};
  const type = String(raw.type ?? "");
  const title = trim(raw.title);
  const head = title ? { type, title } : { type };
  if (type === "markdown") return { ...head, text: trim(raw.text) };
  if (type === "stats") {
    return {
      ...head,
      items: (Array.isArray(raw.items) ? raw.items : []).map((item) => ({
        label: trim(item?.label),
        value: trim(item?.value),
      })),
    };
  }
  if (type === "table") {
    return {
      ...head,
      columns: stringList(raw.columns),
      rows: (Array.isArray(raw.rows) ? raw.rows : []).map((row) => stringList(row)),
    };
  }
  if (type === "list") {
    return {
      ...head,
      items: (Array.isArray(raw.items) ? raw.items : []).map((item) => ({
        title: trim(item?.title),
        // 应用归一化给缺省 ""（zod .default("")）——这里必须补，否则与 web 文本不一致
        description: trim(item?.description),
        ...(trim(item?.badge) ? { badge: trim(item?.badge) } : {}),
      })),
    };
  }
  if (type === "actions") {
    return {
      ...head,
      items: (Array.isArray(raw.items) ? raw.items : []).map((item) => ({
        label: trim(item?.label),
        target: normalizeTarget(item?.target),
      })),
    };
  }
  if (type === "contributions") return { ...head, kind: String(raw.kind ?? "") };
  // 未知块 type 在应用解析阶段就会被拒；签名文本保持最小形状，避免把垃圾数据签进去。
  return head;
}

/**
 * 页面 → 签名用的确定性形状。
 *
 * 两种形态统一成同一份：声明式（blocks）/ 界面插件（entry）。空 `icon`/`summary`/
 * `entry`/`blocks` **不进文本**——与 shared 的「缺省即空」口径一致，也让没写这些字段的
 * 清单与写了空串的清单签出同一串字节（避免作者手滑多一个 `""` 就验签失败）。
 */
function normalizePage(page) {
  if (!page || typeof page !== "object" || Array.isArray(page)) return null;
  const title = trim(page.title);
  if (!title) return null;
  const out = { title };
  const icon = trim(page.icon);
  if (icon) out.icon = icon;
  const summary = trim(page.summary);
  if (summary) out.summary = summary;
  const entry = trim(page.entry);
  if (entry) out.entry = entry;
  const blocks = (Array.isArray(page.blocks) ? page.blocks : []).map(normalizePageBlock);
  if (blocks.length > 0) out.blocks = blocks;
  return out;
}

/** 与 signature.ts 的 signedManifestText 逐字节一致：含 publisher / packageSha256，排除 signature。 */
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
    ...(normalized.web ? { web: normalized.web } : {}),
    // 审计 P0-1：让签名覆盖 files/** 代码字节；声明式包没有该字段（被 stableValue 丢弃）
    packageSha256: trim(manifest.packageSha256) || undefined,
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
  node scripts/sign-plugin.mjs sign <plugin.json> <private-key.b64url> [--id <发布者 id>] [--write] [--package <tgz> | --dir <包根>]

说明：
  --gen-key  生成 Ed25519 密钥对，打印私钥（base64url）与 publisher 片段
  sign       给清单签名；--write 就地写回，否则只打印 { publisher, signature } 片段
             bundle 会先写 packageSha256（files/** 内容摘要，默认取 plugin.json 同级 files/；
             也可 --package 指定已打好的 tgz，或 --dir 指定包根）`;

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
  const pkgFlag = args.indexOf("--package");
  const packagePath = pkgFlag >= 0 ? args[pkgFlag + 1] : undefined;
  const dirFlag = args.indexOf("--dir");
  const dirPath = dirFlag >= 0 ? args[dirFlag + 1] : undefined;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`读不到或解析不了清单 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (publisherId) manifest.publisher = { id: publisherId, publicKey: manifest.publisher?.publicKey ?? "" };

  // 审计 P0-1：bundle / module 先把 files/** 内容摘要写进清单再签，签名即覆盖代码字节。
  if (manifest.distribution === "bundle" || manifest.distribution === "module") {
    let digest;
    if (packagePath) digest = digestFromTgz(resolve(packagePath));
    else digest = digestFromPackageRoot(dirPath ? resolve(dirPath) : dirname(resolve(file)));
    manifest.packageSha256 = digest;
    console.log(`packageSha256  ${digest}`);
  } else if (manifest.packageSha256 !== undefined) {
    delete manifest.packageSha256;
    console.log("声明式包不写 packageSha256（已忽略）");
  }

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
