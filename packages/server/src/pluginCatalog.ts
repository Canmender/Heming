import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  PLUGIN_CATALOG_ID_RE,
  PLUGIN_CATALOG_VERSION_RE,
  type PluginCatalogContributions,
  type PluginCatalogEntry,
  type PluginCatalogPermissions,
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

const TOOLS = new Set(["none", "read", "write"]);

export interface PluginCatalogRead {
  bytes: Buffer;
  sha256: string;
}

export interface PluginCatalog {
  /** 最新版本列表；目录不存在/为空返回空数组。 */
  list(): PluginCatalogEntry[];
  /** 读取某个 id/版本的原样清单字节；不存在或参数非法返回 null。 */
  read(id: string, version: string): PluginCatalogRead | null;
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
function entryOf(id: string, version: string, bytes: Buffer, mtimeMs: number): PluginCatalogEntry | null {
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

  function latestEntry(id: string): PluginCatalogEntry | null {
    const versions = versionDirsOf(id);
    for (let i = versions.length - 1; i >= 0; i -= 1) {
      const version = versions[i];
      const file = join(dir, id, version, "plugin.json");
      try {
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) continue;
        const bytes = readFileSync(file);
        const entry = entryOf(id, version, bytes, stat.mtimeMs);
        if (entry) return entry;
        console.warn(`[plugin-catalog] 跳过坏清单：${id}@${version}`);
      } catch {
        // 目录存在但文件读不到/不存在：继续看更早的版本
      }
    }
    return null;
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
  };
}
