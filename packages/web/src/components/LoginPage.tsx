import { useState } from "react";
import { useAuthStore } from "../store/auth.js";

export function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "login") void login(username, password);
    else void register(username, password, displayName);
  };

  return (
    <div className="flex h-screen items-center justify-center bg-white">
      <form
        onSubmit={submit}
        className="w-[340px] rounded-xl border border-line bg-white p-7 shadow-card"
      >
        <h1 className="mb-1 text-xl font-extrabold">合序 Heming</h1>
        <p className="mb-5 text-[13px] text-muted">
          {mode === "login" ? "登录你的账号" : "创建新账号"}
        </p>
        <div className="flex flex-col gap-3">
          <input
            className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]"
            placeholder="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          {mode === "register" && (
            <input
              className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]"
              placeholder="昵称"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          )}
          <input
            className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]"
            placeholder="密码（至少 6 位）"
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
            {status === "pending" ? "请稍候…" : mode === "login" ? "登录" : "注册"}
          </button>
          <button
            type="button"
            className="text-[13px] text-muted underline-offset-2 hover:underline"
            onClick={() => setMode(mode === "login" ? "register" : "login")}
          >
            {mode === "login" ? "没有账号？注册" : "已有账号？登录"}
          </button>
        </div>
      </form>
    </div>
  );
}
