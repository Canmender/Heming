import { create } from "zustand";
import { isPluginPagePage } from "../pages/ids.js";
import { ROUTABLE_PAGE_IDS } from "../palette/pages.js";

/**
 * 插件首页卡片（d.125 · 沙箱桥契约 §4）。
 *
 * 背景：automations / infohub 从「内置模块」改成沙箱 bundle 插件后，首页那两张卡
 * 不再由 web 内置组件渲染，而是由**已安装插件的清单**声明（`contributions.homeCards`），
 * 由桌面宿主创建隐藏窗口跑 `contributions.background`，再由插件通过 widget 桥的
 * `homeCardSet()` 回填运行时文案。主窗口只经 preload 暴露的 `window.__heming_plugins`
 * 拿到「卡片数据」，不执行插件代码——这是沙箱边界的一部分，web 侧不得直连插件页面。
 *
 * 数据源单一：宿主 `plugins:homecards` 只返回「已安装 + 已启用 + 文件完好」的插件，
 * 所以本模块不再叠加一遍插件状态判断，避免两处口径漂移（插件停用后宿主会推
 * 空的更新，界面自然下线）。浏览器里没有桥 → 整块不渲染（不是显示空卡）。
 */

/** 宿主 → 主窗口的一张首页卡片（运行时形态；`text/detail/badge` 由插件回填）。 */
export interface PluginHomeCard {
  /** 卡片所属插件 id（如 `heming.infohub`）；与 `id` 一起构成唯一键。 */
  pluginId: string;
  /** 插件显示名，卡片副标题用。 */
  pluginName: string;
  /** 插件内唯一的卡片 id。 */
  id: string;
  title: string;
  summary: string;
  /** 清单里的图标词表 id；web 沿用插件页面图标的映射，未知回落包裹图标。 */
  icon: string;
  /** 点击跳转的页面 id（插件页为 `plugin:<pluginId>`，也允许导航页）。 */
  page: string;
  /** 主文案（如当前归档条数）；缺省时宿主填清单里的 `primary`。 */
  text: string;
  detail: string;
  badge: string;
}

/**
 * 主窗口 preload 暴露的插件桥（`window.__heming_plugins`，仅桌面端主窗存在）。
 *
 * 与 `window.__heming_widgets` 分开是有意的：widget 桥面向「界面插件自己开的窗口」，
 * 这组通道面向「主窗口读插件贡献」，权限域不同（`infohub` / `notify`）。
 */
export interface PluginsBridge {
  /** 已安装且启用的插件首页卡片（宿主已按清单 `primary` 填好缺省文案）。 */
  homeCards(): Promise<PluginHomeCard[]>;
  /** 插件调用 `homeCardSet()` 后的增量推送；返回取消订阅函数。 */
  onHomeCard(cb: (card: PluginHomeCard) => void): () => void;
  /** 插件请求系统通知（宿主已校验 `permissions.notify`）。 */
  onNotify(cb: (event: unknown) => void): () => void;
}

declare global {
  interface Window {
    /** 内部：桌面端插件桥（preload 暴露；浏览器里 undefined）。 */
    __heming_plugins?: PluginsBridge;
  }
}

/** 当前窗口的插件桥；浏览器/旧版桌面端返回 undefined。 */
export function pluginsBridge(): PluginsBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.__heming_plugins;
}

/** 是否有插件首页卡能力（无桥 = 整个区块不渲染，浏览器端即此分支）。 */
export function pluginHomeCardsAvailable(): boolean {
  return Boolean(pluginsBridge());
}

/** 卡片唯一键：同一插件可以声明多张卡，跨插件 id 也不能串。 */
export function pluginHomeCardKey(card: Pick<PluginHomeCard, "pluginId" | "id">): string {
  return `${card.pluginId}:${card.id}`;
}

