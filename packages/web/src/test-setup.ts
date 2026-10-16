import "@testing-library/jest-dom/vitest";

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
