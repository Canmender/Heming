import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TeamKnowledgeDoc } from "@heming/shared";
import { TeamKnowledgeView } from "./TeamKnowledgeView.js";
import {
  fetchTeamKnowledge,
  fetchTeamKnowledgeDoc,
  searchTeamKnowledge,
  fetchWorkspaceTeams,
} from "../../lib/api.js";
import { useVaultStore } from "../../lib/vault/store.js";

vi.mock("../../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api.js")>();
  return {
    ...actual,
    fetchWorkspaceTeams: vi.fn(),
    fetchTeamKnowledge: vi.fn(),
    fetchTeamKnowledgeDoc: vi.fn(),
    searchTeamKnowledge: vi.fn(),
  };
});

const DOC: TeamKnowledgeDoc = {
  id: "doc-1",
  teamId: "t1",
  authorId: "u1",
  title: "预算与结论",
  content: "# 预算\n\n这是团队共享的结论。",
  sourceVault: null,
  tags: ["预算"],
  pinned: true,
  createdAt: "2026-11-20T08:00:00.000Z",
  updatedAt: "2026-11-20T09:00:00.000Z",
};

describe("团队知识库视图（Phase B）", () => {
  beforeEach(() => {
    vi.mocked(fetchWorkspaceTeams).mockResolvedValue({
      teams: [
        {
          id: "t1",
          name: "产品组",
          goal: "",
          ownerId: "u1",
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    });
    vi.mocked(fetchTeamKnowledge).mockResolvedValue({ docs: [DOC] });
    vi.mocked(fetchTeamKnowledgeDoc).mockResolvedValue(DOC);
    vi.mocked(searchTeamKnowledge).mockResolvedValue({ docs: [DOC] });
  });

  it("列出团队文档，点开后只读渲染标题与正文，不提供编辑器", async () => {
    render(<TeamKnowledgeView teamId="t1" teamName="产品组" />);
    // 标题被拆进按钮（📌 + 标题 + 时间），用按钮的 title 属性定位
    const docButton = await screen.findByTestId("team-knowledge-doc");
    expect(docButton.getAttribute("title")).toBe("预算与结论");

    fireEvent.click(docButton);
    await waitFor(() => {
      expect(screen.getByText(/团队共享副本，改请从个人库发布/)).toBeTruthy();
    });
    expect(screen.getByText("这是团队共享的结论。")).toBeTruthy();
    // 只读语义：没有源码编辑框
    expect(screen.queryByRole("textbox", { name: /编辑/ })).toBeNull();
    expect(fetchTeamKnowledgeDoc).toHaveBeenCalledWith("t1", "doc-1");
  });

  it("搜索框输入后走搜索接口而不是全量列表", async () => {
    render(<TeamKnowledgeView teamId="t1" teamName="产品组" />);
    await screen.findByTestId("team-knowledge-doc");
    const box = screen.getByLabelText("搜索团队知识库");
    fireEvent.change(box, { target: { value: "预算" } });
    await waitFor(() => {
      expect(searchTeamKnowledge).toHaveBeenCalledWith("t1", "预算");
    });
  });

  it("空团队给出「还没有知识文档」引导，不报错", async () => {
    vi.mocked(fetchTeamKnowledge).mockResolvedValue({ docs: [] });
    render(<TeamKnowledgeView teamId="t1" teamName="产品组" />);
    expect(await screen.findByText(/还没有知识文档/)).toBeTruthy();
  });

  it("收藏到个人库：写本地 _team/ 路径并提示，重复点置灰", async () => {
    const createFile = vi.fn().mockResolvedValue(true);
    const refreshTree = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ activeVaultId: "v1", createFile, refreshTree } as never);

    render(<TeamKnowledgeView teamId="t1" teamName="产品组" />);
    const docButton = await screen.findByTestId("team-knowledge-doc");
    fireEvent.click(docButton);
    await screen.findByText(/团队共享副本/);

    const fav = screen.getByRole("button", { name: "收藏到我的知识库" });
    fireEvent.click(fav);
    await waitFor(() => {
      expect(createFile).toHaveBeenCalledTimes(1);
    });
    const [rel, text] = createFile.mock.calls[0];
    expect(rel).toBe("_team/产品组/预算与结论.md");
    expect(text).toContain("teamDocId");
    expect(text).toContain("团队共享的结论");
    // 提示含完整路径；按钮此时也变成「已收藏到个人库」，故用更长的路径串精确定位提示
    expect(await screen.findByText(/已收藏到个人库：_team\//)).toBeTruthy();
  });
});
