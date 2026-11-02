/**
 * 可写根（roots）的存储与规整。
 *
 * 产品决策：**不预置任何可写根**——装好之后必须用户显式添加一条，
 * `file_patch` / `file_read` 才对模型可见（与 MCP「装完默认全关」同一口径）。
 *
 * 存 localStorage（本机、不进仓库）：根是本机路径，同步到云端没有意义，
 * 也不该跟着账号跑到别的机器上。
 *
 * `mode` 只有 `read` / `write` 两档，**没有 full-disk**：想写整个盘就逐个目录加，
 * 盘符根（`D:/`）在 `add()` 与读回规整时都会被拒。
 */

import type { StorageLike } from "../memory/types.js";
import { foldSegments, isAbsolutePath, type FileRoot } from "./paths.js";

/** 存储键（带版本后缀，便于将来迁移）。 */
export const FILE_ROOTS_KEY = "heming.fileEdit.roots.v1";

/** 根条数上限：防止误操作把设置区塞满，也防止一次补丁请求带一大串根进主进程。 */
export const MAX_FILE_ROOTS = 20;

/** 根名长度上限（与主进程 `file-fs.js` 的 MAX_ROOT_NAME 一致）。 */
export const MAX_ROOT_NAME = 64;

/** 可写根配置。 */
export interface FileRootsConfig {
  roots: FileRoot[];
  /**
   * 目标落在可写根之外时的处理：`ask`（问用户）或 `reject`（直接拒绝）。
   *
   * ★ 写盘层无论如何都只写可写根内：`reject` 只是把「先问一次再失败」
   * 变成「直接失败」，属于文案与打扰程度的差别，不是安全边界的差别。
   */
  outOfRoot: "ask" | "reject";
}

/** 缺省配置：没有根、越界先问。 */
export const DEFAULT_FILE_ROOTS: FileRootsConfig = { roots: [], outOfRoot: "ask" };

/** localStorage 适配（隐私模式静默降级）。 */
function defaultStorage(): StorageLike {
  return {
    getItem: (k) => {
      try {
        return window.localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* 隐私模式：只在本次会话生效 */
      }
    },
    removeItem: (k) => {
      try {
        window.localStorage.removeItem(k);
      } catch {
        /* 同上 */
      }
    },
  };
}

/** 路径是否是可接受的根：绝对、非盘符根、无 NUL、不超长。 */
export function isAcceptableRootPath(input: string): boolean {
  const raw = String(input ?? "").trim();
  if (!raw || raw.includes("\u0000")) return false;
  if (raw.length > 300) return false;
  if (!isAbsolutePath(raw)) return false;
  const folded = foldSegments(raw);
  // 盘符根 / 文件系统根：等价于整盘可写，拒绝（`/` 折完会是空串，一并挡掉）
  if (!folded) return false;
  if (/^[A-Za-z]:$/.test(folded) || folded === "/") return false;
  return true;
}

/** 从路径取一个默认根名（目录名）。 */
export function defaultRootName(absPath: string): string {
  const segs = foldSegments(absPath).split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  // 盘符形如 "d:" 时不拿它当名字
  return /^[A-Za-z]:$/.test(last) ? "根目录" : last.slice(0, MAX_ROOT_NAME) || "根目录";
}

/** 规整一条根；非法返回 null（坏条目逐条丢弃，不清空全部）。 */
function normalizeRoot(raw: unknown): FileRoot | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const mode = item.mode === "read" ? "read" : item.mode === "write" ? "write" : null;
  if (!mode) return null;
  if (typeof item.path !== "string" || !isAcceptableRootPath(item.path)) return null;
  const path = foldSegments(item.path);
  const name =
    typeof item.name === "string" && item.name.trim()
      ? item.name.trim().slice(0, MAX_ROOT_NAME)
      : defaultRootName(path);
  return { name, path, mode };
}

/** 规整整份配置。 */
export function normalizeRootsConfig(raw: unknown): FileRootsConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_FILE_ROOTS };
  const r = raw as Record<string, unknown>;
  const outOfRoot = r.outOfRoot === "reject" ? "reject" : "ask";
  const roots: FileRoot[] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.roots)) {
    for (const item of r.roots) {
      const root = normalizeRoot(item);
      if (!root) continue;
      const key = root.path.toLowerCase();
      if (seen.has(key)) continue; // 同一路径重复添加：只留第一条（避免两条规则打架）
      seen.add(key);
      roots.push(root);
      if (roots.length >= MAX_FILE_ROOTS) break;
    }
  }
  return { roots, outOfRoot };
}

