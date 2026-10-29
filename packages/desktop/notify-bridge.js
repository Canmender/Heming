"use strict";
/**
 * 系统通知桥（d.39）。
 *
 * 渲染层只传「标题 / 固定正文 / 会话 id」，主进程负责显示与点击聚焦；
 * 通知正文不包含消息内容（锁屏被别人看到也不泄露）。
 * 红线：本模块只碰系统通知，不引入任何网络能力（测试钉死）。
 */

const TITLE_MAX = 80;
const BODY_MAX = 160;
/** 跨进程边界只接受普通 id 字符，限长 128：防 100k 串或注入字符穿透成幽灵会话。 */
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  // 孤立代理项先换成 U+FFFD，避免系统通知显示 �；C0/C1 控制符换成空格后再折叠空白。
  const well = typeof value.toWellFormed === "function" ? value.toWellFormed() : value;
  // 按码点切：UTF-16 slice 会把 emoji 劈成孤立代理项（显示为 �）。
  return [...well.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim()]
    .slice(0, max)
    .join("");
}

function cleanConversationId(value) {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value) ? value : null;
}

/**
 * @param ipcMain Electron ipcMain
 * @param {{Notification: any, getMainWindow: () => any, getFocusedWindow?: () => any}} deps
 *   注入以便纯 node 测试
 */
function registerNotifyIpc(ipcMain, { Notification, getMainWindow, getFocusedWindow }) {
  ipcMain.on("notify:message", (_event, payload) => {
    const title = cleanText(payload && payload.title, TITLE_MAX) || "新消息";
    const body = cleanText(payload && payload.body, BODY_MAX) || "你有一条新消息";
    const conversationId = cleanConversationId(payload && payload.conversationId);
    try {
      // 应用任一窗口在前台（含独立通话窗口）就不打扰：渲染层的 document.hasFocus()
      // 只看主窗口，通话窗口在前台时主窗口不在前台，单看主窗口会误弹。
      const focused = getFocusedWindow?.();
      if (focused && !focused.isDestroyed()) return;
      // 渲染层的 document.hasFocus() 可能滞后；主进程再确认一次窗口确实不在前台。
      const mainWin = getMainWindow();
      if (mainWin && !mainWin.isDestroyed() && mainWin.isFocused()) return;
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title, body });
      // 点击回调可能被触发两次（系统重复派发 / 用户连点）：只处理第一次。
      let clicked = false;
      notification.on("click", () => {
        if (clicked) return;
        clicked = true;
        // 点击回调异步执行：getMainWindow() 抛错或窗口瞬间销毁都不能让主进程未捕获。
        try {
          // 显式取主窗口：多窗口（主窗口 + 独立通话窗口）时不能聚焦到通话窗口。
          const win = getMainWindow();
          if (!win || win.isDestroyed()) return;
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
          if (conversationId) win.webContents.send("notify:open", conversationId);
        } catch {
          /* 聚焦/跳转失败不影响消息主流程 */
        }
      });
      notification.show();
    } catch {
      /* 通知失败不影响消息主流程 */
    }
  });
}

module.exports = { registerNotifyIpc, cleanText };
