import { describe, expect, it } from "vitest";
import type { FileFsBridge, FileWriteOp } from "./bridge.js";
import type { FileRoot } from "./paths.js";
import { runEdit, runGlob, runGrep, runWrite, type FileOpsDeps } from "./toolOps.js";

const ROOT: FileRoot = { name: "工作区", path: "D:/库", mode: "write" };
const READ_ROOT: FileRoot = { name: "参考", path: "D:/参考", mode: "read" };

/**
 * 内存桥：`绝对路径 → 内容`，并记录每次写入的载荷（含 `createParents`）。
 *
 * `globPaths` / `grepMatches` 是预设返回，用来把「桌面端遍历」的细节挡在测试外面——
 * 本文件测的是 web 侧的执行体（路径解析、文案、截断、错误映射），遍历语义归桌面端测试。
 */
function fakeBridge(
  initial: Record<string, string> = {},
  extra: {
    globPaths?: string[];
    grepMatches?: { path: string; line: number; text: string }[];
    /** 桌面端回报的「这次真跳过了哪些目录」（d.231）；不传 = 老桌面端不报。 */
    skipped?: string[];
    /**
     * 桌面端回报的「有多少文件没能打开」（d.232）：null/不传 = 全都搜过了。
     */
    skippedFiles?:
      | {
          total: number;
          tooLarge: number;
          binary: number;
          undecodable: number;
          other: number;
          sample: string[];
        }
      | null;
  } = {},
) {
  const files: Record<string, string> = { ...initial };
  const writes: { ops: FileWriteOp[]; createParents?: boolean }[] = [];
  const bridge: FileFsBridge & { writes: typeof writes; files: Record<string, string> } = {
    files,
    writes,
    async read({ path }) {
      if (path in files) {
        const content = files[path];
        return { ok: true, content, bytes: new TextEncoder().encode(content).length };
      }
      return { ok: false as const, code: "not-found" as const, error: "文件不存在" };
    },
    async write({ ops, createParents }) {
      writes.push({ ops, ...(createParents ? { createParents } : {}) });
      for (const op of ops) {
        if (op.kind === "write") files[op.path] = op.content ?? "";
        else delete files[op.path];
      }
      return { ok: true, results: ops.map((op) => ({ path: op.path, ok: true })), written: ops.length };
    },
    async pickRoot() {
      return null;
    },
    async glob({ pattern }) {
      return {
        ok: true as const,
        root: ROOT.path,
        paths: extra.globPaths ?? [],
        truncated: false,
        ...(extra.skipped ? { skipped: extra.skipped } : {}),
      };
    },
    async grep() {
      return {
        ok: true as const,
        root: ROOT.path,
        matches: extra.grepMatches ?? [],
        truncated: false,
        ...(extra.skipped ? { skipped: extra.skipped } : {}),
        ...(extra.skippedFiles !== undefined ? { skippedFiles: extra.skippedFiles } : {}),
      };
    },
  };
  return bridge;
}

const deps = (
  bridge: ReturnType<typeof fakeBridge>,
  roots: FileRoot[] = [ROOT],
): FileOpsDeps => ({ bridge, roots });

