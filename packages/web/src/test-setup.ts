import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";

/**
 * jsdom 不实现 crypto.subtle（E2E 加密核心的 HKDF/ECDH/AES-GCM 全依赖它），
 * 注入 node:crypto 的 webcrypto（同为 W3C 标准实现）。真实浏览器/Electron 已有
 * subtle（规格 §2.1：http 非安全上下文缺 subtle 是产品横幅问题，不走此分支）。
 */
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

/**
 * jsdom 25 的 Blob/File 未实现 arrayBuffer()（浏览器原生有），附件上传（uploadFile）的
 * 测试会撞 TypeError。用 FileReader 补齐缺失分支（jsdom 的 readAsArrayBuffer 完整可用），
 * 已具备该方法的运行时（真实浏览器/Electron）不走此定义。
 */
if (typeof Blob !== "undefined" && typeof Blob.prototype.arrayBuffer !== "function") {
  Object.defineProperty(Blob.prototype, "arrayBuffer", {
    configurable: true,
    writable: true,
    value(this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as ArrayBuffer);
        fr.onerror = () => reject(fr.error ?? new Error("FileReader 读取失败"));
        fr.readAsArrayBuffer(this);
      });
    },
  });
}

/**
 * jsdom 未实现 URL.createObjectURL/revokeObjectURL（浏览器原生有），附件气泡
 * （fetchFileBlobUrl → objectURL → 卸载 revoke）的用例要 spyOn 这两个方法，
 * 先补可被覆盖的桩（伪地址带序号可区分），真实浏览器不走此分支。
 */
if (typeof URL !== "undefined" && typeof URL.createObjectURL !== "function") {
  let seq = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: () => `blob:jsdom-${++seq}`,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: () => {},
  });
}
