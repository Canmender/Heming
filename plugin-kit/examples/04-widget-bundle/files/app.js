// 界面插件页的全部宿主能力来自 window.__heming_widget（宿主 preload 注入）。
//
// 本示例演示最小闭环：
//   info()         读宿主信息（pluginId / pluginName / appVersion / theme）
//   settings()     读设置（清单里声明的字段，默认值已补全）
//   setSetting()   写设置（未声明的 key 会被静默忽略——只能比对返回值判断是否生效）
//   dataGet/Set    存插件自己的业务数据（JSON、单文件 ≤1MB、卸载即删）
//   onLifecycle    生命周期事件（需 permissions.events 含 "lifecycle"）
//
// 红线：没有 localStorage / Node / 密钥 / 文件桥；不要做「自由拖拽算坐标」——位移由主进程算。
(() => {
  "use strict";

  const widget = window.__heming_widget;
  const $ = (id) => document.getElementById(id);

  if (!widget) {
    $("status").textContent = "没有检测到 window.__heming_widget：请从和鸣桌面端的界面插件窗口打开本页。";
    return;
  }

  const renderGreeting = (greeting) => {
    $("greeting").textContent = `${greeting || "你好"}，这是一条来自插件设置的内容。`;
  };

  const boot = async () => {
    const [info, settings] = await Promise.all([widget.info(), widget.settings()]);
    $("title").textContent = info.pluginName;
    $("status").textContent = `宿主 ${info.appVersion} · 主题 ${info.theme}`;
    renderGreeting(settings.greeting);

    const saved = await widget.dataGet("counter");
    $("log").textContent = `已记录 ${typeof saved === "number" ? saved : 0} 笔`;

    widget.onSettings((next) => renderGreeting(next.greeting));

    if (typeof widget.onLifecycle === "function") {
      widget.onLifecycle((event) => widget.log(`lifecycle: ${event.event} v${event.version}`));
    }
  };

  $("save").addEventListener("click", async () => {
    const next = window.prompt("新的问候语", "你好");
    if (next === null) return;
    // 只会写入清单里声明过的字段；返回值是合并后的全量设置
    const settings = await widget.setSetting("greeting", next);
    renderGreeting(settings.greeting);
    widget.log("设置已更新");
  });

  $("count").addEventListener("click", async () => {
    const current = await widget.dataGet("counter");
    const next = (typeof current === "number" ? current : 0) + 1;
    const result = await widget.dataSet("counter", next);
    $("log").textContent = `已记录 ${next} 笔（${result.bytes} 字节落盘）`;
  });

  boot().catch((error) => {
    $("status").textContent = `初始化失败：${error instanceof Error ? error.message : String(error)}`;
  });
})();
