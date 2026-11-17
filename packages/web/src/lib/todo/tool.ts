/**
 * `todo_write`：让模型把多步计划写下来、并在每一步更新（DSH `tool-todo` 的移植）。
 *
 * 为什么一个「只写本地清单」的工具值得单独存在：
 * - 长任务失败往往不是模型不会做，而是**它忘了自己做到哪**：上下文被压缩、工具轮次用尽、
 *   用户中途插话，计划就散了。清单是模型唯一能「读回自己承诺过什么」的地方。
 * - 清单对用户可见：一次调用就是一次进度汇报（`进度：2/5 已完成`），
 *   比每步一段「我接下来要……」更可核对。
 *
 * 语义与 DSH 保持一致：**整份替换**、三态（pending / in_progress / completed）、
 * 同一时刻只允许一条 `in_progress`（并行子代理那是另一套，这里没有）。
 *
 * 风险等级是 `read`：它不动用户的文件、不改配置、不产生外部副作用，只是记录计划；
 * 让「写一份计划」也弹确认卡，只会把确认卡变成噪音。
 */

import type { ToolBridge } from "../agentStream.js";
import {
  MAX_TODOS,
  TODO_CONTENT_MAX,
  formatTodos,
  getTodos,
  setTodos,
  type TodoItem,
  type TodoStatus,
} from "./store.js";

/** 工具名：`todo_write`，与 DSH 的 `write`-style 命名一致（动作在前）。 */
export const TODO_TOOL = "todo_write";

/** 允许的状态值（运行时校验用；schema 里也写了同一份枚举）。 */
const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

/** 工具描述：照 DSH 的三段式（做什么 / 什么时候做 / 什么时候标完成），中文重写。 */
const DESCRIPTION = [
  "记录并更新任务清单，用来规划多步工作、向用户展示进度；单步的小事不要调用。",
  "动手前先把每个具体步骤写成一条 todo；工作期间把正在做的那条标成 in_progress（只能有一条），做完立刻标 completed。",
  "每次调用都要给**完整清单**（整份替换，不是增量）：可以新增、删除、改写条目、改状态。",
  `最多 ${MAX_TODOS} 条、每条不超过 ${TODO_CONTENT_MAX} 字；内容要具体（「读 src/a.ts 的入口函数」好过「看一下代码」）。`,
].join("");

/** 一次调用解析后的结果：要么是规范化清单，要么是一句能直接回给模型的错误。 */
type ParsedTodos = { ok: true; items: TodoItem[] } | { ok: false; error: string };

/**
 * 校验并规范化模型给的列表。
 *
 * 校验口径与 DSH 对齐：内容去空白后非空、不重复、长度受限、状态合法、最多一条进行中。
 * 错误信息要**指到具体那一条**（`第 3 条`），模型才知道改哪里，而不是整份重来。
 */
export function parseTodoArgs(raw: unknown): ParsedTodos {
  if (!Array.isArray(raw)) return { ok: false, error: "todos 必须是数组" };
  if (raw.length > MAX_TODOS) {
    return { ok: false, error: `最多 ${MAX_TODOS} 条，当前 ${raw.length} 条；请合并或拆阶段` };
  }
  const items: TodoItem[] = [];
  const seen = new Set<string>();
  let inProgress = 0;
  for (const [index, entry] of raw.entries()) {
    const label = `第 ${index + 1} 条`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `${label}不是对象` };
    }
    const record = entry as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) return { ok: false, error: `${label}缺 content（内容不能为空）` };
    if (content.length > TODO_CONTENT_MAX) {
      return { ok: false, error: `${label}内容 ${content.length} 字，超过 ${TODO_CONTENT_MAX} 字上限` };
    }
    if (seen.has(content)) return { ok: false, error: `${label}与前面重复：「${content}」` };
    seen.add(content);
    const status = record.status;
    if (typeof status !== "string" || !STATUSES.includes(status as TodoStatus)) {
      return { ok: false, error: `${label}的 status 必须是 pending / in_progress / completed` };
    }
    if (status === "in_progress") inProgress += 1;
    items.push({ content, status: status as TodoStatus });
  }
  if (inProgress > 1) {
    return { ok: false, error: "同一时刻只能有一条 in_progress，请把其余改成 pending" };
  }
  return { ok: true, items };
}

/**
 * 执行一次 `todo_write`：校验 → 落会话级清单 → 回显整份清单。
 *
 * 回显整份而不是「已更新」：模型下一步要靠这份回显确认自己没漏条目，
 * 用户也能直接从工具卡里看到进度。
 */
export function runTodoWrite(rawArgs: unknown, conversationId: string): { text: string; ok: boolean } {
  const parsed = parseTodoArgs(rawArgs);
  if (!parsed.ok) {
    return {
      text: `${parsed.error}\n没有改动现有清单。当前清单：\n${formatTodos(getTodos(conversationId))}`,
      ok: false,
    };
  }
  setTodos(conversationId, parsed.items);
  if (parsed.items.length === 0) {
    return { text: "已清空任务清单。", ok: true };
  }
  return { text: `已更新任务清单。\n${formatTodos(parsed.items)}`, ok: true };
}

/**
 * 组装 `/todo_write` 的工具桥。
 *
 * `conversationId` 由能力注册表传进来（与文件工具、HITL 的会话口径一致），
 * 所以不同会话的计划天然隔离；没有会话 id 时不提供工具（而不是写进一个全局桶）。
 */
export function buildTodoToolBridge(deps: { conversationId: string }): ToolBridge | null {
  if (!deps.conversationId) return null;
  const conversationId = deps.conversationId;
  return {
    tools: [
      {
        type: "function" as const,
        function: {
          name: TODO_TOOL,
          description: DESCRIPTION,
          parameters: {
            type: "object",
            properties: {
              todos: {
                type: "array",
                description: "完整任务清单（整份替换）",
                items: {
                  type: "object",
                  properties: {
                    content: { type: "string", description: "一步具体做什么" },
                    status: {
                      type: "string",
                      enum: ["pending", "in_progress", "completed"],
                      description: "pending 待开始 / in_progress 正在做（只能一条） / completed 已完成",
                    },
                  },
                  required: ["content", "status"],
                },
              },
            },
            required: ["todos"],
          },
        },
      },
    ],
    // 只写本地计划、无外部副作用：确认卡不该被「写计划」刷屏。
    // d.207：清单是长任务的进度基线，声明成核心工具，别被按需发现挤掉。
    meta: (name) =>
      name === TODO_TOOL ? { risk: "read" as const, displayName: "更新任务清单", core: true } : undefined,
    execute: async (call) => {
      if (call.name !== TODO_TOOL) {
        return { text: `未知工具 ${call.name}`, ok: false };
      }
      let args: unknown;
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
        return { text: "参数不是合法 JSON，请检查后重试。", ok: false };
      }
      const todos = args && typeof args === "object" ? (args as { todos?: unknown }).todos : undefined;
      const result = runTodoWrite(todos, conversationId);
      return result.ok ? { text: result.text, ok: true } : { text: result.text, ok: false };
    },
  };
}
