/**
 * 文档解析：把用户选的文件变成可喂给模型 / 可渲染的文本。
 *
 * ## 为什么在前端解析（而不是服务端）
 *
 * 和鸣的附件是 **E2E 加密**的：服务端只存密文，密钥在客户端随消息走。
 * 服务端**没有**解密能力，也就无从解析。所以解析必须在渲染进程做，
 * 解析结果随消息重新加密上行——这条链路保证了「文件内容不经过明文服务端」。
 *
 * ## 为什么用 officeparser 而不是 pdfjs + mammoth + xlsx 三件套
 *
 * 它一个库覆盖 DOCX/XLSX/PPTX/ODT/ODP/ODS/PDF/RTF/CSV/EPUB，且能**直接转 Markdown**——
 * 正好接上现有渲染器（`MarkdownMessage`），表格、标题、列表都能还原成结构。
 * 三个库分摊下来体积更大、格式覆盖还更少。
 *
 * ## 为什么全部走动态 import
 *
 * 解析库加起来不小（PDF/Office 各自的解析器 + 解压 + 字体）。首屏根本用不到它们，
 * 打进主 bundle 会白白拖慢启动——这是 shiki 那次的教训（见 lib/markdown/highlight.ts）。
 * 这里所有重依赖都在函数内 `await import()`，只在实际解析某个文件时才加载。
 */

/** 解析结果的统一形状。 */
export interface ParsedDoc {
  /** 是否解析成功。失败时 `text` 为空、`error` 有说明。 */
  ok: boolean;
  /** 解析出的文本（Office/PDF 为 Markdown，纯文本类原文）。 */
  text: string;
  /** 来源类型，供界面显示。 */
  kind: "pdf" | "office" | "text" | "unsupported";
  /** 字符数（截断后的）。 */
  chars: number;
  /** 是否因超长被截断。 */
  truncated: boolean;
  /** 失败原因（ok=false 时有值）。 */
  error?: string;
}

/**
 * 单份文档的字符上限。
 *
 * 与消息正文上限（20000）对齐：附件文本要随消息上行，超了会被 schema 拒掉。
 * 取 16000 留出余量——还要拼文件名、引导语，不能顶格。
 */
export const MAX_DOC_CHARS = 16_000;

/** 能直接当文本读的扩展名。 */
const TEXT_EXTENSIONS = [
  "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml",
  "log", "ini", "toml", "sql",
  "js", "ts", "jsx", "tsx", "py", "go", "rs", "java", "c", "h", "cpp", "hpp",
  "css", "scss", "html", "htm", "sh", "bat", "ps1",
];

/** Office 类扩展名（交给 officeparser）。 */
const OFFICE_EXTENSIONS = ["docx", "xlsx", "pptx", "odt", "odp", "ods", "rtf", "epub"];

/**
 * `Promise.try` 兜底。
 *
 * pdfjs 内部用了 `Promise.try`——ES2025 才标准化的 API，Chromium 需 128+ 才内置。
 * 本项目用的 Electron 31 是 Chromium 126，**实测在真实应用里会
 * `Promise.try is not a function` 直接崩**（而且崩在 worker 线程，主线程的 polyfill 救不了）。
 *
 * ⚠️ **pdfjs-dist 必须锁在 4.x**：
 * - v4 的入口自带 `if (typeof Promise.try !== "function") { Promise.try = ... }` 兜底；
 * - v6 把这个兜底删了，装上去就是全局崩，且降级之外没有别的解法
 *   （legacy 构建里同样调 `Promise.try`）。
 *
 * 这段 polyfill 留着是第二道保险：主线程先补上，worker 由 v4 自带的兜底负责。
 * 升级 pdfjs 之前务必先在 Electron 里跑一遍真实 PDF——jsdom 单测发现不了这个问题。
 */
