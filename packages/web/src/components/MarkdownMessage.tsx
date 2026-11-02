import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { highlightCode } from "../lib/markdown/highlight.js";
import { useModalA11y } from "./useModalA11y.js";

/**
 * 消息正文的 markdown 渲染。
 *
 * ## 为什么现在才做
 *
 * 在此之前正文是 `whitespace-pre-wrap` 的纯文本——保留了换行，但**代码块、
 * 表格、列表、引用全都是裸文本**。这在只看聊天时勉强够用，一旦模型输出代码
 * 或对比表，观感立刻掉档。竞品（Cherry Studio / LobeHub / Chatbox）都渲染 markdown。
 *
 * ## 流式与高亮的取舍
 *
 * shiki 是异步的（要加载语法定义）。如果每个流式分片都触发一次高亮，
 * 高频 setState + 重复解析会让长回答明显卡顿，而且中间态没有任何意义。
 *
 * 所以：**流式中只渲染纯文本代码块，结束后再做高亮**。
 * 代价是回答结束的瞬间代码块会"闪"一下变色，收益是流式期间始终顺滑。
 * 这个取舍与 Cherry Studio 的做法一致。
 */

/** 代码块：语言标签 + 复制按钮 + 高亮。 */
function CodeBlock({
  code,
  lang,
  streaming,
}: {
  code: string;
  lang: string;
  streaming: boolean;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // 流式中不高等亮：内容还在变，高亮结果立刻过期
    if (streaming) {
      setHtml(null);
      return;
    }
    let alive = true;
    // ★ 必须带 catch：高亮会加载语法包，可能失败（网络、语法文件缺失、内存不足）。
    //   没有 catch 时拒绝会变成 **unhandled rejection**——
    //   在 Electron 渲染进程里这是未捕获错误，会干扰全局错误处理。
    //   失败时的正确行为是**降级成纯文本**（html 保持 null，组件会走无高亮分支）。
    void highlightCode(code, lang)
      .then((result) => {
        // 组件已卸载或内容已变——丢弃这次结果，避免把旧高亮盖到新内容上
        if (alive) setHtml(result);
      })
      .catch((err: unknown) => {
        // 降级不报错：语法高亮是锦上添花，代码块本身仍要能读
        console.warn("代码高亮失败，降级为纯文本", err);
      });
    return () => {
      alive = false;
    };
  }, [code, lang, streaming]);

  // 卸载时清掉计时器，避免对已卸载组件 setState
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // 剪贴板权限缺失（或非安全上下文）时的退路：临时 textarea + execCommand
      const area = document.createElement("textarea");
      area.value = code;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
      } catch {
        return; // 两条路都失败就不装作成功
      } finally {
        document.body.removeChild(area);
      }
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1600);
  };

  const label = lang?.trim() || "text";

  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-line bg-[#fafafa]">
      <div className="flex items-center justify-between border-b border-line-soft px-2 py-1">
        <span className="text-[10px] font-medium text-muted">{label}</span>
        <button
          type="button"
          aria-label="复制代码"
          onClick={() => void copy()}
          className="rounded-sm px-1.5 py-0.5 text-[10px] text-muted hover:bg-[#f0f0f0] hover:text-[#333]"
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      {html ? (
        // shiki 输出的 HTML 由本库生成（代码内容已转义），不含用户可注入的标签
        <div
          className="overflow-x-auto p-2 text-[12px] leading-relaxed [&_pre]:!bg-transparent [&_code]:!text-[12px]"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto p-2 font-mono text-[12px] leading-relaxed text-[#333]">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

/** 内联代码：浅底等宽，与正文区分但不喧宾夺主。 */
function InlineCode({ children }: { children?: React.ReactNode }) {
  return (
    <code className="rounded-sm bg-[#f2f2f2] px-1 py-[1px] font-mono text-[0.92em] text-[#c7254e]">
      {children}
    </code>
  );
}

/**
 * markdown 图片（A6）：气泡里保持受约束尺寸，点击打开 lightbox 看原图。
 * 遮罩 + 原图 + Esc/点遮罩关闭；焦点循环与背景屏蔽复用全仓统一的 useModalA11y。
 */
function MarkdownImage({ src, alt }: { src?: string; alt: string }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useModalA11y(panelRef, () => setOpen(false), { active: open, autoFocus: false });
  return (
    <>
      <button
        type="button"
        aria-label={`查看图片 ${alt || "图片"}`}
        className="my-1 block max-w-full cursor-zoom-in"
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={alt} className="max-w-full rounded-sm" />
      </button>
      {open && src ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-6"
          onClick={() => setOpen(false)}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="查看大图"
            className="flex max-h-full max-w-full items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={src}
              alt={alt}
              className="max-h-[88vh] max-w-[88vw] rounded-sm object-contain"
              data-testid="markdown-lightbox-image"
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * 正文渲染器。
 *
 * `streaming` 只影响代码块是否高亮；其余结构（列表、表格）随时可渲染——
 * markdown 对不完整输入本身是容错的。
 */
export const MarkdownMessage = memo(function MarkdownMessage({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const components = useMemo(
    () => ({
      // 代码：区分行内与块级。react-markdown 用 className 上的 language-xxx 标语言
      code: ({ className, children, ...props }: any) => {
        const raw = String(children ?? "");
        // 语言名按「非空白字符」整段抓取，不用 [\w+#-]：
        // 那个字符集不认中文，用户写 ` ```不存在的语言 ` 时会匹配失败，
        // 结果语言标签变成 "text"、高亮也被跳过——而这两个行为本不该由
        // 「语言名是否 ASCII」决定。
        const match = /language-([^\s]+)/.exec(className ?? "");
        // 有 language- 前缀，或内容里含换行 → 按块级处理
        const isBlock = Boolean(match) || raw.includes("\n");
        if (!isBlock) return <InlineCode>{children}</InlineCode>;
        return (
          <CodeBlock
            code={raw.replace(/\n$/, "")}
            lang={match?.[1] ?? ""}
            streaming={streaming}
          />
        );
      },
      // 块级代码的外层 <pre> 由 CodeBlock 自己画容器，这里透传避免双层边框
      pre: ({ children }: any) => <>{children}</>,
      a: ({ href, children }: any) => (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[#2563eb] underline underline-offset-2 hover:text-[#1d4ed8]"
        >
          {children}
        </a>
      ),
      p: ({ children }: any) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
      ul: ({ children }: any) => <ul className="my-1 list-disc pl-5">{children}</ul>,
      ol: ({ children }: any) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
      li: ({ children }: any) => <li className="my-0.5">{children}</li>,
      h1: ({ children }: any) => <h1 className="mb-1 mt-2 text-[15px] font-bold">{children}</h1>,
      h2: ({ children }: any) => <h2 className="mb-1 mt-2 text-[14px] font-bold">{children}</h2>,
      h3: ({ children }: any) => <h3 className="mb-1 mt-2 text-[13px] font-bold">{children}</h3>,
      blockquote: ({ children }: any) => (
        <blockquote className="my-1 border-l-2 border-line pl-2.5 text-muted">
          {children}
        </blockquote>
      ),
      hr: () => <hr className="my-2 border-line-soft" />,
      // 表格：GFM 表格在窄气泡里会溢出，用横向滚动兜住（而不是压缩列宽）
      table: ({ children }: any) => (
        <div className="my-1.5 overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">{children}</table>
        </div>
      ),
      th: ({ children }: any) => (
        <th className="border border-line-soft bg-[#fafafa] px-1.5 py-1 text-left font-bold">
          {children}
        </th>
      ),
      td: ({ children }: any) => (
        <td className="border border-line-soft px-1.5 py-1 align-top">{children}</td>
      ),
      img: ({ src, alt }: any) => (
        // 图片在气泡里限制最大尺寸，避免大图把布局撑破；点击放大见 MarkdownImage
        <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt ?? ""} />
      ),
    }),
    [streaming],
  );

  // 空正文不渲染空行：调用方常在无内容时也挂载本组件
  if (!text) return null;

  return (
    <div className="markdown-body break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});