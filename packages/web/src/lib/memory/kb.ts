import type { StorageLike } from "./types.js";
import { createDefaultStorage, readJson, writeJson } from "./storage.js";

/**
 * 个人知识库（`heming.kb.v1`）：本机条目 + 从云端共享库收进来的引用。
 * 与三层记忆分开存放——知识库是「用户显式收藏的资料」，不参与自动沉淀与淘汰。
 */

export const KB_KEY = "heming.kb.v1";

export type KnowledgeSource = "manual" | "cloud";

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  source: KnowledgeSource;
  /** 来源为云端共享时记录原文件 id，用于去重。 */
  cloudId?: string;
  createdAt: string;
  updatedAt: string;
}

function pickKnowledge(raw: unknown): KnowledgeEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: KnowledgeEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.title !== "string" || typeof row.content !== "string") {
      continue;
    }
    const source: KnowledgeSource = row.source === "cloud" ? "cloud" : "manual";
    const createdAt = typeof row.createdAt === "string" ? row.createdAt : new Date(0).toISOString();
    out.push({
      id: row.id,
      title: row.title.slice(0, 120),
      content: row.content.slice(0, 2000),
      tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
      source,
      ...(source === "cloud" && typeof row.cloudId === "string" ? { cloudId: row.cloudId } : {}),
      createdAt,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : createdAt,
    });
  }
  return out;
}

let idSeq = 0;

function newId(nowMs: number): string {
  idSeq += 1;
  return `k-${nowMs.toString(36)}-${idSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class KnowledgeBase {
  private readonly storage: StorageLike;
  private readonly now: () => number;
  private entries: KnowledgeEntry[];

  constructor(storage?: StorageLike, now?: () => number) {
    this.storage = storage ?? createDefaultStorage();
    this.now = now ?? (() => Date.now());
    this.entries = readJson(this.storage, KB_KEY, [], pickKnowledge);
  }

  /** 最新在先。 */
  list(): KnowledgeEntry[] {
    return [...this.entries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  hasCloud(cloudId: string): boolean {
    return this.entries.some((entry) => entry.source === "cloud" && entry.cloudId === cloudId);
  }

  add(input: { title: string; content: string; tags?: string[] }): KnowledgeEntry {
    const nowIso = new Date(this.now()).toISOString();
    const entry: KnowledgeEntry = {
      id: newId(this.now()),
      title: String(input.title ?? "").trim().slice(0, 120),
      content: String(input.content ?? "").trim().slice(0, 2000),
      tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
      source: "manual",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.entries = [...this.entries, entry];
    this.save();
    return entry;
  }

  /** 云端共享条目入本机知识库：同 cloudId 幂等（已存在返回 null）。 */
  addCloud(input: {
    cloudId: string;
    title: string;
    content: string;
    tags?: string[];
  }): KnowledgeEntry | null {
    if (!input.cloudId || this.hasCloud(input.cloudId)) return null;
    const nowIso = new Date(this.now()).toISOString();
    const entry: KnowledgeEntry = {
      id: newId(this.now()),
      title: String(input.title ?? "").trim().slice(0, 120),
      content: String(input.content ?? "").trim().slice(0, 2000),
      tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
      source: "cloud",
      cloudId: input.cloudId,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.entries = [...this.entries, entry];
    this.save();
    return entry;
  }

  remove(id: string): void {
    this.entries = this.entries.filter((entry) => entry.id !== id);
    this.save();
  }

  private save(): void {
    writeJson(this.storage, KB_KEY, this.entries);
  }
}

/** 模块级单例：记忆页默认使用（localStorage 不可用时自动降级纯内存）。 */
export const knowledgeBase = new KnowledgeBase();