describe("file_write（整份建/覆盖）", () => {
  it("新建文件：createParents=true，文案说「已创建」", async () => {
    const bridge = fakeBridge();
    const result = await runWrite(deps(bridge), { path: "notes/新.md", content: "你好\n世界\n" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("已创建 notes/新.md");
    expect(result.text).toContain("2 行");
    expect(bridge.files["D:/库/notes/新.md"]).toBe("你好\n世界\n");
    expect(bridge.writes[0]?.createParents).toBe(true);
  });

  it("覆盖已有文件：文案说「已覆盖」并提醒原内容被替换", async () => {
    const bridge = fakeBridge({ "D:/库/a.md": "旧" });
    const result = await runWrite(deps(bridge), { path: "a.md", content: "新" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("已覆盖 a.md");
    expect(result.text).toContain("原内容已被整份替换");
    expect(bridge.files["D:/库/a.md"]).toBe("新");
  });

  it("空内容合法（建空文件）", async () => {
    const bridge = fakeBridge();
    const result = await runWrite(deps(bridge), { path: "empty.txt", content: "" });
    expect(result.ok).toBe(true);
    expect(bridge.files["D:/库/empty.txt"]).toBe("");
  });

  it("content 不是字符串：invalid-args 且给 retry_with", async () => {
    const bridge = fakeBridge();
    const result = await runWrite(deps(bridge), { path: "a.md" });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("invalid-args");
    expect(result.error?.retry_with).toBeTruthy();
    expect(bridge.writes).toHaveLength(0);
  });

  it("只读根：root-readonly，一个字节都不写", async () => {
    const bridge = fakeBridge();
    const result = await runWrite(deps(bridge, [READ_ROOT]), { path: "a.md", content: "x", root: "参考" });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("root-readonly");
    expect(bridge.writes).toHaveLength(0);
  });

  it("绝对路径 / 越界：path-invalid / path-escape，不写盘", async () => {
    const bridge = fakeBridge();
    const abs = await runWrite(deps(bridge), { path: "D:/库/a.md", content: "x" });
    expect(abs.ok).toBe(false);
    expect(abs.error?.error_code).toBe("path-invalid");
    const escape = await runWrite(deps(bridge), { path: "../外.md", content: "x" });
    expect(escape.ok).toBe(false);
    expect(escape.error?.error_code).toBe("path-escape");
    expect(bridge.writes).toHaveLength(0);
  });
});

describe("file_edit（精确串替换）", () => {
  it("唯一匹配：替换成功并通过 write 落盘（不建父目录）", async () => {
    const bridge = fakeBridge({ "D:/库/a.ts": "const a = 1;\nconst b = 2;\n" });
    const result = await runEdit(deps(bridge), { path: "a.ts", old_string: "const b = 2;", new_string: "const b = 3;" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("替换 1 处");
    expect(bridge.files["D:/库/a.ts"]).toBe("const a = 1;\nconst b = 3;\n");
    expect(bridge.writes[0]?.ops[0]?.kind).toBe("write");
    expect(bridge.writes[0]?.createParents).toBeUndefined();
  });

  it("出现多次且没给 replace_all：拒绝（不是静默只改第一处）", async () => {
    const bridge = fakeBridge({ "D:/库/a.txt": "x\nx\n" });
    const result = await runEdit(deps(bridge), { path: "a.txt", old_string: "x", new_string: "y" });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("match-failed");
    expect(result.error?.retry_with).toContain("replace_all");
    expect(bridge.writes).toHaveLength(0);
  });

  it("replace_all=true：全部替换", async () => {
    const bridge = fakeBridge({ "D:/库/a.txt": "x\nx\nx\n" });
    const result = await runEdit(deps(bridge), { path: "a.txt", old_string: "x", new_string: "y", replace_all: true });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("替换 3 处");
    expect(bridge.files["D:/库/a.txt"]).toBe("y\ny\ny\n");
  });

  it("模型给 \\n、文件是 CRLF：自动按 CRLF 变体再匹配一次", async () => {
    const bridge = fakeBridge({ "D:/库/a.txt": "第一行\r\n第二行\r\n" });
    const result = await runEdit(deps(bridge), { path: "a.txt", old_string: "第一行\n第二行", new_string: "改了" });
    expect(result.ok).toBe(true);
    expect(bridge.files["D:/库/a.txt"]).toBe("改了\r\n");
  });

  it("找不到原文：match-failed，提示先 file_read", async () => {
    const bridge = fakeBridge({ "D:/库/a.txt": "abc" });
    const result = await runEdit(deps(bridge), { path: "a.txt", old_string: "zzz", new_string: "y" });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("match-failed");
    expect(result.text).toContain("file_read");
    expect(bridge.writes).toHaveLength(0);
  });

  it("文件不存在：not-found，并指向 file_write", async () => {
    const bridge = fakeBridge();
    const result = await runEdit(deps(bridge), { path: "没有.md", old_string: "a", new_string: "b" });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("not-found");
    expect(result.text).toContain("file_write");
    expect(bridge.writes).toHaveLength(0);
  });

  it("old_string 为空：invalid-args", async () => {
    const bridge = fakeBridge({ "D:/库/a.txt": "abc" });
    const result = await runEdit(deps(bridge), { path: "a.txt", old_string: "", new_string: "y" });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("invalid-args");
  });
});

describe("file_glob（按通配符找文件）", () => {
  it("返回根内相对路径（绝对路径不对模型暴露）", async () => {
    const bridge = fakeBridge({}, { globPaths: ["D:/库/src/a.ts", "D:/库/README.md"] });
    const result = await runGlob(deps(bridge), { pattern: "**/*" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("命中 2 个文件");
    expect(result.text).toContain("src/a.ts");
    expect(result.text).not.toContain("D:/库/src/a.ts");
  });

  it("没有命中：给可执行的下一步，而不是干巴巴的 0", async () => {
    const bridge = fakeBridge();
    const result = await runGlob(deps(bridge), { pattern: "*.nope" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("没有匹配的文件");
    expect(result.text).toContain("file_read");
  });

  it("path 越界：path-escape，不调用桥", async () => {
    const bridge = fakeBridge();
    const result = await runGlob(deps(bridge), { pattern: "*", path: "../外面" });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("path-escape");
  });
});

describe("file_grep（按正则搜内容）", () => {
  it("命中按「相对路径:行号: 内容」输出，并统计文件数", async () => {
    const bridge = fakeBridge({}, {
      grepMatches: [
        { path: "D:/库/src/a.ts", line: 2, text: "const TODO = 1" },
        { path: "D:/库/src/a.ts", line: 9, text: "// TODO: 改" },
        { path: "D:/库/b.ts", line: 1, text: "TODO" },
      ],
    });
    const result = await runGrep(deps(bridge), { pattern: "TODO" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("命中 3 处，涉及 2 个文件");
    expect(result.text).toContain("src/a.ts:2: const TODO = 1");
    expect(result.text).toContain("src/a.ts:9:");
    expect(result.text).not.toContain("D:/库/");
  });

  it("没有命中：提示换关键词或去 include", async () => {
    const bridge = fakeBridge();
    const result = await runGrep(deps(bridge), { pattern: "NOTHING" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("没有匹配内容");
  });

  it("空 pattern：invalid-pattern 且给 retry_with", async () => {
    const bridge = fakeBridge();
    const result = await runGrep(deps(bridge), { pattern: "  " });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("invalid-pattern");
    expect(result.error?.retry_with).toBeTruthy();
  });
});

describe("落盘清单 writes（d.176）", () => {
  it("file_write 成功时回绝对路径，界面据此给「撤回本轮改动」", async () => {
    const bridge = fakeBridge();
    const result = await runWrite(deps(bridge), { path: "notes/新.md", content: "内容\n" });
    expect(result.ok).toBe(true);
    expect(result.writes).toEqual(["D:/库/notes/新.md"]);
  });

  it("file_edit 成功时也回绝对路径（只改了内容，仍然是这一轮动过的文件）", async () => {
    const bridge = fakeBridge({ "D:/库/a.md": "端口：8080\n" });
    const result = await runEdit(deps(bridge), { path: "a.md", old_string: "8080", new_string: "9090" });
    expect(result.ok).toBe(true);
    expect(result.writes).toEqual(["D:/库/a.md"]);
  });

  it("失败时没有 writes（没写成的文件不该出现在撤回条上）", async () => {
    const bridge = fakeBridge({ "D:/库/a.md": "端口：8080\n" });
    const result = await runEdit(deps(bridge), { path: "a.md", old_string: "不存在", new_string: "x" });
    expect(result.ok).toBe(false);
    expect(result.writes).toBeUndefined();
  });
});

describe("写入被编码闸拦下：给 encoding-mismatch 与改道建议（d.229）", () => {
  it("目标不是 UTF-8 时不再报 write-failed，而是说清「换个新文件」", async () => {
    const bridge = fakeBridge();
    bridge.write = async () => ({
      ok: false as const,
      error: "目标文件不是 UTF-8 编码（看起来是 GBK）：直接写入会把它的编码改成 UTF-8",
    });
    const result = await runWrite(deps(bridge), { path: "旧.txt", content: "新内容" });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("encoding-mismatch");
    expect(result.error?.hint).toContain("编码");
    expect(result.error?.retry_with).toContain("新文件");
  });
});

describe("搜索跳过的目录要说出来（d.231）", () => {
  it("glob 与 grep 的头里点名被跳过的目录，并说明 path 可以指进去", async () => {
    const bridge = fakeBridge({}, { skipped: ["build", "dist"] });
    const glob = await runGlob(deps(bridge), { pattern: "**/*.ts" });
    expect(glob.ok).toBe(true);
    expect(glob.text).toContain("已跳过这些目录：build、dist");
    expect(glob.text).toContain("path 指到那个目录");
    // 「跳过」不等于「不存在」：正文里还有「没有匹配的文件」时这条提示同样在
    const empty = await runGrep(deps(bridge), { pattern: "needle" });
    expect(empty.text).toContain("没有匹配内容");
    expect(empty.text).toContain("已跳过这些目录：build、dist");
  });

  it("老桌面端不报 skipped 时不多写这一行（不编不知道的事）", async () => {
    const bridge = fakeBridge({}, { globPaths: ["D:/库/src/a.ts"] });
    const glob = await runGlob(deps(bridge), { pattern: "**/*.ts" });
    expect(glob.text).not.toContain("已跳过这些目录");
  });
});

describe("搜索没搜到的文件要说出来（d.232）", () => {
  it("抬头点名没能打开的文件数与原因，并给出可行的下一步", async () => {
    const bridge = fakeBridge(
      {},
      {
        grepMatches: [{ path: "D:/库/src/a.ts", line: 3, text: "needle" }],
        skippedFiles: {
          total: 3,
          tooLarge: 1,
          binary: 1,
          undecodable: 1,
          other: 0,
          sample: ["巨大.log", "图片.png", "坏编码.bin"],
        },
      },
    );
    const result = await runGrep(deps(bridge), { pattern: "needle" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("另有 3 个文件没能搜");
    expect(result.text).toContain("1 个超过 2MB");
    expect(result.text).toContain("1 个像二进制");
    expect(result.text).toContain("1 个编码认不出");
    expect(result.text).toContain("巨大.log");
    expect(result.text).toContain("直接 file_read");
    // 命中 0 个时这条同样是关键信息：真的没有，还是没去搜
    expect(result.text).not.toContain("读不了");
  });

  it("全都搜过了就不写这一行（不编一个「另有 0 个」）", async () => {
    const bridge = fakeBridge({}, { grepMatches: [], skippedFiles: null });
    const result = await runGrep(deps(bridge), { pattern: "needle" });
    expect(result.text).toContain("没有匹配内容");
    expect(result.text).not.toContain("没能搜");
  });
});

describe("换行风格跟着文件走（d.233）", () => {
  it("file_edit 插入多行到 CRLF 文件：写进去的行也是 CRLF，不留混合行尾", async () => {
    const bridge = fakeBridge({ "D:/库/a.md": "第一行\r\n第二行\r\n" });
    const result = await runEdit(deps(bridge), {
      path: "a.md",
      old_string: "第二行",
      new_string: "第二行改\n第三行",
    });
    expect(result.ok).toBe(true);
    expect(bridge.files["D:/库/a.md"]).toBe("第一行\r\n第二行改\r\n第三行\r\n");
    expect(result.text).toContain("CRLF 换行");
  });

  it("file_edit 插到 LF 文件：不引入 \\r", async () => {
    const bridge = fakeBridge({ "D:/库/b.md": "第一行\n第二行\n" });
    const result = await runEdit(deps(bridge), {
      path: "b.md",
      old_string: "第二行",
      new_string: "第二行改\r\n第三行",
    });
    expect(result.ok).toBe(true);
    expect(bridge.files["D:/库/b.md"]).toBe("第一行\n第二行改\n第三行\n");
  });

  it("file_write 覆盖 CRLF 文件：整份跟着 CRLF，不会把 5000 行的行尾全改掉", async () => {
    const bridge = fakeBridge({ "D:/库/c.md": "旧一\r\n旧二\r\n" });
    const result = await runWrite(deps(bridge), { path: "c.md", content: "新一\n新二\n" });
    expect(result.ok).toBe(true);
    expect(bridge.files["D:/库/c.md"]).toBe("新一\r\n新二\r\n");
    expect(result.text).toContain("CRLF 换行");
  });

  it("新建文件没有风格可跟随：保持模型给的 LF，也不多写对齐说明", async () => {
    const bridge = fakeBridge({});
    const result = await runWrite(deps(bridge), { path: "d.md", content: "一\n二\n" });
    expect(result.ok).toBe(true);
    expect(bridge.files["D:/库/d.md"]).toBe("一\n二\n");
    expect(result.text).not.toContain("换行风格");
  });
});
