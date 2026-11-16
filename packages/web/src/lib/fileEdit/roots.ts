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
import { getDefaultRootPath } from "./bridge.js";
import { compareKey, foldSegments, isAbsolutePath, type FileRoot } from "./paths.js";

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

/** 会话工作区派生根的名字（模型参数 `root` 与设置区展示共用这一个）。 */
export const WORKSPACE_ROOT_NAME = "工作区";

/**
 * 未分组会话兜底写根的名字（桌面端 `文档\和鸣`）。
 *
 * 为什么还要兜底：大部分既有会话是「未分组」（没选工作区），只靠工作区派生根的话，
 * 用户问「帮我建个文件」仍然会得到「没有可写根」——投诉等于没修好。
 */
export const DEFAULT_WORKSPACE_ROOT_NAME = "默认工作区";

/**
 * 把「当前会话的工作区」并进根清单 —— 工作区自动可读写（d.153）。
 *
 * 为什么需要它：和鸣默认不预置任何根（`DEFAULT_FILE_ROOTS.roots = []`），
 * 于是新装用户的智能体一个文件工具都没有（用户投诉的正是这件事）。会话工作区
 * 是用户**已经显式选过**的文件夹（建会话时选的，或「移动到工作区」选的），
 * 把它当作隐式写根，既符合直觉也不必让用户再去设置区配一遍。
 *
 * 三条口径（实现时别改）：
 * 1. **只派生、不落盘**：不写 localStorage，用户打开设置区仍看到「手动根」列表原样；
 *    workspace 是会话属性，跟着会话走，删会话/挪分组就自然失效。
 * 2. **手动配置优先**：同路径已有配置根时原样保留（用户可能特意把它设成只读，
 *    自动根不能把只读悄悄升级成可写）。
 * 3. **排第一位**：工具 `root` 缺省取「第一条可写根」/「第一条根」，工作区排第一
 *    才能让「不写 root」的调用默认落在用户当前的工作区里。
 *
 * 非法/空/盘符根（`isAcceptableRootPath` 拒绝）→ 原样返回，绝不因为工作区路径怪
 * 就吞掉用户已配好的根。
 */
export function mergeWorkspaceRoot(roots: FileRoot[], workspace?: string | null): FileRoot[] {
  const raw = String(workspace ?? "").trim();
  if (!raw || !isAcceptableRootPath(raw)) return roots;
  const path = foldSegments(raw);
  const key = compareKey(path);
  if (roots.some((root) => compareKey(root.path) === key)) return roots;

  let name = WORKSPACE_ROOT_NAME;
  let n = 2;
  while (roots.some((root) => root.name.trim().toLowerCase() === name.toLowerCase())) {
    name = `${WORKSPACE_ROOT_NAME}-${n}`;
    n += 1;
  }
  // 派生根允许比配置上限多一条：配置上限约束的是用户手填，不能让「工作区」把
  // 用户第 20 条根挤掉（那一跳会静默丢配置，比多一条根危险得多）。
  return [{ name: name.slice(0, MAX_ROOT_NAME), path, mode: "write" }, ...roots];
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

/**
 * 「当前会话的工作区」——模块级可变状态，ChatPage 切会话/开流时写入。
 *
 * 为什么不放进 `fileRootsStore`（localStorage）：工作区是**会话的属性**，不是一条设置。
 * 落盘会带来两个后果：换会话后上一个项目的目录仍留在根清单里（下次用它得先想「这条是谁加的」），
 * 以及删会话后根还在。所以这里只放内存：进程结束即忘，`mergeWorkspaceRoot` 每次现场派生。
 *
 * 读不到（未分组会话 / 浏览器端）就是 `undefined`＝不自动开放任何目录。
 */
let activeWorkspacePath: string | undefined;

/** 记下当前会话的工作区（`null`/空串 = 未分组会话，清空状态）。 */
export function setActiveWorkspace(workspace?: string | null): void {
  const trimmed = typeof workspace === "string" ? workspace.trim() : "";
  activeWorkspacePath = trimmed || undefined;
}

/** 当前会话的工作区（未分组 / 未设置时 `undefined`）。 */
export function activeWorkspace(): string | undefined {
  return activeWorkspacePath;
}

/**
 * 当前生效的全部根 = 手动配置根 + 会话工作区派生根（工作区排第一）。
 *
 * 这是「文件工具、HITL 闸门、确认卡预览、记住授权」四处唯一的根口径：
 * 各模块若各自读 `fileRootsStore.roots()`，只设工作区的会话就会被判成「没有根」——
 * 出现「工具能写、闸门以为越界」的分裂。
 */
export function currentFileRoots(): FileRoot[] {
  return fileRootsFor(activeWorkspacePath);
}

/**
 * 指定工作区下的根清单（`currentFileRoots` 的显式参数版）。
 *
 * 为什么留这个入口：capability provider 拿得到 `ctx.workspace`（会话数据），
 * 不该依赖「ChatPage 的 effect 先把模块状态写好」这个时序——两条来源都要能工作，
 * 且合并/兜底逻辑只写一遍。
 */
export function fileRootsFor(workspace?: string | null): FileRoot[] {
  const merged = mergeWorkspaceRoot(fileRootsStore.roots(), workspace ?? activeWorkspacePath);
  if (merged.length > 0) return merged;
  // 未分组会话的兜底：用户没选工作区、也没手动配任何根时，才把桌面端的「默认工作区」
  // （文档\和鸣）当作写根。只要用户配过根（哪怕只有只读根），就尊重他的配置——
  // 悄悄加一个可写目录会把「我只让它读」的策略放开，这类越权比不能写更糟。
  return mergeDefaultRoot(merged, getDefaultRootPath());
}

/**
 * 把「默认工作区」并进根清单（只在根清单为空时由 `currentFileRoots` 调用）。
 *
 * 与 `mergeWorkspaceRoot` 的区别：它排在末尾（此刻是唯一一条）、名字不同，
 * 且**只有完全没有根时**才生效，避免和手动配置打架。
 */
export function mergeDefaultRoot(roots: FileRoot[], defaultPath?: string | null): FileRoot[] {
  const raw = String(defaultPath ?? "").trim();
  if (!raw || !isAcceptableRootPath(raw)) return roots;
  const path = foldSegments(raw);
  const key = compareKey(path);
  if (roots.some((root) => compareKey(root.path) === key)) return roots;

  let name = DEFAULT_WORKSPACE_ROOT_NAME;
  let n = 2;
  while (roots.some((root) => root.name.trim().toLowerCase() === name.toLowerCase())) {
    name = `${DEFAULT_WORKSPACE_ROOT_NAME}-${n}`;
    n += 1;
  }
  return [...roots, { name: name.slice(0, MAX_ROOT_NAME), path, mode: "write" }];
}
