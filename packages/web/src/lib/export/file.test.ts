import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDesktopExportBridge, saveExportFile } from "./file.js";

/**
 * 导出落盘：有桌面桥走主进程，无桥回退 Blob 下载。
 * 两条路径都必须只碰本机——用 fetch 断言钉死「不发网络请求」的红线。
 */

beforeEach(() => {
  delete window.__heming_exports;
});

afterEach(() => {
  delete window.__heming_exports;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("saveExportFile", () => {
  it("有桌面桥：调用主进程写文件并返回路径，不走浏览器下载", async () => {
    const write = vi.fn(async () => ({
      ok: true,
      path: "C:\\Users\\u\\Heming\\exports\\记忆导出.json",
    }));
    window.__heming_exports = {
      write,
      info: async () => ({ dir: "C:\\Users\\u\\Heming\\exports", exists: true }),
    };
    const create = vi.spyOn(URL, "createObjectURL");

    expect(hasDesktopExportBridge()).toBe(true);
    const result = await saveExportFile("记忆导出.json", '{"a":1}');

    expect(result).toEqual({ via: "desktop", path: "C:\\Users\\u\\Heming\\exports\\记忆导出.json" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("记忆导出.json", '{"a":1}');
    expect(create).not.toHaveBeenCalled();
  });

  it("桌面桥写失败：抛错（不静默回退下载）", async () => {
    window.__heming_exports = {
      write: async () => ({ ok: false, error: "磁盘已满" }),
      info: async () => ({ dir: "C:\\exports", exists: true }),
    };
    await expect(saveExportFile("记忆导出.json", "{}")).rejects.toThrow("磁盘已满");
  });

  it("桌面桥 IPC 异常：包装成可读错误抛出", async () => {
    window.__heming_exports = {
      write: async () => {
        throw new Error("IPC 连接断开");
      },
      info: async () => ({ dir: "C:\\exports", exists: true }),
    };
    await expect(saveExportFile("记忆导出.json", "{}")).rejects.toThrow(/写入导出文件失败.*IPC 连接断开/);
  });

  it("无桥：Blob 下载，临时 <a download> 触发后移除，fetch 未被调用", async () => {
    expect(hasDesktopExportBridge()).toBe(false);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-1");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const seen: { download?: string; href?: string } = {};
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      seen.download = this.download;
      seen.href = this.href;
    });
    vi.useFakeTimers();

    const result = await saveExportFile("记忆导出-2026-10-23.json", '{"a":1}');

    expect(result).toEqual({ via: "download" });
    expect(click).toHaveBeenCalledTimes(1);
    expect(seen).toEqual({ download: "记忆导出-2026-10-23.json", href: "blob:mock-1" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    // 延迟回收：点击后立刻 revoke 会让部分浏览器读到空 blob
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:mock-1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
