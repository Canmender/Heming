import { useMemo, useState } from "react";
import type { Agent } from "@heming/shared";
import { Avatar } from "../Avatar.js";
import { PlusIcon, SearchIcon } from "../icons.js";
import { EmptyState } from "../ui/EmptyState.js";

/**
 * 智能体 Tab · 名册（d.126 阶段 B）。
 *
 * 与对话 Tab 的选择页的区别：这是**管理**入口——分组列出系统/自建智能体、
 * 模型绑定状态，编辑进入独立编辑页；「开始对话」只是顺手入口，不再承担主流程。
 *
 * 卡片上的「编辑」常显（不是 hover 才出现）：触屏与键盘用户不会 hover，
 * 隐藏式操作等于没有入口。
 */

export interface AgentRosterViewProps {
  /** 已排序的名册（系统智能体在前，其余按名称）。 */
  agents: Agent[];
  /** 该智能体是否绑定了可用模型（决定「模型已绑定 / 未绑定模型」）。 */
  boundOf: (agentId: string) => boolean;
  /** 正在打开对话的智能体 id（按钮 busy 态）。 */
  openingId?: string | null;
  /** 打开对话失败的原因。 */
  error?: string;
  onStartChat: (agentId: string) => void;
  onEdit: (agent: Agent) => void;
  /** 新建智能体：`name` 直接填表，`templates` 落在模板区。 */
  onCreate: (startAt: "name" | "templates") => void;
}

export function AgentRosterView({
  agents,
  boundOf,
  openingId = null,
  error = "",
  onStartChat,
  onEdit,
  onCreate,
}: AgentRosterViewProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q),
    );
  }, [agents, query]);

  const systemAgents = filtered.filter((a) => a.id === "system-assistant");
  const ownAgents = filtered.filter((a) => a.id !== "system-assistant");
  /** 同时有系统/自建时才打分组标题；只有一类时不加噪。 */
  const showGroupLabels = systemAgents.length > 0 && ownAgents.length > 0;
  const groups = showGroupLabels
    ? [
        { key: "system", label: "系统智能体", items: systemAgents },
        { key: "own", label: "自建智能体", items: ownAgents },
      ]
    : [{ key: "all", label: "", items: filtered }];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[960px] px-6 py-5 max-[1199px]:px-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="ui-section-title">智能体名册</h2>
            <p className="ui-body-sm mt-1">
              系统内置与你自己创建的智能体都在这里；编辑会打开独立页面，改完保存即生效。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onCreate("templates")}
              className="ui-btn ui-btn-md ui-btn-ghost"
            >
              从模板创建
            </button>
            <button
              type="button"
              onClick={() => onCreate("name")}
              className="ui-btn ui-btn-md ui-btn-primary"
            >
              <PlusIcon width={14} height={14} />
              新建智能体
            </button>
          </div>
        </div>

        {error && (
          <p role="alert" className="ui-alert ui-alert-danger mt-3">
            {error}
          </p>
        )}

        {agents.length > 0 ? (
          <div className="relative mt-4">
            <SearchIcon
              width={14}
              height={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              aria-label="搜索智能体"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索智能体…"
              className="ui-input w-full pl-8"
            />
          </div>
        ) : null}

        {agents.length === 0 ? (
          <EmptyState
            className="mt-8"
            title="还没有智能体"
            desc="从模板开始最快：选个预设、改个名字就能用。"
            actions={
              <>
                <button
                  type="button"
                  onClick={() => onCreate("name")}
                  className="ui-btn ui-btn-md ui-btn-primary"
                >
                  新建智能体
                </button>
                <button
                  type="button"
                  onClick={() => onCreate("templates")}
                  className="ui-btn ui-btn-md ui-btn-ghost"
                >
                  从模板创建
                </button>
              </>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            className="mt-8"
            title="没有匹配的智能体"
            desc="换个名字试试，或清空关键词。"
            actions={
              <button
                type="button"
                className="ui-btn ui-btn-md ui-btn-ghost"
                onClick={() => setQuery("")}
              >
                清空搜索
              </button>
            }
          />
        ) : (
          groups
            .filter((g) => g.items.length > 0)
            .map((group) => (
              <section key={group.key} className="mt-5">
                {group.label ? (
                  <h3 className="ui-micro mb-2 text-muted">{group.label}</h3>
                ) : null}
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
                  {group.items.map((agent) => {
                    const busy = openingId === agent.id;
                    const bound = boundOf(agent.id);
                    return (
                      <div
                        key={agent.id}
                        className="flex min-w-0 flex-col rounded-xl border border-line-soft bg-white p-3 transition-colors hover:border-line"
                      >
                        <button
                          type="button"
                          // d.138：与选择页同一口径——没绑模型时头部不再假装能开聊，直接去编辑器选模型。
                          aria-label={
                            bound ? `与智能体 ${agent.name} 对话` : `编辑智能体 ${agent.name}：先绑定模型`
                          }
                          disabled={busy}
                          onClick={() => (bound ? onStartChat(agent.id) : onEdit(agent))}
                          className="flex min-w-0 items-start gap-2.5 text-left disabled:opacity-60"
                        >
                          {/* 头像单字会被读屏拼进按钮名（「和和小鸣…」），按钮已有 aria-label，头像纯装饰 */}
                          <span aria-hidden="true" className="shrink-0">
                            <Avatar
                              user={{
                                displayName: agent.name,
                                avatar: agent.avatar ?? undefined,
                              }}
                              size={32}
                            />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="ui-body-sm block truncate font-medium">
                              {agent.name}
                            </span>
                            <span className="ui-caption mt-0.5 line-clamp-2 block min-h-[34px] leading-[17px]">
                              {busy
                                ? "正在打开…"
                                : agent.description ||
                                  (agent.id === "system-assistant"
                                    ? "和鸣内置智能体"
                                    : "还没有简介")}
                            </span>
                          </span>
                        </button>
                        <div className="mt-2 flex items-center gap-2">
                          <span
                            className={`ui-chip ${bound ? "" : "text-[var(--danger)]"}`}
                            title={
                              bound
                                ? "该智能体已绑定模型"
                                : "该智能体还没有绑定模型，发送会失败"
                            }
                          >
                            {bound ? "模型已绑定" : "未绑定模型"}
                          </span>
                          <span className="ml-auto flex items-center gap-1">
                            <button
                              type="button"
                              aria-label={`编辑智能体：${agent.name}`}
                              title="编辑智能体"
                              onClick={() => onEdit(agent)}
                              className="ui-btn ui-btn-sm ui-btn-ghost"
                            >
                              编辑
                            </button>
                            {bound && (
                              <button
                                type="button"
                                aria-label={`与智能体 ${agent.name} 开始对话`}
                                disabled={busy}
                                onClick={() => onStartChat(agent.id)}
                                className="ui-btn ui-btn-sm ui-btn-ghost"
                              >
                                {busy ? "打开中…" : "开始对话"}
                              </button>
                            )}
                            {/* d.138：没绑模型时不给「开始对话」——进去也发不出消息。
                                下一步是「编辑」（在里面选模型），所以这里只留编辑。 */}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))
        )}
      </div>
    </div>
  );
}