/** 渲染/跳转只认「导航页 + 内置插件页 + 插件页」；其余（坏数据/旧版本）安全丢弃。 */
function isRoutableCardPage(page: string): boolean {
  return isPluginPagePage(page) || ROUTABLE_PAGE_IDS.has(page);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 宿主数据 → 可信卡片；不合法返回 null。
 *
 * 为什么在 web 再校验一遍：桥的另一端是宿主，但卡片 page 最终会喂给 `setPage`，
 * 非法值会让路由白屏。这里只做「形状 + 可路由」校验，业务含义仍归宿主。
 */
export function normalizePluginHomeCard(raw: unknown): PluginHomeCard | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const pluginId = textOf(record.pluginId);
  const id = textOf(record.id);
  const title = textOf(record.title);
  const page = textOf(record.page);
  if (!pluginId || !id || !title || !isRoutableCardPage(page)) return null;
  return {
    pluginId,
    pluginName: textOf(record.pluginName),
    id,
    title,
    summary: textOf(record.summary),
    icon: textOf(record.icon),
    page,
    text: textOf(record.text),
    detail: textOf(record.detail),
    badge: textOf(record.badge),
  };
}

export interface PluginHomeCardsState {
  /** 首页插件卡（顺序即清单顺序，宿主保证）。 */
  cards: PluginHomeCard[];
  /** 至少成功读过一次（区分「还没读」与「读到了空」）。 */
  loaded: boolean;
  /** 读失败的中文原因；界面只在调试面板展示，不影响其它区块。 */
  error: string | null;
}

export const usePluginHomeCardsStore = create<PluginHomeCardsState>(() => ({
  cards: [],
  loaded: false,
  error: null,
}));

function upsert(cards: PluginHomeCard[], card: PluginHomeCard): PluginHomeCard[] {
  const key = pluginHomeCardKey(card);
  const index = cards.findIndex((item) => pluginHomeCardKey(item) === key);
  if (index < 0) return [...cards, card];
  const next = [...cards];
  next[index] = card;
  return next;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 读一次卡片列表。
 *
 * 失败时清空而不是保留旧卡：卡片代表「当前可用的插件入口」，插件被停用/卸载后
 * 留着旧卡就是假入口（与首页模块卡「不留假入口」的口径一致）。
 */
export async function refreshPluginHomeCards(
  options: { bridge?: PluginsBridge | undefined } = {},
): Promise<void> {
  const bridge = options.bridge ?? pluginsBridge();
  if (!bridge) {
    usePluginHomeCardsStore.setState({ cards: [], loaded: true, error: null });
    return;
  }
  try {
    const listed = await bridge.homeCards();
    const seen = new Set<string>();
    const cards: PluginHomeCard[] = [];
    for (const raw of Array.isArray(listed) ? listed : []) {
      const card = normalizePluginHomeCard(raw);
      if (!card) continue;
      const key = pluginHomeCardKey(card);
      // 同一张卡重复出现时保留第一条（宿主列表是权威，后到的重复项没有新信息）。
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push(card);
    }
    usePluginHomeCardsStore.setState({ cards, loaded: true, error: null });
  } catch (err) {
    usePluginHomeCardsStore.setState({
      cards: [],
      loaded: true,
      error: `读取插件首页卡片失败：${reasonOf(err)}`,
    });
  }
}

/**
 * 订阅增量卡片更新（插件 `homeCardSet()` → 宿主 → 这里）。
 *
 * 只做 upsert：宿主是按「已安装插件」推送的，且卡片列表以宿主为真源；
 * 这里删卡会与插件的生命周期判断打架。返回取消订阅函数（组件卸载即调）。
 */
export function subscribePluginHomeCards(
  options: { bridge?: PluginsBridge | undefined } = {},
): () => void {
  const bridge = options.bridge ?? pluginsBridge();
  if (!bridge) return () => {};
  try {
    return bridge.onHomeCard((raw) => {
      const card = normalizePluginHomeCard(raw);
      if (!card) return;
      const state = usePluginHomeCardsStore.getState();
      usePluginHomeCardsStore.setState({
        cards: upsert(state.cards, card),
        loaded: true,
        error: null,
      });
    });
  } catch (err) {
    // 旧 preload 没有该方法是正常降级：首屏卡片照常显示，只是不接收实时更新。
    usePluginHomeCardsStore.setState({ error: `订阅插件首页卡片失败：${reasonOf(err)}` });
    return () => {};
  }
}

/** 测试隔离：清空缓存（不碰宿主状态）。 */
export function resetPluginHomeCards(): void {
  usePluginHomeCardsStore.setState({ cards: [], loaded: false, error: null });
}
