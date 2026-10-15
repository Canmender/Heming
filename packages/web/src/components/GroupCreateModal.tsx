import { useState } from "react";
import { useChatStore } from "../store/chat.js";

/**
 * 新建群聊弹窗：群名 + 好友多选 → useChatStore.createGroup（POST /api/conversations 后 reload）。
 * open=false 时所有 hooks 已先执行完毕再早返回（hooks 规则）。
 */
export function GroupCreateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const friends = useChatStore((s) => s.friends);
  const createGroup = useChatStore((s) => s.createGroup);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  if (!open) return null;

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || pending) {
      setError("请输入群名称");
      return;
    }
    setPending(true);
    setError("");
    try {
      await createGroup(name.trim(), picked);
      setName("");
      setPicked([]);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
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
        <div className="mb-3 max-h-[180px] overflow-y-auto">
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
            className="rounded-lg bg-ink px-3 py-1.5 text-[13px] font-bold text-white"
          >
            创建
          </button>
        </div>
      </form>
    </div>
  );
}
