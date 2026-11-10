import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { VaultIndex } from "../../lib/vault/types.js";
import { remarkWikiLinks } from "./remarkWikiLinks.js";
import { anchorStatusOf, decodeWikiHref, isSafeExternalHref, resolveWikiTarget } from "./wikilinks.js";

/**
 * 知识库预览面板：复用仓库既有的 markdown 渲染链
 * （react-markdown + remark-gfm + remark-math + rehype-katex），在此之上把
 * `[[双链]]` 渲染成可点 chip、`![[图片]]` 渲染成图片、`![[笔记]]` 限深嵌入。
 *
 * 三条硬约束：
 * 1. **不注入 raw HTML**：没有 rehype-raw，正文里的 HTML 只会被转义成文本；
 * 2. **不猜链接**：解析不到的双链点一下是「创建该页」，不是随便跳一篇同名文；
 * 3. 数据全部走 props（`VaultIndex` / 回调），组件本身不 import store 实现，
 *    测试与索引层并行开发时可以直接喂假数据。
 */

export interface PreviewPaneProps {
  /** 当前文件 rel（链接解析的「最近路径」基准）。 */
  rel: string;
  /** markdown 正文。 */
  text: string;
  /** 全库索引（缺省时双链一律按未解析渲染）。 */
  index?: VaultIndex | null;
  /** 覆盖默认解析逻辑（返回目标 rel 或 null）。 */
  resolve?: (target: string) => string | null;
  /** 点击已解析双链。 */
  onOpenLink?: (rel: string) => void;
  /** 点击未解析双链（= 创建该页）。 */
  onCreatePage?: (target: string) => void;
  /** 读图片附件 → data URL（桌面桥 vault:readBinary）。 */
  resolveImage?: (rel: string) => Promise<string | null>;
  /** 读嵌入笔记（`![[笔记]]` 限深 1），同步路径：已在 docs 缓存里时优先用它。 */
  resolveDoc?: (rel: string) => { rel: string; text: string } | null;
  /** 异步读嵌入笔记：缓存里没有时按需读一次（store.readText / 文件桥）。 */
  loadDoc?: (rel: string) => Promise<{ rel: string; text: string } | null>;
  /** 嵌入深度：0=顶层；到 1 后不再继续嵌入，防环。 */
  embedDepth?: number;
  className?: string;
}

/** 链接 chip：已解析→跳转，未解析→提示建页（样式与 `ui-chip` 同族，暗色可读）。 */
function WikiChip({
  label,
  resolved,
  ambiguous,
  anchorMiss = false,
  title,
  onClick,
}: {
  label: string;
  resolved: boolean;
  ambiguous: boolean;
  /** 文件已解析但 `#锚点` 没命中：黄色提示，不当成断链。 */
  anchorMiss?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={
        resolved ? `打开页面 ${label}${anchorMiss ? "（锚点未命中）" : ""}` : `创建页面 ${label}（当前未解析）`
      }
      className={`mx-0.5 inline-flex max-w-full items-baseline gap-1 truncate rounded-sm border px-1 py-0 align-baseline text-[12px] leading-5 transition-colors ${
        resolved
          ? anchorMiss
            ? "border-dashed border-warn text-[var(--warn)] hover:bg-subtle-3"
            : "border-line text-[var(--info)] hover:border-[var(--info)] hover:bg-subtle-3"
          : ambiguous
            ? "border-dashed border-warn text-[var(--warn)] hover:bg-subtle-3"
            : "border-dashed border-line-strong text-muted hover:border-ink hover:text-ink"
      }`}
    >
      <span className="truncate">{label}</span>
      {!resolved ? (
        <span className="shrink-0 text-[10px]">{ambiguous ? "有歧义" : "未创建"}</span>
      ) : anchorMiss ? (
        <span className="shrink-0 text-[10px]">锚点未命中</span>
      ) : null}
    </button>
  );
}

/**
 * 异步嵌入笔记：`![[笔记]]` 不在 docs 缓存里时按需读一次正文再渲染。
 *
 * 限深由调用方控制（embedDepth）；这里只做「加载中 / 读不到 / 读到」三态，
 * 读不到时退回一张可点 chip（不是空块），用户仍能打开原页。
 */
