import { useState } from "react";
import { useAuthStore } from "../store/auth.js";
import { Wordmark } from "./Wordmark.js";

/**
 * 仅登录界面：公开注册在服务端默认 403，此页不再提供注册切换。
 *
 * 布局：宽屏左右等分——左栏登录卡片垂直居中，右栏品牌手写字样居中；
 * 窗口窄于 900px 时退化为单栏（隐藏字样），避免两块都被挤扁。
 */
export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const login = useAuthStore((s) => s.login);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void login(username, password);
  };

  return (
    <div className="flex h-full flex-col bg-[#fafafa] min-[900px]:flex-row">
      {/* 左：登录卡片垂直居中 */}
      <div className="flex flex-1 items-center justify-center p-6">
        <form
          onSubmit={submit}
          className="w-[340px] rounded-xl border border-line bg-white p-7 shadow-card"
        >
          <h1 className="mb-1 text-xl font-extrabold">和鸣</h1>
          <p className="mb-5 text-[13px] text-muted">登录你的账号</p>
          <div className="flex flex-col gap-3">
            <input
              className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]"
              placeholder="用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <input
              className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]"
              placeholder="密码"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {error && <div className="text-[12px] text-red-600">{error}</div>}
            <button
              type="submit"
              disabled={status === "pending"}
              className="mt-1 rounded-lg bg-ink py-2 text-sm font-bold text-white disabled:opacity-50"
            >
              {status === "pending" ? "请稍候…" : "登录"}
            </button>
          </div>
        </form>
      </div>

      {/* 右：品牌手写字样（窄屏隐藏）。宽度随视口收敛，避免小窗口里溢出版心 */}
      <div className="hidden flex-1 items-center justify-center p-6 min-[900px]:flex">
        <Wordmark className="h-auto w-[min(320px,26vw)] text-ink" />
      </div>
    </div>
  );
}
