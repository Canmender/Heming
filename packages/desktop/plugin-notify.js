"use strict";

const { cleanText } = require("./notify-bridge");

/**
 * 插件通知（`permissions.notify` + `__heming_widget.notify`）的投递层。
 *
 * 为什么先转给主窗、再退回系统通知：主窗有通知中心（历史可回看、点击能定位到
 * 会话），系统通知只是一次性气泡。所以只要主窗还活着就交给主窗渲染，主窗不在
 * （未创建/已销毁/退出中）才退回 Notification，保证插件通知不会静默消失。
 *
 * 文本清洗复用 notify-bridge 的 `cleanText`：那条路径已经在处理「用户输入的标题里
 * 混控制符/超长」的问题，插件参数同样是外部输入，没必要写第二套规则。
 */

/** 标题长度上限（与 notify-bridge 的主窗通知一致）。 */
const NOTIFY_TITLE_MAX = 80;
/** 正文长度上限，同样是主窗通知的口径。 */
const NOTIFY_BODY_MAX = 160;
/** 只认三档，其余值按 info 处理（插件同宿主版本不一致时不该整条丢弃）。 */
const NOTIFY_LEVELS = new Set(["info", "warn", "error"]);

/** 归一化插件通知载荷；返回可读错误而不是抛异常，调用方决定记日志还是拒绝。 */
function normalizePluginNotify(raw) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const pluginId = typeof input.pluginId === "string" ? input.pluginId.trim() : "";
  if (!pluginId) return { ok: false, error: "plugin:notify 缺少 pluginId" };
  const title = cleanText(input.title, NOTIFY_TITLE_MAX);
  if (!title) return { ok: false, error: "plugin:notify 缺少 title" };
  const level = NOTIFY_LEVELS.has(input.level) ? input.level : "info";
  const body = cleanText(input.body, NOTIFY_BODY_MAX);
  const payload = { pluginId, title, level };
  // body 可选：空正文不进载荷，主窗渲染时也不用区分「空串」和「没有」
  if (body) payload.body = body;
  return { ok: true, payload };
}

/**
 * 建一个插件通知投递器。
 *
 * `getMainWindow` / `Notification` 都注入：主进程用真 Electron 对象，单测用假对象，
 * 两条路径（渲染层 / 系统通知）都能被测到。
 */
function createPluginNotifier(deps = {}) {
  const { getMainWindow, Notification, log = () => {} } = deps;

  function sendToMainWindow(payload) {
    const win = typeof getMainWindow === "function" ? getMainWindow() : null;
    if (!win || typeof win.isDestroyed !== "function" || win.isDestroyed()) return false;
    const wc = win.webContents;
    if (!wc || (typeof wc.isDestroyed === "function" && wc.isDestroyed())) return false;
    try {
      wc.send("plugin:notify", payload);
      return true;
    } catch (err) {
      log(`[widgets] 插件通知转交主窗失败：${(err && err.message) || err}`);
      return false;
    }
  }

  function sendSystemNotification(payload) {
    if (!Notification) return false;
    try {
      if (typeof Notification.isSupported === "function" && !Notification.isSupported()) return false;
      const notification = new Notification({ title: payload.title, body: payload.body || "" });
      if (typeof notification.show === "function") notification.show();
      return true;
    } catch (err) {
      log(`[widgets] 插件系统通知失败：${(err && err.message) || err}`);
      return false;
    }
  }

  return {
    /**
     * 投递一条通知，返回 `{ delivered }`：`renderer` 主窗通知中心 / `system` 系统
     * 通知 / `none` 两条路都不可用（例如无 GUI 通知支持的平台）。
     */
    notify(raw) {
      const normalized = normalizePluginNotify(raw);
      if (!normalized.ok) {
        log(`[widgets] 插件通知被丢弃：${normalized.error}`);
        return { delivered: "none", error: normalized.error };
      }
      const { payload } = normalized;
      if (sendToMainWindow(payload)) return { delivered: "renderer" };
      if (sendSystemNotification(payload)) return { delivered: "system" };
      return { delivered: "none" };
    },
  };
}

module.exports = {
  createPluginNotifier,
  normalizePluginNotify,
  NOTIFY_TITLE_MAX,
  NOTIFY_BODY_MAX,
  NOTIFY_LEVELS,
};