function AsyncNoteEmbed({
  rel,
  load,
  render,
}: {
  rel: string;
  load: (rel: string) => Promise<{ rel: string; text: string } | null>;
  render: (doc: { rel: string; text: string }) => React.ReactNode;
}) {
  const [doc, setDoc] = useState<{ rel: string; text: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setDoc(null);
    setFailed(false);
    void load(rel)
      .then((loaded) => {
        if (!alive) return;
        if (loaded) setDoc(loaded);
        else setFailed(true);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [rel, load]);

  if (doc) return <>{render(doc)}</>;
  return (
    <span className="ui-chip my-1 align-middle">
      {failed ? `嵌入读取失败：${rel}（点击原页查看）` : `嵌入加载中：${rel}`}
    </span>
  );
}

/** 图片附件：异步读 data URL；失败/未接桥都给明确的文字占位（不装作加载成功）。 */
function VaultImage({
  rel,
  alt,
  load,
}: {
  rel: string;
  alt: string;
  load: (rel: string) => Promise<string | null>;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setFailed(false);
    void load(rel)
      .then((url) => {
        if (!alive) return;
        if (url) setSrc(url);
        else setFailed(true);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [rel, load]);

  if (src) {
    return (
      <img
        src={src}
        alt={alt}
        data-testid="vault-preview-image"
        className="my-2 max-h-80 max-w-full rounded-md border border-line-soft"
      />
    );
  }
  return (
    <span role="img" aria-label={`图片 ${alt}`} className="ui-chip my-1 align-middle">
      {failed ? `图片无法显示：${alt}` : `图片加载中：${alt}`}
    </span>
  );
}

export function PreviewPane({
  rel,
  text,
  index = null,
  resolve,
  onOpenLink,
  onCreatePage,
  resolveImage,
  resolveDoc,
  loadDoc,
  embedDepth = 0,
  className = "",
}: PreviewPaneProps) {
  /** 统一解析入口：外部覆盖优先，否则按「最短唯一路径」用索引解析。 */
  const resolvedOf = (target: string): { rel: string | null; ambiguous: boolean } => {
    if (resolve) return { rel: resolve(target), ambiguous: false };
    return resolveWikiTarget(index, rel, target);
  };

  const components = useMemo(() => {
    /** 嵌入块（同步：文档已在缓存里）。 */
    const renderEmbedded = (doc: { rel: string; text: string }) => (
      <div className="my-2 rounded-lg border border-line-soft bg-subtle p-2.5">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="ui-micro truncate text-muted">嵌入：{doc.rel}</span>
          <button
            type="button"
            aria-label={`打开嵌入页面 ${doc.rel}`}
            className="ui-link shrink-0"
            onClick={() => onOpenLink?.(doc.rel)}
          >
            打开
          </button>
        </div>
        <PreviewPane
          rel={doc.rel}
          text={doc.text}
          index={index}
          resolve={resolve}
          onOpenLink={onOpenLink}
          onCreatePage={onCreatePage}
          resolveImage={resolveImage}
          resolveDoc={resolveDoc}
          loadDoc={loadDoc}
          embedDepth={embedDepth + 1}
        />
      </div>
    );

    const embed = (target: string, display: string) => {
      const { rel: targetRel } = resolvedOf(target);
      const chip = (
        <WikiChip
          label={`嵌入：${display}`}
          resolved={Boolean(targetRel)}
          ambiguous={false}
          title={targetRel ? "嵌入层级已达上限，点击打开原页" : "目标页面不存在"}
          onClick={() => (targetRel ? onOpenLink?.(targetRel) : onCreatePage?.(target))}
        />
      );
      // 限深 1：内层不再继续嵌入，避免 A→B→A 这种环
      if (embedDepth >= 1 || !targetRel) return chip;
      // 先走同步缓存（已打开的文档），没有再异步读一次
      const cached = resolveDoc?.(targetRel) ?? null;
      if (cached) return renderEmbedded(cached);
      if (loadDoc) return <AsyncNoteEmbed rel={targetRel} load={loadDoc} render={renderEmbedded} />;
      return chip;
    };

    return {
      a: ({ href, children, title }: { href?: string; children?: React.ReactNode; title?: string }) => {
        const wiki = decodeWikiHref(href);
        if (wiki) {
          const display =
            typeof children === "string" ? children : String(children ?? wiki.target);
          if (wiki.kind === "embed") return embed(wiki.target, display);
          const { rel: targetRel, ambiguous } = resolvedOf(wiki.target);
          // 锚点未命中：文件解析成功、但 `#标题` 找不到 → 黄色提示（不是断链）
          const anchorMiss = anchorStatusOf(index, targetRel, title) === "miss";
          return (
            <WikiChip
              label={display}
              resolved={Boolean(targetRel)}
              ambiguous={ambiguous}
              anchorMiss={anchorMiss}
              title={targetRel ? (title ? `跳到「${title}」` : `打开 ${targetRel}`) : `创建「${wiki.target}」`}
              onClick={() =>
                targetRel ? onOpenLink?.(targetRel) : onCreatePage?.(wiki.target)
              }
            />
          );
        }
        // 外链只放行 http(s)/mailto：其它协议（javascript: 等）不渲染成可点链接
        if (!isSafeExternalHref(href)) {
          return <span className="text-muted">{children}</span>;
        }
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[var(--info)] underline underline-offset-2 hover:text-[var(--info)]"
          >
            {children}
          </a>
        );
      },
      img: ({ src, alt }: { src?: string; alt?: string }) => {
        const wiki = decodeWikiHref(src);
        if (wiki?.kind === "image") {
          if (!resolveImage) {
            return (
              <span className="ui-chip my-1 align-middle">
                图片：{wiki.target}（未接入图片读取）
              </span>
            );
          }
          return <VaultImage rel={wiki.target} alt={alt ?? wiki.target} load={resolveImage} />;
        }
        // 普通 markdown 图片：只允许 http(s) 与 data:image，其它按文字处理
        if (!src || !/^(https?:\/\/|data:image\/)/i.test(src)) {
          return <span className="ui-chip my-1 align-middle">图片：{alt || "无法显示"}</span>;
        }
        return (
          <img
            src={src}
            alt={alt ?? ""}
            loading="lazy"
            className="my-2 max-h-80 max-w-full rounded-md border border-line-soft"
          />
        );
      },
      p: ({ children }: { children?: React.ReactNode }) => (
        <p className="my-2 first:mt-0 last:mb-0">{children}</p>
      ),
      h1: ({ children }: { children?: React.ReactNode }) => (
        <h1 className="mb-2 mt-4 border-b border-line-soft pb-1 text-[18px] font-semibold leading-[26px] text-ink first:mt-0">
          {children}
        </h1>
      ),
      h2: ({ children }: { children?: React.ReactNode }) => (
        <h2 className="mb-1.5 mt-3.5 text-[16px] font-semibold leading-6 text-ink first:mt-0">
          {children}
        </h2>
      ),
      h3: ({ children }: { children?: React.ReactNode }) => (
        <h3 className="mb-1 mt-3 text-[14px] font-semibold leading-5 text-ink first:mt-0">
          {children}
        </h3>
      ),
      h4: ({ children }: { children?: React.ReactNode }) => (
        <h4 className="mb-1 mt-2.5 text-[13px] font-semibold leading-5 text-ink first:mt-0">
          {children}
        </h4>
      ),
      ul: ({ children }: { children?: React.ReactNode }) => (
        <ul className="my-1.5 list-disc pl-5">{children}</ul>
      ),
      ol: ({ children }: { children?: React.ReactNode }) => (
        <ol className="my-1.5 list-decimal pl-5">{children}</ol>
      ),
      li: ({ children }: { children?: React.ReactNode }) => <li className="my-0.5">{children}</li>,
      blockquote: ({ children }: { children?: React.ReactNode }) => (
        <blockquote className="my-2 border-l-2 border-line pl-3 text-muted">{children}</blockquote>
      ),
      hr: () => <hr className="my-3 border-line-soft" />,
      table: ({ children }: { children?: React.ReactNode }) => (
        <div className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">{children}</table>
        </div>
      ),
      th: ({ children }: { children?: React.ReactNode }) => (
        <th className="border border-line-soft bg-subtle-2 px-1.5 py-1 text-left font-semibold">
          {children}
        </th>
      ),
      td: ({ children }: { children?: React.ReactNode }) => (
        <td className="border border-line-soft px-1.5 py-1 align-top">{children}</td>
      ),
      // 代码：区分行内与块级；块级不加语法高亮（预览是阅读路径，shiki 留给消息气泡）
      pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
      code: ({ className: codeClass, children }: { className?: string; children?: React.ReactNode }) => {
        const raw = String(children ?? "");
        const isBlock = /language-/.test(codeClass ?? "") || raw.includes("\n");
        if (!isBlock) {
          return (
            <code className="rounded-sm bg-subtle-3 px-1 py-px font-mono text-[0.92em] text-ink">
              {children}
            </code>
          );
        }
        return (
          <pre className="my-2 overflow-x-auto rounded-lg border border-line bg-subtle p-2 font-mono text-[12px] leading-relaxed text-ink">
            <code>{raw.replace(/\n$/, "")}</code>
          </pre>
        );
      },
    };
    // resolvedOf 是闭包，依赖列表用显式 props 表达，避免每渲染换一次组件导致重挂载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    index,
    rel,
    resolve,
    onOpenLink,
    onCreatePage,
    resolveImage,
    resolveDoc,
    loadDoc,
    embedDepth,
  ]);

  if (!text.trim()) {
    return (
      <div className={`flex h-full items-center justify-center p-6 text-[12px] text-muted ${className}`}>
        这篇笔记还是空的，切到源码模式开始写。
      </div>
    );
  }

  return (
    <div className={`markdown-body break-words text-[13px] leading-[1.75] text-ink ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkWikiLinks]}
        rehypePlugins={[rehypeKatex]}
        components={components as unknown as Components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
