import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";
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

/**
 * jsdom 未实现 Element.scrollIntoView（浏览器原生有）。
 *
 * 放全局而不是各测试文件自己打桩：消息列表、引用跳转、工具轮都可能在
 * 任何一轮 effect 里调它，漏掉一个文件就会在某个用例里抛
 * "scrollIntoView is not a function"，而报错点与真正的缺口相隔很远，很难定位。
 * 真实浏览器不走此分支。
 */
if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

/**
 * 全量门禁下 jsdom 环境争用会把 `findBy*` 的默认 1s 等待顶穿。
 *
 * 背景（d.64 集成时实测）：210 个测试文件并发跑时，环境创建占去约 65% 的 worker 时间，
 * `App.test.tsx` 里「关掉弹窗后 Ctrl+K 打开命令面板」这条断言偶发在 1s 内等不到
 * `role="dialog"`——单文件跑必然通过，全量跑必红。断言本身没有放宽（仍要求弹窗出现），
 * 只是把「等多久算失败」从 1s 提到 3s：宁可让真正的挂起多等 2s，也不要让门禁被环境争用染红。
 *
 * 放在全局而不是给单条用例传 timeout：同类断言全仓有几百处，逐个加只会变成打地鼠。
 */
configure({ asyncUtilTimeout: 3000 });

/**
 * jsdom 未实现 window.matchMedia（浏览器/Electron 原生有），而 BootWave 的用例要
 * `vi.spyOn(window, "matchMedia")` 来模拟「减弱动态」。
 *
 * 为什么升级后必须补：vitest 1.x 的 spyOn 遇到不存在的属性会**静默新建**一个再替换，
 * 所以那 3 个用例一直能过；vitest 5 的 spyOn 收紧为「只能 spy 函数，收到 undefined 就抛」，
 * 于是升级后立刻红。补一个基线桩即可让 spyOn 有东西可替换。
 *
 * 取值刻意是 `matches: false` —— 与「没有 matchMedia」时产品代码的回落分支
 * （BootWave.tsx 里 `typeof window.matchMedia === "function" && …` 判假）**语义完全一致**，
 * 不会让别的用例看到「开启了减弱动态」这种假的真分支。
 */
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}
