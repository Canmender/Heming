import { create } from "zustand";
import {
  ApiError,
  login as apiLogin,
  fetchMe,
  updateProfile as apiUpdateProfile,
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
  /** restore 临时失败（断网/5xx）时的说明；token 仍保留，界面显示重连面板而非登录页。 */
  restoreError: string | null;
  login: (username: string, password: string) => Promise<void>;
  /** 用户重新输入时清掉上一次的登录错误（错误不该在改密码后还挂着）。 */
  clearError: () => void;
  updateProfile: (displayName: string, avatar?: string) => Promise<void>;
  logout: () => void;
  restore: () => Promise<void>;
}

/**
 * 恢复登录失败后的自动重试间隔（index 随失败次数递增，末位封顶）。
 * 只在临时故障（断网、超时、5xx）时使用；token 真失效（401）直接回登录页。
 */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
/** 每次 restore/logout 递增，晚到的旧请求结果不再改写状态。 */
let restoreEpoch = 0;

/**
 * 临时故障判定：fetch 网络层失败（非 ApiError）与 408/429/5xx 都视为「稍后可能好」；
 * 其余 4xx 不自动重试（但也不清 token，面板上可手动重试）。
 */
function isTransientFailure(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  return e.status === 408 || e.status === 429 || e.status >= 500;
}

function restoreErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return "网络异常，暂时连不上服务器";
  return e.message || `http ${e.status}`;
}

/**
 * 登录失败文案：**不透传服务端/网络的英文原文**（此前直接显示 "invalid credentials"）。
 * 只按状态码翻成人话；未知情况给一句可操作的兜底，不暴露内部实现。
 */
export function loginErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return "用户名或密码不正确";
    if (e.status === 429) return "尝试次数过多，请稍后再试";
    if (e.status === 408) return "请求超时，请重试";
    if (e.status >= 500) return "服务器暂时不可用，请稍后重试";
    return "登录失败，请重试";
  }
  return "连不上服务器，请检查网络后重试";
}

export const useAuthStore = create<AuthState>((set) => {
  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  async function attemptRestore(): Promise<void> {
    const token = getToken();
    if (!token) return;
    clearRetryTimer();
    const epoch = ++restoreEpoch;
    set({ status: "pending", restoreError: null });
    try {
      const user = await fetchMe();
      if (epoch !== restoreEpoch) return;
      retryAttempt = 0;
      set({ user, token: getToken(), status: "authed", error: null, restoreError: null });
    } catch (e) {
      if (epoch !== restoreEpoch) return;
      // 401 = 凭证真失效。正常情况下 api() 已触发 onUnauthorized → logout()；
      // 这里再兜底一次，确保不会把失效 token 留在本地。
      if (e instanceof ApiError && e.status === 401) {
        clearRetryTimer();
        restoreEpoch += 1;
        retryAttempt = 0;
        setToken(null);
        set({ token: null, user: null, status: "idle", error: null, restoreError: null });
        return;
      }
      // token 被其它路径清掉（如 onUnauthorized 已触发 logout）：直接回登录页。
      if (!getToken()) {
        set({ token: null, user: null, status: "idle", error: null, restoreError: null });
        return;
      }
      // 关键：网络/5xx 失败**不清 token**。以前这里直接 logout，服务重启或断网
      // 一下就把用户踢回登录页；现在保留凭证并自动重试，恢复后仍是已登录。
      const message = restoreErrorMessage(e);
      set({ status: "pending", restoreError: message });
      if (!isTransientFailure(e)) {
        retryAttempt = 0;
        return;
      }
      const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
      retryAttempt = Math.min(retryAttempt + 1, RETRY_DELAYS_MS.length - 1);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void attemptRestore();
      }, delay);
    }
  }

  return {
    token: getToken(),
    user: null,
    // 带 token 启动即 pending：首帧渲染「加载中…」而非闪一帧登录页（restore 随后接管）
    status: getToken() ? "pending" : "idle",
    error: null,
    restoreError: null,
    async login(username, password) {
      set({ status: "pending", error: null, restoreError: null });
      try {
        const { token, user } = await apiLogin(username, password);
        setToken(token);
        retryAttempt = 0;
        set({ token, user, status: "authed" });
      } catch (e) {
        set({ status: "error", error: loginErrorMessage(e) });
      }
    },
    clearError() {
      // 只在「上一次确实失败了」时复位，正常状态下不要无谓触发订阅更新
      const { error, status } = useAuthStore.getState();
      if (error !== null || status === "error") set({ error: null, status: "idle" });
    },
    async updateProfile(displayName, avatar) {
      // 成功后用服务端返回的 User 整体替换；失败直接抛给页面展示（不改登录状态）
      const user = await apiUpdateProfile(displayName, avatar);
      set({ user });
    },
    logout() {
      clearRetryTimer();
      restoreEpoch += 1;
      retryAttempt = 0;
      setToken(null);
      set({ token: null, user: null, status: "idle", error: null, restoreError: null });
    },
    async restore() {
      // 手动恢复（启动/用户点重试）从最短间隔重新开始
      retryAttempt = 0;
      await attemptRestore();
    },
  };
});

// 模块底部注册（避免初始化顺序问题）：运行中任一请求 401 → 清会话回登录页
setOnUnauthorized(() => useAuthStore.getState().logout());
