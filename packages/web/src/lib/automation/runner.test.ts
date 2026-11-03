import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runAutomationTask, automationBlockedReason } from "./runner.js";
import { DEFAULT_SYNC, type AutomationTask } from "./model.js";
import { useInfohubStore } from "../infohub/store.js";
import type { InfohubBridgeInfo, InfohubStatus } from "../infohub/client.js";

/**
 * 自动化执行器的红线：未连接时只回 skipped，绝不借桥的 `call()` 自动拉起 Python。
 * 其余用例钉住三种结果留痕与参数透传（来源/全量/导出、日程重扫）。
 */

type Bridge = NonNullable<Window["__heming_infohub"]>;

const HOME = "D:\\wohaolei";
const HOME_KEY = "heming.infohub.home.v1";

function task(overrides: Partial<AutomationTask> = {}): AutomationTask {
  return {
    id: "auto-1",
    name: "同步本机归档",
    kind: "infohub.sync",
    enabled: true,
    schedule: { type: "interval", minutes: 60 },
    sync: { ...DEFAULT_SYNC, sources: ["qq"] },
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 2,
    runCount: 0,
    ...overrides,
  };
}

function installBridge(overrides: Partial<Bridge> = {}) {
  const call = vi.fn(async (method: string) => {
    if (method === "status") return { home: HOME } as unknown as InfohubStatus;
    if (method === "agenda") return { items: [], summary: { overdue: 0, today: 0, week: 0, total: 0 } };
    if (method === "sync") {
      return {
        reports: [
          { source: "qq", conversations: 3, added: 2, updated: 1, skipped: 0, errors: [], elapsed: 1.2 },
          { source: "wechat", conversations: 1, added: 0, updated: 0, skipped: 0, errors: ["数据库被占用"], elapsed: 0.2 },
        ],
        agenda: {},
        kb: { vault: "D:\\notes" },
      };
    }
    return undefined;
  });
  const bridge = {
    info: vi.fn(async (): Promise<InfohubBridgeInfo> => ({
      packageDir: "D:\\Heming\\packages\\infohub",
      defaultHome: "C:\\Users\\x\\Heming\\infohub",
      bundledPython: null,
      running: true,
      pid: 4321,
      home: HOME,
      python: "C:\\py\\python.exe",
      pythonSource: "bundled",
      startedAt: 1,
      methods: ["status", "agenda", "sync"],
    })),
    start: vi.fn(),
    call,
    stop: vi.fn(async () => true),
    pickHome: vi.fn(async () => null),
    pickPython: vi.fn(async () => null),
    onEvent: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as Bridge;
  (window as unknown as { __heming_infohub?: Bridge }).__heming_infohub = bridge;
  // 覆盖 call 时也要返回真正挂到桥上那个，否则断言会落在没人调用的旧 mock 上。
  return { bridge, call: bridge.call as typeof call };
}

function resetStores() {
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
}

describe("自动化执行器", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    resetStores();
  });

  afterEach(() => {
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });

  it("浏览器端：直接跳过，不发任何请求", async () => {
    expect(automationBlockedReason()).toBe("信息中枢仅桌面端可用，自动化未执行");
    const outcome = await runAutomationTask(task());
    expect(outcome).toEqual({ status: "skipped", detail: "信息中枢仅桌面端可用，自动化未执行" });
  });

  it("桌面端但未连接：跳过且不拉起进程", async () => {
    const { bridge } = installBridge();
    useInfohubStore.setState({ available: true, booted: true, running: false });

    const outcome = await runAutomationTask(task());

    expect(outcome.status).toBe("skipped");
    expect(outcome.detail).toContain("信息中枢未连接");
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it("同步：透传来源选项、汇总新增与错误，并刷新共享状态", async () => {
    localStorage.setItem(HOME_KEY, HOME);
    const { call } = installBridge();
    useInfohubStore.setState({ available: true, booted: true, running: true });

    const outcome = await runAutomationTask(
      task({ sync: { sources: ["qq", "wechat"], full: true, archive: true } }),
    );

    expect(call).toHaveBeenCalledWith(
      "sync",
      { sources: ["qq", "wechat"], full: true, archive: true },
      { home: HOME },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.detail).toBe("同步完成：QQ 新增 2；1 个采集错误；知识库已导出");
    // 同步会写归档：统计与日程跟着重算
    expect(call).toHaveBeenCalledWith("status", {}, { home: HOME });
    expect(call).toHaveBeenCalledWith(
      "agenda",
      expect.objectContaining({ days: 14, overdue: 30 }),
      { home: HOME },
    );
  });

  it("同步：未开启导出（kb 为空）时给出明确说明", async () => {
    installBridge({
      call: vi.fn(async (method: string) => {
        if (method === "sync") {
          return { reports: [{ source: "qq", added: 0, errors: [] }], agenda: {}, kb: null };
        }
        if (method === "status") return {};
        if (method === "agenda") return { items: [], summary: {} };
        return undefined;
      }),
    });
    useInfohubStore.setState({ available: true, booted: true, running: true });

    const outcome = await runAutomationTask(
      task({ sync: { sources: ["qq"], full: false, archive: true } }),
    );

    expect(outcome.detail).toBe("同步完成：无新增；配置未开启知识库导出");
  });

  it("日程重扫：带 rebuild 调用并把结果写回共享 store", async () => {
    const agenda = {
      items: [{ id: 1 }, { id: 2 }],
      summary: { overdue: 0, today: 0, week: 0, total: 2 },
    };
    const { call } = installBridge({
      call: vi.fn(async (method: string) => (method === "agenda" ? agenda : undefined)),
    });
    useInfohubStore.setState({ available: true, booted: true, running: true });

    const outcome = await runAutomationTask(
      task({ kind: "infohub.agenda", sync: { ...DEFAULT_SYNC } }),
    );

    expect(call).toHaveBeenCalledWith(
      "agenda",
      { days: 14, overdue: 30, rebuild: true },
      {},
    );
    expect(outcome).toEqual({ status: "ok", detail: "重扫完成：2 项日程" });
    expect(useInfohubStore.getState().agenda).toBe(agenda);
  });

  it("桥报错：剥掉 IPC 前缀后记为失败，不抛出", async () => {
    installBridge({
      call: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'infohub:call': Error: InfoHub 请求超时（300s）：sync",
        );
      }),
    });
    useInfohubStore.setState({ available: true, booted: true, running: true });

    const outcome = await runAutomationTask(task());

    expect(outcome.status).toBe("error");
    expect(outcome.detail).toBe("InfoHub 请求超时（300s）：sync");
  });

  it("未知动作：不调用桥、不拉起进程，直接记为失败", async () => {
    const { bridge } = installBridge();
    useInfohubStore.setState({ available: true, booted: true, running: true });
    const unknownKind = "infohub.unknown" as unknown as AutomationTask["kind"];

    const outcome = await runAutomationTask(task({ kind: unknownKind }));

    expect(outcome).toEqual({ status: "error", detail: "未知的自动化动作" });
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.call).not.toHaveBeenCalled();
  });
});
