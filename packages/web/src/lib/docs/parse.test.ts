import { describe, it, expect, vi } from "vitest";
import { parseDocument, docToPromptBlock, isDocumentLike, MAX_DOC_CHARS } from "./parse";

/**
 * 文档解析的契约。
 *
 * 重点不是「能不能解析某个真实文件」（那依赖具体格式实现），而是：
 * 1. 类型分派对不对（文本 / Office / 不支持）；
 * 2. 失败时**不抛异常**、给出人话原因；
 * 3. 超长截断，且明确标注截断过。
 *
 * 真实的 PDF/DOCX 解析在 `parse.integration.test.ts` 里用真文件验证。
 */

/** 造一个 Blob（jsdom 的 Blob 支持 text()）。 */
function blobOf(content: string, type = "text/plain"): Blob {
  return new Blob([content], { type });
}

describe("parseDocument：文本类文件", () => {
  it("直接读出原文", async () => {
    const doc = await parseDocument(blobOf("# 标题\n\n正文内容"), "note.md");
    expect(doc.ok).toBe(true);
    expect(doc.kind).toBe("text");
    expect(doc.text).toContain("正文内容");
    expect(doc.chars).toBeGreaterThan(0);
    expect(doc.truncated).toBe(false);
  });

  it("CSV / 代码 / 日志都按文本处理", async () => {
    for (const name of ["data.csv", "main.ts", "app.log", "conf.yaml"]) {
      const doc = await parseDocument(blobOf("a,b\n1,2"), name);
      expect(doc.ok, name).toBe(true);
      expect(doc.kind, name).toBe("text");
    }
  });

  it("超长文本截断到上限并标注", async () => {
    const long = "字".repeat(MAX_DOC_CHARS + 500);
    const doc = await parseDocument(blobOf(long), "long.txt");
    expect(doc.ok).toBe(true);
    expect(doc.truncated).toBe(true);
    expect(doc.chars).toBeLessThanOrEqual(MAX_DOC_CHARS);
  });

  it("折掉行尾空白与连续空行（PDF 转出的文本常有大量空白）", async () => {
    const doc = await parseDocument(blobOf("第一行   \n\n\n\n第二行  "), "x.txt");
    expect(doc.text).toBe("第一行\n\n第二行");
  });
});

describe("parseDocument：不支持的类型", () => {
  it("未知扩展名给出明确说明，不抛异常", async () => {
    const doc = await parseDocument(blobOf("x"), "archive.zip");
    expect(doc.ok).toBe(false);
    expect(doc.kind).toBe("unsupported");
    expect(doc.error).toContain("暂不支持");
    expect(doc.error).toContain("zip");
  });

  it("没有扩展名也不崩", async () => {
    const doc = await parseDocument(blobOf("x"), "noext");
    expect(doc.ok).toBe(false);
    expect(doc.kind).toBe("unsupported");
  });
});

describe("parseDocument：Office/PDF", () => {
  it("损坏的 docx 返回失败原因，而不是抛异常", async () => {
    // 一个不是合法 zip 的假 docx
    const doc = await parseDocument(blobOf("这不是一个真的 docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "broken.docx");
    expect(doc.ok).toBe(false);
    expect(doc.kind).toBe("office");
    expect(doc.error).toBeTruthy();
  });

  it("空 PDF 报「没有可提取的文字」", async () => {
    const doc = await parseDocument(blobOf("", "application/pdf"), "empty.pdf");
    expect(doc.kind).toBe("pdf");
    // 空字节的 PDF 解析会失败，但要落在「解析失败」或「没有文字」这两类可读原因上
    expect(doc.ok).toBe(false);
    expect(doc.error).toBeTruthy();
  });
});

describe("isDocumentLike：哪些附件该走文本提取", () => {
  it("文档类要走", () => {
    expect(isDocumentLike("报告.pdf", "application/pdf")).toBe(true);
    expect(isDocumentLike("方案.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
    expect(isDocumentLike("数据.xlsx", "application/vnd.ms-excel")).toBe(true);
    expect(isDocumentLike("笔记.md", "text/markdown")).toBe(true);
    expect(isDocumentLike("code.ts", "")).toBe(true);
  });

  it("音频/视频/图片不走（它们本身就是内容，不是装文字的容器）", () => {
    // 这条来自真实缺陷：发语音会弹「不支持 .webm 格式」的警告
    expect(isDocumentLike("voice.webm", "audio/webm")).toBe(false);
    expect(isDocumentLike("clip.mp4", "video/mp4")).toBe(false);
    expect(isDocumentLike("photo.png", "image/png")).toBe(false);
    // 即使扩展名看起来像文档，mime 说明是媒体也不解析
    expect(isDocumentLike("x.txt", "audio/mpeg")).toBe(false);
  });

  it("未知类型不走（避免无谓的解析尝试与误导性提示）", () => {
    expect(isDocumentLike("archive.zip", "application/zip")).toBe(false);
    expect(isDocumentLike("noext", "")).toBe(false);
  });
});

describe("docToPromptBlock", () => {
  it("成功时包出清晰的边界，模型能分清文件内容与用户的话", () => {
    const block = docToPromptBlock("方案.md", {
      ok: true, text: "内容", kind: "text", chars: 2, truncated: false,
    });
    expect(block).toContain("【附件：方案.md】");
    expect(block).toContain("内容");
    expect(block).toContain("【附件结束】");
  });

  it("截断时说明已截取", () => {
    const block = docToPromptBlock("长文档.pdf", {
      ok: true, text: "内容", kind: "pdf", chars: 100, truncated: true,
    });
    expect(block).toContain("已截取");
  });

  it("解析失败时返回空串（不要把失败信息当文件内容喂给模型）", () => {
    expect(docToPromptBlock("坏.docx", {
      ok: false, text: "", kind: "office", chars: 0, truncated: false, error: "解析失败",
    })).toBe("");
  });
});