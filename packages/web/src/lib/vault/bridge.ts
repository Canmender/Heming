/**
 * vault 文件桥：桌面端读 preload 暴露的 `window.__heming_vault`，浏览器端降级到内存实现。
 *
 * 为什么要有内存实现：浏览器（以及没有桌面桥的 Web 预览）里也要能打开知识库页、
 * 试双链与搜索。功能同形、只是关掉页面就没了——界面据此显示「临时模式」。
 *
 * 错误口径（规格 §4）：桥的所有失败统一抛 `VaultBridgeError`（带机器可读 code），
 * 界面与工具层按 code 出中文提示，不直接展示底层异常文本。
 */

import {
  IMAGE_EXTS,
  MAX_IMAGE_BYTES,
  MAX_PATH_CHARS,
  MAX_TEXT_BYTES,
  TEXT_EXTS,
  VaultBridgeError,
  type EntryKind,
  type VaultApplyRequest,
  type VaultBridge,
  type VaultDoc,
  type VaultEntry,
  type VaultErrorCode,
  type VaultId,
  type VaultImage,
  type VaultMeta,
  type VaultWriteResult,
} from "./types.js";

/** 各错误码的默认中文文案（桥没给 message 时兜底）。 */
export const VAULT_ERROR_TEXT: Record<VaultErrorCode, string> = {
  "no-vault": "还没有打开知识库。",
  "not-found": "文件不存在。",
  "forbidden-path": "路径不合法：不能越出库根，也不能包含非法字符。",
  "forbidden-ext": "这个文件类型不支持读写。",
  "too-large": "文件超过大小上限。",
  "outside-write-dirs": "智能体只能写入知识库允许的目录。",
  "stale-mtime": "文件已被外部修改，请重新加载后再保存。",
  "io-error": "读写知识库失败。",
};

const ERROR_CODES = new Set<VaultErrorCode>(
  Object.keys(VAULT_ERROR_TEXT) as VaultErrorCode[],
);

/** 取桌面桥（浏览器端为 null）。 */
export function getVaultBridge(): VaultBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { __heming_vault?: VaultBridge }).__heming_vault;
  return bridge ?? null;
}

/** 是否浏览器临时模式（无桌面桥，关掉页面就没了）。 */
export function isVaultEphemeral(): boolean {
  return getVaultBridge() === null;
}

/** 判断任意值是否是合法错误码。 */
export function isVaultErrorCode(value: unknown): value is VaultErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value as VaultErrorCode);
}

/**
 * 错误归一化：任何来源的失败都转成 `VaultBridgeError`。
 *
 * 兼容三种来源：本模块抛出的实例、IPC 拒绝时传的 `{ code, message }` 纯对象、
 * 以及普通 Error / 任意值（统一归到 `io-error`，不把英文底层报错当产品文案）。
 */
export function toVaultBridgeError(err: unknown): VaultBridgeError {
  if (err instanceof VaultBridgeError) return err;
  if (err && typeof err === "object") {
    const row = err as { code?: unknown; message?: unknown };
    if (isVaultErrorCode(row.code)) {
      const message =
        typeof row.message === "string" && row.message.trim()
          ? row.message.trim()
          : VAULT_ERROR_TEXT[row.code];
      return new VaultBridgeError(row.code, message);
    }
    if (err instanceof Error && err.message.trim()) {
      return new VaultBridgeError("io-error", err.message.trim());
    }
  }
  if (typeof err === "string" && err.trim()) {
    return new VaultBridgeError("io-error", err.trim());
  }
  return new VaultBridgeError("io-error", VAULT_ERROR_TEXT["io-error"]);
}

/** 错误 → 中文提示（界面直接用）。 */
export function describeVaultError(err: unknown): string {
  const normalized = toVaultBridgeError(err);
  return normalized.message.trim() || VAULT_ERROR_TEXT[normalized.code];
}

/* ------------------------------------------------------------------ 内存桥 */

/** 内存桥的初始文件（便于测试与演示）。 */
export interface MemoryVaultFile {
  rel: string;
  text: string;
  mtime?: string;
}

