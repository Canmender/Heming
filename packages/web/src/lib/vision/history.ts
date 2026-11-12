/**
 * 视觉附件：把聊天历史里的图片变成模型能读的内容片。
 *
 * 三条边界：
 * - **只有支持视觉的模型才附图片**（能力表说了算，未知模型按不支持处理）；
 * - 图片必须在本地解密后转 base64——服务端只存密文，供应商请求直连，不经过和鸣服务端；
 * - 历史里的图片数量与体积都要封顶：30 条历史里可能塞满图，全带上会撞供应商上限，
 *   也会让每轮请求慢到不可用。
 */

import { downloadEncryptedFile, fetchFileBlobUrl } from "../api.js";
import type { ContentPart } from "../llmClient.js";

/** 一次请求最多带几张历史图片（取最近的若干张）。 */
export const VISION_MAX_IMAGES = 4;

/** 单张图片上限：超过就不发（base64 还会再涨约 1/3）。 */
export const VISION_MAX_BYTES = 4 * 1024 * 1024;

export interface VisionFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  key?: string;
}

/** 历史里某一行对应的图片（rowIndex 指向 rows 下标）。 */
export interface VisionImageSlot {
  rowIndex: number;
  file: VisionFile;
}

export interface HistoryRow {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  contentParts?: ContentPart[];
  /**
   * 历史里的工具调用（跟本轮请求里的形状一致）。
   *
   * ★ 以前历史只保留 user/assistant 的**文本**，工具调用与结果全被丢掉：
   * 模型回看上一轮只知道「我说过一句话」，不知道自己查过什么、拿到什么，
   * 于是重复调用同一个工具、或者把已经核实过的事实当成没结论重新猜
   * （就是用户说的「逻辑链断了」）。
   */
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  /** role=tool 时对应哪次调用（必须与 tool_calls 的 id 对得上，否则供应商 400）。 */
  tool_call_id?: string;
  /** role=tool 时的工具名（部分供应商要求）。 */
  name?: string;
}

/** 能不能当图片发给模型：类型对、体积在限内（0 字节视为坏文件）。 */
export function isVisionImage(file: VisionFile | undefined | null): file is VisionFile {
  if (!file) return false;
  if (!file.mime?.startsWith("image/")) return false;
  if (!(file.size > 0) || file.size > VISION_MAX_BYTES) return false;
  return Boolean(file.id);
}

/** Blob → base64（不带 `data:` 前缀；供应商各自组装外层）。分块避免大文件爆栈。 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 把图片片挂进历史行（纯逻辑，加载器注入以便单测）。
 *
 * 返回新数组，不原地改入参：历史对象可能被上下文预算层复用。
 * 加载失败的那张直接跳过——不能让一张坏图拖垮整轮回答。
 */
export async function attachImageParts(
  rows: HistoryRow[],
  images: VisionImageSlot[],
  load: (file: VisionFile) => Promise<string | null>,
): Promise<HistoryRow[]> {
  const usable = images
    .filter((s) => Number.isInteger(s.rowIndex) && s.rowIndex >= 0 && s.rowIndex < rows.length)
    .slice(-VISION_MAX_IMAGES);
  if (!usable.length) return rows;
  const loaded = await Promise.all(
    usable.map(async (slot) => ({
      ...slot,
      data: await load(slot.file).catch(() => null),
    })),
  );
  const out = rows.map((r) => ({ ...r }));
  for (const item of loaded) {
    if (!item.data) continue;
    const row = out[item.rowIndex];
    const text = row.content;
    const parts: ContentPart[] = [
      { type: "text", text: text || `（图片：${item.file.name}）` },
      { type: "image", mime: item.file.mime, data: item.data },
    ];
    row.content = text || `（图片：${item.file.name}）`;
    row.contentParts = parts;
  }
  return out;
}

/** 图片 data 缓存：同一附件在后续轮次里只解密读一次。 */
const imageCache = new Map<string, Promise<string | null>>();

/** 取图片 base64（带缓存）；失败返回 null（下次轮次重试）。 */
export function visionImageDataUrl(file: VisionFile): Promise<string | null> {
  const hit = imageCache.get(file.id);
  if (hit) return hit;
  const task = (async () => {
    let blob: Blob;
    if (file.key) {
      blob = await downloadEncryptedFile(file.id, file.key, file.mime);
    } else {
      // 旧版明文附件：先拿鉴权 blob URL 再读回字节，读完立刻释放。
      const url = await fetchFileBlobUrl(file.id);
      try {
        blob = await (await fetch(url)).blob();
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    if (blob.size > VISION_MAX_BYTES) return null;
    return await blobToBase64(blob);
  })()
    .catch(() => null) // 解密/下载失败不外抛：整轮回答不因一张坏图失败
    .then((data) => {
      if (!data) imageCache.delete(file.id); // 失败不缓存，下一轮再试
      return data;
    });
  imageCache.set(file.id, task);
  // 缓存按最近使用封顶：超了丢最旧的，不让图片把内存吃满。
  if (imageCache.size > VISION_MAX_IMAGES * 2) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined && oldest !== file.id) imageCache.delete(oldest);
  }
  return task;
}

/** 测试/退出会话时清缓存。 */
export function clearVisionImageCache(): void {
  imageCache.clear();
}
