/**
 * 团队知识库的运行态（zustand）：当前团队的文档列表、搜索、打开的那篇。
 *
 * 为什么独立成 store 而不塞进 useVaultStore：本地库走 IPC（vault:list/read/write/watch），
 * 团队库走 REST（/api/teams/:id/knowledge），写语义与缓存策略都不同。硬塞会污染本地契约。
 * 但它与本地库共用知识库页右上角那个下拉入口——由页面按选中值分派：
 * 个人库 → useVaultStore.setActiveVault()，团队库 → 本 store 的 load()。
 *
 * 隐私口径：智能体不作为团队成员、无服务端身份，不调用这里；团队资料要进本机
 * 智能体检索，必须经"人取回→收藏到个人库→本机 vault_search"的路径。
 */

import { create } from "zustand";
import type { TeamKnowledgeDoc, WorkspaceTeam } from "@heming/shared";
import {
  fetchTeamKnowledge,
  searchTeamKnowledge,
  fetchTeamKnowledgeDoc,
  fetchWorkspaceTeams,
} from "../api.js";

export interface TeamKnowledgeState {
  /** 我加入/拥有的团队（下拉 optgroup 用；失败为空数组，不挡个人库）。 */
  teams: WorkspaceTeam[];
  /** 当前团队文档列表（含搜索结果）。 */
  docs: TeamKnowledgeDoc[];
  /** 当前打开的那篇正文（详情接口返回，含 content）。 */
  activeDoc: TeamKnowledgeDoc | null;
  /** 当前搜索词；空串 = 列全量。 */
  query: string;
  /** 正在请求（列表/搜索/详情任一）。 */
  loading: boolean;
  /** 失败文案；空串 = 无错误。 */
  error: string;
  /** 拉团队列表（幂等）。 */
  loadTeams: () => Promise<void>;
  /** 切团队/刷新列表：清掉旧团队的文档与选中项再拉。 */
  load: (teamId: string) => Promise<void>;
  /** 搜索当前团队（空 query 回落全量）。 */
  search: (teamId: string, q: string) => Promise<void>;
  /** 打开一篇文档（拉正文）。 */
  openDoc: (teamId: string, docId: string) => Promise<void>;
  /** 清空（切回个人库时调用，避免团队内容残留在内存）。 */
  reset: () => void;
}

/** 请求竞态序号：切队/搜索并发时只让最新一次落地。 */
let seq = 0;

export const useTeamKnowledgeStore = create<TeamKnowledgeState>((set) => ({
  teams: [],
  docs: [],
  activeDoc: null,
  query: "",
  loading: false,
  error: "",
  loadTeams: async () => {
    try {
      const data = await fetchWorkspaceTeams();
      set({ teams: data.teams });
    } catch {
      // 团队列表是增强：拿不到时下拉里就没有团队选项，个人库不受影响。
      set({ teams: [] });
    }
  },
  load: async (teamId) => {
    const mine = ++seq;
    set({ docs: [], activeDoc: null, query: "", loading: true, error: "" });
    try {
      const data = await fetchTeamKnowledge(teamId);
      if (mine !== seq) return;
      set({ docs: data.docs, loading: false });
    } catch {
      if (mine !== seq) return;
      set({ error: "团队知识库没拉下来：可能是网络或登录态问题。", loading: false });
    }
  },
  search: async (teamId, q) => {
    const mine = ++seq;
    set({ query: q, loading: true, error: "" });
    try {
      const data = q.trim()
        ? await searchTeamKnowledge(teamId, q.trim())
        : await fetchTeamKnowledge(teamId);
      if (mine !== seq) return;
      set({ docs: data.docs, activeDoc: null, loading: false });
    } catch {
      if (mine !== seq) return;
      set({ error: "搜索没成功，稍后重试。", loading: false });
    }
  },
  openDoc: async (teamId, docId) => {
    const mine = ++seq;
    set({ activeDoc: null, loading: true, error: "" });
    try {
      const doc = await fetchTeamKnowledgeDoc(teamId, docId);
      if (mine !== seq) return;
      set({ activeDoc: doc, loading: false });
    } catch {
      if (mine !== seq) return;
      set({ error: "文档没打开，稍后重试。", loading: false });
    }
  },
  reset: () => {
    seq++;
    set({ docs: [], activeDoc: null, query: "", loading: false, error: "" });
  },
}));
