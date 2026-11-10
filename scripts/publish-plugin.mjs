#!/usr/bin/env node
/**
 * 发布插件包到「云端插件目录」的本地发布目录（d.86）。
 *
 * 为什么需要：信息采集 / magpie 网关这类插件**不随安装包分发**——它们是独立产物，
 * 由服务端 `/api/plugins` 列出来、用户自行下载安装。本脚本只负责把仓库里的
 * `plugin-kit/plugins/<名字>/plugin.json` 校验后摆成服务端要的目录布局：
 *
 *   <dest>/<插件 id>/<版本>/plugin.json      （原样字节）
 *   <dest>/<插件 id>/<版本>/package.tgz      （仅界面插件：v4 distribution: "bundle"）
 *
 * 界面插件（d.94）：输入 = 一个**包根目录**（含 `plugin.json` + `files/**`），
 * 脚本把这两部分打成确定性 tar.gz，客户端下载后先比对目录里的 sha256 再解包。
 * 目录布局与读取逻辑见 `packages/server/src/pluginCatalog.ts`。
 *
 * 用法：
 *   node scripts/publish-plugin.mjs plugin-kit/plugins/infohub-collector/plugin.json
 *   node scripts/publish-plugin.mjs plugin-kit/plugins/                 # 目录下每个并包
 *   node scripts/publish-plugin.mjs plugin-kit/plugins/infohub-collector/plugin.json --dry-run
 *   node scripts/publish-plugin.mjs plugin-kit/plugins/ --dest D:/tmp/plugins-catalog
 *   node scripts/publish-plugin.mjs plugin-kit/plugins/ --push https://heming.example.com
 *
 * 两种目标：
 * - 缺省写本地目录（沿用「同步目录到服务器」的部署链）；
 * - `--push <apiBase>` 直接走仓库发布接口：`PUT /api/plugins/<id>/<version>`
 *   （`x-publish-key: $HEMING_PLUGIN_PUBLISH_KEY`），适合 CI 直接发到云端。
 *
 * 环境变量：
 *   HEMING_PLUGIN_DIR         目标目录；缺省 `<cwd>/plugins-catalog`
 *   HEMING_PLUGIN_PUBLISH_KEY 发布密钥（`--push` 必填；服务端未配置则接口关闭）
 *
 * 不做的事（边界）：
 * - **不做 SFTP/SSH**：上传服务器沿用现有部署链（把本目录同步到服务器的
 *   `HEMING_PLUGIN_DIR`，例如 `/opt/heming/plugins`），发布账号与凭据不在这里新增一套；
 * - 不信任清单内容：只做「是不是一个能解析、id/版本合规的插件包」的基础校验；
 *   权限、签名、安装校验都由客户端在下载后做。
 *
 * 退出码：0 全部成功；1 有坏包或写盘失败（不静默跳过）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

/**
 * 界面插件包（v4 `distribution: "bundle"`）的 tar 打包复用桌面端实现：
 * 安装端解包与发布端打包必须是同一份代码（确定性 tar、路径安全、配额口径一致），
 * 在这里 import 一份 ESM 版没有意义，直接 require CJS 纯函数模块。
 */
const require = createRequire(import.meta.url);
const { packTarGz } = require("../packages/desktop/plugin-tar.js");

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/**
 * 界面插件包根目录 → tar 条目（plugin.json + files/**）。
 * 只接受包根下的 `files/` 子树：规格 §2.1 的固定结构，多一层少一层都是坏包。
 */
function collectBundleEntries(rootDir) {
  const entries = [];
  const manifestPath = join(rootDir, "plugin.json");
  entries.push({ path: "plugin.json", data: readFileSync(manifestPath) });
  const filesDir = join(rootDir, "files");
  if (!existsSync(filesDir) || !statSync(filesDir).isDirectory()) {
    return { entries, error: "缺少 files/ 目录（界面插件包必须包含 files/**）" };
  }
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) return { error: `不允许符号链接/特殊文件：${abs}` };
      const rel = relative(rootDir, abs).split("\\").join("/");
      entries.push({ path: rel, data: readFileSync(abs) });
    }
    return null;
  };
  const walkError = walk(filesDir);
  if (walkError) return { entries, error: walkError.error };
  if (entries.length <= 1) return { entries, error: "files/ 目录为空" };
  return { entries, error: null };
}

