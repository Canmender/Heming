import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "../store/auth.js";
import { FOCUS_RING } from "../lib/a11y/focus.js";
import { Wordmark } from "./Wordmark.js";
import { Button } from "../components/ui/Button.js";

/**
 * 仅登录界面：公开注册在服务端默认 403，此页不再提供注册切换。
 *
 * 布局：宽屏左右等分——左栏登录卡片垂直居中，右栏品牌手写字样居中；
 * 窗口窄于 900px 时退化为单栏（隐藏字样），避免两块都被挤扁。
 */
export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  /** 密码框聚焦且大写锁定开启时提示（登录失败里「密码看起来没打错」的最常见原因）。 */
  const [capsLock, setCapsLock] = useState(false);
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const login = useAuthStore((s) => s.login);
  const clearError = useAuthStore((s) => s.clearError);
  const userRef = useRef<HTMLInputElement>(null);

  /**
   * 打开即聚焦用户名——但**只在焦点确实无处可去时**：
   * 会话过期被踢回登录页时，用户可能正在输入框里打字，autofocus 抢焦点会把后续按键吞进用户名框。
   */
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (document.activeElement === document.body) userRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void login(username, password);
  };

  /** 改输入即清掉上一次的失败提示：错误不再追着用户走、aria-invalid 同步复位。 */
  const onEdit = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setter(e.target.value);
    clearError();
  };
  /** CapsLock 状态只能从键盘事件的 modifier 里读，没有别的来源。 */
  const trackCapsLock = (e: React.KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(e.getModifierState("CapsLock"));
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
    <div className="flex h-full w-full min-w-0 flex-col bg-subtle min-[900px]:flex-row">
      {/* 左：登录表单。简约 · 大气：去掉居中卡片与装饰线，改成左对齐的大标题
          + 充足留白，靠字号与间距建立层次。外层仍 flex-1 / items-center / justify-center
          （回归用例钉住这两个类，也保证窄屏单栏时表单不偏）。 */}
      <div className="flex flex-1 items-center justify-center p-8 sm:p-14">
        <form
          onSubmit={submit}
          className="w-[min(400px,100%)]"
        >
          <h1 className="text-ui-xl font-semibold leading-10 tracking-tight text-ink">和鸣</h1>
          <p className="mt-1 text-ui-base text-muted">登录你的账号</p>
          <div className="mt-9 flex flex-col gap-4">
            {/*
             * d.141：可见 label。此前是裸输入框 + placeholder，placeholder 一敲字就消失，
             * 密码框还叠加大写锁定提示，填错了根本看不出哪个框是用户名。可访问名仍由
             * <label htmlFor> 提供（不再用 aria-label），错误时接 aria-invalid + aria-describedby。
             */}
            <div>
              <label htmlFor="login-username" className="ui-caption block">
                用户名
              </label>
              <input
                ref={userRef}
                id="login-username"
                autoComplete="username"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "login-error" : undefined}
                className={`mt-1 block w-full ui-input ${FOCUS_RING}`}
                placeholder="输入用户名"
                value={username}
                onChange={onEdit(setUsername)}
                required
              />
            </div>
            <div>
              <label htmlFor="login-password" className="ui-caption block">
                密码
              </label>
              <input
                id="login-password"
                autoComplete="current-password"
                aria-invalid={error ? true : undefined}
                aria-describedby={
                  error ? "login-error login-capslock" : "login-capslock"
                }
                className={`mt-1 block w-full ui-input ${FOCUS_RING}`}
                placeholder="输入密码"
                type="password"
                value={password}
                onChange={onEdit(setPassword)}
                onKeyDown={trackCapsLock}
                onKeyUp={trackCapsLock}
                onBlur={() => setCapsLock(false)}
                required
              />
            </div>
            {/*
              大写锁定提示：live region 常驻（动态插入的 role=status 很多读屏不播报），
              关闭时 sr-only 不占位；同时通过 aria-describedby 挂在密码框上，聚焦即可听到。
            */}
            <div
              id="login-capslock"
              role="status"
              className={capsLock ? "ui-caption text-warn" : "sr-only"}
            >
              {capsLock ? "大写锁定已开启" : ""}
            </div>
            {error && (
              // 失败原因必须被读屏播报：role=alert 让它在出现时立刻读出（不是等用户 Tab 到）
              <div id="login-error" role="alert" className="ui-caption text-danger">
                {error}
              </div>
            )}
            <Button
              type="submit"
              disabled={status === "pending"}
              className={`mt-1 w-full ${FOCUS_RING}`}
            >
              {status === "pending" ? "请稍候…" : "登录"}
            </Button>
            {/* 登录页没有注册入口（服务端默认关闭公开注册）：说清去哪儿要账号，别让新用户干瞪眼 */}
            <p className="ui-caption">账号由团队管理员开通。</p>
          </div>
        </form>
      </div>

      {/* 右：品牌区（窄屏隐藏）。简约 · 大气：深色版面 + 手写字样 + 一句大标语，
          与左侧浅色表单形成「明 / 暗」的层次对比；Wordmark 的 svg[aria-label="Heming"]
          与品牌栏的 hidden/min-[900px]:flex/items-center/justify-center
          都被回归用例钉住，原样保留。 */}
      <div className="hidden flex-1 flex-col items-center justify-center overflow-hidden bg-ink p-6 min-[900px]:flex">
        <Wordmark className="h-auto w-[min(360px,26vw)] text-surface" />
        <p className="mt-10 max-w-[min(360px,26vw)] text-center text-ui-lg leading-relaxed text-surface">
          让智能体接手重复的事，把判断留给你。
        </p>
      </div>
    </div>
  );
}
