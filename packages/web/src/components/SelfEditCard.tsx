import { useCallback, useState } from "react";
import {
  SelfEditStore,
  readAudit,
  type AuditEntry,
  type StorageLike,
} from "../lib/selfEdit/guards.js";

/**
 * 自我修改设置卡（挂在技能区）：
 * - 每个智能体一个开关（默认开启，用户明确要求），关掉后该智能体不再有 self.* 工具；
 * - 变更记录：智能体改过自己的什么、什么时候、为什么，被拒绝的也列出。
 *
 * 为什么要把这块放在技能区而不是设置区：技能页已经是「这个智能体具备什么能力」
 * 的入口，自我优化正属于同一主题；放设置区会让人找不到。
 */
export function SelfEditCard({
  agents,
  agentId,
  storage,
  policyStore,
}: {
  agents: { id: string; name: string }[];
  agentId: string;
  storage?: StorageLike;
  policyStore?: SelfEditStore;
}) {
  const policy = policyStore ?? new SelfEditStore(storage);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);

  // 留痕与开关都直接从存储读，不需要额外的同步 effect——
  // 早期版本写了个 `[agentId, tick] → bump()` 的 effect，那会自己触发自己，
  // 变成无限重渲染（技能页测试直接挂住）。这里改成「改开关时 bump，
  // agentId 变化天然触发重渲染」就够了。
  void tick; // 仅为让 bump() 触发重渲染（留痕是外部存储，无订阅机制）
  const store = storage ?? browserStorage();
  const audit = readAudit(store, agentId || undefined).slice(0, 20);
  const enabled = agentId ? policy.allowed(agentId) : true;

  return (
    <section aria-label="自我优化" className="mt-3 rounded-xl border border-line bg-white p-4 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-bold text-[#777]">自我优化</div>
          <div className="mt-1 text-[11px] text-muted">
            允许智能体按需修改自己的记忆、技能与 MCP 配置。改动即时生效，并记录在下方。
          </div>
          <div className="mt-1 text-[11px] text-[#aaa]">
            工具占一定上下文开销，仅在开关被操作过（开或关）之后才会真正注入。
          </div>
        </div>
        {agentId && (
          <label className="flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              aria-label="允许自我优化"
              checked={enabled}
              onChange={(e) => {
                policy.setPolicy(agentId, { enabled: e.target.checked });
                bump();
              }}
            />
            <span className={enabled ? "text-ink" : "text-muted"}>
              {enabled ? "已开启" : "已关闭"}
            </span>
          </label>
        )}
      </div>

      {!agentId && (
        <div className="mt-2 text-[11px] text-[#b45309]">先在上方选择一个智能体，才能配置它的自我优化。</div>
      )}
      {agentId && !enabled && (
        <div className="mt-2 text-[11px] text-[#b45309]">
          该智能体当前拿不到 self.* 工具，无法自行改动配置。
        </div>
      )}

      <div className="mt-3 border-t border-line-soft pt-2">
        <div className="text-[11px] font-bold text-[#999]">
          变更记录{audit.length ? `（最近 ${audit.length} 条）` : ""}
        </div>
        {audit.length === 0 ? (
          <div className="mt-1 text-[11px] text-muted">还没有变更记录。</div>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {audit.map((entry, i) => (
              <AuditRow key={`${entry.at}-${i}`} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const SCOPE_LABEL: Record<AuditEntry["scope"], string> = {
  memory: "记忆",
  skill: "技能",
  mcp: "MCP",
  tool: "工具调用",
  other: "其它",
};

const ACTION_LABEL: Record<string, string> = {
  write: "写入",
  update: "更新",
  remove: "删除",
  enable: "启用",
  disable: "停用",
  create: "新建",
  add_server: "新增服务",
  update_server: "改服务",
  remove_server: "删服务",
  reject: "已拒绝",
};

function AuditRow({ entry }: { entry: AuditEntry }) {
  const time = entry.at.slice(0, 16).replace("T", " ");
  return (
    <li className="flex flex-wrap items-baseline gap-1.5 rounded border border-line-soft px-2 py-1 text-[11px]">
      <span className="text-[#aaa]">{time}</span>
      <span className="rounded bg-[#f3f3f3] px-1 text-[#777]">
        {SCOPE_LABEL[entry.scope]}·{ACTION_LABEL[entry.action] ?? entry.action}
      </span>
      <span className="min-w-0 flex-1 truncate text-[#555]">{entry.target}</span>
      {entry.rejected && (
        <span className="text-[#b45309]" title={entry.rejected}>
          {entry.rejected}
        </span>
      )}
      {entry.reason && !entry.rejected && (
        <span className="max-w-[45%] truncate text-[#aaa]" title={entry.reason}>
          {entry.reason}
        </span>
      )}
    </li>
  );
}

/** localStorage 适配（与 guards 默认实现同口径）。 */
function browserStorage(): StorageLike {
  return {
    getItem: (k) => {
      try {
        return window.localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* 隐私模式 */
      }
    },
    removeItem: (k) => {
      try {
        window.localStorage.removeItem(k);
      } catch {
        /* 同上 */
      }
    },
  };
}