import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  PLUGIN_CATALOG_ID_RE,
  PLUGIN_CATALOG_VERSION_RE,
  type PluginCatalogContributions,
  type PluginCatalogDetail,
  type PluginCatalogEntry,
  type PluginCatalogPermissions,
  type PluginCatalogPublishResult,
} from "@heming/shared";

/**
 * 云端插件目录（d.86）：服务端只做「目录 + 原样分发」，不解析执行插件。
 *
 * 布局：`<dir>/<插件 id>/<版本>/plugin.json`（原样字节）。
 * - 一个 id 可以有多版；目录接口只返回**最新版本**，客户端拿到的 entry 带 sha256，
 *   下载后再用它校验内容（服务端不替客户端做信任判断）；
 * - 目录里的坏包只跳过该条（并在 stderr 提示），不让整份目录 500；
 * - `read()` 只接受 shared 里的 id/版本正则并只拼这两段路径——不变量：**永不越界读文件**。
 *
 * 为什么不做缓存：插件目录很小（每个包几 KB、总量几十个），一次 readdir + 几个 readFile
 * 的开销远小于缓存失效带来的「发了新版本但客户端看不到」。
 */

/** 单个 plugin.json 上限：插件只声明能力，正常几 KB；超了说明不是插件包。 */
const MAX_MANIFEST_BYTES = 256 * 1024;
/** 界面插件包（`package.tgz`）上限：解包后还有 20MB/2000 文件的校验，这里只挡明显异常。 */
const MAX_PACKAGE_BYTES = 40 * 1024 * 1024;

const TOOLS = new Set(["none", "read", "write"]);

/** 发布/下线失败原因（app 层映射 400/409）。 */
export type PluginCatalogWriteError = "invalid_id" | "invalid_version" | "too_large" | "mismatch";

export interface PluginCatalogRead {
  bytes: Buffer;
  sha256: string;
}

export interface PluginCatalog {
  /** 最新版本列表；目录不存在/为空返回空数组。 */
  list(): PluginCatalogEntry[];
  /** 读取某个 id/版本的原样清单字节；不存在或参数非法返回 null。 */
  read(id: string, version: string): PluginCatalogRead | null;
  /** 读取某个 id/版本的界面插件包（`package.tgz`）字节；纯声明式包返回 null。 */
  readPackage(id: string, version: string): PluginCatalogRead | null;
  /**
   * 发布界面插件包（d.98）：原样落盘 `package.tgz`。
   *
   * 与清单分开两次发布（先清单、再包）：包必须能找到同 id/版本的清单，避免「有包没清单」的孤儿；
   * 不解析包内容——解包配额、清单结构、entry 存在性都由客户端安装时校验。
   */
  publishPackage(
    id: string,
    version: string,
    bytes: Buffer,
  ):
    | { created: boolean; sha256: string; size: number }
    | "invalid_id"
    | "invalid_version"
    | "too_large"
    | "missing_manifest"
    | "conflict";
  /** 某个插件在仓库里的全部版本（新→旧）；不存在返回 null。 */
  detail(id: string): PluginCatalogDetail | null;
  /**
   * 发布一份清单到仓库（原样字节落盘，不解析权限/不执行任何代码）。
   *
   * 只做三件事：校验 id/版本字符集与大小、确认清单里的 id/version 与参数一致、原子写入。
   * 同 id/版本重复发布 = 覆盖（幂等重发），返回 created=false。
   */
  publish(id: string, version: string, bytes: Buffer): PluginCatalogPublishResult | PluginCatalogWriteError;
  /** 下线一个版本（仓库运维；不存在返回 not_found）。 */
  remove(id: string, version: string): "ok" | "not_found";
  /** 目录位置（部署排查用）。 */
  readonly dir: string;
}

/**
 * 版本比较：`1.10.0` > `1.9.0`（数字段按数值比），非数字段按字符串比；
 * 无法解析的一律退回字符串比较，保证排序确定性。
 */
export function comparePluginVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    if (sa === sb) continue;
    const na = /^\d+$/.test(sa) ? Number(sa) : null;
    const nb = /^\d+$/.test(sb) ? Number(sb) : null;
    if (na !== null && nb !== null) return na - nb;
    return sa < sb ? -1 : 1;
  }
  return 0;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** 计数口径与客户端同源：v3/v4 看 contributions，v1/v2 旧包看顶层 skills / mcpServers。 */
