/**
 * vault 索引：把一批 markdown 文档算成全库索引（页面信息 / 双链 / 反链 / 标签 / 孤立页）。
 *
 * 为什么自己算而不是用现成图库：索引要同时喂给界面（反链、大纲、标签面板）、
 * 搜索、图谱和记忆层，形状必须稳定、可测、纯函数。这里不碰文件系统，输入就是
 * `{ rel, text, mtime }[]`——同一份输入永远得到同一份输出（所有 Map / 数组的
 * 插入顺序与排序都有确定规则，不读时钟、不用随机）。
 *
 * 链接解析口径（规格 §3，对齐 Obsidian 的「最短唯一路径」）：
 * 1. `[[foo]]` 先按文件名（去 `.md`）匹配，再按 frontmatter 别名匹配；
 * 2. 多个同名文件时「相对当前文件最近」的优先（同目录 > 公共前缀更长 > 层级更浅 > 字典序），
 *    同时把该名字记进 `ambiguous`（界面标黄，不静默选一个）；
 * 3. `[[dir/foo]]` 按库根相对路径解析，`[[/foo]]` 视为库根绝对；
 * 4. `[[foo#标题]]` 的文件解析与锚点无关：标题没匹配上仍算「文件已解析」；
 * 5. 解析不到的目标进 `unresolved`，界面可一键建页。
 *
 * 内容 hash 用自带的 SHA-256（前 16 位十六进制），不依赖 WebCrypto：
 * 测试环境、浏览器、Electron 渲染层行为完全一致，记忆增量同步才能对得上。
 */

import type { PageInfo, TagRef, VaultIndex, WikiLink } from "./types.js";
import { IMAGE_EXTS } from "./types.js";
import {
  extractHeadings,
  extractInlineTags,
  extractLinks,
  frontmatterAliases,
  frontmatterTags,
  parseFrontmatter,
} from "./parse.js";

/** 索引输入：一个 markdown 文档（`VaultDoc` 结构上兼容）。 */
export interface VaultDocInput {
  rel: string;
  text: string;
  mtime: string;
}

/** 已解析文档 + frontmatter 行偏移（增量重算时缓存它，避免重复解析）。 */
export interface ParsedVaultDoc {
  page: PageInfo;
  /** body 首行在文件里的行偏移，供双链/标签行号还原。 */
  lineOffset: number;
}

/** 根目录下这几类文件不算孤立页（它们是库自身的索引/流水/规约）。 */
const ORPHAN_ROOT_EXEMPT = new Set(["index.md", "log.md", "schema.md"]);

/* ------------------------------------------------------------------ 小工具 */

