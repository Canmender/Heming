import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  VISION_MAX_BYTES,
  VISION_MAX_IMAGES,
  attachImageParts,
  blobToBase64,
  clearVisionImageCache,
  isVisionImage,
  visionImageDataUrl,
  type HistoryRow,
  type VisionFile,
} from "./history.js";
import { downloadEncryptedFile, fetchFileBlobUrl } from "../api.js";

vi.mock("../api.js", () => ({
  downloadEncryptedFile: vi.fn(),
  fetchFileBlobUrl: vi.fn(),
}));

const png: VisionFile = { id: "f1", name: "cat.png", mime: "image/png", size: 10, key: "k1" };

const rows = (n: number): HistoryRow[] =>
  Array.from({ length: n }, (_, i) => ({ role: "user" as const, content: `第${i}条` }));

describe("isVisionImage", () => {
  it("图片类型 + 非空体积 + 有 id 才算", () => {
    expect(isVisionImage(png)).toBe(true);
  });

  it("非图片、0 字节、超限、缺 id 都不算", () => {
    expect(isVisionImage({ ...png, mime: "text/plain" })).toBe(false);
    expect(isVisionImage({ ...png, mime: "" })).toBe(false);
    expect(isVisionImage({ ...png, size: 0 })).toBe(false);
    expect(isVisionImage({ ...png, size: VISION_MAX_BYTES + 1 })).toBe(false);
    expect(isVisionImage({ ...png, id: "" })).toBe(false);
    expect(isVisionImage(null)).toBe(false);
    expect(isVisionImage(undefined)).toBe(false);
  });

  it("上限本身是允许的（不差一字节）", () => {
    expect(isVisionImage({ ...png, size: VISION_MAX_BYTES })).toBe(true);
  });
});

describe("blobToBase64", () => {
  it("转出标准 base64，不带 data: 前缀", async () => {
    expect(await blobToBase64(new Blob(["img"]))).toBe("aW1n");
  });

  it("超过分块阈值也对（分块拼接不丢字节）", async () => {
    const bytes = new Uint8Array(70_000); // > 0x8000
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const b64 = await blobToBase64(new Blob([bytes]));
    const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(back).toEqual(bytes);
  });
});

describe("attachImageParts", () => {
  it("只挂到对应行，正文保留，返回新数组不改入参", async () => {
    const source = rows(2);
    const out = await attachImageParts(
      source,
      [{ rowIndex: 1, file: png }],
      async () => "aW1n",
    );
    expect(out[1].contentParts).toEqual([
      { type: "text", text: "第1条" },
      { type: "image", mime: "image/png", data: "aW1n" },
    ]);
    expect(out[0].contentParts).toBeUndefined();
    expect(source[1].contentParts).toBeUndefined(); // 入参未被原地改
    expect(out).not.toBe(source);
  });

  it("空正文用「（图片：文件名）」占位（纯图片消息也要有文字可显示）", async () => {
    const out = await attachImageParts(
      [{ role: "user", content: "" }],
      [{ rowIndex: 0, file: png }],
      async () => "aW1n",
    );
    expect(out[0].content).toBe("（图片：cat.png）");
    expect(out[0].contentParts?.[0]).toEqual({ type: "text", text: "（图片：cat.png）" });
  });

  it("超过张数上限时只带最近几张", async () => {
    const slots = Array.from({ length: VISION_MAX_IMAGES + 2 }, (_, i) => ({
      rowIndex: i,
      file: { ...png, id: `f${i}` },
    }));
    const seen: string[] = [];
    const out = await attachImageParts(rows(slots.length), slots, async (f) => {
      seen.push(f.id);
      return "aW1n";
    });
    expect(seen).toEqual(["f2", "f3", "f4", "f5"]); // 丢掉最早的两张
    expect(out.slice(0, 2).every((r) => !r.contentParts)).toBe(true);
    expect(out.slice(2).every((r) => r.contentParts?.length === 2)).toBe(true);
  });

  it("越界/负数/非整数的下标先被过滤，不会越界写", async () => {
    const out = await attachImageParts(
      rows(2),
      [
        { rowIndex: -1, file: png },
        { rowIndex: 9, file: png },
        { rowIndex: 1.5, file: png },
      ],
      async () => "aW1n",
    );
    expect(out.every((r) => !r.contentParts)).toBe(true);
  });

  it("某张加载失败不影响其它图片与正文", async () => {
    const out = await attachImageParts(
      rows(2),
      [
        { rowIndex: 0, file: { ...png, id: "bad" } },
        { rowIndex: 1, file: png },
      ],
      async (f) => {
        if (f.id === "bad") throw new Error("解密失败");
        return "aW1n";
      },
    );
    expect(out[0].content).toBe("第0条");
    expect(out[0].contentParts).toBeUndefined();
    expect(out[1].contentParts).toHaveLength(2);
  });

  it("加载器返回 null 同样跳过", async () => {
    const out = await attachImageParts(rows(1), [{ rowIndex: 0, file: png }], async () => null);
    expect(out[0].contentParts).toBeUndefined();
  });

  it("没有可用图片时原样返回（不白拷贝）", async () => {
    const source = rows(1);
    expect(await attachImageParts(source, [], async () => "aW1n")).toBe(source);
  });
});

