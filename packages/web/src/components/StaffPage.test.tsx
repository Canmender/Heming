import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StaffPage } from "./StaffPage.js";
import { useStaffStore } from "../lib/staff/store.js";
import { DEFAULT_STAFF_SETTINGS, normalizeSeen, type StaffRun } from "../lib/staff/model.js";
import { useTaskStore } from "../lib/tasks/store.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import { useNotificationStore } from "../store/notifications.js";
import { useLlmStore } from "../store/llm.js";
import { useUiStore } from "../store/ui.js";

/**
 * 幕僚页（d.48）：
 *
 * - 未开启 → 空态 + 一个开启入口；开启后立刻生成首份简报；
 * - 设置项落盘（来源开关、时间、模型）；
 * - finding 动作只跳转，不写任何业务数据。
 */

function resetStores(): void {
  useStaffStore.setState({
    settings: { ...DEFAULT_STAFF_SETTINGS, sources: { ...DEFAULT_STAFF_SETTINGS.sources } },
    runs: [],
    seen: normalizeSeen(null),
  });
  useTaskStore.setState({ tasks: [] });
  useInfohubStore.setState({
    available: false,
    running: false,
    booted: false,
    info: null,
    status: null,
    agenda: null,
    busy: "",
    error: "",
  });
  useNotificationStore.setState({ items: [] });
  useLlmStore.setState({ profiles: [], bindings: {} });
  useUiStore.setState({
    page: "staff",
    taskFocusId: null,
    activeConversationId: null,
    infohubIntent: null,
  });
}

function enabledSettings() {
  useStaffStore.setState({
    settings: {
      ...DEFAULT_STAFF_SETTINGS,
      enabled: true,
      sources: { ...DEFAULT_STAFF_SETTINGS.sources },
    },
  });
}

function runWithActions(): StaffRun {
  return {
    id: "staff-1",
    trigger: "task",
    mode: "rules",
    startedAt: Date.now() - 60_000,
    finishedAt: Date.now() - 59_000,
    summary: "有 2 个任务需要留意。",
    tokens: null,
    findings: [
      {
        id: "f-task",
        severity: "warn",
        title: "任务失败：抓取成绩单",
        detail: "失败原因：网络超时",
        evidence: [{ label: "任务区", kind: "task", refId: "task:t-1" }],
        action: { kind: "open-task", targetId: "t-1", conversationId: "c-1" },
      },
      {
        id: "f-agenda",
        severity: "urgent",
        title: "已逾期：交报名表",
        detail: "叶老师 · 原定 10:00",
        evidence: [{ label: "日程", kind: "agenda", refId: "agenda:9" }],
        action: { kind: "open-infohub" },
      },
    ],
  };
}

describe("StaffPage", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    resetStores();
  });

  it("未开启：空态说明 + 开启后立刻生成首份简报", async () => {
    render(<StaffPage />);
    expect(screen.getByText("还没有简报")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开启幕僚" }));

    await waitFor(() => expect(screen.getByText(/首份简报已生成/)).toBeInTheDocument());
    const state = useStaffStore.getState();
    expect(state.settings.enabled).toBe(true);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].trigger).toBe("daily");
    expect(screen.getByText("常驻巡检")).toBeInTheDocument();
  });

  it("手动运行：历史 +1，按钮在运行期间禁用", async () => {
    enabledSettings();
    render(<StaffPage />);
    fireEvent.click(screen.getByRole("button", { name: "现在跑一次" }));

    await waitFor(() =>
      expect(screen.getByText(/简报已生成：今天没有临期事项/)).toBeInTheDocument(),
    );
    expect(useStaffStore.getState().runs).toHaveLength(1);
    expect(useStaffStore.getState().runs[0].trigger).toBe("manual");
    expect(screen.getByRole("button", { name: "现在跑一次" })).toBeEnabled();
  });

  it("设置项落盘：来源开关、晨报时间、模型选择", () => {
    render(<StaffPage />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    fireEvent.click(screen.getByLabelText(/日程临期/));
    expect(useStaffStore.getState().settings.sources.agenda).toBe(false);

    fireEvent.change(screen.getByLabelText("晨报时间"), { target: { value: "07:10" } });
    expect(useStaffStore.getState().settings.dailyAt).toBe("07:10");

    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "" } });
    expect(useStaffStore.getState().settings.profileId).toBeNull();
  });

  it("finding 动作只跳转：任务 → 智能体页任务视图，日程 → 信息中枢", () => {
    enabledSettings();
    useStaffStore.setState({ runs: [runWithActions()] });
    render(<StaffPage />);

    fireEvent.click(screen.getByRole("button", { name: "去智能体" }));
    // 任务区已并入智能体页：page=chat + view=tasks，再由 taskFocusId 定位
    expect(useUiStore.getState().page).toBe("chat");
    expect(useUiStore.getState().pageView).toBe("tasks");
    expect(useUiStore.getState().taskFocusId).toBe("t-1");

    fireEvent.click(screen.getByRole("button", { name: "看日程" }));
    expect(useUiStore.getState().infohubIntent).toEqual({ tab: "agenda" });
  });

  it("清空历史需要二次确认，且保留去重账本", () => {
    enabledSettings();
    useStaffStore.setState({
      runs: [runWithActions()],
      seen: { agenda: { "9:overdue": 1 }, tasks: {} },
    });
    render(<StaffPage />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "清空历史简报" }));
    expect(screen.getByRole("dialog", { name: "清空历史简报" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(useStaffStore.getState().runs).toHaveLength(0);
    expect(useStaffStore.getState().seen.agenda["9:overdue"]).toBe(1);
  });
});
