/**
 * 信息中枢 · 沙箱 bundle 插件入口
 *
 * 运行在 widget:// 沙箱页面里，只能通过 window.__heming_widget 与宿主通信：
 *   - infohubCall(method, params, { timeoutMs })：调用本机归档桥（只读浏览 + 采集）
 *   - dataGet / dataSet：插件私有数据（自动采集时间、AI 偏好与识别结果）
 *   - homeCardSet：刷新首页卡片文案；openPage / log
 *
 * 不接触 Node、不使用 localStorage，所有归档数据都留在宿主进程；采集全程静默，不弹通知。
 */
import { boot } from './app.js';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
