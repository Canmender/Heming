const { app, BrowserWindow } = require("electron");
const path = require("node:path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    backgroundColor: "#ffffff",
    title: "和鸣",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 加载地址优先级：HEMING_DEV_URL（本地开发）> HEMING_WEB_URL > 默认远程（云端中心化，file:// 静态产物方案废弃）
  const devUrl = process.env.HEMING_DEV_URL;
  const webUrl = process.env.HEMING_WEB_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else if (webUrl) {
    win.loadURL(webUrl);
  } else {
    win.loadURL("http://47.92.39.184");
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
