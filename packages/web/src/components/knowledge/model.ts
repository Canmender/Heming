import type { VaultEntry } from "../../lib/vault/types.js";

/**
 * 知识库文件树的**纯函数层**（无 React、无 IO）。
 *
 * 为什么单独抽出来：文件树的折叠/展开、右键菜单算目标目录、新建时补 `.md` 后缀
 * 这些规则会被「文件树」和「知识库页」两边共用，写两遍必然漂移；而它们又全是
 * 纯逻辑，抽出来能直接单测，不用渲染组件。
 */

/** 目录节点的子节点数组（文件节点没有 children）。 */
export function isDir(entry: VaultEntry): boolean {
  return entry.kind === "dir";
}

/** 拼接库内相对路径；空目录视为库根。 */
export function joinRel(dir: string, name: string): string {
  const left = dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const right = name.replace(/\\/g, "/").replace(/^\/+/g, "");
  if (!left) return right;
  if (!right) return left;
  return `${left}/${right}`;
}

/** 取父目录；库根文件返回空串（表示库根）。 */
export function parentOf(rel: string): string {
  const normalized = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

/** 取路径末段（文件名或目录名）。 */
export function baseName(rel: string): string {
  const normalized = rel.replace(/\\/g, "/").replace(/\/+$/g, "");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

/** 去掉 `.md` 后缀，得到链接/标签里用的短名。 */
export function stripMdExt(name: string): string {
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}

/** 新建笔记时补后缀：用户只输入名字时补 `.md`，已经带扩展名则原样保留。 */
export function ensureMdExt(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return /\.[a-z0-9]+$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}

/** 深度优先展开成扁平行（只展开 `expanded` 里的目录）。 */
export interface FlatRow {
  entry: VaultEntry;
  depth: number;
}

export function flattenTree(
  entries: readonly VaultEntry[],
  expanded: ReadonlySet<string>,
  depth = 0,
): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const entry of entries) {
    rows.push({ entry, depth });
    if (isDir(entry) && expanded.has(entry.rel) && entry.children?.length) {
      rows.push(...flattenTree(entry.children, expanded, depth + 1));
    }
  }
  return rows;
}

/** 按 rel 在树里找节点（含未展开目录的 children）。 */
export function findEntry(entries: readonly VaultEntry[], rel: string): VaultEntry | null {
  for (const entry of entries) {
    if (entry.rel === rel) return entry;
    if (entry.children?.length) {
      const hit = findEntry(entry.children, rel);
      if (hit) return hit;
    }
  }
  return null;
}

/** 默认展开祖先目录：用于打开深层文件时把它所在路径露出来。 */
export function ancestorsOf(rel: string): string[] {
  const parts = rel.replace(/\\/g, "/").split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join("/"));
  return out;
}
