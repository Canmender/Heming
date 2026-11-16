/**
 * 订阅「当前会话的任务清单」的 React hook（d.158 起清单要渲染进输入栏）。
 *
 * 为什么不直接在组件里 `getTodos()`：store 是模块级内存 + localStorage，
 * 模型调用 `todo_write` 的时机在流式过程中，组件不会因为 store 变了自动重渲。
 * 这里用 useEffect 订阅 + 首次挂载同步读，保证「工具刚写完，输入栏上方就出现清单」。
 */
import { useEffect, useState } from "react";
import { getTodos, subscribeTodos, type TodoItem } from "./store.js";

/** 某个会话的清单（会话切换时重新读；别的会话变更不触发重算）。 */
export function useTodos(conversationId: string | undefined): TodoItem[] {
  const [items, setItems] = useState<TodoItem[]>(() =>
    conversationId ? getTodos(conversationId) : [],
  );

  useEffect(() => {
    const read = () => setItems(conversationId ? getTodos(conversationId) : []);
    // 挂载时补读一次：useState 初始化与 effect 之间 store 可能已经变了（流式里正好写清单）。
    read();
    return subscribeTodos((changed) => {
      if (changed && conversationId && changed !== conversationId) return;
      read();
    });
  }, [conversationId]);

  return items;
}
