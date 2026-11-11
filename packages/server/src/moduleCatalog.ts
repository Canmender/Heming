import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  PLUGIN_CATALOG_ID_RE,
  PLUGIN_CATALOG_VERSION_RE,
  ModuleCatalogEntrySchema,
  comparePluginVersions,
  type ModuleCatalogEntry,
} from "@heming/shared";

/**
 * 云端模块目录（d.117）。
 *
 * 背景：模块（幕僚 / 信息中枢 / 自动化）以前是客户端里写死的「内置模块」卡片，
 * 原生安装也总能看到它们。现在**目录由服务端提供**：客户端只显示云端真实存在的模块，
 * 用户自己决定装不装。安装包里不携带任何模块，引擎包也不随包。
 *
 * 来源优先级：
 * 1. `HEMING_MODULE_DIR`（或默认 `<cwd>/module-catalog`）里每个
 *    `<id>/<version>/module.json`（我们的目录条目形状，不是 module.tgz 里的清单）；
 * 2. 内置的四条目录项（随服务端发布，保证新部署也能看到可选模块）。
 *
 * 服务端不解析模块代码、不执行任何东西；只回答「有哪些模块、版本、是否需要下载引擎」。
 */

/** 随服务端发布的可选模块目录。 */
const DEFAULT_MODULES: readonly ModuleCatalogEntry[] = [
  {
    id: "automations",
    name: "自动化",
    version: "1.0.0",
    description: "一个页面管定时任务、工作流与简报：快速创建普通定时任务，或完整创建工作流并指定时间与次数。",
    author: "和鸣",
    engine: null,
  },
  {
    id: "infohub",
    name: "信息中枢",
    version: "1.0.0",
    description: "在本机采集、浏览、检索 QQ / 微信聊天记录和日程；采集引擎随插件安装，归档不出本机。",
    author: "和鸣",
    engine: "infohub",
  },
];

export interface ModuleCatalog {
  dir: string;
  /** 每个 id 只给最新版本；目录不存在/为空时回落到随服务端发布的四条。 */
  list(): ModuleCatalogEntry[];
  /** 模块包文件绝对路径（不存在/越界返回 null）；供客户端下载安装。 */
  packagePath(id: string, version: string): string | null;
}

function readEntry(dir: string, id: string, version: string): ModuleCatalogEntry | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, id, version, "module.json"), "utf8"));
    const parsed = ModuleCatalogEntrySchema.safeParse({ ...raw, id, version });
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function createModuleCatalog(opts: { dir?: string } = {}): ModuleCatalog {
  const dir = opts.dir?.trim() || join(process.cwd(), "module-catalog");

  return {
    dir,
    packagePath(id, version) {
      if (!PLUGIN_CATALOG_ID_RE.test(id) || !PLUGIN_CATALOG_VERSION_RE.test(version)) return null;
      const root = resolve(dir);
      const file = resolve(root, id, version, "module.tgz");
      if (file !== root && !file.startsWith(root + sep)) return null;
      try {
        return statSync(file).isFile() ? file : null;
      } catch {
        return null;
      }
    },
    list() {
      const byId = new Map<string, ModuleCatalogEntry[]>();
      if (existsSync(dir)) {
        let ids: string[] = [];
        try {
          ids = readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && PLUGIN_CATALOG_ID_RE.test(entry.name))
            .map((entry) => entry.name);
        } catch {
          ids = [];
        }
        for (const id of ids) {
          let versions: string[] = [];
          try {
            versions = readdirSync(join(dir, id), { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && PLUGIN_CATALOG_VERSION_RE.test(entry.name))
              .map((entry) => entry.name);
          } catch {
            versions = [];
          }
          for (const version of versions) {
            const entry = readEntry(dir, id, version);
            if (!entry) continue;
            const list = byId.get(id) ?? [];
            list.push(entry);
            byId.set(id, list);
          }
        }
      }

      const merged = new Map<string, ModuleCatalogEntry>();
      for (const entry of DEFAULT_MODULES) merged.set(entry.id, entry);
      for (const [id, entries] of byId) {
        const latest = [...entries].sort((a, b) => comparePluginVersions(b.version, a.version))[0];
        if (latest) merged.set(id, latest);
      }
      return [...merged.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
}
