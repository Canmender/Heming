import { useState } from "react";
import { UNIT_SOURCE_LABELS, type UnitStatus } from "@heming/shared";
import type { WidgetRecord } from "../../types/widgets.js";
import { setWidgetEnabled, uninstallWidget } from "../../lib/widgets/store.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { BTN_DANGER_SM, BTN_GHOST_SM, CHIP, HINT, Switch } from "./shared.js";

/**
 * 界面插件（bundle 来源）的卡片（d.141）。
 *
 * 为什么需要它：d.135「插件仓库入口合并，桌面小组件并入插件」删掉了 `WidgetsView`
 * （424 行），它的启停/卸载按钮随之消失——bundle 插件在统一单元列表里只剩只读默认行，
 * 用户装得上、停不了、也卸不掉。这里把管理动作补回来，口径沿用被删组件与规格 §3.1：
 * - 停用 = 收起窗口与托盘，**保留**文件与设置；
 * - 卸载 = 删插件文件、模型与插件设置，二次确认且不可恢复；
 * - 一切写操作都走 `lib/widgets/store.ts`（主进程持有真源），本组件不碰 fs。
 */
export interface BundlePluginCardProps {
  /** 统一单元投影（来源徽标、状态、阻断原因都读它，与默认行一致）。 */
  status: UnitStatus;
  /** 主进程持有的安装记录（id / 名称 / 版本 / 启停态 / 页面）。 */
  record: WidgetRecord;
  /** 「打开页面」入口；注册表判定页面不可用时由宿主传 undefined。 */
  onOpenPage?: (() => void) | undefined;
  /** 结果反馈（插件区顶部的提示条）。 */
  onNotify: (kind: "ok" | "error", text: string) => void;
  /** 启停/卸载成功后让宿主重算投影（`bump()`）。 */
  onChanged?: (() => void) | undefined;
}

export function BundlePluginCard({
  status,
  record,
  onOpenPage,
  onNotify,
  onChanged,
}: BundlePluginCardProps) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const unit = status.unit;
  const initial = Array.from(record.name)[0]?.toUpperCase() ?? "?";
  const broken = Boolean(record.error);

  async function toggle(next: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    const result = await setWidgetEnabled(record.id, next);
    setBusy(false);
    onChanged?.();
    if (result.ok) {
      onNotify(
        "ok",
        next
          ? `已启用插件：${record.name}`
          : `已停用插件：${record.name}（窗口与托盘已收起，文件与设置保留）`,
      );
    } else {
      onNotify("error", result.error ?? "切换失败");
    }
  }

  async function remove(): Promise<void> {
    if (busy) return;
    setBusy(true);
    const result = await uninstallWidget(record.id);
    setBusy(false);
    setConfirming(false);
    onChanged?.();
    if (result.ok) {
      onNotify("ok", `已卸载插件：${record.name}（插件文件、模型与插件设置已删除）`);
    } else {
      onNotify("error", result.error ?? "卸载失败");
    }
  }

  return (
    <section
      data-plugin-id={record.id}
      data-enabled={record.enabled}
      role="region"
      aria-label={`插件 ${record.name}`}
      className="ui-card plugin-card p-4"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="plugin-icon-tile h-9 w-9 text-[13px] font-bold">
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={CHIP}>{UNIT_SOURCE_LABELS[unit.source]}</span>
            <span className="truncate text-[13px] font-extrabold">{record.name}</span>
            <span className={CHIP}>v{record.version}</span>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted">
              <span
                aria-hidden="true"
                className="plugin-dot"
                data-off={record.enabled ? undefined : "true"}
                data-warn={broken ? "true" : undefined}
              />
              {record.enabled ? "已启用" : "已停用"}
            </span>
          </div>
          <div className={`mt-0.5 ${HINT}`}>{record.id}</div>
          <p className="mt-1 ui-body-sm text-muted">{unit.description || "暂无描述"}</p>
          {record.error && (
            <p className={`mt-1 ${HINT}`} role="note">
              {record.error}
            </p>
          )}
        </div>
        <Switch
          label={`启用插件 ${record.name}`}
          checked={record.enabled}
          disabled={busy}
          onChange={(next) => void toggle(next)}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
        {onOpenPage && (
          <button
            type="button"
            aria-label={`打开插件页面 ${record.name}`}
            onClick={onOpenPage}
            className={BTN_GHOST_SM}
          >
            打开页面
          </button>
        )}
        <button
          type="button"
          aria-label={`卸载插件 ${record.name}`}
          disabled={busy}
          onClick={() => setConfirming(true)}
          className={BTN_DANGER_SM}
        >
          卸载
        </button>
      </div>

      {confirming && (
        <ConfirmDialog
          title="卸载插件"
          onCancel={() => setConfirming(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="ui-btn ui-btn-md ui-btn-ghost text-muted"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy}
                className="ui-btn ui-btn-md ui-btn-danger"
              >
                确认卸载
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            卸载插件「{record.name}」？它的插件文件、模型与插件设置都会一并删除，此操作不可恢复。
            只想临时收起，改用左侧开关停用即可——停用会保留文件与设置。
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}