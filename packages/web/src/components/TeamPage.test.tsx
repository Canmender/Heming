import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TeamActivity, TeamUsageResponse } from "@heming/shared";
import {
  clearMyTeamUsage,
  fetchTeam,
  fetchTeamActivities,
  fetchTeamUsage,
  uploadTeamActivities,
  uploadTeamUsage,
} from "../lib/api.js";
import { TeamPage } from "./TeamPage.js";
import { useAuthStore } from "../store/auth.js";
import { useUiStore } from "../store/ui.js";
import { useTokenUsageStore } from "../store/tokenUsage.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import { DEFAULT_TEAM_SHARE, useTeamShareStore } from "../lib/team/share.js";

// 只替换团队相关的 API：其余导出（getToken 等）必须保留真实实现，
// 否则 auth store 初始化就会炸。
vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    fetchTeam: vi.fn(),
    fetchTeamActivities: vi.fn(),
    fetchTeamUsage: vi.fn(),
    uploadTeamActivities: vi.fn(),
    uploadTeamUsage: vi.fn(),
    clearMyTeamActivities: vi.fn(),
    clearMyTeamUsage: vi.fn(),
  };
});

/**
 * 团队页 ②-3：用量排行（默认只看本人，开启共享才上传/可见排行）与团队日程（只读摘要）。
 *
 * 两个验收重点：
 * - 隐私：关闭共享时**不采集、不上传**，请求体里只有白名单字段；
 * - 口径：排行按 token 降序，未上报单独展示（不是 0）。
 */

const me = { id: "u1", username: "alice", displayName: "爱丽丝" };
const bob = { id: "u2", username: "bob", displayName: "鲍勃" };
const nowIso = new Date().toISOString();

function member(user: typeof me, online = false) {
  return { user, lastSeenAt: nowIso, online };
}

function activity(over: Partial<TeamActivity>): TeamActivity {
  return {
    id: "a1",
    actorId: me.id,
    kind: "agenda",
    title: "项目周会",
    detail: "日程 · 今天到期",
    sourceId: "agenda:1",
    occurredAt: nowIso,
    createdAt: nowIso,
    ...over,
  };
}

function usageResponse(over: Partial<TeamUsageResponse> = {}): TeamUsageResponse {
  return {
    range: "7d",
    from: "2026-10-27",
    to: "2026-11-02",
    self: {
      total: 1234,
      unreported: 2,
      byModel: [
        { model: "gpt-x", tokens: 1000, unreported: 1, connections: ["主连接"] },
        { model: "claude-y", tokens: 234, unreported: 1, connections: [] },
      ],
      byDay: [{ date: "2026-11-02", tokens: 1234, unreported: 2 }],
    },
    ranking: [
      { userId: bob.id, displayName: "鲍勃", tokens: 9000, unreported: 0, days: 3 },
      { userId: me.id, displayName: "爱丽丝", tokens: 1234, unreported: 2, days: 1 },
    ],
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  useTeamShareStore.setState({ settings: { ...DEFAULT_TEAM_SHARE } });
  useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
  useUiStore.setState({ page: "team", activeConversationId: null, teamFocusUserId: null });
  useInfohubStore.setState({ running: false, available: false, agenda: null });
  useTokenUsageStore.setState({
    records: [
      { model: "gpt-x", tokens: 700, at: nowIso, profileLabel: "主连接" },
      { model: "gpt-x", tokens: null, at: nowIso, profileLabel: "主连接" },
    ],
  });
  vi.mocked(fetchTeam).mockResolvedValue({
    members: [member(me, true), member(bob)],
    onlineCount: 1,
  });
  vi.mocked(fetchTeamActivities).mockResolvedValue({ activities: [] });
  vi.mocked(fetchTeamUsage).mockResolvedValue(usageResponse());
  vi.mocked(uploadTeamActivities).mockResolvedValue({ inserted: 0, skipped: 0 });
  vi.mocked(uploadTeamUsage).mockResolvedValue({ written: 0, stored: 0 });
  vi.mocked(clearMyTeamUsage).mockResolvedValue({ deleted: 0 });
  for (const fn of [
    fetchTeam,
    fetchTeamActivities,
    fetchTeamUsage,
    uploadTeamActivities,
    uploadTeamUsage,
    clearMyTeamUsage,
  ]) {
    vi.mocked(fn).mockClear();
  }
});

async function renderPage() {
  render(<TeamPage />);
  await waitFor(() => expect(screen.getByText(/名真实成员/)).toBeInTheDocument());
}

