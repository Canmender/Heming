import { useEffect, useRef, useState } from "react";
import type { WsServerEvent } from "@heming/shared";
import { connectWs, type WsHandle } from "./ws.js";
import { useAuthStore } from "../store/auth.js";

/**
 * 桌宠的未读感知（d.53 第二期）。
 *
 * 与 d.39 的后台通道（`lib/backgroundMessages.ts`）的关系：那个通道服务于**应用壳**，
 * 复用了 chat store 的未读口径与系统通知入口，且约定「同一时刻只有一条后台连接」。
 * 桌宠窗口是独立渲染进程、没有 ChatPage、也**必须在主窗口关闭后继续工作**，
 * 所以它建自己的一条轻量连接，只做三件事：记未读数、记最近的来源会话、响应已读清零。
 *
 * ★ 三条边界（与 d.39 一致，不因为它是桌宠就放松）：
 *   1. 只感知**不解密正文**：只读 message 的 id / 会话 / 发送者，不碰 ciphertext；
 *   2. **不弹系统通知**：主窗口那边的 `notifyIncomingMessage` 已经负责提醒，
 *      桌宠再弹一次就是双份；这里只更新角标；
 *   3. 自己发的消息不计未读。
 */

export interface PetUnreadState {
  /** 会话 id → 未读条数（只记 > 0 的） */
  byConv: Record<string, number>;
  /** 最近一条未读的来源会话，点击角标时跳转用 */
  latestConvId: string | null;
}

export const EMPTY_UNREAD: PetUnreadState = Object.freeze({
  byConv: {},
  latestConvId: null,
});

/** 未读总数。 */
export function totalUnread(state: PetUnreadState): number {
  let sum = 0;
  for (const n of Object.values(state.byConv)) sum += n;
  return sum;
}

/**
 * 按一个服务端事件归约未读状态（纯函数，可单测）。
 *
 * @param state 当前状态
 * @param event 服务端事件
 * @param meId 当前用户 id；为 null（未登录）时一律不计数
 */
export function applyUnreadEvent(
  state: PetUnreadState,
  event: WsServerEvent,
  meId: string | null,
): PetUnreadState {
  if (!meId) return state;

  if (event.type === "message_new") {
    const m = event.message;
    // 自己发的：服务端会回推，但那是自己写的，不该让桌宠头上冒红点
    if (!m || m.senderId === meId) return state;
    const convId = m.conversationId;
    if (!convId) return state;
    return {
      byConv: { ...state.byConv, [convId]: (state.byConv[convId] ?? 0) + 1 },
      latestConvId: convId,
    };
  }

  if (event.type === "read_update") {
    // 只认「自己已读」：别人已读不影响我的未读
    if (event.userId !== meId) return state;
    if (!state.byConv[event.conversationId]) return state;
    const { [event.conversationId]: _removed, ...rest } = state.byConv;
    void _removed;
    // 被清掉的是当前跳转目标时，改指向剩下的任一未读会话（保持「有红点就有去处」）
    const remaining = Object.keys(rest);
    const latestConvId =
      state.latestConvId === event.conversationId
        ? (remaining[remaining.length - 1] ?? null)
        : state.latestConvId;
    return { byConv: rest, latestConvId };
  }

  // 撤回不是新消息：不清未读、不改跳转目标（与 d.39 同口径）
  return state;
}

/**
 * 桌宠窗口的未读订阅。
 *
 * @param enabled 是否启用（未登录 / 用户关掉桌宠时不连）
 */
export function usePetUnread(enabled: boolean): PetUnreadState & { total: number } {
  const [state, setState] = useState<PetUnreadState>(EMPTY_UNREAD);
  const meId = useAuthStore((s) => s.user?.id ?? null);
  /** 归约需要读到最新 meId，但换 meId 不该重连。 */
  const meIdRef = useRef(meId);
  meIdRef.current = meId;

  useEffect(() => {
    if (!enabled || !meId) return;
    let alive = true;
    const handle: WsHandle = connectWs({
      onEvent: (e) => {
        if (!alive) return;
        setState((prev) => applyUnreadEvent(prev, e, meIdRef.current));
      },
    });
    return () => {
      alive = false;
      handle.close();
    };
  }, [enabled, meId]);

  // 退出登录时清零，避免把上个账号的红点带给下一个
  useEffect(() => {
    if (!meId) setState(EMPTY_UNREAD);
  }, [meId]);

  return { ...state, total: totalUnread(state) };
}