function contributionsOf(raw: Record<string, unknown>): PluginCatalogContributions {
  const contributions =
    raw.contributions && typeof raw.contributions === "object"
      ? (raw.contributions as Record<string, unknown>)
      : {};
  const legacySkills = Array.isArray(raw.skills) ? raw.skills : [];
  const legacyServers = Array.isArray(raw.mcpServers) ? raw.mcpServers : [];
  const declaredSkills = Array.isArray(contributions.skills) ? contributions.skills : legacySkills;
  const declaredServers = Array.isArray(contributions.mcpServers)
    ? contributions.mcpServers
    : legacyServers;
  return {
    skills: countOf(declaredSkills),
    mcpServers: countOf(declaredServers),
    commands: countOf(contributions.commands),
    toolPacks: countOf(contributions.toolPacks),

    desktopWidgets: countOf(contributions.desktopWidgets),
  };
}

function permissionsOf(raw: Record<string, unknown>): PluginCatalogPermissions {
  const permissions =
    raw.permissions && typeof raw.permissions === "object"
      ? (raw.permissions as Record<string, unknown>)
      : {};
  const tools = asString(permissions.tools, "none");
  return {
    network: stringArray(permissions.network),
    tools: (TOOLS.has(tools) ? tools : "none") as PluginCatalogPermissions["tools"],
    files: stringArray(permissions.files),
  };
}

/** 解析一份清单为目录条目；缺关键字段返回 null（该版本跳过）。 */
function entryOf(
  id: string,
  version: string,
  bytes: Buffer,
  mtimeMs: number,
  pkg: { sha256: string; size: number } | null,
): PluginCatalogEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const schemaVersion = typeof obj.schemaVersion === "number" ? obj.schemaVersion : NaN;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) return null;
  const distribution = obj.distribution === "bundle" ? "bundle" : "manifest";
  // 界面插件必须同时有 package.tgz，否则装上也起不来——按坏包跳过，不返回半可用条目
  if (distribution === "bundle" && !pkg) return null;
  return {
    id,
    name: asString(obj.name, id).slice(0, 128) || id,
    version: asString(obj.version, version).slice(0, 64) || version,
    schemaVersion,
    description: asString(obj.description).slice(0, 2000),
    author: asString(obj.author).slice(0, 128),
    publishedAt: new Date(mtimeMs).toISOString(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    permissions: permissionsOf(obj),
    contributions: contributionsOf(obj),
    distribution,
    ...(pkg ? { package: pkg } : {}),
  };
}

