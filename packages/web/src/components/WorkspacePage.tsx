import { useEffect, useState } from "react";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { requestFriend, acceptFriend } from "../lib/api.js";
import { ChatIcon } from "./icons.js";

export function WorkspacePage() {
  const { conversations, friends, incoming, loadWorkspace, openDirect } = useChatStore();
  const openConversation = useUiStore((s) => s.openConversation);
  const me = useAuthStore((s) => s.user);
  const [addName, setAddName] = useState("");
  const [hint, setHint] = useState("");

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await requestFriend(addName.trim());
      setHint("申请已发送");
      setAddName("");
    } catch (err) {
      setHint((err as Error).message);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      <h1 className="mb-3 text-lg font-extrabold">工作区</h1>

      <section className="mb-5">
        <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">
          好友申请
        </div>
        {incoming.length === 0 ? (
          <div className="text-[13px] text-muted">没有待处理申请</div>
        ) : (
          incoming.map((r) => (
            <div key={r.id} className="mb-1.5 flex items-center gap-2 text-[13px]">
              <span className="font-medium">{r.from.displayName}</span>
              <span className="text-muted">@{r.from.username}</span>
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
        <form onSubmit={onAdd} className="mt-2 flex gap-2">
          <input
            className="rounded-md border border-line px-2 py-1 text-[13px] outline-none focus:border-[#bbb]"
            placeholder="按用户名加好友"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
          />
          <button type="submit" className="rounded-md bg-ink px-3 py-1 text-[12px] font-bold text-white">
            发送
          </button>
          {hint && <span className="self-center text-[12px] text-muted">{hint}</span>}
        </form>
      </section>

      <section className="mb-5">
        <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">好友</div>
        {friends.length === 0 ? (
          <div className="text-[13px] text-muted">还没有好友</div>
        ) : (
          friends.map((f) => (
            <button
              key={f.id}
              type="button"
              className="mb-1.5 flex w-full items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-left text-[13px] shadow-card hover:shadow-float"
              onClick={() => void openDirect(f.user.id).then(openConversation)}
            >
              <ChatIcon width={15} height={15} className="text-muted" />
              <span className="font-medium">{f.user.displayName}</span>
              <span className="text-muted">@{f.user.username}</span>
              {f.user.id === me?.id && <span className="ml-auto text-[11px] text-muted">我</span>}
            </button>
          ))
        )}
      </section>

      <section>
        <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">直聊</div>
        {conversations.length === 0 ? (
          <div className="text-[13px] text-muted">暂无会话</div>
        ) : (
          conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              className="mb-1.5 flex w-full items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-left text-[13px] shadow-card hover:shadow-float"
              onClick={() => openConversation(c.id)}
            >
              <span className="font-medium">{c.peer.displayName}</span>
              <span className="text-muted">@{c.peer.username}</span>
            </button>
          ))
        )}
        <div className="mt-4 text-[11px] text-muted">群聊（纯 Agent / 预设混合群）在 M3 开放</div>
      </section>
    </div>
  );
}