/** 稳定的字符串比较：按 UTF-16 码元比较，跨环境一致（localeCompare 受 ICU 影响）。 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function lower(value: string): string {
  return value.toLowerCase();
}

/** 规范化库内相对路径：统一 `/`、去 `./` 与前导 `/`、压重复分隔符。 */
export function normalizeRel(rel: string): string {
  let out = String(rel ?? "")
    .replace(/\\/g, "/")
    .trim();
  while (out.startsWith("./")) out = out.slice(2);
  out = out.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** 取文件名（不含 `.md`）：链接解析的第一选择键。 */
export function titleOf(rel: string): string {
  const normalized = normalizeRel(rel);
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.replace(/\.md$/i, "");
}

/** 是否 markdown（索引只收 md；canvas 等文本文件不进双链索引）。 */
export function isMarkdownRel(rel: string): boolean {
  return /\.md$/i.test(normalizeRel(rel));
}

/**
 * 目标是否是图片附件（`.png/.jpg/.jpeg/.gif/.webp/.svg`，大小写不敏感）。
 *
 * 为什么单独判：索引输入只有 markdown 文档，图片附件天然不在 `pages` 里，
 * 所以 `![[附件/图.png]]` 与 `[[附件/图.png]]` 一定「解析不到」。但这不是
 * 「页面还没建」——界面会把它列进未解析并提示建页，而 `vault:create` 对图片扩展名
 * 会直接返回 forbidden-ext，是个死路。因此这类目标不计入 `unresolved`；
 * 图片本身由界面通过 `vault:readBinary` 渲染（预览层就是这么做的）。
 */
export function isImageTarget(target: string): boolean {
  const value = String(target ?? "")
    .trim()
    .toLowerCase();
  return IMAGE_EXTS.some((ext) => value.endsWith(ext));
}

/* ------------------------------------------------------------------ SHA-256 */

/** SHA-256 轮常量。 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** 手写 UTF-8 编码：不依赖 TextEncoder，保证 Node / jsdom / 浏览器结果一致。 */
function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** 标准 SHA-256，返回 64 位小写十六进制。 */
function sha256Hex(input: string): string {
  const bytes = utf8Bytes(String(input ?? ""));
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(total);
  message.set(bytes);
  message[bytes.length] = 0x80;
  const view = new DataView(message.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(total - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(total - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
    0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  let hex = "";
  for (const word of h) hex += word.toString(16).padStart(8, "0");
  return hex;
}

/**
 * 内容摘要：整份文件文本的 SHA-256 前 16 位十六进制。
 * 同内容同 hash、不同内容不同 hash；记忆层用它与 mtime 一起判断「这篇没变」。
 */
export function contentHash(text: string): string {
  return sha256Hex(text).slice(0, 16);
}

/* ------------------------------------------------------------------ 解析单个文档 */

/** 解析一个文档成 PageInfo（标签 = frontmatter ∪ 行内，按出现顺序去重）。 */
export function parseDoc(doc: VaultDocInput): PageInfo {
  return parseDocWithOffset(doc).page;
}

/** 解析文档并保留 frontmatter 行偏移（索引层内部用）。 */
export function parseDocWithOffset(doc: VaultDocInput): ParsedVaultDoc {
  const rel = normalizeRel(doc.rel);
  const text = String(doc.text ?? "");
  const { meta, body, lineOffset } = parseFrontmatter(text);
  const title = titleOf(rel);
  const aliases = frontmatterAliases(meta);
  const tags: string[] = [];
  const seenTags = new Set<string>();
  const addTag = (tag: string): void => {
    const value = tag.replace(/^#+/, "").trim();
    if (!value) return;
    const key = lower(value);
    if (seenTags.has(key)) return;
    seenTags.add(key);
    tags.push(value);
  };
  for (const tag of frontmatterTags(meta)) addTag(tag);
  for (const { tag } of extractInlineTags(body, { lineOffset })) addTag(tag);

  return {
    page: {
      rel,
      title,
      aliases,
      tags,
      headings: extractHeadings(body, { lineOffset }),
      mtime: String(doc.mtime ?? ""),
      hash: contentHash(text),
      frontmatter: meta,
      body,
    },
    lineOffset,
  };
}

/** 页面的标签引用（行内带行号，frontmatter 来源行号为 0）——界面标签面板用。 */
export function tagRefsOf(page: PageInfo, lineOffset = 0): TagRef[] {
  const refs: TagRef[] = frontmatterTags(page.frontmatter).map((tag) => ({
    tag: tag.replace(/^#+/, ""),
    from: page.rel,
    line: 0,
    source: "frontmatter" as const,
  }));
  for (const { tag, line } of extractInlineTags(page.body, { lineOffset })) {
    refs.push({ tag, from: page.rel, line, source: "inline" });
  }
  return refs;
}

/* ------------------------------------------------------------------ 索引构建 */

function pushTo(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (!list) {
    map.set(key, [value]);
    return;
  }
  if (!list.includes(value)) list.push(value);
}

/** 目录层级（用于「相对当前文件最近」的判定）。 */
function segments(rel: string): string[] {
  return rel.split("/").filter(Boolean);
}

function dirSegments(rel: string): string[] {
  return segments(rel).slice(0, -1);
}

/** 在多个同名候选中挑「相对 fromRel 最近」的一个（确定性的四级 tie-break）。 */
function nearestCandidate(fromRel: string, candidates: string[]): string {
  const fromDir = dirSegments(fromRel);
  const ranked = candidates.map((rel) => {
    const dir = dirSegments(rel);
    let common = 0;
    while (common < dir.length && common < fromDir.length && dir[common] === fromDir[common]) {
      common += 1;
    }
    const sameDir = common === dir.length && common === fromDir.length ? 1 : 0;
    return { rel, sameDir, common, depth: segments(rel).length };
  });
  ranked.sort(
    (a, b) =>
      b.sameDir - a.sameDir ||
      b.common - a.common ||
      a.depth - b.depth ||
      compareText(a.rel, b.rel),
  );
  return ranked[0].rel;
}

/**
 * 由「已解析文档 + 行偏移」构建全库索引。
 *
 * 增量重算时调用方只需重解析变化的文件，再把整表传进来——
 * 链接解析是全局的（同名歧义会随文件增删变化），所以这一步总是全量重算，
 * 但它只做字符串比较，不读文件、不重新解析正文。
 */
export function buildVaultIndexFromParsed(docs: ParsedVaultDoc[]): VaultIndex {
  const sortedDocs = [...docs].sort((a, b) => compareText(a.page.rel, b.page.rel));
  const pageMap = new Map<string, PageInfo>();
  const byTitle = new Map<string, string[]>();
  const byAlias = new Map<string, string[]>();
  const byPath = new Map<string, string>();
  for (const { page } of sortedDocs) {
    if (pageMap.has(page.rel)) continue; // 重复 rel 只保留字典序靠前的那份
    pageMap.set(page.rel, page);
    pushTo(byTitle, lower(page.title), page.rel);
    for (const alias of page.aliases) pushTo(byAlias, lower(alias), page.rel);
    byPath.set(lower(page.rel), page.rel);
    if (/\.md$/i.test(page.rel)) byPath.set(lower(page.rel.replace(/\.md$/i, "")), page.rel);
  }

  /** 带路径的目标：先精确匹配，再按「以 /目标 结尾」做路径后缀匹配。 */
  const pathCandidates = (target: string): string[] => {
    const exact = byPath.get(target);
    if (exact) return [exact];
    const out: string[] = [];
    for (const [key, rel] of byPath) {
      if (key.endsWith(`/${target}`)) out.push(rel);
    }
    return [...new Set(out)];
  };

  /** 裸名字（无 `/`）：文件名优先，其次 frontmatter 别名。 */
  const bareCandidates = (name: string): { key: string; candidates: string[] } => {
    let key = name;
    let candidates = byTitle.get(name) ?? [];
    if (!candidates.length) candidates = byAlias.get(name) ?? [];
    if (!candidates.length && name.endsWith(".md")) {
      key = name.slice(0, -3);
      candidates = byTitle.get(key) ?? [];
    }
    return { key, candidates };
  };

  const ambiguousSets = new Map<string, Set<string>>();
  const markAmbiguous = (key: string, rels: string[]): void => {
    const set = ambiguousSets.get(key) ?? new Set<string>();
    for (const rel of rels) set.add(rel);
    ambiguousSets.set(key, set);
  };

  const resolve = (target: string, fromRel: string): { rel: string | null; key: string | null } => {
    const cleaned = lower(target.trim().replace(/\\/g, "/").replace(/^\/+/, ""));
    if (!cleaned) return { rel: null, key: null };
    if (cleaned.includes("/")) {
      const candidates = pathCandidates(cleaned).sort(compareText);
      if (!candidates.length) return { rel: null, key: null };
      if (candidates.length > 1) markAmbiguous(cleaned, candidates);
      return {
        rel: candidates.length === 1 ? candidates[0] : nearestCandidate(fromRel, candidates),
        key: candidates.length > 1 ? cleaned : null,
      };
    }
    const bare = bareCandidates(cleaned);
    const candidates = [...new Set(bare.candidates)].sort(compareText);
    if (!candidates.length) return { rel: null, key: null };
    if (candidates.length > 1) markAmbiguous(bare.key, candidates);
    return {
      rel: candidates.length === 1 ? candidates[0] : nearestCandidate(fromRel, candidates),
      key: candidates.length > 1 ? bare.key : null,
    };
  };

  // 同名（文件名冲突 / 别名冲突）即使没人链接也要标出来，界面才能提前提示
  for (const [key, rels] of byTitle) if (rels.length > 1) markAmbiguous(key, rels);
  for (const [key, rels] of byAlias) if (rels.length > 1) markAmbiguous(key, rels);

  const links: WikiLink[] = [];
  for (const { page, lineOffset } of sortedDocs) {
    if (pageMap.get(page.rel) !== page) continue; // 重复 rel 跳过
    for (const parsed of extractLinks(page.body, { lineOffset })) {
      const { rel } = resolve(parsed.target, page.rel);
      const link: WikiLink = {
        target: parsed.target,
        embed: parsed.embed,
        from: page.rel,
        line: parsed.line,
        resolved: rel,
      };
      if (parsed.alias !== undefined) link.alias = parsed.alias;
      if (parsed.heading !== undefined) link.heading = parsed.heading;
      links.push(link);
    }
  }
  links.sort(
    (a, b) =>
      compareText(a.from, b.from) ||
      a.line - b.line ||
      compareText(a.target, b.target) ||
      Number(a.embed) - Number(b.embed) ||
      compareText(a.alias ?? "", b.alias ?? "") ||
      compareText(a.heading ?? "", b.heading ?? ""),
  );

  const backlinks = new Map<string, WikiLink[]>();
  const unresolved: WikiLink[] = [];
  for (const link of links) {
    if (link.resolved === null) {
      // 图片附件不可能是「待建页面」：不进 unresolved（原因见 isImageTarget 注释），
      // 但仍保留在 links 里，图谱/预览需要知道「这里有个嵌入」。
      if (!isImageTarget(link.target)) unresolved.push(link);
      continue;
    }
    const list = backlinks.get(link.resolved);
    if (list) list.push(link);
    else backlinks.set(link.resolved, [link]);
  }
  for (const list of backlinks.values()) {
    list.sort(
      (a, b) =>
        compareText(a.from, b.from) ||
        a.line - b.line ||
        compareText(a.target, b.target),
    );
  }

  const tags = new Map<string, string[]>();
  for (const { page } of sortedDocs) {
    for (const tag of page.tags) pushTo(tags, lower(tag), page.rel);
  }
  for (const list of tags.values()) list.sort(compareText);

  const orphans: string[] = [];
  for (const rel of pageMap.keys()) {
    if ((backlinks.get(rel)?.length ?? 0) > 0) continue;
    if (!rel.includes("/") && ORPHAN_ROOT_EXEMPT.has(lower(rel))) continue;
    orphans.push(rel);
  }
  orphans.sort(compareText);

  const ambiguous = new Map<string, string[]>();
  for (const key of [...ambiguousSets.keys()].sort(compareText)) {
    const rels = [...(ambiguousSets.get(key) ?? [])].sort(compareText);
    if (rels.length > 1) ambiguous.set(key, rels);
  }

  return { pages: pageMap, links, backlinks, unresolved, tags, orphans, ambiguous };
}

/** 由 PageInfo 列表构建索引（外部构造的页面没有 frontmatter 偏移，行号按 body 计）。 */
export function buildVaultIndexFromPages(pages: PageInfo[]): VaultIndex {
  return buildVaultIndexFromParsed(pages.map((page) => ({ page, lineOffset: 0 })));
}

/**
 * 由文档列表构建全库索引（规格 §3）。
 *
 * 输入顺序不影响输出：内部按 rel 排序；重复 rel 只保留字典序靠前的一份。
 */
export function buildVaultIndex(docs: VaultDocInput[]): VaultIndex {
  return buildVaultIndexFromParsed(docs.map((doc) => parseDocWithOffset(doc)));
}

/* ------------------------------------------------------------------ 公共 API（桶） */

/**
 * 知识库模块的公共出口。
 *
 * 本文件既是「索引构建」的实现（`buildVaultIndex`），也是整个 `lib/vault` 的桶：
 * 界面、工具层、记忆适配都从这里取公共 API，避免各自深链内部文件。
 * `types.ts` 是契约层，这里一并再导出，调用方不必区分「类型从哪来」。
 *
 * ★ 已知结构问题（P3-16，第二轮处理，本轮不改）：
 * `store.ts` 反向 `import { buildVaultIndexFromParsed, ... } from "./index.js"`，
 * 而本文件又 `export * from "./store.js"`——存在**循环依赖**。当前能跑，是因为
 * store 只在运行时函数里用这些值（不是模块顶层求值），但 ESM 循环依赖对求值顺序
 * 很敏感：以后谁把相关调用提到模块顶层就会拿到 undefined。另外任何只想用
 * `buildVaultIndex` 的调用方（如记忆层）也会被连带到 zustand store 与浏览器桥。
 * 第二轮应拆成 `parse.ts`/`index-core.ts`（纯函数）与 `barrel.ts`，本文件只保留桶。
 */
export * from "./types.js";
export * from "./parse.js";
export * from "./bridge.js";
export * from "./search.js";
export * from "./graph.js";
export * from "./store.js";
export * from "./tools.js";
