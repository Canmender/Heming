import { useRef, useState } from "react";
import { useChatStore } from "../store/chat.js";
import { useAuthStore } from "../store/auth.js";

/**
 * 新建群聊弹窗：群名 + 好友多选 + **自建智能体多选**（M3 I2 入群接线）→
 * useChatStore.createGroup（POST /api/conversations 后 reload）→ 对每个勾选 agent 逐一
 * attachAgentToGroup（先建群再挂载；挂载失败不回滚群，单独提示）。
 * open=false 时所有 hooks 已先执行完毕再早返回（hooks 规则）。
 */
export function GroupCreateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const friends = useChatStore((s) => s.friends);
  const agentsRoster = useChatStore((s) => s.agentsRoster);
  const createGroup = useChatStore((s) => s.createGroup);
  const attachAgentToGroup = useChatStore((s) => s.attachAgentToGroup);
  const me = useAuthStore((s) => s.user);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  /** 勾选要带入群的自建智能体 id（owner = 我；系统/他人名册项不出现）。 */
  const [pickedAgents, setPickedAgents] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  // 同步提交互斥：state 闭包在同帧双击下仍是旧值（真实浏览器已复现二次 POST），
  // ref 在渲染外即时翻转，与 ChatPage 的 wsHandleRef 同一模式
  const pendingRef = useRef(false);
  if (!open) return null;

  // 源 = 名册全量中 owner 是我的项（雷达/弹窗共用同一 GET /api/agents 结果）
  const myAgents = me ? agentsRoster.filter((a) => a.owner_id === me.id) : [];

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleAgent = (id: string) =>
    setPickedAgents((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // pending 守卫与空名校验分开：双击/连点期间不误报「请输入群名称」
    if (pendingRef.current) return;
    if (!name.trim()) {
      setError("请输入群名称");
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError("");
    try {
      const convId = await createGroup(name.trim(), picked);
      // 先建群、再逐个挂载（挂载失败**不回滚群**）：失败名单单独提示；
      // 名称/勾选清空防止用户在错误提示下重提造成同名重复建群
      const failed: string[] = [];
      for (const id of pickedAgents) {
        const label = myAgents.find((a) => a.id === id)?.name ?? id;
        try {
          await attachAgentToGroup(convId, id);
        } catch (err) {
          failed.push(`${label}（${(err as Error).message}）`);
        }
      }
      setName("");
      setPicked([]);
      setPickedAgents([]);
      if (failed.length > 0) {
        // 弹窗保持打开以显示提示（群已建成，不回滚）；点「取消」关闭
        setError(`群已创建，但部分智能体加入失败：${failed.join("、")}`);
        return;
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
      <form
        onSubmit={submit}
        className="w-[320px] rounded-xl border border-line bg-white p-5 shadow-card"
      >
        <h3 className="mb-3 text-[14px] font-bold">新建群聊</h3>
        <input
          className="mb-3 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]"
          placeholder="群名称"
          maxLength={32}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="mb-3 max-h-[140px] overflow-y-auto">
          {friends.length === 0 ? (
            <div className="text-[12px] text-muted">暂无好友可邀请</div>
          ) : (
            friends.map((f) => (
              <label key={f.id} className="flex items-center gap-2 py-1 text-[13px]">
                <input
                  type="checkbox"
                  aria-label={`选择成员 ${f.user.displayName}`}
                  checked={picked.includes(f.user.id)}
                  onChange={() => toggle(f.user.id)}
                />
                {f.user.displayName}
              </label>
            ))
          )}
        </div>
        {/* 智能体段（M3 I2）：只列我自建的名册项；无自建项时给一行空态说明 */}
        <div className="mb-3 max-h-[120px] overflow-y-auto border-t border-line-soft pt-2">
          <div className="mb-1 text-[12px] font-bold text-muted">智能体</div>
          {myAgents.length === 0 ? (
            <div className="text-[12px] text-muted">暂无自建智能体（可先在通讯录新建）</div>
          ) : (
            myAgents.map((a) => (
              <label key={a.id} className="flex items-center gap-2 py-1 text-[13px]">
                <input
                  type="checkbox"
                  aria-label={`选择智能体 ${a.name}`}
                  checked={pickedAgents.includes(a.id)}
                  onChange={() => toggleAgent(a.id)}
                />
                {a.name}
              </label>
            ))
          )}
        </div>
        {error && <div className="mb-2 text-[12px] text-red-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-1.5 text-[13px]"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-ink px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60"
          >
            创建
          </button>
        </div>
      </form>
    </div>
  );
}
