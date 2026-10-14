import { useState } from "react";
import { useAuthStore } from "../store/auth.js";

/** 仅登录界面：公开注册在服务端默认 403，此页不再提供注册切换。 */
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
    <div className="flex h-screen items-center justify-center bg-white">
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
  );
}
