import { describe, expect, it } from "vitest";
import type { FileFsBridge, FileReadResponse } from "../fileEdit/bridge.js";
import type { FileRoot } from "../fileEdit/paths.js";
import {
  FILE_REFS_HEADING,
  MAX_FILE_REFS,
  MAX_FILE_REF_CHARS,
  MAX_FILE_REFS_TOTAL_CHARS,
  collectFileRefs,
} from "./fileRefs.js";

const ROOT: FileRoot = { name: "工作区", path: "D:/项目/和鸣", mode: "write" };

/** 以「绝对路径 → 内容」做一张内存盘；未收录的路径回 not-found。 */
function fakeBridge(files: Record<string, string>, onRead?: (path: string) => void): FileFsBridge {
  return {
    read: async ({ path }): Promise<FileReadResponse> => {
      onRead?.(path);
      const key = Object.keys(files).find((k) => k.toLowerCase() === path.toLowerCase());
      if (key === undefined) return { ok: false, code: "not-found", error: "找不到文件" };
      return { ok: true, content: files[key]!, bytes: files[key]!.length };
    },
    write: async () => ({ ok: true }),
    pickRoot: async () => null,
  };
}

const base = () => ({ bridge: fakeBridge({}), roots: [ROOT] });

describe("引用工作区文件（d.175）", () => {
  it("没有桌面桥时零注入（浏览器端没有本机文件）", async () => {
    const got = await collectFileRefs({ ...base(), bridge: null, paths: ["D:/项目/和鸣/AGENTS.md"] });
    expect(got.section).toBe("");
    expect(got.files).toEqual([]);
  });

  it("没有选中任何文件时零注入", async () => {
    const got = await collectFileRefs({ ...base(), paths: [] });
    expect(got).toEqual({ files: [], missing: [], section: "" });
  });

  it("有根但一个都读不到时，也只在读不到的清单里说一句，不编内容", async () => {
    const got = await collectFileRefs({
      ...base(),
      bridge: fakeBridge({}),
      paths: ["D:/项目/和鸣/不存在.md"],
    });
    expect(got.files).toEqual([]);
    expect(got.missing).toEqual(["不存在.md"]);
    expect(got.section).toContain("没读到");
    expect(got.section).toContain("不要凭文件名猜内容");
  });

  it("读到文件时：标题、相对路径、原文都在，且明说不用再读一遍", async () => {
    const got = await collectFileRefs({
      ...base(),
      bridge: fakeBridge({ "D:/项目/和鸣/docs/说明.md": "# 说明\n\n这是正文。" }),
      paths: ["D:/项目/和鸣/docs/说明.md"],
    });
    expect(got.section).toContain(FILE_REFS_HEADING);
    expect(got.section).toContain("### docs/说明.md");
    expect(got.section).toContain("这是正文。");
    expect(got.section).toContain("不用再 file_read 取一遍");
    expect(got.files.map((f) => f.rel)).toEqual(["docs/说明.md"]);
  });

  it("最多引用 3 个：多给的直接丢弃", async () => {
    const got = await collectFileRefs({
      ...base(),
      bridge: fakeBridge({
        "D:/项目/和鸣/a.md": "A",
        "D:/项目/和鸣/b.md": "B",
        "D:/项目/和鸣/c.md": "C",
        "D:/项目/和鸣/d.md": "D",
      }),
      paths: [
        "D:/项目/和鸣/a.md",
        "D:/项目/和鸣/b.md",
        "D:/项目/和鸣/c.md",
        "D:/项目/和鸣/d.md",
      ],
    });
    expect(got.files.map((f) => f.rel)).toEqual(["a.md", "b.md", "c.md"]);
    expect(MAX_FILE_REFS).toBe(3);
  });

  it("单文件超长会截断，并明说要用 file_read 读后面", async () => {
    const long = "x".repeat(MAX_FILE_REF_CHARS + 500);
    const got = await collectFileRefs({
      ...base(),
      bridge: fakeBridge({ "D:/项目/和鸣/长.txt": long }),
      paths: ["D:/项目/和鸣/长.txt"],
    });
    expect(got.files[0]!.truncated).toBe(true);
    expect(got.section).toContain(`只给了前 ${MAX_FILE_REF_CHARS} 字`);
    expect(got.section).toContain("file_read");
  });

  it("根外路径不读盘：引用不等于授权", async () => {
    const read: string[] = [];
    const got = await collectFileRefs({
      bridge: fakeBridge({ "C:/Windows/win.ini": "[x]" }, (path) => read.push(path)),
      roots: [ROOT],
      paths: ["C:/Windows/win.ini"],
    });
    expect(read).toEqual([]);
    expect(got.files).toEqual([]);
    expect(got.missing).toEqual(["C:/Windows/win.ini"]);
  });

  it("空文件按「读不到」处理：给模型一段空白等于让它编", async () => {
    const got = await collectFileRefs({
      ...base(),
      bridge: fakeBridge({ "D:/项目/和鸣/空.md": "  \n\n" }),
      paths: ["D:/项目/和鸣/空.md"],
    });
    expect(got.files).toEqual([]);
    expect(got.missing).toEqual(["空.md"]);
  });

  it("合计超过总量上限的文件不进正文，但要出现在没读到的清单里", async () => {
    // 单文件上限 6000、总量 12000：两份刚好吃满，第三份必须让位。
    const full = "y".repeat(MAX_FILE_REF_CHARS);
    const got = await collectFileRefs({
      ...base(),
      bridge: fakeBridge({
        "D:/项目/和鸣/一.txt": full,
        "D:/项目/和鸣/二.txt": full,
        "D:/项目/和鸣/三.txt": "z".repeat(200),
      }),
      paths: ["D:/项目/和鸣/一.txt", "D:/项目/和鸣/二.txt", "D:/项目/和鸣/三.txt"],
    });
    expect(got.files.map((f) => f.rel)).toEqual(["一.txt", "二.txt"]);
    expect(got.missing).toEqual(["三.txt"]);
    expect(MAX_FILE_REFS_TOTAL_CHARS).toBe(12000);
  });

  it("桥抛错时静默降级，不让一轮对话因为引用而失败", async () => {
    const broken: FileFsBridge = {
      read: async () => {
        throw new Error("桥挂了");
      },
      write: async () => ({ ok: true }),
      pickRoot: async () => null,
    };
    const got = await collectFileRefs({
      bridge: broken,
      roots: [ROOT],
      paths: ["D:/项目/和鸣/a.md"],
    });
    expect(got.files).toEqual([]);
    expect(got.missing).toEqual(["a.md"]);
  });
});
