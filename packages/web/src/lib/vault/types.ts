/**
 * 原生知识库（vault）的**契约层**：只有类型与常量，零运行时依赖、零副作用。
 *
 * 为什么单独一个文件：这一轮有四个工作面并行（桌面文件桥 / web 索引层 / 界面 / 记忆绑定），
 * 谁都不许改这个文件里的形状——要改先改这里并通知所有人。索引层、桥、界面、记忆适配
 * 全部按本文件的类型互相编译，接口漂移会在 `pnpm -r typecheck` 第一步就暴露。
 *
 * 安全口径（详见 docs/superpowers/specs/2026-11-08-d113-native-knowledge-vault.md §4）：
 * 库根由主进程登记，渲染层只传 `vaultId` + 相对路径；所有路径在主进程再夹一次。
 */

/** 库 id：注册时生成，路径改名不换 id。 */
export type VaultId = string;

/** 一个已登记的库（注册表在主进程 `~/Heming/vaults.json`）。 */
export interface VaultMeta {
  id: VaultId;
  /** 展示名，默认取目录名，可改。 */
  name: string;
  /** 库根绝对路径（只在主进程可信，渲染层仅用于展示）。 */
  root: string;
  /**
   * 智能体**可写**的库内相对目录（默认 `["inbox"]`）。
   * 空数组 = 智能体对本库只读；用户自己在界面里不受此限制。
   */
  writeDirs: string[];
  addedAt: string;
}

/** 文本类文件上限：与 wiki-fs 的 2MB 同口径。 */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** 图片类文件上限（走 readBinary，转 data URL）。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 单次目录树返回的节点上限（防超大库把 IPC 打爆）。 */
export const MAX_TREE_NODES = 20000;
/** 库内路径长度上限（与 path-guard 一致）。 */
export const MAX_PATH_CHARS = 300;

/** 可写文本扩展名（小写，含点）。 */
export const TEXT_EXTS = [".md", ".canvas", ".json", ".txt", ".csv"] as const;
/** 只读图片扩展名。 */
export const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"] as const;

export type TextExt = (typeof TEXT_EXTS)[number];
export type ImageExt = (typeof IMAGE_EXTS)[number];

/** 文件树条目的类别：dir / md / canvas / image / other。 */
export type EntryKind = "dir" | "md" | "canvas" | "image" | "other";

/** 目录树节点（相对路径 `rel` 用 `/` 分隔，不含库根）。 */
export interface VaultEntry {
  rel: string;
  name: string;
  kind: EntryKind;
  /** 字节数；dir 为 0。 */
  size: number;
  /** ISO 时间；dir 取自身 mtime。 */
  mtime: string;
  /** 仅目录有；按「目录优先 + 名称自然序」排列。 */
  children?: VaultEntry[];
}

/** 读到的文本文档。 */
export interface VaultDoc {
  vaultId: VaultId;
  rel: string;
  text: string;
  mtime: string;
  size: number;
}

/** 读到的图片（data URL，供 <img> 直接用）。 */
export interface VaultImage {
  rel: string;
  mime: string;
  dataUrl: string;
}

/** 写结果。 */
export interface VaultWriteResult {
  rel: string;
  bytes: number;
  /** 写后文件的 mtime（ISO），编辑器据此更新「已知版本」。 */
  mtime: string;
}

/** 智能体写入请求（走独立通道 `vault:apply`，仅允许 `writeDirs` 内）。 */
export interface VaultApplyRequest {
  vaultId: VaultId;
  rel: string;
  text: string;
  /** append 用于记忆写回里的「追加小节」；缺省覆盖写。 */
  mode?: "overwrite" | "append";
}

/** 失败一律中文原因（`code` 给程序分支用）。 */
export type VaultErrorCode =
  | "no-vault"
  | "not-found"
  | "forbidden-path"
  | "forbidden-ext"
  | "too-large"
  | "outside-write-dirs"
  | "stale-mtime"
  | "io-error";

export interface VaultFailure {
  ok: false;
  code: VaultErrorCode;
  message: string;
}

/** 统一的成功/失败结果。 */
export type VaultResult<T> = ({ ok: true } & T) | VaultFailure;

/* ------------------------------------------------------------------ 索引 */

/**
 * 链接：`[[target|alias]]` / `[[target#heading]]` / `![[target]]`。
 * `from` 是所在文件 rel；`line` 是 1 基行号（界面跳转用）。
 */
export interface WikiLink {
  target: string;
  alias?: string;
  heading?: string;
  /** `![[...]]` 嵌入。 */
  embed: boolean;
  from: string;
  line: number;
  /** 解析结果：目标文件的 rel；未解析为 null。 */
  resolved: string | null;
  /**
   * 锚点命中情况（d.114 第二轮补，规格 §3.3）：
   * - `"hit"`：`#标题` 能在目标文件的 headings 里找到；
   * - `"miss"`：文件解析成功但这个标题不存在（界面标「锚点未命中」，**不**当未解析链接）；
   * - `"none"`：链接没带锚点，或文件本身未解析。
   *
   * 可选：老调用方/测试构造的链接可以不带该字段，按 `"none"` 处理。
   */
  anchor?: "hit" | "miss" | "none";
}

