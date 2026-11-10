import { useMemo, useState } from "react";
import type { Agent } from "@heming/shared";
import { Avatar } from "../Avatar.js";
import { PlusIcon, SearchIcon } from "../icons.js";

/**
 * 对话 Tab 主区 · 没有选中会话时的智能体选择页（d.67 起，d.126 保留）。
 *
 * 对话 Tab 的左栏只列「已有会话」；要开一段全新的对话，就在主区选智能体。
 * 与「智能体 Tab 的名册」刻意分开：这里是**开聊入口**（卡片一点就开聊），
 * 名册是**管理入口**（编辑/新建/删除）。两处都提供「新建智能体」，但主次不同。
 */

export interface AgentPickerProps {
  /** 已排序名册（系统智能体在前）。 */
  agents: Agent[];
  /** 该智能体是否绑定了可用模型。 */
  boundOf: (agentId: string) => boolean;
  openingId?: string | null;
  onStartChat: (agentId: string) => void;
  onEdit: (agent: Agent) => void;
  onCreate: (startAt: "name" | "templates") => void;
}

export function AgentPicker({
  agents,
  boundOf,
  openingId = null,
  onStartChat,
  onEdit,
  onCreate,
}: AgentPickerProps) {
  /** 选择页的智能体搜索（≥5 个才显示，不给一两条数据配搜索框）。 */
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
  const showGroupLabels = systemAgents.length > 0 && ownAgents.length > 0;
  const groups = showGroupLabels
    ? [
        { key: "system", label: "系统智能体", agents: systemAgents },
        { key: "own", label: "自建智能体", agents: ownAgents },
      ]
    : [{ key: "all", label: "", agents: filtered }];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[960px] px-6 py-5 max-[1199px]:px-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="ui-section-title">选择智能体</h2>
            <p className="ui-body-sm mt-1">
              选一个智能体开始对话；已有的对话都在左边，随时可以点回去。
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

        {agents.length >= 5 ? (
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
          <div className="ui-empty mt-8">
            <p className="ui-empty-title">还没有智能体</p>
            <p className="ui-empty-desc">从模板开始最快：选个预设、改个名字就能用。</p>
            <div className="ui-empty-actions">
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
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="ui-empty mt-8">
            <p className="ui-empty-title">没有匹配的智能体</p>
            <p className="ui-empty-desc">换个名字试试，或清空关键词。</p>
            <button
              type="button"
              className="ui-btn ui-btn-md ui-btn-ghost"
              onClick={() => setQuery("")}
            >
              清空搜索
            </button>
          </div>
        ) : (
          groups
            .filter((g) => g.agents.length > 0)
            .map((group) => (
              <section key={group.key} className="mt-5">
                {group.label ? (
                  <h3 className="ui-micro mb-2 text-muted">{group.label}</h3>
                ) : null}
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
                  {group.agents.map((agent) => {
                    const busy = openingId === agent.id;
                    const bound = boundOf(agent.id);
                    return (
                      <div
                        key={agent.id}
                        className="flex min-w-0 flex-col rounded-xl border border-line-soft bg-white p-3 transition-colors hover:border-line"
                      >
                        <button
                          type="button"
                          aria-label={`与智能体 ${agent.name} 对话`}
                          disabled={busy}
                          onClick={() => onStartChat(agent.id)}
                          className="flex min-w-0 items-start gap-2.5 text-left disabled:opacity-60"
                        >
                          <Avatar
                            user={{
                              displayName: agent.name,
                              avatar: agent.avatar ?? undefined,
                            }}
                            size={32}
                          />
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
                              className="ui-micro rounded-sm px-1.5 py-0.5 text-muted opacity-70 hover:bg-[var(--subtle-3)] hover:text-ink hover:opacity-100 focus:opacity-100"
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              aria-label={`与智能体 ${agent.name} 开始对话`}
                              disabled={busy}
                              onClick={() => onStartChat(agent.id)}
                              className="ui-btn ui-btn-sm ui-btn-ghost"
                            >
                              {busy ? "打开中…" : "开始对话"}
                            </button>
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
