import { encodeWikiHref, looksLikeImage } from "./wikilinks.js";

/**
 * remark 插件：把正文里的 `[[页面]]` / `[[页面|别名]]` / `[[页面#标题]]` / `![[嵌入]]`
 * 换成标准 mdast 节点（link / image），预览面板再用组件覆盖渲染成 chip 与图片。
 *
 * 为什么走「换成标准节点」而不是在渲染层用正则切字符串：
 * - mdast 的代码块/行内代码是**独立节点**，天然不会被扫描到，规格 §3.5 那条
 *   「代码块内不算链接」就不用自己重新实现一遍 markdown 词法；
 * - 换成标准 link/image 后，react-markdown 的 URL 消毒、段落内联、列表嵌套全都照旧，
 *   不需要自己维护一份「像 markdown 的渲染器」。
 *
 * 不使用 `dangerouslySetInnerHTML`：节点里只有转义过的文本与注释，链路不碰 raw HTML。
 */

/** mdast 节点的最小形状（避免为此引入 @types/mdast 依赖）。 */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  url?: string;
  alt?: string;
  title?: string;
}

/** 一个双链 token：`!?[[内容]]`，内容不能跨行。 */
const WIKI_TOKEN = /!?\[\[[^\]\n]+\]\]/g;

/** 解析 `[[...]]` 的内部内容。 */
export function parseWikiToken(raw: string): {
  embed: boolean;
  target: string;
  alias?: string;
  heading?: string;
} | null {
  const match = /^(!?)\[\[([^\]\n]+)\]\]$/.exec(raw.trim());
  if (!match) return null;
  const embed = match[1] === "!";
  const inner = match[2];
  const pipe = inner.indexOf("|");
  const targetPart = pipe < 0 ? inner : inner.slice(0, pipe);
  const alias = pipe < 0 ? undefined : inner.slice(pipe + 1).trim() || undefined;
  const hash = targetPart.indexOf("#");
  const target = (hash < 0 ? targetPart : targetPart.slice(0, hash)).trim();
  const heading = hash < 0 ? undefined : targetPart.slice(hash + 1).trim() || undefined;
  if (!target) return null;
  return { embed, target, alias, heading };
}

/** 生成一个内联链接节点。 */
function wikiLinkNodes(raw: string): MdNode[] {
  const token = parseWikiToken(raw);
  if (!token) return [{ type: "text", value: raw }];
  const display = token.alias ?? (token.heading ? `${token.target}#${token.heading}` : token.target);
  if (token.embed && looksLikeImage(token.target)) {
    return [{ type: "image", url: encodeWikiHref("image", token.target), alt: token.target }];
  }
  return [
    {
      type: "link",
      url: encodeWikiHref(token.embed ? "embed" : "link", token.target),
      title: token.heading,
      children: [{ type: "text", value: display }],
    },
  ];
}

/** 把一段纯文本按双链切成节点序列。 */
function splitTextNode(value: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  WIKI_TOKEN.lastIndex = 0;
  for (let match = WIKI_TOKEN.exec(value); match; match = WIKI_TOKEN.exec(value)) {
    if (match.index > last) out.push({ type: "text", value: value.slice(last, match.index) });
    out.push(...wikiLinkNodes(match[0]));
    last = match.index + match[0].length;
  }
  if (last === 0) return [{ type: "text", value }];
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/** 递归改写 children 数组（代码节点没有 children，天然跳过）。 */
function transformChildren(node: MdNode): void {
  if (!Array.isArray(node.children)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string" && child.value.includes("[[")) {
      next.push(...splitTextNode(child.value));
      continue;
    }
    // 链接内部不再嵌套双链（`[ [[x]] ](url)` 这类写法保留原文，避免生成非法嵌套）
    if (child.type === "link") {
      next.push(child);
      continue;
    }
    transformChildren(child);
    next.push(child);
  }
  node.children = next;
}

/** remark 插件入口（不引 unified 的类型，保持零额外依赖）。 */
export function remarkWikiLinks() {
  return (tree: MdNode): void => {
    transformChildren(tree);
  };
}
