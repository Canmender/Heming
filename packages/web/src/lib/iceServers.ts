import { api } from "./api.js";

/**
 * ICE 服务器配置（d.30 · P0-2）。
 *
 * 服务端 `/api/ice-servers` 现在**要鉴权**（TURN 凭据不该对未登录者可读），
 * 所以 ICE 改由**渲染层自己拉**（渲染层本来就持有 token，`api()` 已带 Bearer 头）。
 *
 * 三段优先级（`getIceServers()`）：
 *   1. 模块缓存（本次登录拉到的服务端配置）；
 *   2. preload 注入（`window.__heming_ice_servers_get?.()`）——**兼容位，当前无注入方**：
 *      桌面主进程那条裸 fetch 本轮已删，preload 的注入通道保留只为不牵动兜底链；
 *   3. 公共 STUN 兜底。
 */

/** 服务端返回的一条 ICE 服务器配置（STUN 只有 urls，TURN 另有凭据）。 */
export interface IceServerEntry {
  urls: string;
  username?: string;
  credential?: string;
}

/** 公共 STUN 兜底：服务端不可达/未拉取成功时至少能穿透 NAT 打洞。 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.miwifi.com:3478" }];

/** 模块级缓存：拉取成功后的服务端配置（进程内有效，不落盘——TURN 凭据不写本机存储）。 */
let cached: IceServerEntry[] | null = null;

/**
 * 写入缓存（渲染层拉取成功后调用）。
 * 空列表视为无效（清空缓存 → 回落公共 STUN），避免服务端返回空数组把通话打成无 STUN。
 */
export function setIceServers(list: IceServerEntry[]): void {
  cached = list.length > 0 ? list.slice() : null;
}

/** 读取当前生效的 ICE 列表：模块缓存 → preload 注入（兼容位）→ 公共 STUN。 */
export function getIceServers(): RTCIceServer[] {
  if (cached && cached.length > 0) return cached as RTCIceServer[];
  if (typeof window !== "undefined") {
    // 兼容位：preload 暴露的注入通道（当前桌面主进程已不再注入，留着不牵动兜底链）
    const injected = (window as unknown as { __heming_ice_servers_get?: () => RTCIceServer[] })
      .__heming_ice_servers_get?.();
    if (injected && injected.length > 0) return injected;
  }
  return DEFAULT_ICE_SERVERS;
}

/**
 * 从服务端拉一次 ICE 配置。
 *
 * **静默失败**：401（token 失效）、网络错误、服务端返回空列表——都不抛，
 * 缓存保持原值、读取回落公共 STUN。理由：ICE 拉不到不该阻断登录或聊天主链路，
 * 公共 STUN 已经能覆盖绝大多数直连场景。
 */
export async function fetchIceServers(): Promise<void> {
  try {
    const body = await api<{ iceServers?: IceServerEntry[] }>("/api/ice-servers");
    const list = body?.iceServers;
    if (Array.isArray(list) && list.length > 0) setIceServers(list);
  } catch {
    /* 拉不到就用公共 STUN 兜底：通话弱一点，但不阻断主链路 */
  }
}