describe("团队用量：默认关闭只看本人", () => {
  it("默认关闭：不上传、不采集、不拉排行；用量区显示本机统计", async () => {
    await renderPage();
    // 三个开关默认关
    expect(screen.getByLabelText("共享用量")).not.toBeChecked();

    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
    expect(screen.getByText("本机用量（仅自己可见）")).toBeInTheDocument();
    expect(screen.getByText(/不上传、不采集/)).toBeInTheDocument();
    expect(screen.getAllByText(/700/).length).toBeGreaterThan(0); // 本机合计（明细也含同值）
    expect(screen.getAllByText(/未上报 1 轮/).length).toBeGreaterThan(0);

    // 隐私红线：关闭时没有任何用量请求（GET 也不发，排行数据不进内存）
    expect(uploadTeamUsage).not.toHaveBeenCalled();
    expect(fetchTeamUsage).not.toHaveBeenCalled();
  });

  it("开启共享后：只上传白名单字段并展示排行（按 token 降序）", async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText("共享用量"));

    await waitFor(() => expect(uploadTeamUsage).toHaveBeenCalledTimes(1));
    const items = vi.mocked(uploadTeamUsage).mock.calls[0]![0];
    expect(items).toEqual([
      { date: expect.any(String), model: "gpt-x", tokens: 700, unreported: 1, connections: ["主连接"] },
    ]);
    // 请求体白名单：不含提示词 / 正文 / 参数 / 结果
    const raw = JSON.stringify(items);
    for (const forbidden of ["prompt", "content", '"text"', "args", "result"]) {
      expect(raw).not.toContain(forbidden);
    }
    expect(fetchTeamUsage).toHaveBeenCalledWith({ range: "7d", to: expect.any(String) });

    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
    const ranking = await screen.findByRole("region", { name: "团队用量排行" });
    const rows = within(ranking).getAllByRole("listitem");
    // 服务端已排序，界面再排一次兜底：9000 在前
    expect(rows[0]).toHaveTextContent("鲍勃");
    expect(rows[1]).toHaveTextContent("爱丽丝（我）");
    expect(rows[1]).toHaveTextContent("未上报 2 轮");
    // 明细里的模型名与连接名只在「我的用量」出现
    const mine = screen.getByRole("region", { name: "我的用量" });
    expect(mine).toHaveTextContent("gpt-x");
    expect(mine).toHaveTextContent("主连接");
    expect(ranking).not.toHaveTextContent("gpt-x");
  });

  it("排行空态：没有成员共享时给可解释文案", async () => {
    vi.mocked(fetchTeamUsage).mockResolvedValue(usageResponse({ ranking: [] }));
    await renderPage();
    fireEvent.click(screen.getByLabelText("共享用量"));
    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
    expect(await screen.findByText("还没有成员共享用量。")).toBeInTheDocument();
  });

  it("区间切换会带 range 重新拉取", async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText("共享用量"));
    await waitFor(() => expect(fetchTeamUsage).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
    fireEvent.click(screen.getByRole("button", { name: "近 30 天" }));
    await waitFor(() =>
      expect(fetchTeamUsage).toHaveBeenLastCalledWith({ range: "30d", to: expect.any(String) }),
    );
  });
});