export function createPluginCatalog(opts: { dir: string }): PluginCatalog {
  const dir = opts.dir;

  function versionDirsOf(id: string): string[] {
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, id), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && PLUGIN_CATALOG_VERSION_RE.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    return names.sort(comparePluginVersions);
  }

  /** 读 package.tgz 的指纹；不存在/超限返回 null。 */
  function packageOf(id: string, version: string): { sha256: string; size: number } | null {
    const file = join(dir, id, version, "package.tgz");
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_PACKAGE_BYTES) return null;
      const bytes = readFileSync(file);
      return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
    } catch {
      return null;
    }
  }

  function latestEntry(id: string): PluginCatalogEntry | null {
    const versions = versionDirsOf(id);
    for (let i = versions.length - 1; i >= 0; i -= 1) {
      const version = versions[i];
      const file = join(dir, id, version, "plugin.json");
      try {
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) continue;
        const bytes = readFileSync(file);
        const entry = entryOf(id, version, bytes, stat.mtimeMs, packageOf(id, version));
        if (entry) return entry;
        console.warn(`[plugin-catalog] 跳过坏清单：${id}@${version}`);
      } catch {
        // 目录存在但文件读不到/不存在：继续看更早的版本
      }
    }
    return null;
  }

  /** 某个 id 的全部可解析版本（新→旧）。坏版本跳过，不阻断其它版本。 */
  function allEntriesOf(id: string): PluginCatalogEntry[] {
    const out: PluginCatalogEntry[] = [];
    for (const version of [...versionDirsOf(id)].reverse()) {
      const file = join(dir, id, version, "plugin.json");
      try {
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) continue;
        const entry = entryOf(id, version, readFileSync(file), stat.mtimeMs, packageOf(id, version));
        if (entry) out.push(entry);
      } catch {
        // 该版本不可读：跳过，继续看其它版本
      }
    }
    return out;
  }

  /** 发布时的清单一致性校验：解析出的 id/version 必须与发布参数一致。 */
  function manifestMatches(bytes: Buffer, id: string, version: string): boolean {
    try {
      const raw = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      return asString(raw.id) === id && asString(raw.version) === version;
    } catch {
      return false;
    }
  }

  return {
    dir,
    list(): PluginCatalogEntry[] {
      let ids: string[] = [];
      try {
        ids = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && PLUGIN_CATALOG_ID_RE.test(entry.name))
          .map((entry) => entry.name);
      } catch {
        return []; // 目录还没建：合法状态（尚未发布任何插件）
      }
      const out: PluginCatalogEntry[] = [];
      for (const id of ids) {
        const entry = latestEntry(id);
        if (entry) out.push(entry);
      }
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    read(id: string, version: string): PluginCatalogRead | null {
      // 只接受 shared 的字符集（不含 `/`、`\`、`.` 段），再拼路径——双保险防穿越。
      if (!PLUGIN_CATALOG_ID_RE.test(id) || !PLUGIN_CATALOG_VERSION_RE.test(version)) return null;
      if (!existsSync(dir)) return null;
      const file = join(dir, id, version, "plugin.json");
      try {
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
        const bytes = readFileSync(file);
        return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
      } catch {
        return null;
      }
    },
    readPackage(id: string, version: string): PluginCatalogRead | null {
      if (!PLUGIN_CATALOG_ID_RE.test(id) || !PLUGIN_CATALOG_VERSION_RE.test(version)) return null;
      if (!existsSync(dir)) return null;
      const file = join(dir, id, version, "package.tgz");
      try {
        const stat = statSync(file);
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_PACKAGE_BYTES) return null;
        const bytes = readFileSync(file);
        return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
      } catch {
        return null;
      }
    },
    detail(id: string): PluginCatalogDetail | null {
      if (!PLUGIN_CATALOG_ID_RE.test(id)) return null;
      const versions = allEntriesOf(id);
      if (versions.length === 0) return null;
      return { id, versions };
    },
    publish(id, version, bytes) {
      if (!PLUGIN_CATALOG_ID_RE.test(id)) return "invalid_id";
      if (!PLUGIN_CATALOG_VERSION_RE.test(version)) return "invalid_version";
      if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) return "too_large";
      if (!manifestMatches(bytes, id, version)) return "mismatch";
      const targetDir = join(dir, id, version);
      const targetFile = join(targetDir, "plugin.json");
      const created = !existsSync(targetFile);
      mkdirSync(targetDir, { recursive: true });
      // 先写临时文件再 rename：并发发布/读到半个文件的窗口都不存在
      const tmp = join(targetDir, `.plugin.json.tmp-${process.pid}-${Date.now()}`);
      writeFileSync(tmp, bytes);
      renameSync(tmp, targetFile);
      // 注意：这里**不**用 entryOf 判成败——界面插件的 package.tgz 是清单之后第二次 PUT 才到，
      // 那一瞬间 entryOf 会因为「声明 bundle 却没有包」返回 null；清单本身是否合法已由
      // manifestMatches（可解析 + id/version 与路径一致）判过，故只做落盘与指纹。
      return {
        id,
        version,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        created,
      };
    },
    publishPackage(id, version, bytes) {
      if (!PLUGIN_CATALOG_ID_RE.test(id)) return "invalid_id";
      if (!PLUGIN_CATALOG_VERSION_RE.test(version)) return "invalid_version";
      if (!bytes || bytes.length === 0 || bytes.length > MAX_PACKAGE_BYTES) return "too_large";
      const targetDir = join(dir, id, version);
      if (!existsSync(join(targetDir, "plugin.json"))) return "missing_manifest";
      const targetFile = join(targetDir, "package.tgz");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (existsSync(targetFile)) {
        /**
         * 版本内容不可变（P1-2，与清单 PUT 的 409 同一条不变量）：同 id+version 的包
         * 只能发布一次。字节相同 → 幂等 200 且**不重写**；字节不同 → `conflict`（路由映射 409）。
         * 已安装用户手里的 sha256 是回滚/更新判定的依据，静默覆盖会让同一版本对应两份内容。
         */
        let existingSha: string | null = null;
        let existingSize = 0;
        try {
          const existing = readFileSync(targetFile);
          existingSha = createHash("sha256").update(existing).digest("hex");
          existingSize = existing.length;
        } catch {
          existingSha = null;
        }
        if (existingSha !== sha256) return "conflict";
        return { created: false, sha256: existingSha, size: existingSize };
      }
      const tmp = join(targetDir, `.package.tgz.tmp-${process.pid}-${Date.now()}`);
      writeFileSync(tmp, bytes);
      renameSync(tmp, targetFile);
      return {
        created: true,
        sha256,
        size: bytes.length,
      };
    },
    remove(id, version) {
      if (!PLUGIN_CATALOG_ID_RE.test(id) || !PLUGIN_CATALOG_VERSION_RE.test(version)) {
        return "not_found";
      }
      const targetDir = join(dir, id, version);
      if (!existsSync(targetDir)) return "not_found";
      try {
        rmSync(targetDir, { recursive: true, force: true });
        return "ok";
      } catch {
        return "not_found";
      }
    }
  };
}
