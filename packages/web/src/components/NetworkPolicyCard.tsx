import { useState, useSyncExternalStore } from "react";
import {
  MAX_NET_ALLOW,
  addNetAllow,
  getNetPolicy,
  removeNetAllow,
  resetNetPolicy,
  setNetPolicy,
  subscribeNetPolicy,
} from "../lib/webtools/netPolicy.js";
import { Button } from "./ui/Button.js";

/**
 * 设置区 · 网络访问（d.238）。
 *
 * 为什么放在设置里而不是智能体卡片里：**网络边界是本机的一道安全边界**，
 * 与「工具调用确认」同级——用户在这里说「这个应用能读哪些网站」，
 * 对所有对话生效（`web_read` 每次读取都按当前策略校验）。
 *
 * 三条交互口径：
 * 1. 默认「开放」，与升级前行为一致（不能因为加了策略就把老用户锁死）；
 * 2. 切成「仅允许列表」时如果列表是空的，界面必须**明说现在什么都读不了**，
 *    否则用户会以为「切了模式就自动只读信任站点」，然后发现智能体全废；
 * 3. 加错的写法（IP、只写 `*`、带路径）当场说明为什么没加进去，
 *    不静默丢弃——规则类界面最常见的坑是「点了没反应」。
 */
export function NetworkPolicyCard() {
  const policy = useSyncExternalStore(subscribeNetPolicy, getNetPolicy, getNetPolicy);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const allowlist = policy.mode === "allowlist";
  const rules = policy.allow;
  const isDefault = policy.mode === "open" && rules.length === 0;

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    const result = addNetAllow(text);
    if (result.rejected.length > 0) {
      // 有写法被拒：输入框**保留原文**（用户改一个字符就能重试，不用重打一遍）。
      const accepted = result.added.length > 0 ? `已加入：${result.added.join("、")}；` : "";
      setMessage({
        kind: "error",
        text: `${accepted}这些写法用不了：${result.rejected.join("、")}（只认域名，例如 example.com 或 *.example.com；IP 地址、只写 *、带路径都不行）`,
      });
      return;
    }
    if (result.added.length === 0) {
      setMessage({ kind: "error", text: `列表里已经有 ${text} 了` });
      return;
    }
    setMessage({ kind: "ok", text: `已加入：${result.added.join("、")}` });
    setDraft("");
  };

  const setMode = (mode: "open" | "allowlist") => {
    if (mode === policy.mode) return;
    setMessage(null);
    setNetPolicy({ mode });
  };

  return (
    <section data-testid="network-policy-card" className="ui-card mt-3 p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <div className="text-ui-sm font-medium text-muted">网络访问</div>
      </div>
      <div className="mt-1 ui-caption">
        智能体读网页（web_read）时能访问哪些站点。内网与本机地址始终被挡，这一项只决定「公开网页」的边界
      </div>

      <div className="mt-3 flex flex-col gap-1.5" role="radiogroup" aria-label="网络访问模式">
        <label className="flex items-start gap-2 text-ui-sm text-body">
          <input
            type="radio"
            name="net-policy-mode"
            className="mt-0.5"
            checked={policy.mode === "open"}
            onChange={() => setMode("open")}
          />
          <span>
            开放
            <span className="block ui-caption">能读任意公开网页（当前默认；内网/本机仍然读不到）</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-ui-sm text-body">
          <input
            type="radio"
            name="net-policy-mode"
            className="mt-0.5"
            checked={allowlist}
            onChange={() => setMode("allowlist")}
          />
          <span>
            仅允许列表里的域名
            <span className="block ui-caption">列表之外的网页一律拒绝，并告诉智能体「去设置里加」</span>
          </span>
        </label>
      </div>

      {allowlist && rules.length === 0 ? (
        <div data-testid="net-policy-empty" className="mt-2 ui-caption text-warn">
          列表还是空的：现在任何网页都读不了。先加几个站点，或者改回「开放」。
        </div>
      ) : null}

      <div className="mt-3 ui-caption">
        允许的域名（{rules.length}/{MAX_NET_ALLOW}）
      </div>
      {rules.length === 0 ? (
        <div className="mt-1 ui-caption">还没有规则。</div>
      ) : (
        <ul data-testid="net-policy-rules" className="mt-1 flex flex-col gap-1">
          {rules.map((rule) => (
            <li key={rule} className="flex items-center gap-2 text-ui-sm text-body">
              <code className="rounded-sm bg-subtle-2 px-1.5 py-0.5 text-ui-xs">{rule}</code>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                aria-label={`移除 ${rule}`}
                onClick={() => {
                  removeNetAllow(rule);
                  setMessage({ kind: "ok", text: `已移除：${rule}` });
                }}
              >
                移除
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-end gap-2">
        {/*
         * 用 textarea 而不是 input：用户最常见的手势是从别处**粘一串域名**进来，
         * 而单行 input 会把换行吞掉、把两行粘成一个非法串（`a.com` + `b.com` 变 `a.comb.com`）。
         * Enter 仍是「添加」（符合直觉），Shift+Enter 换行（手工分多行时用）。
         */}
        <textarea
          aria-label="添加域名"
          className="ui-input min-w-0 flex-1"
          rows={2}
          placeholder="example.com 或 *.example.com（换行/逗号分隔，可一次贴多个）"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button variant="primary" size="sm" onClick={add} disabled={!draft.trim()}>
          添加
        </Button>
      </div>
      {message ? (
        <div
          data-testid="net-policy-message"
          className={`mt-2 ui-caption ${message.kind === "error" ? "text-warn" : "text-muted"}`}
        >
          {message.text}
        </div>
      ) : null}
      <div className="mt-2 ui-caption">
        写 example.com 会放行它自己和它的子域；写 *.example.com 只放行子域。规则只认域名，路径/端口会被忽略。
      </div>
      {isDefault ? null : (
        <div className="mt-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              resetNetPolicy();
              setMessage({ kind: "ok", text: "已恢复默认：开放访问" });
            }}
          >
            恢复默认
          </Button>
        </div>
      )}
    </section>
  );
}