describe("团队用量：清除已上传记录", () => {
  it("关闭共享只停上传、不删旧行：不清除服务端数据，并提示可手动清除", async () => {
    // 先开着共享把数据拉回来
    useTeamShareStore.setState({
      settings: { ...DEFAULT_TEAM_SHARE, usage: true },
    });
    await renderPage();
    await waitFor(() => expect(fetchTeamUsage).toHaveBeenCalledTimes(1));

    // 关掉开关：只是停未来上传，绝不自动删（避免误伤）
    fireEvent.click(screen.getByLabelText("共享用量"));
    expect(clearMyTeamUsage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
    expect(screen.getByText(/已停止上传/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清除我的用量" })).toBeInTheDocument();
  });

  it("点「清除我的用量」二次确认后才删，删完重拉排行且不再含本人", async () => {
    vi.mocked(clearMyTeamUsage).mockResolvedValue({ deleted: 2 });
    // 第二次拉取：本人行已删，排行只剩鲍勃
    vi.mocked(fetchTeamUsage)
      .mockResolvedValueOnce(usageResponse())
      .mockResolvedValue(
        usageResponse({
          self: { total: 0, unreported: 0, byModel: [], byDay: [] },
          ranking: [{ userId: bob.id, displayName: "鲍勃", tokens: 9000, unreported: 0, days: 3 }],
        }),
      );

    await renderPage();
    fireEvent.click(screen.getByLabelText("共享用量"));
    await waitFor(() => expect(fetchTeamUsage).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: "用量" }));

    // 有已上传数据 → 出现清除入口；点击先出确认框（不直接删）
    fireEvent.click(await screen.findByRole("button", { name: "清除我的用量" }));
    expect(clearMyTeamUsage).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "清除我的用量" });
    expect(within(dialog).getByText(/删除后你不再出现在/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "清除" }));
    await waitFor(() => expect(clearMyTeamUsage).toHaveBeenCalledTimes(1));
    // 删完重拉排行：本人消失，只剩鲍勃
    await waitFor(() => expect(fetchTeamUsage).toHaveBeenCalledTimes(2));
    const ranking = screen.getByRole("region", { name: "团队用量排行" });
    await waitFor(() =>
      expect(within(ranking).getAllByRole("listitem")).toHaveLength(1),
    );
    expect(within(ranking).queryByText(/爱丽丝/)).toBeNull();
    expect(within(ranking).getByText("鲍勃")).toBeInTheDocument();
    // 本地水位已落：水位之前的用量不会被下一轮同步再传回去
    expect(useTeamShareStore.getState().settings.usageClearedAt).toBeTypeOf("number");
  });
});

describe("团队日程：只读摘要", () => {
  it("未连接信息中枢：空态写明「仅本机可见」，且不自动拉起、不上传", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "团队日程" }));
    expect(screen.getByText("仅本机可见")).toBeInTheDocument();
    expect(screen.getByText(/不会自动拉起/)).toBeInTheDocument();
    expect(uploadTeamActivities).not.toHaveBeenCalled();
    expect(useInfohubStore.getState().running).toBe(false);
  });

  it("有日程摘要时按时间列出，只读（不新增任何上传）", async () => {
    vi.mocked(fetchTeamActivities).mockResolvedValue({
      activities: [
        activity({ id: "a1", title: "项目周会", occurredAt: "2026-11-02T09:00:00.000Z" }),
        activity({
          id: "a2",
          actorId: bob.id,
          title: "客户回访",
          occurredAt: "2026-11-01T09:00:00.000Z",
        }),
        activity({ id: "t1", kind: "task", title: "不该出现在日程区" }),
      ],
    });
    await renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "团队日程" }));

    expect(await screen.findByText("项目周会")).toBeInTheDocument();
    expect(screen.getByText("客户回访")).toBeInTheDocument();
    expect(screen.queryByText("不该出现在日程区")).not.toBeInTheDocument();
    // 只读：没有新的上传/请求副作用
    expect(uploadTeamActivities).not.toHaveBeenCalled();
    expect(uploadTeamUsage).not.toHaveBeenCalled();
  });
});

describe("团队页错误态语义（③-3）", () => {
  it("名册与动向失败都用 role=alert 播报，并给可重试按钮（不静默）", async () => {
    vi.mocked(fetchTeam).mockRejectedValue(new Error("网络异常"));
    vi.mocked(fetchTeamActivities).mockRejectedValue(new Error("网络异常"));

    render(<TeamPage />);
    const alerts = await screen.findAllByRole("alert");
    const text = alerts.map((a) => a.textContent ?? "").join("\n");
    expect(text).toContain("名册加载失败");
    expect(text).toContain("动向加载失败");
    // 两个失败态都带「重试」入口
    expect(screen.getAllByRole("button", { name: "重试" }).length).toBe(2);
  });

  it("用量加载失败用 role=alert 播报并可重试", async () => {
    useTeamShareStore.setState({ settings: { ...DEFAULT_TEAM_SHARE, usage: true } });
    vi.mocked(fetchTeamUsage).mockRejectedValue(new Error("网络异常"));

    await renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "用量" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/用量加载失败/);
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

/** d.62-B 布局迁移守卫：页头统一走 PageShell（标题档位/副标题在同一处）。 */
describe("团队页布局（d.62-B）", () => {
  it("页头由 PageShell 提供：唯一 h1 用 ui-page-title，副标题用 ui-page-sub", async () => {
    await renderPage();
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveClass("ui-page-title");
    expect(headings[0]).toHaveTextContent("团队");
    expect(document.querySelector(".ui-page-sub")?.textContent).toContain("名真实成员");
  });
});