function usage() {
  console.error(
    [
      "用法：node scripts/publish-plugin.mjs <plugin.json | 目录> [...] [--dest <dir>] [--push <apiBase>] [--dry-run]",
      "      node scripts/publish-plugin.mjs --index <目录> [--title <标题>] [--description <描述>] [--dest <dir>] [--push <apiBase>] [--dry-run]",
      "  --dest      目标目录（缺省 HEMING_PLUGIN_DIR 或 <cwd>/plugins-catalog）",
      "  --push      直接发布到远端仓库（PUT /api/plugins/<id>/<version>），需 HEMING_PLUGIN_PUBLISH_KEY",
      "  --index     扫描 <目录>/<id>/<version>/plugin.json，生成市场索引 market.json（format 1）",
      "  --title     索引顶层标题（缺省「和鸣插件目录」）",
      "  --description 索引顶层描述（缺省「官方与社区能力包」）",
      "  --dry-run   只校验并打印，不写盘/不请求",
    ].join("\n"),
  );
}

/** 参数里的目录 → 其下的 plugin.json；文件则原样。 */
function resolveInputs(rawArgs) {
  const files = [];
  const missing = [];
  for (const arg of rawArgs) {
    const abs = resolve(arg);
    if (!existsSync(abs)) {
      missing.push(arg);
      continue;
    }
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      const nested = join(abs, "plugin.json");
      if (existsSync(nested)) files.push(nested);
      else {
        for (const entry of readdirSync(abs, { withFileTypes: true })) {
          if (entry.isDirectory() && existsSync(join(abs, entry.name, "plugin.json"))) {
            files.push(join(abs, entry.name, "plugin.json"));
          }
        }
      }
    } else {
      files.push(abs);
    }
  }
  return { files, missing };
}