/** 可写根存储。 */
export class FileRootsStore {
  private readonly storage: StorageLike;

  constructor(storage?: StorageLike) {
    this.storage = storage ?? defaultStorage();
  }

  /** 读配置：缺键 / 损坏 / 存储抛错一律回落默认（没有根）。 */
  get(): FileRootsConfig {
    try {
      const raw = this.storage.getItem(FILE_ROOTS_KEY);
      if (!raw) return { ...DEFAULT_FILE_ROOTS, roots: [] };
      return normalizeRootsConfig(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_FILE_ROOTS, roots: [] };
    }
  }

  /** 写配置：落盘前也过一遍规整（写侧同样夹住盘符根这类值）。 */
  set(config: FileRootsConfig): void {
    try {
      this.storage.setItem(FILE_ROOTS_KEY, JSON.stringify(normalizeRootsConfig(config)));
    } catch {
      /* 存不下只影响「记住设置」，不影响本次生效 */
    }
  }

  /** 全部根。 */
  roots(): FileRoot[] {
    return this.get().roots;
  }

  /** 可写根（`mode=write`）。 */
  writeRoots(): FileRoot[] {
    return this.roots().filter((r) => r.mode === "write");
  }

  /**
   * 添加一条根。
   *
   * 同名或同路径都拒绝：同路径会出现两条规则打架；同名会让工具参数 `root` 无法唯一选中。
   */
  add(input: { name?: string; path: string; mode: "read" | "write" }): { ok: true; root: FileRoot } | { ok: false; error: string } {
    const config = this.get();
    if (config.roots.length >= MAX_FILE_ROOTS) {
      return { ok: false, error: `最多只能添加 ${MAX_FILE_ROOTS} 个根，请先删掉不用的。` };
    }
    if (!isAcceptableRootPath(input.path)) {
      return {
        ok: false,
        error: "路径必须是绝对路径（如 D:/Obsidian/学院事务），且不能是盘符根（D:/ 等于整盘可写）。",
      };
    }
    const path = foldSegments(input.path);
    if (config.roots.some((r) => r.path.toLowerCase() === path.toLowerCase())) {
      return { ok: false, error: "这个目录已经在根列表里了。" };
    }
    const baseName = (input.name ?? "").trim().slice(0, MAX_ROOT_NAME) || defaultRootName(path);
    let name = baseName;
    let n = 2;
    while (config.roots.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      const suffix = `-${n}`;
      name = baseName.slice(0, MAX_ROOT_NAME - suffix.length) + suffix;
      n += 1;
    }
    const root: FileRoot = { name, path, mode: input.mode };
    this.set({ ...config, roots: [...config.roots, root] });
    return { ok: true, root };
  }

  /** 按路径删除一条根（大小写不敏感）。 */
  remove(path: string): void {
    const config = this.get();
    const key = foldSegments(path).toLowerCase();
    this.set({ ...config, roots: config.roots.filter((r) => r.path.toLowerCase() !== key) });
  }

  /** 改某条根的读写模式。 */
  setMode(path: string, mode: "read" | "write"): void {
    const config = this.get();
    const key = foldSegments(path).toLowerCase();
    this.set({
      ...config,
      roots: config.roots.map((r) => (r.path.toLowerCase() === key ? { ...r, mode } : r)),
    });
  }

  /** 改越界处理方式。 */
  setOutOfRoot(outOfRoot: "ask" | "reject"): void {
    this.set({ ...this.get(), outOfRoot });
  }

  /** 一键清空（设置区的「清空全部根」）。 */
  clear(): void {
    try {
      this.storage.removeItem(FILE_ROOTS_KEY);
    } catch {
      /* 隐私模式：存储不可用，内存里本就没有根 */
    }
  }
}

/** 应用默认实例（ChatPage / 设置区 / 闸门共用同一份配置）。 */
export const fileRootsStore = new FileRootsStore();
