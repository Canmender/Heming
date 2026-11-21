import { describe, expect, it, vi } from "vitest";
import {
  CUSTOM_COMMANDS_DIR,
  MAX_CUSTOM_COMMANDS,
  MAX_CUSTOM_COMMAND_CHARS,
  collectCustomCommands,
  commandNameOf,
  commandsToSlash,
  expandCustomCommand,
  parseCustomCommand,
  parseCustomCommands,
  splitCommandFile,
} from "./customCommands.js";
import type { FileRoot } from "../fileEdit/paths.js";

const ROOTS: FileRoot[] = [{ name: "评测区", path: "D:/评测区", mode: "write" }];

function source(rel: string, text: string) {
  return { rel, text };
}

describe("自定义命令：文件名即命令名（d.240）", () => {
  it("只认 .md、名字限小写字母数字与短横线，其余忽略", () => {
    expect(commandNameOf(".heming/commands/review.md")).toBe("review");
    expect(commandNameOf(".heming/commands/daily-report.md")).toBe("daily-report");
    expect(commandNameOf(".heming/commands/Review.md")).toBe("review");
    expect(commandNameOf(".heming/commands/复盘.md")).toBeNull();
    expect(commandNameOf(".heming/commands/review.txt")).toBeNull();
    expect(commandNameOf(".heming/commands/-bad.md")).toBeNull();
    expect(commandNameOf(".heming/commands/中文.md")).toBeNull();
  });

  it("拆出可选的标题与说明，正文原样保留", () => {
    const parsed = splitCommandFile("# 复盘\n> 按我们的风格复盘\n\n第一步：读 diff\n第二步：找漏测\n");
    expect(parsed.title).toBe("复盘");
    expect(parsed.hint).toBe("按我们的风格复盘");
    expect(parsed.body).toBe("第一步：读 diff\n第二步：找漏测");
  });

  it("没有标题/说明时，整份文件都是提示词（正文里的 # 不会被当元信息吃掉）", () => {
    const parsed = splitCommandFile("先读 docs/DESIGN.md\n# 这是正文里的小标题\n再看实现\n");
    expect(parsed.title).toBeNull();
    expect(parsed.hint).toBeNull();
    expect(parsed.body).toBe("先读 docs/DESIGN.md\n# 这是正文里的小标题\n再看实现");
  });

  it("空文件、只有标题没有正文 → 不算命令", () => {
    expect(parseCustomCommand(source(".heming/commands/empty.md", "\n\n"))).toBeNull();
    expect(parseCustomCommand(source(".heming/commands/title-only.md", "# 只有标题\n> 说明\n"))).toBeNull();
  });

  it("解析出完整命令：标题、说明、提示词、来源", () => {
    const cmd = parseCustomCommand(source(".heming/commands/review.md", "# 复盘\n> 按我们的风格复盘\n先读 diff，再找漏测。"));
    expect(cmd).not.toBeNull();
    expect(cmd).toMatchObject({
      name: "review",
      command: "/review",
      title: "复盘",
      hint: "按我们的风格复盘",
      prompt: "先读 diff，再找漏测。",
      rel: ".heming/commands/review.md",
      truncated: false,
    });
    // 没有标题/说明时退化成文件名与默认提示
    const plain = parseCustomCommand(source(".heming/commands/tidy.md", "清理 import 顺序"));
    expect(plain?.title).toBe("tidy");
    expect(plain?.hint).toContain(".heming/commands/tidy.md");
  });

  it("超长提示词按上限截断，并写明「需要完整内容用 file_read」", () => {
    const long = "字".repeat(MAX_CUSTOM_COMMAND_CHARS + 200);
    const cmd = parseCustomCommand(source(".heming/commands/long.md", long));
    expect(cmd?.truncated).toBe(true);
    expect(cmd?.prompt.startsWith("字".repeat(100))).toBe(true);
    expect(cmd?.prompt).toContain("只发了前面这些");
    expect(cmd?.prompt).toContain(".heming/commands/long.md");
  });

  it("提示词截断落在 emoji 中间时不劈出落单代理（会进提示词，d.412 回归）", () => {
    const long = "x".repeat(MAX_CUSTOM_COMMAND_CHARS - 1) + "😀" + "tail";
    const prompt = parseCustomCommand(source(".heming/commands/emoji.md", long))?.prompt ?? "";
    const units = prompt.split("").map((ch) => ch.charCodeAt(0));
    const lone = units.some((c, i) =>
      (c >= 0xd800 && c <= 0xdbff)
        ? !(i + 1 < units.length && units[i + 1] >= 0xdc00 && units[i + 1] <= 0xdfff)
        : (c >= 0xdc00 && c <= 0xdfff)
          ? !(i > 0 && units[i - 1] >= 0xd800 && units[i - 1] <= 0xdbff)
          : false,
    );
    expect(lone).toBe(false);
    // 正文字数按码点正好到上限（不含追加的说明）
    expect(Array.from(prompt.split("\n")[0]!)).toHaveLength(MAX_CUSTOM_COMMAND_CHARS);
  });

  it("整批：按路径排序、同名取先读到的、超过上限就停", () => {
    const sources = [
      source(".heming/commands/b.md", "占位 B"),
      source(".heming/commands/a.md", "占位 A"),
      source(".heming/commands/b.md", "重复的 B"),
      ...Array.from({ length: MAX_CUSTOM_COMMANDS + 5 }, (_, i) =>
        source(`.heming/commands/c${String(i).padStart(2, "0")}.md`, `命令 ${i}`),
      ),
    ];
    const commands = parseCustomCommands(sources);
    expect(commands).toHaveLength(MAX_CUSTOM_COMMANDS);
    expect(commands[0].name).toBe("a");
    expect(commands.filter((c) => c.name === "b")).toHaveLength(1);
  });

  it("精确匹配才展开；带参数/大小写不同都不算", () => {
    const commands = parseCustomCommands([
      source(".heming/commands/review.md", "先读 diff。"),
      source(".heming/commands/tidy.md", "清理 import。"),
    ]);
    expect(expandCustomCommand("/review", commands)).toBe("先读 diff。");
    expect(expandCustomCommand("  /tidy  ", commands)).toBe("清理 import。");
    expect(expandCustomCommand("/review 顺便看登录", commands)).toBeNull();
    expect(expandCustomCommand("/Review", commands)).toBeNull();
    expect(expandCustomCommand("看看 /review", commands)).toBeNull();
    expect(expandCustomCommand("/plan", commands)).toBeNull();
  });

  it("面板条目带来源，便于和内置命令区分", () => {
    const commands = parseCustomCommands([source(".heming/commands/review.md", "# 复盘\n> 一段说明\n做点什么")]);
    expect(commandsToSlash(commands)).toEqual([
      { command: "/review", title: "复盘", hint: "一段说明（.heming/commands/review.md）" },
    ]);
  });
});

