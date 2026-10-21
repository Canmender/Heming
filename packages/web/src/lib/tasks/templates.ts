import { create } from "zustand";
import {
  createDefaultStorage,
  isPlainObject,
  readJson,
  utf8Length,
  writeJson,
} from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import { MAX_PROMPT_CHARS } from "./store.js";

/**
 * 任务模板（本机）：把常用的任务目标存成可复用的条目，建任务时一键填入。
 *
 * 只存文本，不存执行结果——模板是「怎么问」，任务记录是「问完之后发生了什么」，
 * 两者分开放，模板才不会随任务淘汰一起丢。
 */

export const TASK_TEMPLATES_KEY = "heming.taskTemplates.v1";

/** 模板条数上限（超出淘汰最旧）。 */
export const MAX_TEMPLATES = 12;
/** 模板名长度。 */
export const MAX_TEMPLATE_NAME_CHARS = 40;
/** 整个键的字节上限（模板文本短，给不了任务区那么多）。 */
export const TEMPLATES_BYTE_LIMIT = Math.floor(128 * 1024);

export interface TaskTemplate {
  id: string;
  name: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
}

let seq = 0;

function newTemplateId(now: number): string {
  seq += 1;
  return `tpl-${now.toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 按码点截断（与任务区同口径，避免切坏代理对）。 */
function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** 名称归一：压平空白 + 截断。 */
export function templateName(raw: string): string {
  return clip(raw.replace(/\s+/g, " ").trim(), MAX_TEMPLATE_NAME_CHARS);
}

/** 从任务记录推默认名：取标题，去重名时由调用方加序号。 */
export function suggestTemplateName(prompt: string): string {
  const first = prompt.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return templateName(first) || "未命名模板";
}

/** 校验并归一一条模板；不合规返回 null（读盘时逐条丢弃）。 */
export function normalizeTemplate(raw: unknown): TaskTemplate | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  const name = templateName(typeof raw.name === "string" ? raw.name : "");
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!name || !prompt) return null;
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : Date.now();
  return {
    id: raw.id,
    name,
    prompt: clip(prompt, MAX_PROMPT_CHARS),
    createdAt,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : createdAt,
  };
}

/** 数量与字节双重淘汰：先按条数（保最新），再按字节从尾部砍。 */
export function pruneTemplates(
  templates: TaskTemplate[],
  limit = TEMPLATES_BYTE_LIMIT,
): TaskTemplate[] {
  const next = [...templates]
    .sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)
    .slice(0, MAX_TEMPLATES);
  let bytes = utf8Length(JSON.stringify(next));
  while (bytes > limit && next.length > 1) {
    next.pop();
    bytes = utf8Length(JSON.stringify(next));
  }
  if (bytes > limit) return [];
  return next;
}

/** 读模板列表：缺键/损坏回退空，结构不符的条目丢弃。 */
export function readTemplates(storage: StorageLike = createDefaultStorage()): TaskTemplate[] {
  return readJson(storage, TASK_TEMPLATES_KEY, [] as TaskTemplate[], (raw) => {
    if (!Array.isArray(raw)) return [];
    return pruneTemplates(raw.map(normalizeTemplate).filter((t): t is TaskTemplate => t !== null));
  });
}

export type SaveResult = { ok: true; template: TaskTemplate } | { ok: false; error: string };

interface TemplateState {
  templates: TaskTemplate[];
  /** 新增模板：名称/目标为空或同名则拒绝。 */
  save: (input: { name: string; prompt: string; now?: number }) => SaveResult;
  remove: (id: string) => void;
}

let storage: StorageLike | null = null;

function getStorage(): StorageLike {
  return (storage ??= createDefaultStorage());
}

/** 测试注入点：传 null 恢复默认（jsdom 的 localStorage）。 */
export function setTemplateStorage(next: StorageLike | null): void {
  storage = next;
}

function persist(templates: TaskTemplate[]): TaskTemplate[] {
  const pruned = pruneTemplates(templates);
  writeJson(getStorage(), TASK_TEMPLATES_KEY, pruned, TEMPLATES_BYTE_LIMIT);
  return pruned;
}

export const useTemplateStore = create<TemplateState>((set, get) => ({
  templates: readTemplates(),

  save: ({ name, prompt, now = Date.now() }) => {
    const cleanName = templateName(name);
    const cleanPrompt = prompt.trim();
    if (!cleanName) return { ok: false, error: "模板名称不能为空" };
    if (!cleanPrompt) return { ok: false, error: "任务目标为空，没什么可存的" };
    if (cleanPrompt.length > MAX_PROMPT_CHARS) {
      return { ok: false, error: `任务目标超过 ${MAX_PROMPT_CHARS} 字，请先精简` };
    }
    if (get().templates.some((t) => t.name === cleanName)) {
      return { ok: false, error: `已有同名模板「${cleanName}」` };
    }
    const template: TaskTemplate = {
      id: newTemplateId(now),
      name: cleanName,
      prompt: clip(cleanPrompt, MAX_PROMPT_CHARS),
      createdAt: now,
      updatedAt: now,
    };
    set({ templates: persist([template, ...get().templates]) });
    return { ok: true, template };
  },

  remove: (id) => {
    const next = get().templates.filter((t) => t.id !== id);
    if (next.length === get().templates.length) return;
    set({ templates: persist(next) });
  },
}));
