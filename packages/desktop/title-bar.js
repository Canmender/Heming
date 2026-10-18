"use strict";
// 桌面窗口自定义标题栏配置（设计 §3/§4）：把平台分支抽成纯函数，
// 便于 node:test 直接验证，不 require electron（同 secure-origins.js 的模式）。
//
// 方案选型：titleBarOverlay（保留原生窗口控件）而非全自绘——原生控件带 Win11
// 贴靠布局等系统特性，自绘即丢失。Mica 材质因按壁纸着色、与和鸣灰白调性冲突而不用。

/** 标题栏高度：比 Win 原生（约 32px + 菜单栏）更紧凑。 */
const TITLE_BAR_HEIGHT = 38;
/** 标题栏背景：与左侧导航轨同色（bg-[#fafafa]），视觉上连成一片。 */
const TITLE_BAR_COLOR = "#fafafa";
/** 控件符号色：与导航图标 text-[#666] 一致。 */
const TITLE_BAR_SYMBOL_COLOR = "#666666";
/** 窗口背景：替代纯白，消除启动白闪（与标题栏/导航轨同色）。 */
const WINDOW_BACKGROUND = "#fafafa";

/**
 * 按平台返回 BrowserWindow 的标题栏相关选项（调用方展开进构造参数）。
 * - win32/linux：titleBarOverlay 自定义控件配色与高度（Linux 不支持 overlay，但
 *   传入无害且当前只构建 Win 安装包）；
 * - darwin：控件在左上，用 trafficLightPosition 微调，避免与内容顶部贴太近。
 */
function titleBarOptions(platform) {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 14, y: 12 },
    };
  }
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLE_BAR_COLOR,
      symbolColor: TITLE_BAR_SYMBOL_COLOR,
      height: TITLE_BAR_HEIGHT,
    },
  };
}

module.exports = {
  TITLE_BAR_HEIGHT,
  TITLE_BAR_COLOR,
  TITLE_BAR_SYMBOL_COLOR,
  WINDOW_BACKGROUND,
  titleBarOptions,
};