function validate(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { error: `不是合法 JSON：${err.message}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "清单必须是 JSON 对象" };
  if (!ID_RE.test(String(raw.id ?? ""))) return { error: `插件 id 不合规：${String(raw.id)}` };
  if (!VERSION_RE.test(String(raw.version ?? ""))) return { error: `版本号不合规：${String(raw.version)}` };
  if (!Number.isInteger(raw.schemaVersion)) return { error: "缺少整数 schemaVersion" };
  if (typeof raw.name !== "string" || !raw.name.trim()) return { error: "缺少插件名" };
  const bytes = readFileSync(file);
  const base = {
    id: raw.id,
    version: raw.version,
    schemaVersion: raw.schemaVersion,
    name: raw.name,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };

  // 界面插件（d.94）：结构化校验比纯声明式严——它带可执行代码，坏包必须拒绝而不是半装。
  if (raw.distribution === "bundle") {
    if (raw.schemaVersion !== 4) return { error: "distribution: bundle 需要 schemaVersion 4" };
    const contributions = raw.contributions && typeof raw.contributions === "object" ? raw.contributions : {};
    const widgets = Array.isArray(contributions.desktopWidgets) ? contributions.desktopWidgets : [];
    /**
     * d.124：bundle 可以只声明页面（纯页面插件，没有桌面浮窗）。
     *
     * 规则与安装端 `plugin-package.js` 一致：至少 `desktopWidgets` 或 `page` 之一，
     * 每类最多 1 个——发布脚本此前写死「必须 1 个 desktopWidgets」，页面插件在
     * 发布机上就被误拒（安装端其实已经接受）。
     */
    const page =
      contributions.page && typeof contributions.page === "object" && !Array.isArray(contributions.page)
        ? contributions.page
        : null;
    if (widgets.length > 1) return { error: "bundle 清单最多声明 1 个 contributions.desktopWidgets" };
    if (widgets.length === 0 && !page) {
      return { error: "bundle 清单必须声明 1 个 contributions.desktopWidgets 或 contributions.page" };
    }
    for (const denied of ["skills", "mcpServers", "toolPacks"]) {
      const list = contributions[denied];
      if (Array.isArray(list) && list.length > 0) {
        return { error: `界面插件不允许声明 contributions.${denied}（只能带 commands + desktopWidgets + page）` };
      }
    }
    const root = dirname(file);
    const { entries, error } = collectBundleEntries(root);
    if (error) return { error };
    const paths = new Set(entries.map((item) => item.path));
    if (widgets.length === 1) {
      const entry = String(widgets[0].entry ?? "");
      if (!entry.startsWith("files/") || entry.includes("..")) {
        return { error: `desktopWidgets[0].entry 必须是 files/ 下的相对路径：${entry}` };
      }
      if (!paths.has(entry)) return { error: `entry 指向的文件不存在：${entry}` };
    }
    if (page) {
      const entry = String(page.entry ?? "");
      if (!entry.startsWith("files/") || entry.includes("..")) {
        return { error: `contributions.page.entry 必须是 files/ 下的相对路径：${entry}` };
      }
      if (!paths.has(entry)) return { error: `页面入口指向的文件不存在：${entry}` };
    }
    let packageBytes;
    try {
      packageBytes = packTarGz(entries);
    } catch (err) {
      return { error: `打包失败：${err.message}` };
    }
    /**
     * 发布前用**安装口径**复验（审计 P0-1 的收尾）：未签名 / 首方签名不符 /
     * `packageSha256` 与 files/** 不一致的包，绝不能进目录。之前这里只做了
     * 结构校验，导致「未签名包被发布、用户端才拒绝」；现在坏包在发布机就失败。
     */
    try {
      const { readPackage } = require("../packages/desktop/plugin-package.js");
      const check = readPackage(packageBytes, {
        allowDevKeys: process.env.HEMING_ALLOW_DEV_PLUGIN_KEYS === "1",
      });
      if (!check.ok) {
        return { error: `界面插件包未通过安装口径校验：${check.errors.join("；")}` };
      }
    } catch (err) {
      return { error: `界面插件包复验失败：${err instanceof Error ? err.message : String(err)}` };
    }
    return {
      ...base,
      bundle: {
        entries: entries.length,
        bytes: packageBytes,
        sha256: createHash("sha256").update(packageBytes).digest("hex"),
      },
    };
  }

  return base;
}

async function pushToRepo(apiBase, result) {
  const key = (process.env.HEMING_PLUGIN_PUBLISH_KEY ?? "").trim();
  if (!key) return { error: "未设置 HEMING_PLUGIN_PUBLISH_KEY（发布接口需要发布密钥）" };
  const base = apiBase.replace(/\/+$/, "");
  const url = `${base}/api/plugins/${encodeURIComponent(result.id)}/${encodeURIComponent(result.version)}`;
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-publish-key": key },
      body: result.bytes,
    });
    if (!response.ok) {
      let reason = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (body && typeof body.error === "string") reason = `${reason} ${body.error}`;
      } catch {
        /* 非 JSON 错误体：保留状态码 */
      }
      return { error: `发布失败：${reason}` };
    }
    const body = await response.json();
    // 界面插件：清单发布成功后再发 package.tgz（服务端要求同 id/版本的清单已存在）
    if (result.bundle) {
      const packageResponse = await fetch(`${url}/package`, {
        method: "PUT",
        headers: { "content-type": "application/gzip", "x-publish-key": key },
        body: result.bundle.bytes,
      });
      if (!packageResponse.ok) {
        let reason = `HTTP ${packageResponse.status}`;
        try {
          const packageBody = await packageResponse.json();
          if (packageBody && typeof packageBody.error === "string") reason = `${reason} ${packageBody.error}`;
        } catch {
          /* 非 JSON 错误体：保留状态码 */
        }
        return { error: `清单已发布，但插件包发布失败：${reason}` };
      }
    }
    return { target: url, created: Boolean(body?.created) };
  } catch (err) {
    return { error: `请求失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

// ───────────────────────── 市场索引 v2（--index，d.105） ─────────────────────────
// 规格 §6：服务端不扫描、不生成索引；发布工具扫描 `<dir>/<id>/<version>/plugin.json`
// 生成 `market.json`（format 1），服务端只在 PUT 时校验格式并原样落盘。

const HEMING_VERSION_RE = /^[dcm](?:\.[0-9]{1,7}){1,4}(?:-dev\.[0-9]{1,7})?$/i;
const CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** 详情文件名：服务端详情路由按「版本目录下的单段 .md」分发（防目录穿越）。 */
const DETAIL_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/i;
const MAX_BUNDLE_BYTES = 40 * 1024 * 1024;
const DEFAULT_INDEX_TITLE = "和鸣插件目录";
const DEFAULT_INDEX_DESCRIPTION = "官方与社区能力包";

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 版本比较：与服务端目录排序同口径（数字段按数值比，非数字段退化为字典序）。 */
function compareVersions(a, b) {
  const split = (value) =>
    value.split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

function readJsonObject(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { error: `不是合法 JSON：${error.message}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "必须是 JSON 对象" };
  return { raw };
}

/** 可选 sidecar：`<id>/market.json`（插件级）与 `<id>/<version>/market.json`（版本级）。 */
function readSidecar(file) {
  if (!existsSync(file)) return { raw: null };
  const parsed = readJsonObject(file);
  return parsed.error ? { error: parsed.error } : { raw: parsed.raw };
}

function localize(value, max) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

function stringList(value, max, itemMax = 32) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim().slice(0, itemMax))
    .slice(0, max);
}

function httpsUrlOf(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return /^https?:\/\//.test(text) && text.length <= 2_048 ? text : undefined;
}

/** 扫一个版本目录：校验清单 + 计算指纹 + 读版本级 sidecar。 */
function scanVersionEntry(id, version, versionDir) {
  const manifestPath = join(versionDir, "plugin.json");
  const parsed = readJsonObject(manifestPath);
  if (parsed.error) return { error: `plugin.json ${parsed.error}` };
  const manifest = parsed.raw;
  if (String(manifest.id) !== id) {
    return { error: `plugin.json 的 id（${String(manifest.id)}）与目录 ${id} 不一致` };
  }
  if (String(manifest.version) !== version) {
    return { error: `plugin.json 的 version（${String(manifest.version)}）与目录 ${version} 不一致` };
  }
  if (!Number.isInteger(manifest.schemaVersion)) return { error: "缺少整数 schemaVersion" };
  if (typeof manifest.name !== "string" || !manifest.name.trim()) return { error: "缺少插件名 name" };

  const engine =
    manifest.engines && typeof manifest.engines === "object" && typeof manifest.engines.heming === "string"
      ? manifest.engines.heming.trim()
      : "";
  // v5 清单 engines 必填；v1–v4 归一化为 d.0（与 shared 的 legacy 视图一致）。
  if (!engine && manifest.schemaVersion >= 5) return { error: "v5 清单必须声明 engines.heming" };
  const heming = engine || "d.0";
  if (!HEMING_VERSION_RE.test(heming)) return { error: `engines.heming 不合法：${heming}` };

  const sidecar = readSidecar(join(versionDir, "market.json"));
  if (sidecar.error) return { error: `market.json sidecar ${sidecar.error}` };
  const extra = sidecar.raw ?? {};

  const distribution = manifest.distribution === "bundle" ? "bundle" : "manifest";
  const manifestBytes = readFileSync(manifestPath);
  const manifestStat = statSync(manifestPath);
  const packagePath = join(versionDir, "package.tgz");
  let packageInfo = null;
  if (existsSync(packagePath)) {
    const stat = statSync(packagePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BUNDLE_BYTES) {
      return { error: `package.tgz 为空、不是文件或超过 40MB：${packagePath}` };
    }
    packageInfo = { sha256: sha256Of(readFileSync(packagePath)), size: stat.size };
  }
  if (distribution === "bundle" && !packageInfo) {
    return { error: "distribution: bundle 必须有同版本的 package.tgz" };
  }

  let detail;
  if (extra.detail !== undefined) {
    const value = extra.detail;
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 200 ||
      !DETAIL_FILE_RE.test(value)
    ) {
      return { error: `sidecar detail 必须是版本目录内的单段 .md 文件名（如 detail.md / intro.md）：${String(value)}` };
    }
    if (!existsSync(join(versionDir, value))) return { error: `sidecar detail 指向的文件不存在：${value}` };
    detail = value;
  } else if (existsSync(join(versionDir, "detail.md"))) {
    detail = "detail.md";
  }

  if (extra.status !== undefined && !["active", "deprecated", "deleted"].includes(extra.status)) {
    return { error: `sidecar status 只能是 active/deprecated/deleted：${String(extra.status)}` };
  }
  if (extra.channel !== undefined && !["release", "prerelease"].includes(extra.channel)) {
    return { error: `sidecar channel 只能是 release/prerelease：${String(extra.channel)}` };
  }
  if (
    extra.statusMessage !== undefined &&
    (typeof extra.statusMessage !== "string" || extra.statusMessage.length > 500)
  ) {
    return { error: "sidecar statusMessage 必须是 ≤500 字的字符串" };
  }
  let publishedAt;
  if (extra.publishedAt !== undefined) {
    if (
      typeof extra.publishedAt !== "string" ||
      extra.publishedAt.length > 40 ||
      Number.isNaN(Date.parse(extra.publishedAt))
    ) {
      return { error: `sidecar publishedAt 不是合法时间：${String(extra.publishedAt)}` };
    }
    publishedAt = extra.publishedAt;
  } else {
    publishedAt = new Date(manifestStat.mtimeMs).toISOString();
  }

  return {
    manifest,
    manifestPath,
    manifestBytes,
    packagePath: packageInfo ? packagePath : null,
    extra,
    entry: {
      version,
      publishedAt,
      schemaVersion: manifest.schemaVersion,
      engines: { heming },
      distribution,
      sha256: sha256Of(manifestBytes),
      size: manifestBytes.length,
      ...(packageInfo ? { package: packageInfo } : {}),
      ...(detail ? { detail } : {}),
      ...(extra.status ? { status: extra.status } : {}),
      ...(extra.statusMessage ? { statusMessage: extra.statusMessage } : {}),
      ...(extra.channel ? { channel: extra.channel } : {}),
    },
  };
}

/** sidecar 的 categories/tags 既允许数组（只有 id），也允许对象（id → 标题）。 */
function absorbTaxonomy(value, into) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && CATEGORY_RE.test(item)) into[item] ??= { title: item };
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, title] of Object.entries(value)) {
    if (!CATEGORY_RE.test(key)) continue;
    into[key] ??= { title: localize(title, 200) ?? key };
  }
}

/** 插件级字段：取最新版本的清单 + 插件级 sidecar（版本级 sidecar 仅覆盖版本字段）。 */
function buildPluginEntry(id, scanned, pluginSidecar) {
  const warnings = [];
  const newest = scanned[scanned.length - 1];
  const raw = newest.manifest;
  const meta = raw.meta && typeof raw.meta === "object" ? raw.meta : {};
  const sidecar = pluginSidecar ?? {};
  const categoryTitles = {};
  const tagTitles = {};
  absorbTaxonomy(sidecar.categories, categoryTitles);
  absorbTaxonomy(newest.extra?.categories, categoryTitles);
  absorbTaxonomy(sidecar.tags, tagTitles);
  absorbTaxonomy(newest.extra?.tags, tagTitles);

  const categoryCandidate = [
    sidecar.category,
    ...Object.keys(categoryTitles),
    meta.category,
  ].find((value) => typeof value === "string" && CATEGORY_RE.test(value));
  const category = categoryCandidate;
  if (category) categoryTitles[category] ??= { title: category };

  for (const tag of [...stringList(sidecar.tags, 8), ...stringList(meta.tags, 8)]) {
    if (CATEGORY_RE.test(tag)) tagTitles[tag] ??= { title: tag };
  }
  const tags = [
    ...new Set([...Object.keys(tagTitles), ...stringList(sidecar.tags, 8), ...stringList(meta.tags, 8)]),
  ]
    .filter((tag) => CATEGORY_RE.test(tag))
    .slice(0, 8);
  const keywords = [...new Set([...stringList(sidecar.keywords, 20), ...stringList(meta.keywords, 20)])];

  let sortKeys;
  if (sidecar.sortKeys && typeof sidecar.sortKeys === "object" && !Array.isArray(sidecar.sortKeys)) {
    const entries = Object.entries(sidecar.sortKeys)
      .filter(([key, value]) => key.length <= 32 && typeof value === "number" && Number.isFinite(value))
      .slice(0, 8);
    if (entries.length > 0) sortKeys = Object.fromEntries(entries);
  }

  const screenshots = [
    ...(Array.isArray(sidecar.screenshots) ? sidecar.screenshots : []),
    ...(Array.isArray(meta.screenshots) ? meta.screenshots : []),
  ];
  if (screenshots.length > 0) {
    warnings.push(
      `${id}：索引格式（format 1）暂无 screenshots 字段，已忽略 ${screenshots.length} 张截图；请改用 detail.md 展示`,
    );
  }

  const versionStatus =
    sidecar.status === "active" || sidecar.status === "deprecated" || sidecar.status === "removed"
      ? sidecar.status
      : undefined;
  const deprecatedReason = localize(sidecar.deprecatedReason ?? sidecar.deprecated_reason, 500);
  const alternativeId =
    typeof sidecar.alternativeId === "string" && ID_RE.test(sidecar.alternativeId)
      ? sidecar.alternativeId
      : undefined;
  const renames = stringList(sidecar.renames, 8, 64).filter((rename) => ID_RE.test(rename));

  const publishedTimes = scanned
    .map((item) => Date.parse(item.entry.publishedAt))
    .filter((time) => !Number.isNaN(time));
  const updatedAt =
    publishedTimes.length > 0
      ? new Date(Math.max(...publishedTimes)).toISOString()
      : new Date(newest.entry.publishedAt).toISOString();

  const metadata = {
    ...(category ? { category } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(sortKeys ? { sortKeys } : {}),
  };

  return {
    plugin: {
      id,
      title: localize(sidecar.title, 200) ?? localize(raw.name, 200) ?? id,
      ...(localize(sidecar.description, 200) ?? localize(raw.description, 200)
        ? { description: localize(sidecar.description, 200) ?? localize(raw.description, 200) }
        : {}),
      ...(typeof sidecar.icon === "string" && sidecar.icon
        ? { icon: sidecar.icon.slice(0, 48_000) }
        : typeof meta.icon === "string" && meta.icon
          ? { icon: meta.icon.slice(0, 48_000) }
          : {}),
      ...(localize(sidecar.author, 64) ?? localize(raw.author, 64)
        ? { author: localize(sidecar.author, 64) ?? localize(raw.author, 64) }
        : {}),
      ...(httpsUrlOf(sidecar.homepage) ?? httpsUrlOf(meta.homepage)
        ? { homepage: httpsUrlOf(sidecar.homepage) ?? httpsUrlOf(meta.homepage) }
        : {}),
      ...(httpsUrlOf(sidecar.repository) ?? httpsUrlOf(meta.repository)
        ? { repository: httpsUrlOf(sidecar.repository) ?? httpsUrlOf(meta.repository) }
        : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      latest: newest.entry.version,
      updatedAt,
      ...(versionStatus ? { status: versionStatus } : {}),
      ...(deprecatedReason ? { deprecatedReason } : {}),
      ...(alternativeId ? { alternativeId } : {}),
      ...(renames.length > 0 ? { renames } : {}),
      versions: scanned.map((item) => item.entry),
    },
    categoryTitles,
    tagTitles,
    warnings,
  };
}

/** 扫描发布目录并生成索引（纯函数：不写盘、不请求，便于 --dry-run 与自测）。 */
function buildMarketIndex(opts) {
  const failures = [];
  const warnings = [];
  const versions = [];
  const plugins = [];
  const categoryTitles = {};
  const tagTitles = {};

  let ids = [];
  try {
    ids = readdirSync(opts.catalogDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ID_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    failures.push(`目录不可读：${opts.catalogDir}（${error.message}）`);
  }
  if (ids.length === 0 && failures.length === 0) failures.push(`目录里没有任何插件：${opts.catalogDir}`);

  for (const id of ids) {
    const pluginDir = join(opts.catalogDir, id);
    let versionNames = [];
    try {
      versionNames = readdirSync(pluginDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && VERSION_RE.test(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      failures.push(`${id}：读目录失败（${error.message}）`);
      continue;
    }
    versionNames.sort(compareVersions);
    if (versionNames.length === 0) {
      failures.push(`${id}：没有合法版本目录`);
      continue;
    }
    const sidecar = readSidecar(join(pluginDir, "market.json"));
    if (sidecar.error) {
      failures.push(`${id}/market.json：${sidecar.error}`);
      continue;
    }
    const scanned = [];
    for (const version of versionNames) {
      const result = scanVersionEntry(id, version, join(pluginDir, version));
      if (result.error) {
        failures.push(`${id}@${version}：${result.error}`);
        continue;
      }
      scanned.push(result);
      versions.push({
        id,
        version,
        manifestPath: result.manifestPath,
        manifestBytes: result.manifestBytes,
        packagePath: result.packagePath,
      });
    }
    if (scanned.length === 0) continue;
    const built = buildPluginEntry(id, scanned, sidecar.raw);
    warnings.push(...built.warnings);
    Object.assign(categoryTitles, built.categoryTitles);
    Object.assign(tagTitles, built.tagTitles);
    plugins.push(built.plugin);
  }

  const index = {
    format: 1,
    title: localize(opts.title, 200) ?? DEFAULT_INDEX_TITLE,
    description: localize(opts.description, 200) ?? DEFAULT_INDEX_DESCRIPTION,
    generatedAt: new Date().toISOString(),
    ...(Object.keys(categoryTitles).length > 0 ? { categories: categoryTitles } : {}),
    ...(Object.keys(tagTitles).length > 0 ? { tags: tagTitles } : {}),
    plugins,
  };
  return { index, failures, warnings, versions };
}

/** 原子写索引（tmp + rename），返回写入字节。 */
function writeMarketIndex(dest, index) {
  mkdirSync(dest, { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8");
  const target = join(dest, "market.json");
  const tmp = join(dest, `.market.json.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, target);
  return bytes;
}

/** 一次 PUT（清单 / 包 / 索引共用）：失败返回可读原因，不抛。 */
async function putBytes(url, bytes, contentType, key) {
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: { "content-type": contentType, "x-publish-key": key },
      body: bytes,
    });
    if (!response.ok) {
      let reason = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (body && typeof body.error === "string") reason = `${reason} ${body.error}`;
      } catch {
        /* 非 JSON 错误体：保留状态码 */
      }
      return { error: reason };
    }
    return { ok: true };
  } catch (error) {
    return { error: `请求失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * `--index` 模式：生成 market.json（写 dest）→ 可选推送。
 *
 * 有坏包时**不写也不推**：市场索引是「列表页的全部字段」，缺条目的索引会让插件静默消失，
 * 比发布失败更难排查；和单包模式一样以非 0 退出。
 */
async function runIndexMode(opts) {
  const built = buildMarketIndex({
    catalogDir: opts.indexDir,
    title: opts.title,
    description: opts.description,
  });
  for (const warning of built.warnings) console.warn(`[提示] ${warning}`);
  if (built.failures.length > 0) {
    for (const failure of built.failures) console.error(`[失败] ${failure}`);
    console.error(
      `索引未生成：${built.failures.length} 个坏包/坏目录（先修完再发布，避免发出缺条目的市场）`,
    );
    return 1;
  }

  const pluginCount = built.index.plugins.length;
  const versionCount = built.versions.length;
  if (opts.dryRun) {
    console.log(
      `[dry-run] 将生成 market.json：${pluginCount} 个插件 / ${versionCount} 个版本 → ${join(opts.dest, "market.json")}`,
    );
    return 0;
  }

  if (opts.dest !== opts.indexDir) {
    console.warn(
      `[提示] 索引写到 ${opts.dest}，但 detail.md / 资源仍在 ${opts.indexDir}；部署时两者应指向同一个发布目录`,
    );
  }
  let indexBytes;
  try {
    indexBytes = writeMarketIndex(opts.dest, built.index);
  } catch (error) {
    console.error(`[失败] 写索引失败：${error.message}`);
    return 1;
  }
  console.log(
    `生成 ${join(opts.dest, "market.json")}：${pluginCount} 个插件 / ${versionCount} 个版本（${indexBytes.length}B）`,
  );

  if (!opts.push) {
    console.log(
      "\n下一步：把该目录同步到服务器的 HEMING_PLUGIN_DIR（客户端 GET /api/plugin-market 读取），" +
        "或用 --push <apiBase> 直接上传索引与各版本。",
    );
    return 0;
  }

  const key = (process.env.HEMING_PLUGIN_PUBLISH_KEY ?? "").trim();
  if (!key) {
    console.error("[失败] 未设置 HEMING_PLUGIN_PUBLISH_KEY（发布接口需要发布密钥）");
    return 1;
  }
  const base = opts.push.replace(/\/+$/, "");
  const indexPush = await putBytes(`${base}/api/plugin-market`, indexBytes, "application/json", key);
  if (indexPush.error) {
    console.error(`[失败] 索引发布失败：${indexPush.error}`);
    return 1;
  }
  console.log(`索引已发布到 ${base}/api/plugin-market`);

  const failures = [];
  for (const item of built.versions) {
    const url = `${base}/api/plugins/${encodeURIComponent(item.id)}/${encodeURIComponent(item.version)}`;
    const manifestPush = await putBytes(url, item.manifestBytes, "application/json", key);
    if (manifestPush.error) {
      failures.push(`${item.id}@${item.version} 清单：${manifestPush.error}`);
      continue;
    }
    if (item.packagePath) {
      const packagePush = await putBytes(`${url}/package`, readFileSync(item.packagePath), "application/gzip", key);
      if (packagePush.error) failures.push(`${item.id}@${item.version} 包：${packagePush.error}`);
    }
  }
  for (const failure of failures) console.error(`[失败] ${failure}`);
  if (failures.length > 0) {
    console.error(`${failures.length} 个版本未发布成功（索引已先发布，重跑即可补齐）`);
    return 1;
  }
  console.log(`已推送 ${versionCount} 个版本`);
  return 0;
}

async function main(argv) {
  let destArg = "";
  let pushArg = "";
  let indexArg = "";
  let titleArg = "";
  let descriptionArg = "";
  let dryRun = false;
  const inputs = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--push") {
      pushArg = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--dest") {
      destArg = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--index") {
      indexArg = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--title") {
      titleArg = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--description") {
      descriptionArg = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      return 0;
    } else inputs.push(arg);
  }
  // --index 模式：扫发布目录生成市场索引（不接收单包路径参数，避免语义混淆）
  if (indexArg) {
    if (inputs.length > 0) {
      console.error("[失败] --index 模式不接受单包路径参数（单包发布请去掉 --index）");
      usage();
      return 1;
    }
    const indexDir = resolve(indexArg);
    return runIndexMode({
      indexDir,
      dest: resolve(destArg || process.env.HEMING_PLUGIN_DIR || indexDir),
      push: pushArg,
      title: titleArg,
      description: descriptionArg,
      dryRun,
    });
  }
  if (inputs.length === 0) {
    usage();
    return 1;
  }
  const dest = resolve(destArg || process.env.HEMING_PLUGIN_DIR || join(process.cwd(), "plugins-catalog"));
  const { files, missing } = resolveInputs(inputs);
  const failures = [];
  for (const item of missing) failures.push(`${item}：路径不存在`);
  if (files.length === 0 && failures.length === 0) failures.push("没有找到任何 plugin.json");

  const ok = [];
  for (const file of files) {
    const result = validate(file);
    if (result.error) {
      failures.push(`${file}：${result.error}`);
      continue;
    }
    if (!dryRun && pushArg) {
      const pushed = await pushToRepo(pushArg, result);
      if (pushed.error) {
        failures.push(`${file}：${pushed.error}`);
        continue;
      }
      ok.push({ ...result, source: file, target: pushed.target, created: pushed.created });
      continue;
    }
    const targetDir = join(dest, result.id, result.version);
    if (!dryRun) {
      try {
        mkdirSync(targetDir, { recursive: true });
        copyFileSync(file, join(targetDir, "plugin.json"));
        if (result.bundle) writeFileSync(join(targetDir, "package.tgz"), result.bundle.bytes);
      } catch (err) {
        failures.push(`${file}：写盘失败 ${err.message}`);
        continue;
      }
    }
    ok.push({
      ...result,
      source: file,
      target: result.bundle ? join(targetDir, "package.tgz") : join(targetDir, "plugin.json"),
    });
  }

  for (const item of ok) {
    const bundle = item.bundle
      ? `，界面包 ${item.bundle.entries} 个文件 / ${item.bundle.bytes.length}B sha256=${item.bundle.sha256.slice(0, 16)}…`
      : "";
    console.log(
      `${dryRun ? "[dry-run] " : ""}发布 ${item.id}@${item.version}（schemaVersion ${item.schemaVersion}）` +
        ` sha256=${item.sha256.slice(0, 16)}…${bundle} → ${item.target}` +
        (item.created === false ? "（覆盖已有版本）" : ""),
    );
  }
  for (const failure of failures) console.error(`[失败] ${failure}`);
  if (ok.length > 0) {
    if (pushArg) {
      console.log(`
已发布到 ${pushArg}；客户端「插件区 → 仓库」即可看到（服务端 GET /api/plugins）。`);
    } else {
      console.log(`
目录：${dest}`);
      console.log(
        "下一步：把该目录同步到服务器的 HEMING_PLUGIN_DIR（例如 /opt/heming/plugins），" +
          "客户端「插件区 → 仓库」即可看到（服务端 GET /api/plugins）。",
      );
    }
  }
  return failures.length > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
