import type { PluginCatalogEntry } from "@heming/shared";
import {
  downloadPluginPackage,
  type DownloadedPluginPackage,
} from "../plugins/catalogClient.js";
import { installWidgetFromBytes, type WidgetInstallOutcome } from "./store.js";
import type { WidgetRecord } from "../../types/widgets.js";

/**
 * 市场里的界面插件（bundle）直接安装（d.109 · 规格 §7.3 / 市场 §6）。
 *
 * 为什么单独一层而不是塞进 `PluginsPage`：
 * - bundle 与声明式插件是**两条**安装管线（前者主进程解包落盘 + 首方验签，后者写
 *   localStorage 物化成技能/MCP），复用 `installWidgetFromBytes` 才能保证 sha256
 *   二次校验、验签、事务回滚一条不少；
 * - 下载与安装都可注入，组件测试不必联网、也不必真开桌面桥。
 *
 * 成功返回 `record`（主进程回写的安装记录），失败 `error` 已是中文可直接展示。
 */
export interface InstallBundleFromMarketOptions {
  /** 测试注入：下载并校验包（缺省 `downloadPluginPackage`，内部会验 sha256/大小）。 */
  download?: (entry: PluginCatalogEntry) => Promise<DownloadedPluginPackage>;
  /** 测试注入：交给桌面桥安装（缺省 `installWidgetFromBytes`）。 */
  install?: (
    bytes: ArrayBuffer,
    options?: { expectedSha256?: string },
  ) => Promise<WidgetInstallOutcome>;
}

export interface InstallBundleOutcome {
  ok: boolean;
  error?: string;
  record?: WidgetRecord;
  /** 同 id 覆盖更新（提示语与「已安装」徽标要用）。 */
  updated?: boolean;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 下载 → 校验（`downloadPluginPackage` 内做 sha256/大小）→ 交给桌面桥安装。
 *
 * 边界：没有桌面桥时 `installWidgetFromBytes` 会返回「仅桌面端可用」，
 * 本函数原样透出；市场详情页在点击前就会禁用并写明原因。
 */
export async function installBundleFromMarket(
  entry: PluginCatalogEntry,
  options: InstallBundleFromMarketOptions = {},
): Promise<InstallBundleOutcome> {
  if (!entry || entry.distribution !== "bundle" || !entry.package) {
    return { ok: false, error: "该条目不是插件包，不能按插件安装" };
  }
  const download = options.download ?? downloadPluginPackage;
  const install = options.install ?? installWidgetFromBytes;

  let pkg: DownloadedPluginPackage;
  try {
    pkg = await download(entry);
  } catch (err) {
    return { ok: false, error: `下载失败：${reasonOf(err)}` };
  }

  let outcome: WidgetInstallOutcome;
  try {
    outcome = await install(pkg.bytes, { expectedSha256: pkg.sha256 });
  } catch (err) {
    return { ok: false, error: `安装失败：${reasonOf(err)}` };
  }
  if (!outcome || !outcome.ok) {
    return { ok: false, error: (outcome && outcome.error) || "安装失败" };
  }
  return {
    ok: true,
    ...(outcome.record ? { record: outcome.record } : {}),
    ...(outcome.updated ? { updated: true } : {}),
  };
}