/** 内存桥选项。 */
export interface MemoryVaultBridgeOptions {
  /** 初始文件：数组或 `rel → text` 映射。 */
  files?: MemoryVaultFile[] | Record<string, string>;
  /** 初始库列表；缺省是一个名为「临时知识库」的内存库。 */
  vaults?: VaultMeta[];
  /** 时钟注入（测试用固定时间，保证 mtime 可断言）。 */
  now?: () => number;
}

interface MemoryFile {
  text: string;
  mtime: string;
}

interface MemoryVault {
  meta: VaultMeta;
  files: Map<string, MemoryFile>;
  /**
   * 显式登记的目录（含祖先）。内存实现没有真实文件系统，空目录必须单独记下来，
   * 否则 `createDir` 之后 `tree()` 看不到它。
   */
  dirs: Set<string>;
}

const EPOCH = "1970-01-01T00:00:00.000Z";
const MEMORY_ROOT = "（浏览器临时模式，不落盘）";

/** Windows 保留名：这些名字在磁盘上会打不开，内存桥同样拒绝，保证两边口径一致。 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function extOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

function isTextExt(rel: string): boolean {
  return (TEXT_EXTS as readonly string[]).includes(extOf(rel));
}

function isImageExt(rel: string): boolean {
  return (IMAGE_EXTS as readonly string[]).includes(extOf(rel));
}

function kindOf(rel: string): EntryKind {
  if (isTextExt(rel)) {
    const ext = extOf(rel);
    return ext === ".md" ? "md" : ext === ".canvas" ? "canvas" : "other";
  }
  return isImageExt(rel) ? "image" : "other";
}

function mimeOf(ext: string): string {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

/**
 * 校验并规范化库内相对路径（内存桥的「路径守卫」）。
 *
 * 与桌面 `path-guard` 同口径：拒绝绝对路径、盘符、`..`、NUL、隐藏目录、
 * Windows 保留名、超长路径。返回规范化后的 `rel`，失败抛 `forbidden-path`。
 */
export function assertSafeRel(rel: unknown): string {
  if (typeof rel !== "string") throw new VaultBridgeError("forbidden-path", "路径必须是字符串。");
  const text = rel.replace(/\\/g, "/").trim();
  if (!text) throw new VaultBridgeError("forbidden-path", "路径不能为空。");
  if (text.length > MAX_PATH_CHARS) {
    throw new VaultBridgeError("forbidden-path", `路径超过 ${MAX_PATH_CHARS} 字上限。`);
  }
  if (text.includes("\u0000")) throw new VaultBridgeError("forbidden-path", "路径不能包含 NUL。");
  if (/^[A-Za-z]:/.test(text) || text.startsWith("/")) {
    throw new VaultBridgeError("forbidden-path", "只接受库内相对路径，不接受绝对路径。");
  }
  const parts = text.split("/");
  for (const part of parts) {
    if (!part) throw new VaultBridgeError("forbidden-path", "路径不能包含空目录名。");
    if (part === "." || part === "..") {
      throw new VaultBridgeError("forbidden-path", "路径不能包含 . 或 .. 段。");
    }
    if (part.startsWith(".")) {
      throw new VaultBridgeError("forbidden-path", "隐藏目录/文件不允许读写。");
    }
    if (RESERVED_NAMES.test(part)) {
      throw new VaultBridgeError("forbidden-path", `路径段「${part}」是系统保留名。`);
    }
    if (/[. ]$/.test(part)) {
      throw new VaultBridgeError("forbidden-path", "路径段不能以点或空格结尾。");
    }
  }
  return parts.join("/");
}

/** 是否在允许写入的目录内（`dir` 本身或其子路径）。 */
export function isInsideWriteDirs(rel: string, writeDirs: string[]): boolean {
  const target = rel.replace(/\\/g, "/");
  return writeDirs.some((dir) => {
    const normalized = dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return normalized === "" || target === normalized || target.startsWith(`${normalized}/`);
  });
}

