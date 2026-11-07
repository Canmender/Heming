import { create } from "zustand";
import {
  widgetsBridge,
  type WidgetHostAction,
  type WidgetRecord,
  type WidgetState,
  type WidgetsBridge,
} from "../../types/widgets.js";

/**
 * 界面插件（桌面小组件）的主窗状态层（d.97 · 规格 §4.2）。
 *
 * 真源在主进程：`installed.json` / `state.json` / `settings.json` 全由宿主持有，
 * 本模块只做三件事：
 * 1. 经 `window.__heming_widgets` 读列表与窗口状态（zustand 缓存，页面订阅即可）；
 * 2. 把用户动作（启停/卸载/窗口动作/设置表单）转成 IPC 并刷新缓存；
 * 3. 把业务失败统一成中文 `{ ok:false, error }`，界面只负责展示。
 *
 * ★ 为什么不复用 `lib/plugins/store.ts`（声明式插件存储）：两类包的生命周期完全不同——
 *   声明式插件物化成技能/MCP（localStorage）；界面插件是**主进程落盘的独立目录 + 窗口**。
 *   把两套存储混一起，卸载语义与信任模型都会自相矛盾（规格 §2.2 的拒绝规则就是为此）。
 */

export interface WidgetsState {
  /** 已安装界面插件（含停用/损坏记录）。 */
  records: WidgetRecord[];
  /** id → 窗口运行态；列表接口不带它，单独 `widgets:state` 读。 */
  states: Record<string, WidgetState>;
  loading: boolean;
  loaded: boolean;
  /** 列表读取失败的中文原因（单条记录的 `record.error` 另算）。 */
  error: string | null;
}

export const useWidgetsStore = create<WidgetsState>(() => ({
  records: [],
  states: {},
  loading: false,
  loaded: false,
  error: null,
}));

