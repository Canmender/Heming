import { useEffect } from "react";
import { connectWs } from "./ws.js";
import { useAuthStore } from "../store/auth.js";

/**
 * 应用级「在场」连接（d.88）。
 *
 * 服务端的在线判定只看 `/api/ws` 有没有已鉴权的 socket（`presence.ts`）。而此前只有
 * **打开某个智能体会话**才建 WS——于是人明明在团队页/首页，团队名册却把他算成离线，
 * 页头「0 人在线」和自己那行「刚刚活跃」同屏自相矛盾（团队审计 P1-3）。
 *
 * 这里在登录后维持一条**只用于在场**的轻连接：
 * - 不消费业务事件（各页面自己按需建连），只保住 socket；
 * - 登出/卸载即关闭；
 * - 断线重连由 `connectWs` 自己负责（1s→2s→…→30s），不需要上层再写一套。
 *
 * 为什么不改服务端 presence 口径：在线=当前进程内有连接，是既有语义；
 * 客户端该做的是「人在应用里就连着」，而不是把「在线」重新定义成「最近活跃」。
 */
export function useAppPresence(enabled = true): void {
  // 只看 token，不看 status：启动时会话恢复会短暂经过 pending，若依赖 status
  // 就会在启动瞬间「连上→断开→再连上」，多一次无意义的重连（也把「离开必关」的配平搅乱）。
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!enabled || !token) return;
    const handle = connectWs({
      // 只保活：业务事件由页面自己的连接处理，这里收到什么都忽略。
      onEvent: () => {},
    });
    return () => handle.close();
  }, [token, enabled]);
}
