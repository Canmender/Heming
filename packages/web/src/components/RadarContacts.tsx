import { useEffect, useRef, useState } from "react";
import type { Agent, Conversation } from "@heming/shared";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { requestFriend, acceptFriend } from "../lib/api.js";
import { Avatar } from "./Avatar.js";
import { ChevronIcon } from "./icons.js";
import { GroupCreateModal } from "./GroupCreateModal.js";
import { AgentFormModal } from "./AgentFormModal.js";

/**
 * 通讯录主视图 · 圆形雷达（视觉定稿 contacts-final-v2.html 移植）：
 * 圆心「我」+ 三同心虚线环 + 10s 扫描线；三扇区（上=群聊 / 左下=人类 / 右下=智能体）。
 * 悬浮节点 → 信息卡；点击（群/人类）→ 进会话并左滑隐藏；overlay 模式左缘「呼出」拉回。
 */

// ---------- 扇区落位（纯函数，导出可测） ----------

/** 序号 0..3 的 [半径px, 角偏°]：0/1 内圈 ±12°，2/3 中圈 ±14°。 */
const INNER_SLOTS: ReadonlyArray<readonly [number, number]> = [
  [105, 12],
  [105, -12],
  [155, 14],
  [155, -14],
];

function slotOf(i: number): readonly [number, number] {
  if (i < INNER_SLOTS.length) return INNER_SLOTS[i];
  // 4+：外圈 ~195 起，每多一对再外推一档，角偏 ±10°（确定性，无随机）
  const pair = Math.floor((i - 4) / 2);
  return [195 + pair * 34, i % 2 === 0 ? 10 : -10];
}

/**
 * 扇区落位：给定 items 输出与之一一对应的 {x,y,far}（px 偏移，坐标系 y 向下 = CSS top 方向）。
 * 角度用屏幕约定（0°=正右，顺时针；上=270，左下=150，右下=30）。纯函数、无随机。
 */
export function layoutSector(
  centerDeg: number,
  items: readonly unknown[],
): Array<{ x: number; y: number; far: boolean }> {
  return items.map((_, i) => {
    const [r, off] = slotOf(i);
    const rad = ((centerDeg + off) * Math.PI) / 180;
    return {
      x: Math.round(Math.cos(rad) * r * 10) / 10,
      y: Math.round(Math.sin(rad) * r * 10) / 10,
      far: i >= 4,
    };
  });
}

/** 扇区中心角（屏幕约定）：上=群聊、左下=人类、右下=智能体。 */
const SECTORS = [
  { kind: "group" as const, centerDeg: 270, label: "群聊" },
  { kind: "human" as const, centerDeg: 150, label: "人类" },
  { kind: "agent" as const, centerDeg: 30, label: "智能体" },
];

// ---------- 节点视图模型 ----------

interface RadarNode {
  key: string;
  name: string;
  avatar?: string;
  status: string;
  typeLabel: string;
  lastText: string;
  lastTime: string;
  unread: number;
  /** 可直接进入的会话（群/已有直聊）。 */
  convId?: string;
  /** 人类好友尚无直聊：点击时先 openDirect。 */
  peerId?: string;
  /** 智能体（M2 无 1:1 会话）：仅展示信息卡，发消息/历史会话禁用。 */
  agent?: boolean;
  /** 名册行（owner 悬浮卡据此渲染「编辑」入口）。 */
  agentData?: Agent;
  /** roster.owner_id === me.id：名册项属主。 */
  agentOwned?: boolean;
  avatarCls: string;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}

// ---------- 组件 ----------

