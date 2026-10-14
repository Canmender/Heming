import { create } from "zustand";
import {
  login as apiLogin,
  fetchMe,
  setToken,
  getToken,
  setOnUnauthorized,
} from "../lib/api.js";
import type { User } from "@heming/shared";

interface AuthState {
  token: string | null;
  user: User | null;
  status: "idle" | "pending" | "authed" | "error";
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  restore: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: getToken(),
  user: null,
  status: "idle",
  error: null,
  async login(username, password) {
    set({ status: "pending", error: null });
    try {
      const { token, user } = await apiLogin(username, password);
      setToken(token);
      set({ token, user, status: "authed" });
    } catch (e) {
      set({ status: "error", error: (e as Error).message });
    }
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
    } catch {
      setToken(null);
      set({ token: null, user: null, status: "idle" });
    }
  },
}));

// 模块底部注册（避免初始化顺序问题）：运行中任一请求 401 → 清会话回登录页
setOnUnauthorized(() => useAuthStore.getState().logout());
