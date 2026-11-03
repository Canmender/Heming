import { useState } from "react";
import { useAuthStore } from "../store/auth.js";
import { FOCUS_RING } from "../lib/a11y/focus.js";
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
    /*
     * w-full 必须显式写：本节点的父容器（App.tsx 登录分支的 <div class="flex min-h-0 flex-1">）
     * 是 row 方向的 flex 容器，本节点是它的 flex 子项。flex 子项默认 flex-basis:auto →
     * 宽度按 max-content 收缩，于是整页只会占窗口左侧一条（1440 宽下实测仅 758px），
     * 右半屏全空、宽屏分栏看起来「根本没生效」。w-full 把 basis 撑到父容器 100% 宽。
     * min-w-0 抵消 flex 子项默认的 min-width:auto，避免窗口偏窄时被内容反撑出横向滚动。
     * 请勿删除——删掉就退回「卡片和字样全挤在左边」的状态（已有回归用例守护）。
     */
    <div className="flex h-full w-full min-w-0 flex-col bg-[#fafafa] min-[900px]:flex-row">
      {/* 左：登录卡片垂直居中 */}
      <div className="flex flex-1 items-center justify-center p-6">
        <form
          onSubmit={submit}
          className="w-[340px] rounded-xl border border-line bg-white p-7 shadow-card"
        >
          {/* d.63：页面标题/副标题走全站排版档（18/600 + 12/muted），表单与按钮走控件基元 */}
          <h1 className="ui-page-title mb-1">和鸣</h1>
          <p className="ui-page-sub mb-5">登录你的账号</p>
          <div className="flex flex-col gap-3">
            {/*
             * 字段名走 aria-label 而不是可见 <label>：登录页版式是裸输入框 + placeholder，
             * 加可见标签会改变版式（本轮不动视觉）。placeholder 不能当可访问名的主要来源，
             * 所以显式给 aria-label；错误时用 aria-invalid + aria-describedby 关联到错误行。
             */}
            <input
              aria-label="用户名"
              autoComplete="username"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
              className={`ui-input ${FOCUS_RING}`}
              placeholder="用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <input
              aria-label="密码"
              autoComplete="current-password"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
              className={`ui-input ${FOCUS_RING}`}
              placeholder="密码"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {error && (
              // 失败原因必须被读屏播报：role=alert 让它在出现时立刻读出（不是等用户 Tab 到）
              <div id="login-error" role="alert" className="ui-caption text-[#b42318]">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={status === "pending"}
              className={`ui-btn ui-btn-md ui-btn-primary mt-1 w-full ${FOCUS_RING}`}
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