export function RadarContacts({ overlay = false }: { overlay?: boolean }) {
  const conversations = useChatStore((s) => s.conversations);
  const friends = useChatStore((s) => s.friends);
  const incoming = useChatStore((s) => s.incoming);
  const agentsRoster = useChatStore((s) => s.agentsRoster);
  const agentIdsInGroups = useChatStore((s) => s.agentIdsInGroups);
  const messages = useChatStore((s) => s.messages);
  const loadWorkspace = useChatStore((s) => s.loadWorkspace);
  const loadAgents = useChatStore((s) => s.loadAgents);
  const loadAgentsRoster = useChatStore((s) => s.loadAgentsRoster);
  const openDirect = useChatStore((s) => s.openDirect);
  const me = useAuthStore((s) => s.user);
  const openConversation = useUiStore((s) => s.openConversation);
  const hideContacts = useUiStore((s) => s.hideContacts);
  const showContacts = useUiStore((s) => s.showContacts);
  const contactsHidden = useUiStore((s) => s.contactsHidden);

  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [hint, setHint] = useState("");
  /** 打开直聊失败提示（顶部条下方一行；成功进入/切换节点时清除）。 */
  const [openErr, setOpenErr] = useState("");
  const [groupOpen, setGroupOpen] = useState(false);
  /** 智能体弹窗：create 由顶栏「＋ 新建智能体」打开；edit 由 owner 悬浮卡「编辑」打开。 */
  const [agentModal, setAgentModal] = useState<
    { mode: "create" } | { mode: "edit"; agent: Agent }
  | null>(null);
  /** 悬浮信息卡：节点 + 卡片坐标（相对雷达容器）。 */
  const [card, setCard] = useState<{ node: RadarNode; x: number; y: number } | null>(null);
  /**
   * 面板可见态（仅 overlay 用）：初值 true，挂载后 effect 同步 contactsHidden——
   * 从工作区点节点进会话时，面板先挂载再滑出（380ms），复刻定稿的左滑揭示。
   */
  const [show, setShow] = useState(true);
  const radarRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // 名册与群内收集并发拉取：两者的 join 各自重算（store 内谁后完成谁见对方新值），终态一致
    void loadWorkspace()
      .then(() => Promise.all([loadAgentsRoster(), loadAgents()]))
      .catch((err) => console.warn("通讯录数据加载失败", err));
  }, [loadWorkspace, loadAgents, loadAgentsRoster]);

  // 面板可见态跟随 contactsHidden：初值 true，挂载后的首个 effect 同步——
  // 从工作区点节点进会话时，overlay 面板先以可见态挂载再滑出（380ms），复刻定稿的左滑揭示
  useEffect(() => {
    if (overlay) setShow(!contactsHidden);
  }, [overlay, contactsHidden]);

  // 隐藏态同时 inert：面板平移出屏后内部节点仍可 Tab 聚焦（Enter 会隐式切会话）。
  // React 18 无 inert 属性类型，用原生 toggleAttribute 等价设置/移除。
  useEffect(() => {
    panelRef.current?.toggleAttribute("inert", !show);
  }, [show]);

  useEffect(
    () => () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    },
    [],
  );

  // ---- 数据 → 节点 ----

  const q = search.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);

  const lastOf = (convId?: string) => {
    const list = convId ? messages[convId] : undefined;
    const last = list && list.length ? list[list.length - 1] : undefined;
    return {
      lastText: last?.payload.text ?? "暂无消息",
      lastTime: last ? fmtWhen(last.createdAt) : "—",
    };
  };

  const groupNodes: RadarNode[] = conversations
    .filter((c): c is Extract<Conversation, { type: "group" }> => c.type === "group")
    .filter((c) => match(c.name))
    .map((c) => ({
      key: c.id,
      name: c.name,
      status: `${c.memberCount} 人`,
      typeLabel: "群聊",
      unread: c.unreadCount,
      convId: c.id,
      avatarCls: "!bg-ink !text-white",
      ...lastOf(c.id),
    }));

  const humanNodes: RadarNode[] = friends
    .map((f) => f.user)
    .filter((u) => match(u.displayName))
    .map((u) => {
      const direct = conversations.find((c) => c.type === "direct" && c.peer.id === u.id);
      return {
        key: u.id,
        name: u.displayName,
        avatar: u.avatar,
        status: `@${u.username} · 好友`,
        typeLabel: "人类",
        unread: direct?.unreadCount ?? 0,
        convId: direct?.id,
        peerId: u.id,
        avatarCls: "",
        ...lastOf(direct?.id),
      };
    });

  // 扇区简化裁决（写死）：出现在我任一群 members 的名册项 ∪ 自己拥有的名册项；
  // 群内 id 集合来自 loadAgents，名册行带 owner/description（join 在此完成）
  const displayAgents = agentsRoster.filter(
    (a) => agentIdsInGroups.has(a.id) || (me != null && a.owner_id === me.id),
  );

  const agentNodes: RadarNode[] = displayAgents
    .filter((a) => match(a.name))
    .map((a) => ({
      key: a.id,
      name: a.name,
      avatar: a.avatar ?? undefined,
      status: "智能体 · 仅群内可对话",
      typeLabel: "智能体",
      unread: 0,
      agent: true,
      agentData: a,
      agentOwned: me != null && a.owner_id === me.id,
      avatarCls: "!bg-[#dce6f0] !text-[#5b7899]",
      ...lastOf(undefined),
    }));

  const sectors = [
    { ...SECTORS[0], nodes: groupNodes },
    { ...SECTORS[1], nodes: humanNodes },
    { ...SECTORS[2], nodes: agentNodes },
  ];

  // ---- 交互 ----

  const enter = (n: RadarNode) => {
    if (n.agent) return; // 智能体：仅展示卡（M2 不假装能聊）
    setOpenErr("");
    hideContacts();
    if (n.convId) {
      openConversation(n.convId);
    } else if (n.peerId) {
      void openDirect(n.peerId)
        .then(openConversation)
        .catch(() => {
          // 失败恢复：面板已先 hide，拉回避免停在空态，并在顶部条下方提示
          showContacts();
          setOpenErr(`无法打开与 ${n.name} 的会话，请稍后重试`);
        });
    }
  };

  const scheduleHide = () => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setCard(null), 120);
  };

  const cancelHide = () => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
  };

  const showCard = (n: RadarNode, el: HTMLElement) => {
    const radar = radarRef.current;
    if (!radar) return;
    const r = radar.getBoundingClientRect();
    const nb = el.getBoundingClientRect();
    // 定稿脚本同款定位/翻转：默认贴节点右侧，越界翻左侧；上下贴边
    let x = nb.left - r.left + nb.width + 10;
    let y = nb.top - r.top - 16;
    if (x + 220 > r.width) x = nb.left - r.left - 220;
    if (y < 6) y = 6;
    if (y + 175 > r.height) y = r.height - 180;
    if (y < 6) y = 6;
    setCard({ node: n, x, y });
  };

  const onAddFriend = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await requestFriend(addName.trim());
      setHint("申请已发送");
      setAddName("");
    } catch (err) {
      setHint((err as Error).message);
    }
  };

  const coreInitial = (me?.displayName ?? "我").trim().charAt(0) || "我";

  // ---- 渲染 ----

  const panel = (
    <div
      ref={panelRef}
      className={
        overlay
          ? `absolute inset-0 z-10 flex flex-col overflow-hidden bg-white${show ? "" : " -translate-x-full"}`
          : "relative flex h-full w-full flex-col overflow-hidden bg-white"
      }
      style={overlay ? { transition: "transform .38s cubic-bezier(.22,.61,.36,1)" } : undefined}
      aria-hidden={overlay && !show ? true : undefined}
    >
      {/* 顶部条：标题 + 实时搜索 + 三动作 */}
      <div className="top">
        <h4>通讯录 · 雷达</h4>
        <input
          className="search"
          placeholder="搜索联系人…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setCard(null);
          }}
        />
        <div className="acts">
          <button type="button" onClick={() => setAddOpen((v) => !v)}>
            ＋ 加好友
          </button>
          <button type="button" onClick={() => setGroupOpen(true)}>
            ＋ 新建群
          </button>
          <button type="button" onClick={() => setAgentModal({ mode: "create" })}>
            ＋ 新建智能体
          </button>
        </div>
        {addOpen && (
          <div className="addpop">
            <div className="addpop-title">加好友</div>
            <form onSubmit={onAddFriend} className="flex gap-2">
              <input
                className="addpop-input"
                placeholder="按用户名加好友"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
              />
              <button type="submit" className="addpop-send">
                发送
              </button>
            </form>
            {hint && <div className="addpop-hint">{hint}</div>}
            <div className="addpop-title mt-3">待处理申请</div>
            {incoming.length === 0 ? (
              <div className="text-[12px] text-muted">没有待处理申请</div>
            ) : (
              incoming.map((r) => (
                <div key={r.id} className="mt-1 flex items-center gap-2 text-[13px]">
                  <Avatar user={r.from} size={22} />
                  <span className="min-w-0 flex-1 truncate">{r.from.displayName}</span>
                  <button
                    type="button"
                    className="rounded-md border border-line px-2 py-0.5 text-[12px] shadow-card"
                    onClick={() => void acceptFriend(r.id).then(() => loadWorkspace())}
                  >
                    接受
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {openErr && (
        <div className="toperr" role="alert">
          {openErr}
        </div>
      )}

      {/* 雷达区：环 / 扇区分隔 / 扫描线 / 圆心 / 节点 / 信息卡 */}
      <div className="radar" ref={radarRef}>
        <div className="radar-ring" style={{ width: 150, height: 150 }} />
        <div className="radar-ring solid" style={{ width: 262, height: 262 }} />
        <div className="radar-ring" style={{ width: 374, height: 374 }} />

        {/* 120° 分隔虚线（定稿：0°/120°/240° → 屏幕 90°/210°/330° 扇界） */}
        <div className="wedge" style={{ transform: "rotate(0deg)" }} />
        <div className="wedge" style={{ transform: "rotate(120deg)" }} />
        <div className="wedge" style={{ transform: "rotate(240deg)" }} />

        <div className="wlabel" style={{ left: "50%", top: 14, transform: "translateX(-50%)" }}>
          群聊
        </div>
        <div className="wlabel" style={{ left: 24, bottom: 18 }}>
          人类
        </div>
        <div className="wlabel" style={{ right: 24, bottom: 18 }}>
          智能体
        </div>

        {/* Task 2 handoff 落地：名册/扇区为空时的播种空态（不 hack 客户端触发播种） */}
        {displayAgents.length === 0 && (
          <div className="agent-empty">智能体将在预设群播种后出现（重启服务端后可见）</div>
        )}

        <div className="scan" />
        <div className="core">
          {me?.avatar ? (
            <img src={me.avatar} alt="" className="core-img" />
          ) : (
            <span className="core-initial">{coreInitial}</span>
          )}
          <small>在线</small>
        </div>

        {sectors.map((s) => {
          const pts = layoutSector(
            s.centerDeg,
            s.nodes.map((n) => n.key),
          );
          return s.nodes.map((n, i) => {
            const p = pts[i];
            return (
              <button
                key={`${s.kind}:${n.key}`}
                type="button"
                className={`node${p.far ? " far" : ""}`}
                style={{ left: `calc(50% + ${p.x}px)`, top: `calc(50% + ${p.y}px)` }}
                onMouseEnter={(e) => {
                  cancelHide();
                  showCard(n, e.currentTarget);
                }}
                onMouseLeave={scheduleHide}
                onClick={() => {
                  setCard(null);
                  enter(n);
                }}
              >
                <span className="avwrap">
                  <Avatar
                    user={{ displayName: n.name, avatar: n.avatar }}
                    size={p.far ? 29 : 38}
                    className={`border-2 border-white shadow-[0_5px_14px_rgba(0,0,0,.12)]${
                      p.far ? " opacity-[.78]" : ""
                    } ${n.avatarCls}`}
                  />
                  {n.unread > 0 && <span className="bdg">{n.unread}</span>}
                </span>
                <span className="node-name">{n.name}</span>
              </button>
            );
          });
        })}

        {card && (
          <div
            className="hcard"
            style={{ left: card.x, top: card.y }}
            onMouseEnter={cancelHide}
            onMouseLeave={scheduleHide}
          >
            <div className="ph">
              <Avatar
                user={{ displayName: card.node.name, avatar: card.node.avatar }}
                size={40}
                className={`border-2 border-white shadow-card ${card.node.avatarCls}`}
              />
              <div className="min-w-0">
                <div className="hn">{card.node.name}</div>
                <div className="hs">{card.node.status}</div>
              </div>
            </div>
            <div className="hrow">
              <b>类型</b>　{card.node.typeLabel}　　<b>时间</b>　{card.node.lastTime}
            </div>
            <div className="hrow">
              <b>最近消息</b>
              <br />
              {card.node.lastText}
            </div>
            <div className="hb">
              {card.node.agentOwned && card.node.agentData && (
                <button
                  type="button"
                  onClick={() => {
                    const rec = card.node.agentData;
                    setCard(null);
                    if (rec) setAgentModal({ mode: "edit", agent: rec });
                  }}
                >
                  编辑
                </button>
              )}
              <button
                type="button"
                className="pri"
                disabled={!!card.node.agent}
                title={card.node.agent ? "M3 开放对话" : undefined}
                onClick={() => {
                  setCard(null);
                  enter(card.node);
                }}
              >
                发消息
              </button>
              <button
                type="button"
                disabled={!!card.node.agent}
                title={card.node.agent ? "M3 开放对话" : undefined}
                onClick={() => {
                  setCard(null);
                  enter(card.node);
                }}
              >
                历史会话
              </button>
            </div>
          </div>
        )}
      </div>

      <GroupCreateModal open={groupOpen} onClose={() => setGroupOpen(false)} />
      {agentModal && (
        <AgentFormModal
          key={agentModal.mode === "edit" ? agentModal.agent.id : "new"}
          open
          mode={agentModal.mode}
          agent={agentModal.mode === "edit" ? agentModal.agent : undefined}
          onClose={() => setAgentModal(null)}
        />
      )}
    </div>
  );

  // overlay：面板外挂「呼出」钮（面板滑出后左缘可见，点击拉回、不改页）
  return (
    <>
      <style>{STYLE}</style>
      {panel}
      {overlay && !show && (
        <button type="button" className="recall" title="呼出通讯录" onClick={showContacts}>
          <ChevronIcon width={14} height={14} />
          呼出
        </button>
      )}
    </>
  );
}

/** 定稿视觉稿 CSS 移植（类名保持视觉稿结构；令牌与仓库一致：#e6e6e6 线、无 emoji）。 */
const STYLE = `
.top { display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid #f1f1f1; position:relative; }
.top h4 { margin:0; font-size:13.5px; font-weight:800; white-space:nowrap; }
.top .search { margin-left:6px; flex:0 1 150px; min-width:72px; border:1px solid #e6e6e6; border-radius:7px; padding:4px 8px; font-size:11px; color:#1a1a1a; background:#fafafa; outline:none; }
.top .search::placeholder { color:#bbb; }
.top .search:focus { border-color:#bbb; }
.top .acts { margin-left:auto; display:flex; gap:6px; flex:none; }
.top .acts button { white-space:nowrap; border:1px solid #e6e6e6; background:#fff; border-radius:6px; font-size:10.5px; padding:3.5px 8px; color:#555; box-shadow:0 1px 3px rgba(0,0,0,.06); cursor:pointer; }
.top .acts button:disabled { color:#bbb; cursor:default; }

.top .addpop { position:absolute; right:14px; top:100%; margin-top:4px; z-index:30; width:250px; background:#fff; border:1px solid #e6e6e6; border-radius:9px; box-shadow:0 12px 30px rgba(0,0,0,.12); padding:10px; }
.top .addpop-title { font-size:11px; font-weight:700; letter-spacing:.08em; color:#888; margin-bottom:6px; }
.top .addpop-input { flex:1; min-width:0; border:1px solid #e6e6e6; border-radius:6px; padding:4px 8px; font-size:12px; outline:none; }
.top .addpop-input:focus { border-color:#bbb; }
.top .addpop-send { border:none; background:#1a1a1a; color:#fff; border-radius:6px; font-size:12px; padding:4px 10px; cursor:pointer; }
.top .addpop-hint { margin-top:4px; font-size:12px; color:#888; }
.toperr { padding:6px 14px; font-size:11.5px; color:#b42318; background:#fdf3f2; border-bottom:1px solid #f1f1f1; }

.radar { position:relative; flex:1; overflow:hidden; }
.radar-ring { position:absolute; border-radius:50%; border:1px dashed #e8e8e8; left:50%; top:50%; transform:translate(-50%,-50%); }
.radar-ring.solid { border-color:#f0f0f0; }
.scan { position:absolute; left:50%; top:50%; width:2px; height:172px; background:linear-gradient(#1a1a1a00,#1a1a1a22 40%,#1a1a1a44); transform-origin:top center; animation:scan 10s linear infinite; z-index:2; }
@keyframes scan { to { transform:translate(-50%,0) rotate(360deg);} }
.core { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:60px; height:60px; border-radius:50%; background:#1a1a1a; color:#fff; display:flex; flex-direction:column; align-items:center; justify-content:center; font-size:10px; font-weight:700; box-shadow:0 10px 28px rgba(0,0,0,.3); z-index:5; overflow:hidden; }
.core small { font-weight:400; color:#aaa; font-size:8px; margin-top:1px; }
.core-initial { font-size:18px; line-height:1; }
.core-img { width:34px; height:34px; border-radius:50%; object-fit:cover; }

.wedge { position:absolute; left:50%; top:50%; width:1.5px; height:176px; background:repeating-linear-gradient(#e0e0e0 0 5px,transparent 5px 10px); transform-origin:top center; z-index:1; }
.wlabel { position:absolute; font-size:9.5px; font-weight:800; letter-spacing:.18em; color:#c8c8c8; z-index:3; }
.agent-empty { position:absolute; right:16px; bottom:4px; max-width:66%; font-size:9.5px; color:#b8b8b8; z-index:3; text-align:right; }

.node { position:absolute; transform:translate(-50%,-50%); display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer; z-index:6; font-size:9.5px; color:#666; transition:transform .15s; background:none; border:none; padding:0; }
.node:hover { transform:translate(-50%,-50%) scale(1.15); z-index:20; }
.node.far { font-size:8.5px; color:#a8a8a8; }
.node .avwrap { position:relative; display:inline-flex; }
.node .avwrap .bdg { position:absolute; top:-5px; right:-7px; background:#1a1a1a; color:#fff; font-size:8px; border-radius:8px; padding:0 5px; line-height:13px; border:1.5px solid #fff; }
.node-name { max-width:84px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

.hcard { position:absolute; width:210px; background:#fff; border:1px solid #ececec; border-radius:13px; box-shadow:0 18px 46px rgba(0,0,0,.18); padding:13px; z-index:40; display:flex; flex-direction:column; gap:8px; animation:pop .18s ease; }
@keyframes pop { from { opacity:0; transform:translateY(6px);} }
.hcard .ph { display:flex; gap:9px; align-items:center; }
.hcard .hn { font-size:13.5px; font-weight:800; }
.hcard .hs { font-size:9.5px; color:#999; margin-top:1px; }
.hcard .hrow { font-size:10.5px; color:#666; border-top:1px dashed #f0f0f0; padding-top:7px; line-height:1.55; }
.hcard .hrow b { color:#999; font-weight:600; }
.hcard .hb { display:flex; gap:6px; }
.hcard .hb button { flex:1; border:1px solid #e6e6e6; background:#fff; border-radius:7px; font-size:10.5px; padding:5px 0; color:#555; cursor:pointer; }
.hcard .hb button.pri { background:#1a1a1a; color:#fff; border-color:#1a1a1a; }
.hcard .hb button:disabled { color:#bbb; border-color:#e6e6e6; background:#fff; cursor:default; }

.recall { position:absolute; left:0; top:50%; transform:translateY(-50%); width:26px; height:58px; background:#fff; border:1px solid #e6e6e6; border-left:none; border-radius:0 10px 10px 0; box-shadow:6px 0 18px -8px rgba(0,0,0,.28); display:flex; align-items:center; justify-content:center; z-index:50; flex-direction:column; gap:2px; font-size:8.5px; color:#666; cursor:pointer; padding:0; }
.recall svg { stroke:#666; }
`;
