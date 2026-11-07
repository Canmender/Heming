import { useCallback, useEffect, useState } from "react";
import { useUiStore } from "../../store/ui.js";
import {
  refreshWidgets,
  runWidgetAction,
  setWidgetEnabled,
  uninstallWidget,
  useWidgetsStore,
  widgetsAvailable,
} from "../../lib/widgets/store.js";
import {
  dismissPetMigrationHint,
  shouldShowPetMigrationHint,
} from "../../lib/widgets/legacy.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { PackageIcon, PlusIcon } from "../icons.js";
import { PluginInstallDialog } from "../PluginInstallDialog.js";
import { ERROR_TEXT, HINT, Switch } from "./shared.js";

/**
 * 插件区「桌面小组件」Tab（d.97 · 规格 §4.2）。
 *
 * 界面插件（原桌宠是第一例）的宿主管理面：
 * - 列表：名称/版本/启用状态/窗口状态；损坏的记录显示 `error` 而不是静默消失；
 * - 宿主动作：显示隐藏、放大缩小、鼠标穿透、重置位置、打开设置（通用动作，不用插件声明）；
 * - 生命周期：启用/停用、卸载（二次确认，文案写明会删文件与设置）；
 * - 安装：云端目录 bundle / 本地 `.tgz`（新弹窗，与声明式安装分开）。
 *
 * 数据全部来自主进程（`widgets:list` 等），本页不读也不写 localStorage 的插件数据。
 */
