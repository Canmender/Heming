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

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * @param ipcMain Electron ipcMain
 * @param {{Notification: any, BrowserWindow: any}} deps 注入以便纯 node 测试
 */
function registerNotifyIpc(ipcMain, { Notification, BrowserWindow }) {
  ipcMain.on("notify:message", (_event, payload) => {
    const title = cleanText(payload && payload.title, TITLE_MAX) || "新消息";
    const body = cleanText(payload && payload.body, BODY_MAX) || "你有一条新消息";
    const conversationId =
      typeof payload?.conversationId === "string" && payload.conversationId
        ? payload.conversationId
        : null;
    try {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title, body });
      notification.on("click", () => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        if (conversationId) win.webContents.send("notify:open", conversationId);
      });
      notification.show();
    } catch {
      /* 通知失败不影响消息主流程 */
    }
  });
}

module.exports = { registerNotifyIpc, cleanText };
