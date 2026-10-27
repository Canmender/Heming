"use strict";
/**
 * 本机密钥信封桥（d.36 · P0-5）。
 *
 * 职责：用 Electron `safeStorage`（Windows DPAPI / macOS 钥匙串 / 系统密钥环）
 * 给 web 端的三个低频键做加解密：
 *   heming.llmConfigs / heming.mcp.servers.v1 / heming.e2e.identity
 *
 * 红线：只做加解密。**不引入任何网络能力**，也不写文件——密文由渲染层写回
 * 原 localStorage 键位（就地信封），主进程不保存第二份。
 * 测试会从源码的 require 列表结构性断言这一点。
 *
 * 为什么是同步 IPC：渲染层那三个键都是同步读写（store 在模块初始化时读），
 * 改异步会牵动整条启动链。sendSync 的阻塞代价只落在这三个低频键上。
 */

const ENVELOPE_VERSION = "v1";

/** 取 safeStorage；测试可注入，避免纯 node 环境加载 electron。 */
function defaultSafeStorage() {
  try {
    return require("electron").safeStorage;
  } catch {
    return null;
  }
}

function isAvailable(safeStorage = defaultSafeStorage()) {
  try {
    return !!safeStorage && safeStorage.isEncryptionAvailable() === true;
  } catch {
    return false; // Linux 无 keyring / 系统策略禁用：降级为「不可用」，不抛
  }
}

/** 加密为 base64 密文；不可用或失败返回 null（调用方保留明文，绝不丢配置）。 */
function encrypt(plain, safeStorage = defaultSafeStorage()) {
  if (typeof plain !== "string" || !plain) return null;
  if (!isAvailable(safeStorage)) return null;
  try {
    return safeStorage.encryptString(plain).toString("base64");
  } catch {
    return null;
  }
}

function decrypt(cipherB64, safeStorage = defaultSafeStorage()) {
  if (typeof cipherB64 !== "string" || !cipherB64) return null;
  if (!isAvailable(safeStorage)) return null;
  try {
    const buf = Buffer.from(cipherB64, "base64");
    if (!buf.length) return null;
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

/** 注册 IPC：三条都是同步通道（preload 用 sendSync 调用）。 */
function registerSecretIpc(ipcMain, safeStorage = defaultSafeStorage()) {
  ipcMain.on("secret:available", (event) => {
    event.returnValue = isAvailable(safeStorage);
  });
  ipcMain.on("secret:encrypt", (event, plain) => {
    event.returnValue = encrypt(plain, safeStorage);
  });
  ipcMain.on("secret:decrypt", (event, cipherB64) => {
    event.returnValue = decrypt(cipherB64, safeStorage);
  });
}

module.exports = {
  ENVELOPE_VERSION,
  isAvailable,
  encrypt,
  decrypt,
  registerSecretIpc,
};
