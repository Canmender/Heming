import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TeamUsageResponse } from "@heming/shared";
import { fetchTeamUsage, uploadTeamUsage } from "../lib/api.js";
import { HomeTeamUsage } from "./HomeTeamUsage.js";
import { useAuthStore } from "../store/auth.js";
import { dayKeyOf, useTokenUsageStore } from "../store/tokenUsage.js";
import { useUiStore } from "../store/ui.js";
import { DEFAULT_TEAM_SHARE, useTeamShareStore } from "../lib/team/share.js";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, fetchTeamUsage: vi.fn(), uploadTeamUsage: vi.fn() };
});

const me = { id: "u1", username: "alice", displayName: "爱丽丝" };
const bob = { id: "u2", username: "bob", displayName: "鲍勃" };
const nowIso = new Date().toISOString();

function usageResponse(over: Partial<TeamUsageResponse> = {}): TeamUsageResponse {
  return {
    range: "30d",
    from: "2026-10-09",
    to: "2026-11-07",
    self: {
      total: 1234,
      unreported: 1,
      byModel: [{ model: "gpt-x", tokens: 1234, unreported: 1, connections: ["主连接"] }],
      byDay: [{ date: "2026-11-07", tokens: 1234, unreported: 1 }],
    },
    ranking: [
      { userId: bob.id, displayName: "鲍勃", tokens: 90_000, unreported: 0, days: 3 },
      { userId: me.id, displayName: "爱丽丝", tokens: 1234, unreported: 1, days: 1 },
    ],
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  useTeamShareStore.setState({ settings: { ...DEFAULT_TEAM_SHARE } });
  useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
  useUiStore.setState({ page: "home" });
  useTokenUsageStore.setState({
    records: [{ model: "gpt-x", tokens: 700, at: nowIso, profileLabel: "主连接" }],
  });
  vi.mocked(fetchTeamUsage).mockResolvedValue(usageResponse());
  vi.mocked(uploadTeamUsage).mockResolvedValue({ written: 1, stored: 1 });
  vi.mocked(fetchTeamUsage).mockClear();
  vi.mocked(uploadTeamUsage).mockClear();
});

describe("首页 Token 用量卡的「团队」页签", () => {
  it("共享关闭：不采集不上传不请求，只给说明与开启入口", async () => {
    render(<HomeTeamUsage />);
    expect(screen.getByText(/「用量」共享未开启/)).toBeInTheDocument();
    expect(fetchTeamUsage).not.toHaveBeenCalled();
    expect(uploadTeamUsage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "去团队页开启" }));
    expect(useUiStore.getState().page).toBe("team");
  });

  it("共享开启：先同步白名单摘要再拉排行，前 5 名只显示名与 token 数", async () => {
    useTeamShareStore.setState({ settings: { ...DEFAULT_TEAM_SHARE, usage: true } });
    render(<HomeTeamUsage />);

    await waitFor(() => expect(screen.getByText("鲍勃")).toBeInTheDocument());
    expect(uploadTeamUsage).toHaveBeenCalledTimes(1);
    // 上传内容只有白名单字段：日期/模型/token 数/未上报数/连接名
    const payload = vi.mocked(uploadTeamUsage).mock.calls[0][0];
    // 客户端上报的是**本地自然日**（契约），UTC 切片在跨零点时会差一天
    expect(payload[0]).toMatchObject({ date: dayKeyOf(new Date().toISOString()), model: "gpt-x", tokens: 700 });
    expect(JSON.stringify(payload)).not.toMatch(/prompt|content|args|result/);

    expect(fetchTeamUsage).toHaveBeenCalledWith({ range: "30d", to: expect.any(String) });
    expect(screen.getByText("（我）")).toBeInTheDocument();
    expect(screen.getByText("9.0 万")).toBeInTheDocument(); // 排行千位以上压成「万」
    expect(screen.getByText(/我的用量/)).toBeInTheDocument();
    // 模型名/连接名在排行里不出现（只给显示名与聚合数）
    expect(screen.queryByText("gpt-x")).not.toBeInTheDocument();
  });

  it("排行为空：说明去哪儿同步，不显示假名次", async () => {
    useTeamShareStore.setState({ settings: { ...DEFAULT_TEAM_SHARE, usage: true } });
    vi.mocked(fetchTeamUsage).mockResolvedValue(usageResponse({ ranking: [] }));
    render(<HomeTeamUsage />);

    await waitFor(() => expect(screen.getByText("还没有排行数据")).toBeInTheDocument());
    expect(screen.queryByText("（我）")).not.toBeInTheDocument();
  });

  it("拉取失败：可见报错并可重试", async () => {
    useTeamShareStore.setState({ settings: { ...DEFAULT_TEAM_SHARE, usage: true } });
    vi.mocked(fetchTeamUsage).mockRejectedValueOnce(new Error("网络异常"));
    render(<HomeTeamUsage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(/用量排行加载失败/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText("鲍勃")).toBeInTheDocument());
  });
});