describe("从工作区读自定义命令（d.240）", () => {
  it("读得到就解析，读不到文件就跳过（坏一个不影响别的）", async () => {
    const bridge = {
      read: vi.fn(async ({ path }: { path: string }) => {
        if (path.endsWith("bad.md")) return { ok: false as const, code: "io", error: "读不了" };
        return { ok: true as const, content: "# 标题\n> 说明\n正文内容", bytes: 10 };
      }),
      write: vi.fn(),
      pickRoot: vi.fn(),
      glob: vi.fn(async ({ pattern }: { pattern: string }) => {
        expect(pattern).toBe(`${CUSTOM_COMMANDS_DIR}/*.md`);
        return { ok: true as const, root: "D:/评测区", paths: [".heming/commands/a.md", ".heming/commands/bad.md"], truncated: false };
      }),
    };
    const commands = await collectCustomCommands({ bridge: bridge as never, roots: ROOTS });
    expect(commands.map((c) => c.name)).toEqual(["a"]);
    expect(commands[0].prompt).toBe("正文内容");
  });

  it("没有桥 / 没有可写根 / 老桌面端没有 glob → 空数组，不抛", async () => {
    const bridge = { read: vi.fn(), write: vi.fn(), pickRoot: vi.fn() };
    expect(await collectCustomCommands({ bridge: null, roots: ROOTS })).toEqual([]);
    expect(await collectCustomCommands({ bridge: bridge as never, roots: [] })).toEqual([]);
    expect(await collectCustomCommands({ bridge: bridge as never, roots: ROOTS })).toEqual([]);
  });

  it("glob 抛错时吞掉（自定义命令不该让对话失败）", async () => {
    const bridge = {
      read: vi.fn(),
      write: vi.fn(),
      pickRoot: vi.fn(),
      glob: vi.fn(async () => {
        throw new Error("桥崩了");
      }),
    };
    expect(await collectCustomCommands({ bridge: bridge as never, roots: ROOTS })).toEqual([]);
  });
});