function ensurePromiseTry(): void {
  const target = Promise as unknown as { try?: unknown };
  if (typeof target.try === "function") return;
  target.try = function promiseTry<T>(fn: (...args: unknown[]) => T, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve) => resolve(fn(...args)));
  };
}

/**
 * 解析 PDF。
 *
 * ## 为什么不用 officeparser 的 PDF 支持
 *
 * 实测它会抛 `No "GlobalWorkerOptions.workerSrc" specified`——它把 pdfjs 内联打包了，
 * 却没配 worker 路径，而 worker 是 pdfjs 的必需项。这个错在真实浏览器里同样会出现，
 * 不是测试环境的问题。
 *
 * 所以 PDF 自己走 pdfjs-dist：worker 用 Vite 的 `new URL(..., import.meta.url)`
 * 交给构建器处理，路径由打包产物决定，不依赖库的默认值。
 */
async function parsePdf(blob: Blob): Promise<ParsedDoc> {
  try {
    ensurePromiseTry();
    const pdfjs = await import("pdfjs-dist");
    // Vite 会把 worker 作为一个独立资源打包，并把 URL 换成产物里的真实路径
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();

    const data = new Uint8Array(await blob.arrayBuffer());
    // pdfjs v6：销毁要用 loadingTask，不是 document 代理
    const loadingTask = pdfjs.getDocument({ data });
    const pdf = await loadingTask.promise;

    const parts: string[] = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      // pdfjs 给的是文字项流，按 item 拼回去；hasEOL 表示该换行了。
      // 不按坐标重排——那是版面还原的活，代价大且对「喂给模型」没有增益。
      let line = "";
      for (const item of content.items) {
        const textItem = item as { str?: string; hasEOL?: boolean };
        if (typeof textItem.str !== "string") continue;
        line += textItem.str;
        if (textItem.hasEOL) {
          parts.push(line);
          line = "";
        }
      }
      if (line) parts.push(line);
      parts.push(""); // 页与页之间留空行
    }
    await loadingTask.destroy();

    const raw = parts.join("\n");
    if (!raw.trim()) {
      return {
        ok: false,
        text: "",
        kind: "pdf",
        chars: 0,
        truncated: false,
        error: "PDF 里没有可提取的文字（可能是扫描件或纯图片）",
      };
    }
    const clamped = clamp(raw);
    return {
      ok: true,
      text: clamped.text,
      kind: "pdf",
      chars: clamped.text.length,
      truncated: clamped.truncated,
    };
  } catch (err) {
    return {
      ok: false,
      text: "",
      kind: "pdf",
      chars: 0,
      truncated: false,
      error: `PDF 解析失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

/** 按长度截断，并标注是否截断过。 */
function clamp(text: string): { text: string; truncated: boolean } {
  // 折掉行尾空白与连续空行：PDF/PPT 转出来的文本常有大量空白，白占上下文预算
  const normalized = text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= MAX_DOC_CHARS) {
    return { text: normalized, truncated: false };
  }
  return { text: normalized.slice(0, MAX_DOC_CHARS), truncated: true };
}

/**
 * 读出 Blob 的文本内容。
 *
 * 为什么要三级回退：`Blob.text()` 是较新的 API，**jsdom（测试环境）就没有实现**，
 * 直接调用会 `b.text is not a function`。而单元测试跑在 jsdom 里，
 * 不处理这一层就会出现「生产能跑、测试全红」的假象。
 *
 * 1. `blob.text()`（最快，现代运行时）；
 * 2. `FileReader`（老浏览器与 jsdom 都有）；
 * 3. `arrayBuffer` + `TextDecoder`（最后兜底）。
 */
async function readBlobText(blob: Blob): Promise<string> {
  const withText = blob as Blob & { text?: () => Promise<string> };
  if (typeof withText.text === "function") return withText.text();

  if (typeof FileReader !== "undefined") {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
      reader.readAsText(blob);
    });
  }

  const buffer = await blob.arrayBuffer();
  return new TextDecoder("utf-8").decode(buffer);
}

/**
 * 这个附件是否值得尝试解析成文本。
 *
 * 音频、视频、图片要排除掉：它们是**内容本身**（语音消息、照片），
 * 不是「装文字的容器」。早先没排除，用户发一条语音就会看到
 * 「暂不支持 .webm 格式」的警告——而那条语音本来就该原样播放，
 * 根本不需要什么文本提取。
 */
export function isDocumentLike(name: string, mime: string): boolean {
  if (/^(audio|video|image)\//i.test(mime)) return false;
  const ext = extensionOf(name);
  return TEXT_EXTENSIONS.includes(ext) || OFFICE_EXTENSIONS.includes(ext) || ext === "pdf";
}

/**
 * 解析一个文件。
 *
 * **不抛异常**：解析失败是常态（加密 PDF、损坏文件、扫描件无文字层），
 * 调用方要能拿到原因并显示，而不是让整条发送流程崩掉。
 *
 * @param blob 文件内容（已解密的原始字节）
 * @param name 文件名（用于判类型、也是模型理解内容的线索）
 */
export async function parseDocument(blob: Blob, name: string): Promise<ParsedDoc> {
  const ext = extensionOf(name);

  // 纯文本类：直接读，不需要任何解析库
  if (TEXT_EXTENSIONS.includes(ext)) {
    try {
      const raw = await readBlobText(blob);
      const clamped = clamp(raw);
      return {
        ok: true,
        text: clamped.text,
        kind: "text",
        chars: clamped.text.length,
        truncated: clamped.truncated,
      };
    } catch (err) {
      return {
        ok: false,
        text: "",
        kind: "text",
        chars: 0,
        truncated: false,
        error: `读取文本失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // PDF 走 pdfjs（officeparser 的 PDF 路径缺 worker 配置，见 parsePdf 注释）
  if (ext === "pdf") return parsePdf(blob);

  if (!OFFICE_EXTENSIONS.includes(ext)) {
    return {
      ok: false,
      text: "",
      kind: "unsupported",
      chars: 0,
      truncated: false,
      error: `暂不支持 .${ext || "未知"} 格式（支持 PDF、Word、Excel、PPT、RTF、EPUB 与文本类）`,
    };
  }

  try {
    // 动态导入：只在真要解析 Office 文档时才把解析器拉进来
    const { convert } = await import("officeparser/slim");
    const result = await convert(blob, "md");
    const raw = typeof result.value === "string" ? result.value : "";
    if (!raw.trim()) {
      return {
        ok: false,
        text: "",
        kind: "office",
        chars: 0,
        truncated: false,
        error: "文档里没有可提取的文字（可能是纯图片内容）",
      };
    }
    const clamped = clamp(raw);
    return {
      ok: true,
      text: clamped.text,
      kind: "office",
      chars: clamped.text.length,
      truncated: clamped.truncated,
    };
  } catch (err) {
    return {
      ok: false,
      text: "",
      kind: "office",
      chars: 0,
      truncated: false,
      error: `解析失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 把「文件名 + 文本」包成给模型的片段。
 *
 * 刻意写清「以下是文件内容」而不是把原文直接倒进去：
 * 模型需要知道这段文字的边界与来源，否则容易把文件内容当成用户的话来回应。
 */
export function docFileBlock(name: string, text: string, truncated = false): string {
  const note = truncated ? "（内容较长，已截取部分）" : "";
  return `【附件：${name}${note}】\n${text}\n【附件结束】`;
}

/**
 * 把解析结果拼成给模型的提示词片段。
 *
 * 为什么单独抽出来：消息历史里有多个附件、未来可能还有图表/网页快照，
 * 拼装格式要统一，否则模型看到的上下文会一次一个样。
 */
export function docToPromptBlock(name: string, doc: ParsedDoc): string {
  if (!doc.ok || !doc.text) return "";
  return docFileBlock(name, doc.text, doc.truncated);
}