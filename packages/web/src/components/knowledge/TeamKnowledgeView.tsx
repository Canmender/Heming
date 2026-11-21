/**
 * 团队知识库视图（知识库页选到某团队时渲染，替换个人库三栏）。
 *
 * 左栏 = 团队文档列表 + 全文搜索；中栏 = 只读 Markdown 预览（复用 PreviewPane 的
 * react-markdown + GFM + 数学 + 双链渲染链，但不给编辑器，不能改本机/服务端正文）。
 * 右栏不显示个人库专属的反链/大纲（团队库没有本地索引）。
 *
 * 数据全走 useTeamKnowledgeStore（REST），智能体不参与（无服务端身份）。
 * 这是 Phase B 的"看"半边；Phase C 的"发布/收藏"双向动作后续再接。
 */

import { useEffect, useState } from "react";
import { useTeamKnowledgeStore } from "../../lib/team/teamKnowledgeStore.js";
import { favoriteMarkdown, favoriteRel } from "../../lib/team/teamKnowledgeShare.js";
import { useVaultStore } from "../../lib/vault/store.js";
import { Button } from "../ui/Button.js";
import { PreviewPane } from "./PreviewPane.js";

export interface TeamKnowledgeViewProps {
  teamId: string;
  teamName: string;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function TeamKnowledgeView({ teamId, teamName }: TeamKnowledgeViewProps) {
  const docs = useTeamKnowledgeStore((s) => s.docs);
  const activeDoc = useTeamKnowledgeStore((s) => s.activeDoc);
  const query = useTeamKnowledgeStore((s) => s.query);
  const loading = useTeamKnowledgeStore((s) => s.loading);
  const error = useTeamKnowledgeStore((s) => s.error);
  const load = useTeamKnowledgeStore((s) => s.load);
  const search = useTeamKnowledgeStore((s) => s.search);
  const openDoc = useTeamKnowledgeStore((s) => s.openDoc);
  const vaultStore = useVaultStore();
  const [favorited, setFavorited] = useState<string[]>([]);
  const [favNotice, setFavNotice] = useState("");

  // 切团队时拉该团队文档（store.load 内部会先清空旧团队内容）。
  useEffect(() => {
    void load(teamId);
  }, [teamId, load]);

  /** 收藏到个人库：写本地 Markdown（_team/{团队}/{标题}.md），本机智能体随后可检索。 */
  const favoriteToPersonal = async () => {
    if (!activeDoc || !vaultStore.activeVaultId) {
      setFavNotice("请先打开一个本地知识库，再收藏团队文档。");
      return;
    }
    const rel = favoriteRel(teamName, activeDoc.title);
    const ok = await vaultStore.createFile(rel, favoriteMarkdown(activeDoc, teamName));
    if (ok) {
      setFavorited((prev) => [...prev, activeDoc.id]);
      setFavNotice(`已收藏到个人库：${rel}`);
      await vaultStore.refreshTree();
    } else {
      setFavNotice("收藏失败：本地库可能有同名文件，或没有桌面文件桥。");
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        data-testid="team-knowledge-left"
        className="flex w-[248px] shrink-0 flex-col border-r border-line-soft bg-panel"
      >
        <h2 className="sr-only">{teamName} 的知识文档</h2>
        <div className="shrink-0 border-b border-line-soft p-1.5">
          <input
            className="ui-input h-7 w-full text-ui-md"
            aria-label="搜索团队知识库"
            placeholder="搜索团队文档…"
            value={query}
            onChange={(e) => void search(teamId, e.target.value)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
          {loading ? <p className="px-2 py-3 text-ui-md text-muted">正在拉文档…</p> : null}
          {error ? <p className="px-2 py-3 text-ui-md text-danger">{error}</p> : null}
          {!loading && !error && docs.length === 0 ? (
            <p className="px-2 py-3 text-ui-md text-muted">
              这个团队还没有知识文档。成员把自己库里的笔记「发布到团队」后，就会出现在这里。
            </p>
          ) : null}
          {docs.map((doc) => (
            <button
              key={doc.id}
              type="button"
              data-testid="team-knowledge-doc"
              aria-current={activeDoc?.id === doc.id ? "true" : undefined}
              onClick={() => void openDoc(teamId, doc.id)}
              className={`block w-full truncate rounded-sm px-2 py-1.5 text-left text-ui-md ${
                activeDoc?.id === doc.id
                  ? "bg-subtle-2 font-medium text-ink"
                  : "text-body hover:bg-subtle-3 hover:text-ink"
              }`}
              title={doc.title}
            >
              {doc.pinned ? "📌 " : ""}
              {doc.title}
              <span className="block truncate text-ui-sm text-muted">{fmtTime(doc.updatedAt)}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col" aria-label="团队文档正文">
        {activeDoc ? (
          <>
            <div className="shrink-0 border-b border-line-soft px-4 py-3">
              <h1 className="truncate text-ui-xl font-semibold text-ink" title={activeDoc.title}>
                {activeDoc.title}
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                <p className="ui-caption text-muted">
                  {fmtTime(activeDoc.updatedAt)} · 团队共享副本，改请从个人库发布
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={favorited.includes(activeDoc.id)}
                  onClick={() => void favoriteToPersonal()}
                >
                  {favorited.includes(activeDoc.id) ? "已收藏到个人库" : "收藏到我的知识库"}
                </Button>
              </div>
              {favNotice ? <p className="ui-caption mt-1 text-muted">{favNotice}</p> : null}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <PreviewPane rel="" text={activeDoc.content} index={null} />
            </div>
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-ui-md text-body">从左侧选一篇文档，在这里只读查看。</p>
            <Button type="button" size="sm" variant="ghost" onClick={() => void load(teamId)}>
              刷新列表
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
