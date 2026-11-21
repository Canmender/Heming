import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { VaultDoc, VaultMeta } from "../../lib/vault/types.js";
import { createTeamKnowledge } from "../../lib/api.js";
import { useTeamKnowledgeStore } from "../../lib/team/teamKnowledgeStore.js";
import { KnowledgePage, type KnowledgeStore } from "./KnowledgePage.js";
import { makeIndex, pageInfo, wikiLink } from "./testFixtures.js";

vi.mock("../../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api.js")>();
  return {
    ...actual,
    createTeamKnowledge: vi.fn(),
    fetchWorkspaceTeams: vi.fn().mockResolvedValue({
      teams: [{ id: "t1", name: "产品组", goal: "", ownerId: "u1", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" }],
    }),
  };
});

const MTIME = "2026-11-08T08:00:00.000Z";
const vault: VaultMeta = {
  id: "v1", name: "我的库", root: "D:/Notes", writeDirs: ["inbox"], addedAt: MTIME,
};
const doc: VaultDoc = {
  vaultId: "v1", rel: "notes/source.md", text: "# 来源\n\n预算与结论", mtime: MTIME, size: 20,
};

function fakeStore(over: Partial<KnowledgeStore> = {}): KnowledgeStore {
  return {
    vaults: [vault],
    activeVaultId: "v1",
    tree: [{ rel: "notes/source.md", name: "source.md", kind: "md", size: 20, mtime: MTIME }],
    index: makeIndex([pageInfo({ rel: "notes/source.md", body: "# 来源\n\n预算与结论" })], [wikiLink({ target: "x", from: "notes/source.md" })]),
    indexStatus: "ready",
    indexProgress: 1,
    openFiles: ["notes/source.md"],
    activeRel: "notes/source.md",
    mode: "split",
    docs: new Map([["notes/source.md", doc]]),
    dirty: new Set<string>(),
    error: null,
    ephemeral: false,
    loadVaults: vi.fn(async () => {}),
    pickVault: vi.fn(async () => {}),
    removeVault: vi.fn(async () => {}),
    setActiveVault: vi.fn(async () => {}),
    refreshTree: vi.fn(async () => {}),
    openFile: vi.fn(async () => {}),
    closeFile: vi.fn(),
    setActiveRel: vi.fn(),
    setMode: vi.fn(),
    editFile: vi.fn(),
    saveFile: vi.fn(async () => true),
    createFile: vi.fn(async () => true),
    createDir: vi.fn(async () => true),
    renameFile: vi.fn(async () => true),
    deleteFile: vi.fn(async () => true),
    buildIndexNow: vi.fn(async () => {}),
    reindexPaths: vi.fn(async () => {}),
    subscribeWatch: vi.fn(() => () => {}),
    backlinksOf: vi.fn(() => []),
    outlinksOf: vi.fn(() => []),
    unresolvedOf: vi.fn(() => []),
    tagsOf: vi.fn(() => []),
    snapshotDocs: vi.fn(() => []),
    lineOffsetOf: vi.fn(() => 0),
    readText: vi.fn(async () => "# 来源\n\n预算与结论"),
    ...over,
  };
}

describe("个人库笔记 → 发布到团队（Phase C）", () => {
  beforeEach(() => {
    vi.mocked(createTeamKnowledge).mockReset().mockResolvedValue({ id: "doc-9" } as never);
    useTeamKnowledgeStore.setState({
      teams: [{ id: "t1", name: "产品组", goal: "", ownerId: "u1", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" }],
    });
  });

  it("个人库有团队且有活动笔记时显示「发布到团队」，确认走 createTeamKnowledge", async () => {
    render(<KnowledgePage store={fakeStore()} />);
    const btn = await screen.findByRole("button", { name: "发布当前笔记到团队" });
    fireEvent.click(btn);
    expect(await screen.findByText(/只发布这一次快照/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
    await waitFor(() => expect(createTeamKnowledge).toHaveBeenCalledTimes(1));
    const [teamId, body] = vi.mocked(createTeamKnowledge).mock.calls[0];
    expect(teamId).toBe("t1");
    expect(body.title).toBe("source");
    expect(body.content).toContain("预算与结论");
  });

  it("有未保存修改时拒绝发布并提示先保存", async () => {
    render(<KnowledgePage store={fakeStore({ dirty: new Set(["notes/source.md"]) })} />);
    fireEvent.click(await screen.findByRole("button", { name: "发布当前笔记到团队" }));
    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
    await waitFor(() => expect(createTeamKnowledge).not.toHaveBeenCalled());
    expect(await screen.findByText(/请先保存当前笔记/)).toBeTruthy();
  });
});