/** 是否有界面插件能力（桌面端主窗；浏览器里没有）。 */
export function widgetsAvailable(): boolean {
  return Boolean(widgetsBridge());
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 当前列表里的一条记录（找不到返回 undefined）。 */
export function widgetRecord(id: string): WidgetRecord | undefined {
  return useWidgetsStore.getState().records.find((record) => record.id === id);
}

/**
 * 刷新列表 + 各窗口状态。
 *
 * 状态是逐条读的：某条记录坏了（`record.error` / 窗口没起来）不应该让整个列表失败，
 * 所以单条 `state()` 失败只丢那一条的运行态，其余照常展示。
 */
export async function refreshWidgets(
  options: { bridge?: WidgetsBridge | undefined } = {},
): Promise<void> {
  const bridge = options.bridge ?? widgetsBridge();
  if (!bridge) {
    useWidgetsStore.setState({ records: [], states: {}, loading: false, loaded: true, error: null });
    return;
  }
  useWidgetsStore.setState({ loading: true });
  try {
    const listed = await bridge.list();
    const records = Array.isArray(listed) ? listed : [];
    const states: Record<string, WidgetState> = {};
    await Promise.all(
      records.map(async (record) => {
        try {
          const state = await bridge.state({ id: record.id });
          if (state && typeof state === "object") states[record.id] = state;
        } catch {
          /* 记录损坏/窗口起不来：保留空态，界面照常显示这条记录与它的 error */
        }
      }),
    );
    useWidgetsStore.setState({
      records,
      states,
      loading: false,
      loaded: true,
      error: null,
    });
  } catch (err) {
    useWidgetsStore.setState({
      loading: false,
      loaded: true,
      error: `读取桌面小组件失败：${reasonOf(err)}`,
    });
  }
}

/** 测试隔离：清空缓存（不动主进程状态）。 */
export function resetWidgetsStore(): void {
  useWidgetsStore.setState({ records: [], states: {}, loading: false, loaded: false, error: null });
}

export interface WidgetActionResult {
  ok: boolean;
  error?: string;
}

/** 启用/停用：停用 = 销毁窗口与托盘但保留文件与设置（规格 §3.1）。 */
export async function setWidgetEnabled(
  id: string,
  enabled: boolean,
  options: { bridge?: WidgetsBridge | undefined } = {},
): Promise<WidgetActionResult> {
  const bridge = options.bridge ?? widgetsBridge();
  if (!bridge) return { ok: false, error: "仅桌面端可用" };
  try {
    const result = await bridge.setEnabled({ id, enabled });
    await refreshWidgets(options);
    return result?.ok ? { ok: true } : { ok: false, error: result?.error ?? "切换失败" };
  } catch (err) {
    return { ok: false, error: `切换失败：${reasonOf(err)}` };
  }
}

/**
 * 卸载：删目录 + 记录 + 设置（规格 §3.1）。
 *
 * `removeData` 默认 true（与设置区「会删除插件文件与模型与插件设置」的确认文案一致）；
 * 老键 `heming.pet.v1` 不归这里管（规格 §4.3：保留一版不删）。
 */
export async function uninstallWidget(
  id: string,
  options: { bridge?: WidgetsBridge | undefined; removeData?: boolean } = {},
): Promise<WidgetActionResult> {
  const bridge = options.bridge ?? widgetsBridge();
  if (!bridge) return { ok: false, error: "仅桌面端可用" };
  try {
    const result = await bridge.uninstall({ id, removeData: options.removeData ?? true });
    await refreshWidgets(options);
    return result?.ok ? { ok: true } : { ok: false, error: result?.error ?? "卸载失败" };
  } catch (err) {
    return { ok: false, error: `卸载失败：${reasonOf(err)}` };
  }
}

/** 宿主动作（显示/隐藏、缩放、穿透、重置位置、重载）：只操作这一个 widget 窗口。 */
export async function runWidgetAction(
  id: string,
  action: WidgetHostAction,
  options: { bridge?: WidgetsBridge | undefined } = {},
): Promise<WidgetActionResult & { state?: WidgetState }> {
  const bridge = options.bridge ?? widgetsBridge();
  if (!bridge) return { ok: false, error: "仅桌面端可用" };
  try {
    const result = await bridge.action({ id, action });
    let state: WidgetState | undefined = result?.state;
    if (!state) {
      try {
        state = (await bridge.state({ id })) ?? undefined;
      } catch {
        state = undefined;
      }
    }
    if (state) useWidgetsStore.setState((prev) => ({ states: { ...prev.states, [id]: state as WidgetState } }));
    return result?.ok
      ? { ok: true, ...(state ? { state } : {}) }
      : { ok: false, error: result?.error ?? "操作失败" };
  } catch (err) {
    return { ok: false, error: `操作失败：${reasonOf(err)}` };
  }
}

/** 设置表单写回：`patch` 只带改动的键，主进程合并后返回全量设置。 */
export async function saveWidgetSettings(
  id: string,
  patch: Record<string, unknown>,
  options: { bridge?: WidgetsBridge | undefined } = {},
): Promise<WidgetActionResult & { settings?: Record<string, unknown> }> {
  const bridge = options.bridge ?? widgetsBridge();
  if (!bridge) return { ok: false, error: "仅桌面端可用" };
  try {
    const settings = await bridge.settingsSet({ id, patch });
    if (settings && typeof settings === "object") {
      useWidgetsStore.setState((prev) => ({
        records: prev.records.map((record) =>
          record.id === id ? { ...record, settings } : record,
        ),
      }));
    }
    return { ok: true, settings };
  } catch (err) {
    return { ok: false, error: `保存失败：${reasonOf(err)}` };
  }
}

export interface WidgetInstallOutcome extends WidgetActionResult {
  record?: WidgetRecord;
  /** 是否是「同 id 覆盖更新」（用于提示语与迁移判断）。 */
  updated?: boolean;
}

function applyInstalledRecord(record: WidgetRecord | undefined, updated: boolean): void {
  if (!record) return;
  useWidgetsStore.setState((prev) => ({
    records: updated
      ? prev.records.map((item) => (item.id === record.id ? record : item))
      : [...prev.records.filter((item) => item.id !== record.id), record],
  }));
}

/**
 * 云端安装：内存里的包字节 + 期望指纹（规格 §4.2.1 / §5）。
 *
 * 指纹由主进程**再校验一次**：渲染层算过不代表可信（IPC 同一侧也可能被改），
 * 这里把 expectedSha256 原样传下去，主进程校验失败会返回中文错误。
 */
export async function installWidgetFromBytes(
  bytes: ArrayBuffer,
  options: { bridge?: WidgetsBridge | undefined; expectedSha256?: string } = {},
): Promise<WidgetInstallOutcome> {
  const bridge = options.bridge ?? widgetsBridge();
  if (!bridge) return { ok: false, error: "仅桌面端可用" };
  const before = new Set(useWidgetsStore.getState().records.map((record) => record.id));
  try {
    const result = await bridge.install({
      bytes,
      ...(options.expectedSha256 ? { expectedSha256: options.expectedSha256 } : {}),
    });
    if (!result?.ok) return { ok: false, error: result?.error ?? "安装失败" };
    const updated = result.record ? before.has(result.record.id) : false;
    applyInstalledRecord(result.record, updated);
    await refreshWidgets(options);
    return { ok: true, record: result.record, updated };
  } catch (err) {
    return { ok: false, error: `安装失败：${reasonOf(err)}` };
  }
}

/** 本地安装：主进程自己开文件框选 `.tgz` 并安装（渲染层不碰 fs）。 */
export async function installWidgetFromFile(
  options: { bridge?: WidgetsBridge | undefined } = {},
): Promise<WidgetInstallOutcome> {
  const bridge = options.bridge ?? widgetsBridge();
  if (!bridge) return { ok: false, error: "仅桌面端可用" };
  const before = new Set(useWidgetsStore.getState().records.map((record) => record.id));
  try {
    const result = await bridge.installFromFile();
    if (!result?.ok) return { ok: false, error: result?.error ?? "安装失败" };
    const updated = result.record ? before.has(result.record.id) : false;
    applyInstalledRecord(result.record, updated);
    await refreshWidgets(options);
    return { ok: true, record: result.record, updated };
  } catch (err) {
    return { ok: false, error: `安装失败：${reasonOf(err)}` };
  }
}
