import { create } from "zustand";
import {
  login as apiLogin,
  fetchMe,
  updateProfile as apiUpdateProfile,
  setToken,
  getToken,
  setOnUnauthorized,
} from "../lib/api.js";
import { fetchIceServers } from "../lib/iceServers.js";
import type { User } from "@heming/shared";

interface AuthState {
  token: string | null;
  user: User | null;
  status: "idle" | "pending" | "authed" | "error";
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  updateProfile: (displayName: string, avatar?: string) => Promise<void>;
  logout: () => void;
  restore: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: getToken(),
  user: null,
  // 带 token 启动即 pending：首帧渲染「加载中…」而非闪一帧登录页（restore 随后接管）
  status: getToken() ? "pending" : "idle",
  error: null,
  async login(username, password) {
    set({ status: "pending", error: null });
    try {
      const { token, user } = await apiLogin(username, password);
      setToken(token);
      set({ token, user, status: "authed" });
      // 登录成功后拉一次 ICE 配置（d.30 · P0-2）。
      // 为什么在登录后拉而不是启动时拉：`/api/ice-servers` 现在要鉴权，
      // 没有 token 服务端直接 401，启动时拉必然拿不到。
      // 时序天然成立：必须登录才能进会话，而通话发生在进会话之后。
      // 不 await、不阻塞：拉取失败静默回落公共 STUN，ICE 弱一点不该阻断登录。
      void fetchIceServers();
    } catch (e) {
      set({ status: "error", error: (e as Error).message });
    }
  },
  async updateProfile(displayName, avatar) {
    // 成功后用服务端返回的 User 整体替换；失败直接抛给页面展示（不改登录状态）
    const user = await apiUpdateProfile(displayName, avatar);
    set({ user });
  },
  logout() {
    setToken(null);
    set({ token: null, user: null, status: "idle", error: null });
  },
  async restore() {
    if (!getToken()) return;
    set({ status: "pending" });
    try {
      const user = await fetchMe();
      set({ user, token: getToken(), status: "authed" });
      // 与 login() 同理：恢复会话成功也算「已登录」⇒ 拉一次 ICE 配置。
      // 桌面端重启后走的是这条路径（token 已在 localStorage，不经过 login()），
      // 不在这里拉的话 TURN 永远拿不到，等于「配了 TURN 等于没配」。
      void fetchIceServers();
    } catch {
      setToken(null);
      set({ token: null, user: null, status: "idle" });
    }
  },
}));

// 模块底部注册（避免初始化顺序问题）：运行中任一请求 401 → 清会话回登录页
setOnUnauthorized(() => useAuthStore.getState().logout());