/** 内存实现：接口与桌面 `VaultBridge` 完全同形。 */
export function createMemoryVaultBridge(options: MemoryVaultBridgeOptions = {}): VaultBridge {
  const now = options.now ?? (() => Date.now());
  /** 单调时钟：同一毫秒内连续写也能得到不同的 mtime，`expectMtime` 才可测。 */
  let clock = 0;
  const nextMtime = (): string => {
    const ms = Math.max(now(), clock + 1);
    clock = ms;
    return new Date(ms).toISOString();
  };

  const vaults = new Map<VaultId, MemoryVault>();
  const watchers = new Map<VaultId, Set<(rels: string[]) => void>>();
  let pickSeq = 1;

  const addVault = (meta: VaultMeta): void => {
    vaults.set(meta.id, { meta, files: new Map(), dirs: new Set() });
  };

  addVault({
    id: "memory",
    name: "临时知识库",
    root: MEMORY_ROOT,
    writeDirs: ["inbox"],
    addedAt: EPOCH,
  });
  for (const meta of options.vaults ?? []) addVault(meta);
  pickSeq = vaults.size;

  const filesOption = options.files ?? {};
  const initialFiles: MemoryVaultFile[] = Array.isArray(filesOption)
    ? filesOption
    : Object.entries(filesOption).map(([rel, text]) => ({ rel, text }));
  const firstVault = vaults.get([...vaults.keys()][0]);
  for (const file of initialFiles) {
    const rel = assertSafeRel(file.rel);
    firstVault?.files.set(rel, {
      text: String(file.text ?? ""),
      mtime: file.mtime ?? EPOCH,
    });
    if (firstVault) registerParentDirs(firstVault, rel);
  }

  const requireVault = (vaultId: VaultId): MemoryVault => {
    const vault = vaults.get(vaultId);
    if (!vault) throw new VaultBridgeError("no-vault", "知识库不存在或已被移除。");
    return vault;
  };

  const notify = (vaultId: VaultId, rels: string[]): void => {
    const set = watchers.get(vaultId);
    if (!set) return;
    for (const callback of [...set]) {
      try {
        callback(rels);
      } catch {
        // 订阅方异常不能影响写操作本身
      }
    }
  };

  /** 记下一个目录及其所有祖先（`a/b/c` → a、a/b、a/b/c）。 */
  function registerDir(vault: MemoryVault, rel: string): void {
    const parts = rel.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1) vault.dirs.add(parts.slice(0, i).join("/"));
  }

  /** 记下一个文件的所有祖先目录（文件本身不算目录）。 */
  function registerParentDirs(vault: MemoryVault, rel: string): void {
    const parts = rel.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) vault.dirs.add(parts.slice(0, i).join("/"));
  }

  const writeFile = (vault: MemoryVault, rel: string, text: string): VaultWriteResult => {
    const bytes = byteLength(text);
    if (bytes > MAX_TEXT_BYTES) {
      throw new VaultBridgeError(
        "too-large",
        `文件超过 ${Math.floor(MAX_TEXT_BYTES / 1024 / 1024)}MB 上限。`,
      );
    }
    const mtime = nextMtime();
    vault.files.set(rel, { text, mtime });
    registerParentDirs(vault, rel);
    return { rel, bytes, mtime };
  };

  const maxMtimeUnder = (vault: MemoryVault, prefix: string): string => {
    let latest = "";
    for (const [rel, file] of vault.files) {
      if (rel === prefix || rel.startsWith(`${prefix}/`)) {
        if (compareText(file.mtime, latest) > 0) latest = file.mtime;
      }
    }
    return latest;
  };

  const buildEntries = (vault: MemoryVault, prefix: string, depth: number): VaultEntry[] => {
    if (depth <= 0) return [];
    const dirs = new Set<string>();
    const direct: { name: string; rel: string; file: MemoryFile }[] = [];
    const base = prefix ? `${prefix}/` : "";
    for (const [rel, file] of vault.files) {
      if (!rel.startsWith(base) || rel === base) continue;
      const rest = rel.slice(base.length);
      const slash = rest.indexOf("/");
      if (slash < 0) direct.push({ name: rest, rel, file });
      else dirs.add(rest.slice(0, slash));
    }
    // 显式登记的空目录（createDir）也要出现在树里
    for (const dir of vault.dirs) {
      if (!dir.startsWith(base) || dir === base) continue;
      const rest = dir.slice(base.length);
      const slash = rest.indexOf("/");
      if (slash < 0) dirs.add(rest);
      else dirs.add(rest.slice(0, slash));
    }
    const entries: VaultEntry[] = [];
    for (const dir of [...dirs].sort(compareText)) {
      const rel = prefix ? `${prefix}/${dir}` : dir;
      const entry: VaultEntry = {
        rel,
        name: dir,
        kind: "dir",
        size: 0,
        mtime: maxMtimeUnder(vault, rel) || EPOCH,
      };
      if (depth > 1) entry.children = buildEntries(vault, rel, depth - 1);
      entries.push(entry);
    }
    for (const item of direct.sort((a, b) => compareText(a.name, b.name))) {
      entries.push({
        rel: item.rel,
        name: item.name,
        kind: kindOf(item.rel),
        size: byteLength(item.file.text),
        mtime: item.file.mtime,
      });
    }
    return entries;
  };

  const readText = (vault: MemoryVault, vaultId: VaultId, rel: string): VaultDoc | null => {
    if (!isTextExt(rel)) {
      throw new VaultBridgeError("forbidden-ext", "这个文件类型不是可读文本。");
    }
    const file = vault.files.get(rel);
    if (!file) return null;
    return {
      vaultId,
      rel,
      text: file.text,
      mtime: file.mtime,
      size: byteLength(file.text),
    };
  };

  return {
    async list() {
      return [...vaults.values()].map((vault) => ({ ...vault.meta }));
    },

    async pick() {
      pickSeq += 1;
      const meta: VaultMeta = {
        id: `memory-${pickSeq}`,
        name: `临时知识库 ${pickSeq}`,
        root: MEMORY_ROOT,
        writeDirs: ["inbox"],
        addedAt: new Date(now()).toISOString(),
      };
      addVault(meta);
      return { ...meta };
    },

    async remove(vaultId) {
      const existed = vaults.delete(vaultId);
      watchers.delete(vaultId);
      return existed;
    },

    async rename(vaultId, name) {
      const vault = requireVault(vaultId);
      const next = String(name ?? "").trim();
      if (!next) throw new VaultBridgeError("io-error", "库名不能为空。");
      vault.meta = { ...vault.meta, name: next };
      return { ...vault.meta };
    },

    async tree(vaultId, opts) {
      const vault = requireVault(vaultId);
      const prefix = opts?.rel ? assertSafeRel(opts.rel) : "";
      const depth = opts?.depth === undefined ? 2 : Math.max(0, Math.floor(opts.depth));
      return buildEntries(vault, prefix, depth);
    },

    async read(vaultId, rel) {
      const vault = requireVault(vaultId);
      return readText(vault, vaultId, assertSafeRel(rel));
    },

    async readBinary(vaultId, rel) {
      const vault = requireVault(vaultId);
      const safe = assertSafeRel(rel);
      if (!isImageExt(safe)) {
        throw new VaultBridgeError("forbidden-ext", "这个文件类型不是图片。");
      }
      const file = vault.files.get(safe);
      if (!file) return null;
      if (byteLength(file.text) > MAX_IMAGE_BYTES) {
        throw new VaultBridgeError("too-large", "图片超过大小上限。");
      }
      const image: VaultImage = {
        rel: safe,
        mime: mimeOf(extOf(safe)),
        dataUrl: file.text.startsWith("data:") ? file.text : "",
      };
      return image;
    },

    async write(vaultId, rel, text, opts) {
      const vault = requireVault(vaultId);
      const safe = assertSafeRel(rel);
      if (!isTextExt(safe)) {
        throw new VaultBridgeError("forbidden-ext", "这个文件类型不支持写入。");
      }
      const existing = vault.files.get(safe);
      if (opts?.expectMtime !== undefined) {
        if (!existing) throw new VaultBridgeError("not-found", "文件不存在，无法按版本保存。");
        if (existing.mtime !== opts.expectMtime) {
          throw new VaultBridgeError("stale-mtime", VAULT_ERROR_TEXT["stale-mtime"]);
        }
      }
      const result = writeFile(vault, safe, String(text ?? ""));
      notify(vaultId, [safe]);
      return result;
    },

    async apply(req: VaultApplyRequest) {
      const vault = requireVault(req.vaultId);
      const safe = assertSafeRel(req.rel);
      if (!isTextExt(safe)) {
        throw new VaultBridgeError("forbidden-ext", "这个文件类型不支持写入。");
      }
      if (!isInsideWriteDirs(safe, vault.meta.writeDirs)) {
        throw new VaultBridgeError(
          "outside-write-dirs",
          `拒绝写入：智能体只能写 ${vault.meta.writeDirs.join("、") || "（未允许任何目录）"} 内的文件。`,
        );
      }
      const existing = vault.files.get(safe)?.text ?? "";
      const text = String(req.text ?? "");
      const next =
        req.mode === "append" && existing
          ? `${existing}${existing.endsWith("\n") ? "" : "\n"}${text}`
          : text;
      const result = writeFile(vault, safe, next);
      notify(req.vaultId, [safe]);
      return result;
    },

    async create(vaultId, rel, text) {
      const vault = requireVault(vaultId);
      const safe = assertSafeRel(rel);
      if (!isTextExt(safe)) {
        throw new VaultBridgeError("forbidden-ext", "这个文件类型不支持创建。");
      }
      if (vault.files.has(safe)) {
        throw new VaultBridgeError("io-error", `文件已存在：${safe}。`);
      }
      const result = writeFile(vault, safe, String(text ?? ""));
      notify(vaultId, [safe]);
      return result;
    },

    async createDir(vaultId, rel) {
      const vault = requireVault(vaultId);
      const safe = assertSafeRel(rel);
      if (!safe) throw new VaultBridgeError("forbidden-path", "目录路径不能为空。");
      // 多级 mkdir -p + 幂等：重复创建只保证目录存在，不报错
      registerDir(vault, safe);
      return { rel: safe, bytes: 0, mtime: nextMtime() };
    },

    async move(vaultId, from, to) {
      const vault = requireVault(vaultId);
      const source = assertSafeRel(from);
      const target = assertSafeRel(to);
      const file = vault.files.get(source);
      if (!file) return false;
      if (vault.files.has(target)) return false;
      vault.files.delete(source);
      vault.files.set(target, { text: file.text, mtime: nextMtime() });
      registerParentDirs(vault, target);
      notify(vaultId, [source, target]);
      return true;
    },

    async delete(vaultId, rel) {
      const vault = requireVault(vaultId);
      const safe = assertSafeRel(rel);
      const existed = vault.files.delete(safe);
      if (existed) notify(vaultId, [safe]);
      return existed;
    },

    async reveal() {
      // 浏览器没有资源管理器可定位
      return false;
    },

    watch(vaultId, onChange) {
      const set = watchers.get(vaultId) ?? new Set<(rels: string[]) => void>();
      set.add(onChange);
      watchers.set(vaultId, set);
      return () => {
        const current = watchers.get(vaultId);
        if (!current) return;
        current.delete(onChange);
        if (!current.size) watchers.delete(vaultId);
      };
    },
  };
}

/** 取可用桥：桌面端用 preload 桥，否则用模块级内存单例（同一会话内状态不丢）。 */
let memoryBridge: VaultBridge | null = null;

export function resolveVaultBridge(): VaultBridge {
  const desktop = getVaultBridge();
  if (desktop) return desktop;
  memoryBridge ??= createMemoryVaultBridge();
  return memoryBridge;
}
