// 界面插件页的宿主能力全部来自 window.__heming_widget（由宿主 preload 注入）。
// 这里只演示 info() 与 log()；偏好走 settings() / setSetting()，业务数据走 data*。
// 注意：脚本必须放外部文件，CSP 的 script-src 只放 'self'，内联脚本在 enforce 模式下会被拦。
(() => {
  "use strict";

  const widget = window.__heming_widget;
  const status = document.getElementById("status");

  if (!widget) {
    status.textContent = "没有检测到 window.__heming_widget：请从和鸣桌面端的界面插件窗口打开本页。";
    return;
  }

  widget
    .info()
    .then((info) => {
      status.textContent = `插件 ${info.pluginName}（${info.pluginId}）· 宿主 ${info.appVersion} · 主题 ${info.theme}`;
      widget.log("{{id}}：页面已就绪");
    })
    .catch((error) => {
      status.textContent = `读取宿主信息失败：${error instanceof Error ? error.message : String(error)}`;
    });

  document.getElementById("log").addEventListener("click", () => {
    widget.log("{{name}}：用户点击了按钮");
  });
})();
