import { useEffect, useRef, useState, type ReactNode } from "react";
import { useModalA11y } from "./useModalA11y.js";
import { XIcon } from "./icons.js";
import type { SharedFileMeta } from "@heming/shared";
import { fetchFileBlobText, fetchFileBlobUrl } from "../lib/api.js";

/** 预览形态：按 mime + 扩展名归四类（图片直显 / Markdown / 纯文本 / 只给下载）。 */
type PreviewKind = "image" | "markdown" | "text" | "download";

function kindOf(file: SharedFileMeta): PreviewKind {
  if (file.mime.startsWith("image/")) return "image";
  const name = file.name.toLowerCase();
  // .md/.markdown 优先看扩展名（含 application/octet-stream 推上来的确省后缀场景）
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (file.mime.startsWith("text/") || file.mime === "application/json") return "text";
  return "download";
}

/** 行内轻语法：`**粗体**` → <strong>、`` `代码` `` → <code>，其余是普通文本节点（React 天然转义）。 */
function inline(src: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push(src.slice(last, m.index));
    out.push(
      m[1] !== undefined ? (
        <strong key={`${key}.${n}`}>{m[1]}</strong>
      ) : (
        <code key={`${key}.${n}`} className="rounded-sm bg-[var(--subtle-3)] px-1">
          {m[2]}
        </code>
      ),
    );
    last = m.index + m[0].length;
    n += 1;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

/**
 * MarkdownLite：只做行级分组（标题/围栏代码/列表/段落）+ 行内粗体与行内代码，
 * 全部 React 元素拼装，禁用 dangerouslySetInnerHTML（预览外部上传内容的安全红线）。
 */
export function MarkdownLite({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i += 1;
      out.push(
        <pre key={`p${out.length}`} className="whitespace-pre-wrap rounded-sm bg-[var(--subtle-2)] p-2 text-[12px]">{buf.join("\n")}</pre>,
      );
      continue;
    }
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) {
      const Tag = `h${h[1].length + 1}` as "h2" | "h3" | "h4";
      out.push(
        <Tag key={`h${out.length}`} className="mt-1 font-bold">{inline(h[2], `h${out.length}`)}</Tag>,
      );
      i += 1;
      continue;
    }
    if (/^[-*] /.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(<li key={items.length}>{inline(lines[i].slice(2), `l${out.length}.${items.length}`)}</li>);
        i += 1;
      }
      out.push(
        <ul key={`u${out.length}`} className="list-disc pl-5">{items}</ul>,
      );
      continue;
    }
    const buf: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#{1,3} |[-*] |```)/.test(lines[i]))
      buf.push(lines[i++]);
    out.push(
      <p key={`t${out.length}`}>{buf.map((l, j) => (
        <span key={j}>{j > 0 ? <br /> : null}{inline(l, `t${out.length}.${j}`)}</span>
      ))}</p>,
    );
  }
  return <div className="space-y-1 text-[13px] leading-relaxed">{out}</div>;
}

type Status = "loading" | "error" | "done";

/**
 * 文件预览模态：打开即按形态取内容（图片/不支持 → fetchFileBlobUrl 取 objectURL，
 * 文本/Markdown → fetchFileBlobText 取正文），loading|error|done 状态机，失败给原因 + 重试。
 * 换文件/重试时换 attempt 重跑；objectURL 在卸载/换源时 revoke（api.ts 约定调用方负责）。
 */
export function FilePreviewModal({ file, onClose }: { file: SharedFileMeta; onClose: () => void }) {
  const kind = kindOf(file);
  const [status, setStatus] = useState<Status>("loading");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, onClose);

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    setStatus("loading");
    setError("");
    (async () => {
      try {
        if (kind === "image" || kind === "download") {
          created = await fetchFileBlobUrl(file.id);
          if (cancelled) {
            // 等待期间已卸载/换源：补 revoke，不留孤儿 objectURL
            if (created && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(created);
            return;
          }
          setUrl(created);
        } else {
          const body = await fetchFileBlobText(file.id);
          if (cancelled) return;
          setText(body);
        }
        setStatus("done");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      if (created && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(created);
    };
  }, [file.id, kind, attempt]);

  let body: ReactNode;
  if (status === "loading") {
    body = <div className="py-8 text-center text-[13px] text-muted">加载中…</div>;
  } else if (status === "error") {
    body = (
      <div className="py-6 text-center">
        <div role="alert" className="mb-3 ui-body-sm text-[var(--danger)]">加载失败：{error}</div>
        <button
          type="button"
          onClick={() => setAttempt((a) => a + 1)}
          className="rounded-lg border border-line-soft px-3 py-1.5 text-[13px] shadow-card"
        >
          重试
        </button>
      </div>
    );
  } else if (kind === "image") {
    body = <img src={url} alt={file.name} className="mx-auto max-h-[64vh] max-w-full rounded-sm" />;
  } else if (kind === "markdown") {
    body = <MarkdownLite text={text} />;
  } else if (kind === "text") {
    body = (
      <pre className="whitespace-pre-wrap break-all rounded-sm bg-[var(--subtle-2)] p-3 text-[12px]">
        {text}
      </pre>
    );
  } else {
    body = (
      <div className="py-6 text-center">
        <div className="mb-3 text-[13px] text-muted">不支持内嵌预览（{file.mime}）</div>
        <a
          href={url}
          download={file.name}
          className="inline-block rounded-lg border border-line-soft px-3 py-1.5 text-[13px] shadow-card"
        >
          下载
        </a>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`预览 ${file.name}`}
        className="flex max-h-[80vh] w-[min(560px,92vw)] flex-col overflow-hidden rounded-xl border border-line-soft bg-[var(--surface)] shadow-card"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
          <span className="truncate text-[13px] font-bold">{file.name}</span>
          <button
            type="button"
            aria-label="关闭预览"
            onClick={onClose}
            className="shrink-0 rounded-sm p-1 text-muted hover:bg-[var(--subtle-3)] hover:text-ink"
          >
            <XIcon width={16} height={16} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{body}</div>
      </div>
    </div>
  );
}