describe("visionImageDataUrl", () => {
  const download = vi.mocked(downloadEncryptedFile);
  const legacy = vi.mocked(fetchFileBlobUrl);

  beforeEach(() => {
    vi.restoreAllMocks();
    clearVisionImageCache();
    download.mockReset();
    legacy.mockReset();
  });

  it("加密附件解密后转 base64", async () => {
    download.mockResolvedValue(new Blob(["img"]));
    await expect(visionImageDataUrl(png)).resolves.toBe("aW1n");
    expect(download).toHaveBeenCalledWith("f1", "k1", "image/png");
  });

  it("同一附件只解密一次（后续轮次走缓存）", async () => {
    download.mockResolvedValue(new Blob(["img"]));
    await visionImageDataUrl(png);
    await visionImageDataUrl(png);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("失败返回 null 且不缓存（下一轮会重试）", async () => {
    download.mockRejectedValue(new Error("boom"));
    await expect(visionImageDataUrl(png)).resolves.toBeNull();
    download.mockResolvedValue(new Blob(["img"]));
    await expect(visionImageDataUrl(png)).resolves.toBe("aW1n");
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("超过体积上限不发送", async () => {
    download.mockResolvedValue(new Blob([new Uint8Array(VISION_MAX_BYTES + 1)]));
    await expect(visionImageDataUrl(png)).resolves.toBeNull();
  });

  it("旧版明文附件：拿 blob URL 读回字节并释放", async () => {
    legacy.mockResolvedValue("blob:old-1");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    // jsdom 的 Response 会把 Blob body 变成 "[object Blob]"，这里只关心 blob() 的结果
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      blob: async () => new Blob(["img"]),
    } as Response);
    await expect(visionImageDataUrl({ ...png, key: undefined })).resolves.toBe("aW1n");
    expect(legacy).toHaveBeenCalledWith("f1");
    expect(revoke).toHaveBeenCalledWith("blob:old-1");
  });

  it("缓存条数超上限时丢最旧的，不让图片把内存吃满", async () => {
    download.mockResolvedValue(new Blob(["img"]));
    for (let i = 0; i < VISION_MAX_IMAGES * 2 + 1; i++) {
      await visionImageDataUrl({ ...png, id: `f${i}` });
    }
    expect(download).toHaveBeenCalledTimes(VISION_MAX_IMAGES * 2 + 1);
    await visionImageDataUrl({ ...png, id: "f0" }); // 已被挤出缓存 → 重新读
    expect(download).toHaveBeenCalledTimes(VISION_MAX_IMAGES * 2 + 2);
  });
});
