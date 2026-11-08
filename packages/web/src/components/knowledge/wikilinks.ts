import type { PageInfo, VaultIndex } from "../../lib/vault/types.js";

/**
 * 双链解析与渲染地址编码（纯函数，供预览面板与测试共用）。
 *
 * 链接解析口径对齐 Obsidian 的「最短唯一路径」（规格 §3）：
 * 1. 先按**文件名（不含 .md）**精确匹配；
 * 2. 带路径时按相对库根解析，前导 `/` 视为库根绝对；
 * 3. 多个同名文件时取「相对当前文件最近」的一个，并标记 `ambiguous`（界面标黄，不静默）；
 * 4. 锚点 `#标题` 只影响定位，命中失败仍算「文件已解析」。
 *
 * 索引由 `lib/vault` 提供（本文件不 import 实现，只吃 `VaultIndex` 形状）。
 */

/** 解析结果：`ambiguous` 为真表示同名歧义（界面要标出来）。 */
export interface ResolvedWikiLink {
  rel: string | null;
  ambiguous: boolean;
}

/** 去掉 `.md` 后缀（大小写不敏感）。 */
export function stripMdSuffix(name: string): string {
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}

/** 路径归一化：反斜杠转正斜杠、去前后斜杠、转小写（比较用）。 */
export function normalizePathKey(rel: string): string {
  return stripMdSuffix(rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).toLowerCase();
}

/** 取路径末段。 */
function lastSegment(rel: string): string {
  const normalized = rel.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

/** 两段路径的公共目录层数（越近越大）。 */
function commonPrefixDepth(a: string, b: string): number {
  const left = normalizePathKey(a).split("/");
  const right = normalizePathKey(b).split("/");
  let depth = 0;
  while (depth < left.length - 1 && depth < right.length - 1 && left[depth] === right[depth]) {
    depth += 1;
  }
  return depth;
}

/** 同名歧义时选「离当前文件最近」的一个；同距离按路径长度、字典序兜底（确定性）。 */
function pickNearest(candidates: PageInfo[], fromRel: string): PageInfo {
  return [...candidates].sort((a, b) => {
    const depth = commonPrefixDepth(b.rel, fromRel) - commonPrefixDepth(a.rel, fromRel);
    if (depth !== 0) return depth;
    if (a.rel.length !== b.rel.length) return a.rel.length - b.rel.length;
    return a.rel.localeCompare(b.rel);
  })[0];
}

/**
 * 解析一个双链目标到页面 rel。
 *
 * `index` 为空（首屏还没建好索引）时统一返回未解析，调用方按「未解析」渲染，
 * 不做乐观猜测——猜错会把用户送到错的页面。
 */
export function resolveWikiTarget(
  index: VaultIndex | null | undefined,
  fromRel: string,
  rawTarget: string,
): ResolvedWikiLink {
  if (!index || index.pages.size === 0) return { rel: null, ambiguous: false };
  const target = rawTarget.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!target) return { rel: null, ambiguous: false };

  const pages = [...index.pages.values()];
  const wantedKey = normalizePathKey(target);

  // ① 相对路径 / 带路径：先试完全相等的 rel（含带 .md 与不带 .md 两种写法）
  const exact = pages.filter((page) => normalizePathKey(page.rel) === wantedKey);
  if (exact.length === 1) return { rel: exact[0].rel, ambiguous: false };

  // ② 文件名（title）或别名匹配：取目标末段，不带目录时就是目标本身
  const base = stripMdSuffix(lastSegment(target)).toLowerCase();
  const byName = pages.filter(
    (page) =>
      page.title.toLowerCase() === base ||
      page.aliases.some((alias) => stripMdSuffix(alias).toLowerCase() === base),
  );

  // ③ 带目录但 title 没对上（例如 [[dir/foo]] 与 title 不同名）：按 rel 后缀兜底
  const pool =
    byName.length > 0
      ? byName
      : target.includes("/")
        ? pages.filter((page) => normalizePathKey(page.rel).endsWith(`/${wantedKey}`))
        : [];

  if (pool.length === 0) return { rel: null, ambiguous: false };
  if (pool.length === 1) return { rel: pool[0].rel, ambiguous: false };
  return { rel: pickNearest(pool, fromRel).rel, ambiguous: true };
}

/* ------------------------------------------------------------------ 渲染地址 */

/** 渲染用的伪协议前缀：markdown 里走 `#` 片段，既不触发外链也不被 URL 消毒丢掉。 */
export const WIKI_LINK_PREFIX = "#vault-link/";
export const WIKI_EMBED_PREFIX = "#vault-embed/";
export const WIKI_IMAGE_PREFIX = "#vault-image/";

export type WikiHrefKind = "link" | "embed" | "image";

/** 把目标编码成 markdown 可安全携带的片段地址。 */
export function encodeWikiHref(kind: WikiHrefKind, target: string): string {
  const prefix =
    kind === "image" ? WIKI_IMAGE_PREFIX : kind === "embed" ? WIKI_EMBED_PREFIX : WIKI_LINK_PREFIX;
  return `${prefix}${encodeURIComponent(target)}`;
}

/** 解码渲染地址；不是本库生成的地址返回 null（外部链接照常走 <a>）。 */
export function decodeWikiHref(href: string | undefined): { kind: WikiHrefKind; target: string } | null {
  if (!href) return null;
  const table: [string, WikiHrefKind][] = [
    [WIKI_LINK_PREFIX, "link"],
    [WIKI_EMBED_PREFIX, "embed"],
    [WIKI_IMAGE_PREFIX, "image"],
  ];
  for (const [prefix, kind] of table) {
    if (href.startsWith(prefix)) {
      try {
        return { kind, target: decodeURIComponent(href.slice(prefix.length)) };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 判断目标是不是图片附件（决定 `![[x]]` 渲染成图还是嵌入笔记）。 */
export function looksLikeImage(target: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(target.trim());
}

/** 只允许 http(s)/mailto 的外链；其余（javascript: 等）不渲染成可点链接。 */
export function isSafeExternalHref(href: string | undefined): boolean {
  if (!href) return false;
  return /^(https?:\/\/|mailto:)/i.test(href);
}

/** 锚点命中状态：none=没写锚点；hit=标题存在；miss=文件存在但标题没找到（黄色提示，不是断链）。 */
export type AnchorStatus = "none" | "hit" | "miss";

/**
 * 计算 `[[页面#标题]]` 的锚点状态。
 *
 * 规格口径：**锚点没命中也算「文件已解析」**，界面用黄色「锚点未命中」提示，
 * 不当成断链（红色）——用户点进去仍是那篇笔记，只是标题改过名。
 */
export function anchorStatusOf(
  index: VaultIndex | null | undefined,
  targetRel: string | null,
  heading: string | undefined,
): AnchorStatus {
  if (!heading) return "none";
  if (!index || !targetRel) return "miss";
  const page = index.pages.get(targetRel);
  if (!page) return "miss";
  const wanted = heading.trim().toLowerCase();
  if (!wanted) return "none";
  return page.headings.some((item) => item.text.trim().toLowerCase() === wanted) ? "hit" : "miss";
}