/** 标签引用：`#tag` 或 frontmatter tags。 */
export interface TagRef {
  /** 统一成无前导 `#` 的原始大小写；比较时用 lower。 */
  tag: string;
  from: string;
  line: number;
  /** `frontmatter` 来源的标签 line 为 0。 */
  source: "inline" | "frontmatter";
}

/** 标题（大纲）。 */
export interface Heading {
  level: number;
  text: string;
  line: number;
}

/** 一个页面的索引信息。 */
export interface PageInfo {
  rel: string;
  /** 不含 `.md` 的文件名（链接解析的第一选择键）。 */
  title: string;
  /** frontmatter `aliases`（也接受 `alias`），链接解析的第二选择键。 */
  aliases: string[];
  tags: string[];
  headings: Heading[];
  /** ISO 时间。 */
  mtime: string;
  /** 内容摘要（sha256 十六进制，截 16 位即可）；记忆增量同步用。 */
  hash: string;
  /** 原始 frontmatter（键值，值已尽量展开成字符串数组或字符串）。 */
  frontmatter: Record<string, string | string[]>;
  /** 正文（不含 frontmatter）；首屏预览与搜索用，不落 localStorage。 */
  body: string;
}

/** 全库索引。 */
export interface VaultIndex {
  /** key = rel。 */
  pages: Map<string, PageInfo>;
  links: WikiLink[];
  /** 反向索引：目标 rel → 指向它的链接。 */
  backlinks: Map<string, WikiLink[]>;
  /** 未解析链接（界面可一键建页）。 */
  unresolved: WikiLink[];
  /** 标签 → 页面 rel 列表。 */
  tags: Map<string, string[]>;
  /** 无入链的孤立页（不含 index/log/schema 这类根文件）。 */
  orphans: string[];
  /** 同名（title 冲突）→ rel 列表；界面标黄用。 */
  ambiguous: Map<string, string[]>;
}

/* ------------------------------------------------------------------ 搜索 */

export type SearchKey = "tag" | "path" | "file" | "line" | "content";

export interface SearchTerm {
  key: SearchKey;
  /** 原始值（已去引号）。 */
  value: string;
  /** 是否带引号（短语精确匹配）。 */
  phrase: boolean;
}

/** Obsidian 风格子集：`tag:#x` / `path:dir` / `file:name` / `line:xxx` / `"短语"` / `-排除`。 */
export interface SearchQuery {
  raw: string;
  terms: SearchTerm[];
  negations: SearchTerm[];
}

export interface SearchHit {
  rel: string;
  /** 命中的行（1 基）与上下文片段。 */
  line: number;
  snippet: string;
  score: number;
  /** 命中来源：tag/path/file/line/content 的组合。 */
  matched: SearchKey[];
}

/* ------------------------------------------------------------------ 桥 */

/**
 * preload 暴露的桥（浏览器端为 undefined）。
 *
 * 与老 `WikiBridge` 的差别：多库、目录树、二进制读、watch 订阅、智能体专用写通道。
 * 所有方法失败时抛 `VaultBridgeError`（带 `code`），界面统一转中文提示。
 */
export interface VaultBridge {
  /** 已登记的库列表（主进程读注册表）。 */
  list(): Promise<VaultMeta[]>;
  /** 弹系统目录选择器新增一个库；用户取消返回 null。 */
  pick(): Promise<VaultMeta | null>;
  /** 移除登记（不删文件）。 */
  remove(vaultId: VaultId): Promise<boolean>;
  /** 改名。 */
  rename(vaultId: VaultId, name: string): Promise<VaultMeta>;
  /** 目录树（懒加载：`depth` 默认 2，`rel` 为空表示库根）。 */
  tree(vaultId: VaultId, opts?: { rel?: string; depth?: number }): Promise<VaultEntry[]>;
  /** 读文本；不存在返回 null。 */
  read(vaultId: VaultId, rel: string): Promise<VaultDoc | null>;
  /** 读图片，转 data URL。 */
  readBinary(vaultId: VaultId, rel: string): Promise<VaultImage | null>;
  /** 用户编辑通道：库内任意可写文本路径。 */
  write(
    vaultId: VaultId,
    rel: string,
    text: string,
    opts?: { expectMtime?: string },
  ): Promise<VaultWriteResult>;
  /** 智能体通道：仅 `writeDirs` 内，越界抛 `outside-write-dirs`。 */
  apply(req: VaultApplyRequest): Promise<VaultWriteResult>;
  /** 新建文件（父目录自动创建）；已存在返回失败。 */
  create(vaultId: VaultId, rel: string, text?: string): Promise<VaultWriteResult>;
  /**
   * 新建目录（多级 `mkdir -p`；已存在视为成功 = 幂等）。返回形状与 `create` 对齐，
   * 目录没有内容所以 `bytes` 恒为 0（界面不要拿它当"写入了多少"展示）。
   */
  createDir(vaultId: VaultId, rel: string): Promise<VaultWriteResult>;
  /** 改名/移动（只对文件；不跨库）。 */
  move(vaultId: VaultId, from: string, to: string): Promise<boolean>;
  /** 删除单个文件（不递归、不删目录）。 */
  delete(vaultId: VaultId, rel: string): Promise<boolean>;
  /** 在系统资源管理器中定位。 */
  reveal(vaultId: VaultId, rel: string): Promise<boolean>;
  /** 订阅库变化（去抖后的批量变更）；返回取消订阅函数。 */
  watch(vaultId: VaultId, onChange: (rel: string[]) => void): () => void;
}