export function WidgetsView() {
  const records = useWidgetsStore((state) => state.records);
  const states = useWidgetsStore((state) => state.states);
  const loading = useWidgetsStore((state) => state.loading);
  const loaded = useWidgetsStore((state) => state.loaded);
  const listError = useWidgetsStore((state) => state.error);

  const [installOpen, setInstallOpen] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  /** 一次性提示：桌宠已改为插件（只提示一次，本机标记）。 */
  const [petHint, setPetHint] = useState(false);

  const available = widgetsAvailable();

  useEffect(() => {
    void refreshWidgets();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    if (shouldShowPetMigrationHint(records)) {
      setPetHint(true);
      dismissPetMigrationHint();
    }
  }, [loaded, records]);

  const openSettings = useCallback(() => {
    useUiStore.getState().openSettings("appearance");
  }, []);

  const onToggle = async (id: string, name: string, next: boolean): Promise<void> => {
    const result = await setWidgetEnabled(id, next);
    if (result.ok) {
      setMsg({
        kind: "ok",
        text: next
          ? `已启用「${name}」，窗口与托盘已恢复`
          : `已停用「${name}」，窗口与托盘已销毁；文件与设置保留`,
      });
    } else {
      setMsg({ kind: "error", text: result.error ?? "切换失败" });
    }
  };

  const onAction = async (
    id: string,
    action: Parameters<typeof runWidgetAction>[1],
  ): Promise<void> => {
    const result = await runWidgetAction(id, action);
    if (!result.ok) setMsg({ kind: "error", text: result.error ?? "操作失败" });
  };

  const onConfirmRemove = async (): Promise<void> => {
    const id = removeTarget;
    if (!id) return;
    setRemoveTarget(null);
    const result = await uninstallWidget(id);
    setMsg(
      result.ok
        ? {
            kind: "ok",
            text: "已卸载桌面小组件：插件文件、窗口、托盘与插件设置都已删除（旧 heming.pet.v1 键保留，便于回滚）",
          }
        : { kind: "error", text: result.error ?? "卸载失败" },
    );
  };

  if (!available) {
    return (
      <section className="rounded-xl border border-line bg-white p-4 shadow-card" aria-label="桌面小组件">
        <p className="ui-body-sm font-medium">桌面小组件</p>
        <p className={`mt-1 ${HINT}`}>
          界面插件需要桌面窗口能力：装好后会在桌面上开一个独立窗口。浏览器里没有这个能力，
          本页只在安装版里可用。
        </p>
      </section>
    );
  }

  return (
    <div aria-label="桌面小组件">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setMsg(null);
            setInstallOpen(true);
          }}
          className="ui-btn ui-btn-md ui-btn-primary"
        >
          <PlusIcon width={12} height={12} aria-hidden="true" />
          安装桌面小组件
        </button>
        <button
          type="button"
          onClick={() => void refreshWidgets()}
          disabled={loading}
          className="ui-btn ui-btn-sm ui-btn-ghost"
        >
          刷新
        </button>
        <span className="ui-caption">
          {records.length > 0 ? `已安装 ${records.length} 个 · 界面插件含可执行代码` : "界面插件含可执行代码"}
        </span>
      </div>

      {msg && (
        <p
          role="status"
          className={`mb-3 ${msg.kind === "error" ? ERROR_TEXT : "ui-body-sm text-muted"}`}
        >
          {msg.text}
        </p>
      )}

      {listError && (
        <p role="alert" className={`mb-3 ${ERROR_TEXT}`}>
          {listError}
        </p>
      )}

      {petHint && (
        <section
          aria-label="桌宠迁移提示"
          className="mb-3 rounded-xl border border-[#e6e6e6] bg-[#fafafa] p-3"
        >
          <p className="ui-body-sm font-medium">桌宠已改为插件</p>
          <p className={`mt-1 ${HINT}`}>
            桌宠不再随本体安装，改成可安装的界面插件（`heming.pet`）。点「安装桌面小组件」→
            云端目录或本地 `.tgz` 安装；装好后的设置与旧偏好会自动迁移。
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setMsg(null);
                setInstallOpen(true);
              }}
              className="ui-btn ui-btn-sm ui-btn-primary"
            >
              去安装
            </button>
            <button
              type="button"
              onClick={() => setPetHint(false)}
              className="ui-btn ui-btn-sm ui-btn-ghost"
            >
              知道了
            </button>
          </div>
        </section>
      )}

      {loaded && records.length === 0 ? (
        <section
          className="flex flex-col items-center gap-2 rounded-xl border border-line bg-white py-10 text-center shadow-card"
          aria-label="暂无桌面小组件"
        >
          <span className="text-muted" aria-hidden="true">
            <PackageIcon width={28} height={28} />
          </span>
          <p className="ui-section-title">还没有安装桌面小组件</p>
          <p className="ui-caption">
            桌宠（`heming.pet`）就是一个桌面小组件：它会在桌面上开一个独立窗口，
            位置、缩放、鼠标穿透与设置都由宿主管理。
          </p>
          <button
            type="button"
            onClick={() => {
              setMsg(null);
              setInstallOpen(true);
            }}
            className="ui-btn ui-btn-md ui-btn-primary mt-1"
          >
            安装第一个桌面小组件
          </button>
        </section>
      ) : (
        <div className="grid gap-4">
          {records.map((record) => {
            const state = states[record.id];
            const scale = state?.scale ?? record.widget.defaultScale;
            return (
              <section
                key={record.id}
                aria-label={`桌面小组件 ${record.name}`}
                data-widget-id={record.id}
                className="rounded-xl border border-line bg-white p-4 shadow-card"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="ui-body-sm font-bold">{record.name}</span>
                  <span className="ui-chip">v{record.version}</span>
                  <span className="ui-chip">{record.enabled ? "已启用" : "已停用"}</span>
                  <span className="ui-chip">{state?.visible ? "显示中" : "已隐藏"}</span>
                  <span className="ui-chip">{Math.round(scale * 100)}%</span>
                  <span className="ui-chip">
                    {state?.clickThrough ? "鼠标穿透" : "可点击"}
                  </span>
                  <span className="ml-auto ui-caption">{record.id}</span>
                </div>

                {record.error && (
                  <p role="alert" className={`mt-2 ${ERROR_TEXT}`}>
                    这个小组件当前无法运行：{record.error}
                  </p>
                )}

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!record.enabled || Boolean(record.error)}
                    onClick={() => void onAction(record.id, "toggle")}
                    className="ui-btn ui-btn-sm ui-btn-ghost"
                  >
                    {state?.visible ? "隐藏" : "在桌面显示"}
                  </button>
                  <button
                    type="button"
                    disabled={!record.enabled || Boolean(record.error)}
                    onClick={() => void onAction(record.id, "scaleUp")}
                    className="ui-btn ui-btn-sm ui-btn-ghost"
                  >
                    放大一档
                  </button>
                  <button
                    type="button"
                    disabled={!record.enabled || Boolean(record.error)}
                    onClick={() => void onAction(record.id, "scaleDown")}
                    className="ui-btn ui-btn-sm ui-btn-ghost"
                  >
                    缩小一档
                  </button>
                  <button
                    type="button"
                    disabled={!record.enabled || Boolean(record.error)}
                    onClick={() => void onAction(record.id, "toggleClickThrough")}
                    className="ui-btn ui-btn-sm ui-btn-ghost"
                  >
                    {state?.clickThrough ? "关闭鼠标穿透" : "开启鼠标穿透"}
                  </button>
                  <button
                    type="button"
                    disabled={!record.enabled || Boolean(record.error)}
                    onClick={() => void onAction(record.id, "resetPosition")}
                    className="ui-btn ui-btn-sm ui-btn-ghost"
                  >
                    重置位置
                  </button>
                  <button
                    type="button"
                    onClick={openSettings}
                    className="ui-btn ui-btn-sm ui-btn-ghost"
                  >
                    打开设置
                  </button>
                  <button
                    type="button"
                    onClick={() => setRemoveTarget(record.id)}
                    className="ui-btn ui-btn-sm ui-btn-ghost text-[#b42318]"
                  >
                    卸载
                  </button>
                  <div className="ml-auto flex items-center gap-2">
                    <Switch
                      label={`启用「${record.name}」`}
                      checked={record.enabled}
                      onChange={(next) => void onToggle(record.id, record.name, next)}
                    />
                  </div>
                </div>

                <p className={`mt-2 ${HINT}`}>
                  窗口、托盘、置顶与位置记忆都由宿主管理；插件只在自己那一个窗口里渲染，
                  读不到主窗数据，也不能操作其它窗口。
                </p>
              </section>
            );
          })}
        </div>
      )}

      {installOpen && (
        <PluginInstallDialog
          onClose={() => setInstallOpen(false)}
          onInstalled={(text) => {
            setMsg({ kind: "ok", text });
            void refreshWidgets();
          }}
        />
      )}

      {removeTarget && (
        <ConfirmDialog
          title="卸载桌面小组件"
          onCancel={() => setRemoveTarget(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setRemoveTarget(null)}
                className="ui-btn ui-btn-md ui-btn-ghost"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void onConfirmRemove()}
                className="ui-btn ui-btn-md ui-btn-primary"
              >
                确认卸载
              </button>
            </>
          }
        >
          <p className="ui-body">
            将删除这个插件的<strong>文件与模型（约 5MB）</strong>、窗口、托盘图标与
            <strong>插件设置</strong>，不可恢复。
          </p>
          <p className="mt-2 ui-caption">
            旧的 `heming.pet.v1` 本地偏好键会保留一版（回滚用），不会被这次卸载删除。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