/** 桥调用失败：带机器可读 code，界面按 code 出中文。 */
export class VaultBridgeError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultBridgeError";
  }
}

/* ------------------------------------------------------------------ 记忆绑定 */

/**
 * 记忆条目里的 vault 指针（只存指针与校验信息，**不存正文**）。
 * `hash` 与 `mtime` 用于增量同步：两者都没变就跳过该条。
 */
export interface VaultMemoryPointer {
  vaultId: VaultId;
  rel: string;
  mtime: string;
  hash: string;
}

/* ------------------------------------------------------------------ 界面契约 */

/** 编辑态：源码 / 分栏预览 / 阅读。 */
export type EditorMode = "source" | "split" | "read";

export type IndexStatus = "idle" | "indexing" | "ready" | "error";

/**
 * 知识库 store 的公开面（实现见 `lib/vault/store.ts`，界面只许依赖这些成员）。
 *
 * 为什么把界面契约写进这里：UI 与索引层并行开发时，界面不能 import 实现细节，
 * 否则任一侧改内部形状都要同步改对方。界面只用本接口 + 类型，实现侧自由重构。
 */
export interface VaultStoreApi {
  /* 状态 */
  vaults: VaultMeta[];
  activeVaultId: VaultId | null;
  tree: VaultEntry[];
  index: VaultIndex | null;
  indexStatus: IndexStatus;
  /** 索引进度 0–1（未索引为 0）。 */
  indexProgress: number;
  /** 已打开的标签页（rel 数组，顺序即 tab 顺序）。 */
  openFiles: string[];
  activeRel: string | null;
  mode: EditorMode;
  /** rel → 文档缓存。 */
  docs: Map<string, VaultDoc>;
  /** 有未保存修改的 rel 集合。 */
  dirty: Set<string>;
  /** 最近一次错误（中文），成功动作后清空。 */
  error: string | null;
  /** 是否浏览器临时模式（无文件桥）。 */
  ephemeral: boolean;

  /* 库 */
  loadVaults(): Promise<void>;
  pickVault(): Promise<void>;
  removeVault(id: VaultId): Promise<void>;
  setActiveVault(id: VaultId): Promise<void>;

  /* 文件 */
  refreshTree(): Promise<void>;
  openFile(rel: string): Promise<void>;
  closeFile(rel: string, opts?: { force?: boolean }): void;
  setActiveRel(rel: string): void;
  setMode(mode: EditorMode): void;
  /** 编辑正文（写进 docs 缓存并标脏，不落盘）。 */
  editFile(rel: string, text: string): void;
  /** 落盘（走 vault:write，带 expectMtime）。 */
  saveFile(rel: string): Promise<boolean>;
  createFile(rel: string, text?: string): Promise<boolean>;
  /** 新建目录（多级、幂等）；成功后应把新目录合并进树，不必整树刷新。 */
  createDir(rel: string): Promise<boolean>;
  renameFile(from: string, to: string): Promise<boolean>;
  deleteFile(rel: string): Promise<boolean>;

  /* 索引 */
  buildIndexNow(): Promise<void>;
  reindexPaths(rels: string[]): Promise<void>;
  subscribeWatch(): () => void;

  /* 派生查询（纯函数，界面直接调） */
  backlinksOf(rel: string): WikiLink[];
  outlinksOf(rel: string): WikiLink[];
  unresolvedOf(rel: string): WikiLink[];
  tagsOf(rel: string): TagRef[];
  /** 供记忆层/工具层使用的只读快照。 */
  snapshotDocs(): { rel: string; text: string; mtime: string }[];
}

/** 记忆侧「知识库参与」的默认上限与预算（与记忆页展示口径一致）。 */
export const VAULT_MEMORY_MAX = 500;
export const VAULT_INJECT_MAX_CHARS = 1200;
export const VAULT_INJECT_PER_NOTE_CHARS = 400;
