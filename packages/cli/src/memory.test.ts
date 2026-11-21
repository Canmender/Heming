/**
 * 工作区记忆（d.329）的单测。
 *
 * 这一层最容易错的地方不是「记不住」，而是「悄悄记坏了」：文件坏了却当成空表、
 * 记重了、删错条、召回把不相干的带进去。所以这里的用例大多在验「坏的情况下
 * 明确报错」而不是「好情况下能跑」。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CLI_MEMORY_FILE,
  CLI_MEMORY_MAX_ENTRIES,
  CLI_MEMORY_MAX_TEXT,
  addCliMemory,
  describeCliMemory,
  loadCliMemory,
  memoryPath,
  memorySection,
  normalizeMemoryText,
  parseCliMemory,
  recallCliMemory,
  removeCliMemory,
  rememberResultText,
  rememberSpec,
  type CliMemoryEntry,
} from "./memory.js";

const DIRS: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "heming-memory-"));
  DIRS.push(dir);
  return dir;
}

/** 在工作区里放一份记忆文件（内容原样写，方便造坏 JSON / 造形状错误）。 */
function workspaceWith(text: string | null): string {
  const dir = tmpDir();
  if (text !== null) {
    mkdirSync(path.join(dir, ".heming"), { recursive: true });
    writeFileSync(path.join(dir, CLI_MEMORY_FILE), text, "utf8");
  }
  return dir;
}

function entryOf(id: string, text: string, at = "2026-11-18T00:00:00.000Z"): CliMemoryEntry {
  return { id, at, text };
}

afterAll(() => {
  for (const dir of DIRS) rmSync(dir, { recursive: true, force: true });
});

describe("memoryPath", () => {
  it("固定落在工作区的 .heming/memory.json 上", () => {
    expect(memoryPath("D:/work/proj")).toBe("D:/work/proj/.heming/memory.json");
    expect(memoryPath("D:/work/proj/")).toBe("D:/work/proj/.heming/memory.json");
  });
});

describe("loadCliMemory", () => {
  it("没有文件时返回 null（不是错误）", async () => {
    expect(await loadCliMemory(tmpDir())).toBeNull();
  });

  it("正常文件能读回来，且带上来源路径", async () => {
    const dir = workspaceWith(JSON.stringify({ version: 1, entries: [entryOf("m-1", "以后都用中文回答")] }));
    const loaded = await loadCliMemory(dir);
    expect(loaded && loaded.ok).toBe(true);
    if (!loaded || !loaded.ok) return;
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]!.text).toBe("以后都用中文回答");
    expect(loaded.source).toContain(".heming/memory.json");
  });

  it("带 BOM 的文件也能读（记事本 / PowerShell 5 默认会写 BOM）", async () => {
    const dir = workspaceWith(`\uFEFF${JSON.stringify({ version: 1, entries: [entryOf("m-1", "带 BOM")] })}`);
    const loaded = await loadCliMemory(dir);
    expect(loaded && loaded.ok).toBe(true);
  });

  it("坏 JSON 明确报错，而不是当成空表", async () => {
    const loaded = await loadCliMemory(workspaceWith('{"version":1,"entries":[}'));
    expect(loaded && loaded.ok).toBe(false);
    if (!loaded || loaded.ok) return;
    expect(loaded.error).toMatch(/JSON/i);
  });

  it("形状不对时说清需要什么形状", async () => {
    const loaded = await loadCliMemory(workspaceWith(JSON.stringify({ version: 1, entries: [{ id: "", at: 1 }] })));
    expect(loaded && loaded.ok).toBe(false);
    if (!loaded || loaded.ok) return;
    expect(loaded.error).toContain("格式不对");
  });
});

describe("parseCliMemory", () => {
  it("version 不对整份作废（不做「尽量读一点」）", () => {
    expect(parseCliMemory({ version: 2, entries: [entryOf("m-1", "x")] })).toBeNull();
  });

  it("跳过空文本、按 id 去重、只留最新 200 条", () => {
    const many = Array.from({ length: CLI_MEMORY_MAX_ENTRIES + 5 }, (_, index) => entryOf(`m-${index}`, `第 ${index} 条`));
    const parsed = parseCliMemory({ version: 1, entries: [{ id: "m-x", at: "2026-01-01T00:00:00.000Z", text: "  " }, ...many, many[0]] });
    expect(parsed).not.toBeNull();
    expect(parsed!).toHaveLength(CLI_MEMORY_MAX_ENTRIES);
    expect(parsed![parsed!.length - 1]!.text).toBe(`第 ${CLI_MEMORY_MAX_ENTRIES + 4} 条`);
  });

  it("同一 id 重复时保留更新的那条，不是先出现的旧版本（d.412 回归）", () => {
    // 文件可手工编辑，复制一段改了文字却忘改 id 是真实场景；数组老→新，后一条才是最新版本。
    const parsed = parseCliMemory({
      version: 1,
      entries: [
        { id: "m-1", at: "2026-01-01T00:00:00.000Z", text: "旧偏好：用中文" },
        { id: "m-1", at: "2026-02-01T00:00:00.000Z", text: "新偏好：用英文" },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!).toHaveLength(1);
    expect(parsed![0]!.text).toBe("新偏好：用英文");
    expect(parsed![0]!.at).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("normalizeMemoryText", () => {
  it("超长截断不劈开 emoji 的代理对，也不留孤立半截", () => {
    // 长度压到上限时截断点正好落在 emoji 的高/低代理之间：旧的按码元硬切会留下
    // 一个孤立高代理（0xd83d），写进 memory.json 再注入提示词就是非法 Unicode。
    // 修复后退一格、把没截完整的 emoji 整个丢掉。
    const text = "a".repeat(CLI_MEMORY_MAX_TEXT - 2) + "😀" + "b".repeat(10);
    const out = normalizeMemoryText(text);
    expect(out.endsWith("…")).toBe(true);
    // 省略号之前必须是完整码点：既不是孤立高代理，也不是孤立低代理。
    const before = out.slice(0, -1).at(-1)!;
    const cp = before.charCodeAt(0);
    expect(cp >= 0xd800 && cp <= 0xdfff).toBe(false);
    expect(out).toBe("a".repeat(CLI_MEMORY_MAX_TEXT - 2) + "…");
  });

  it("边界恰好落在 emoji 前的普通字符上时正常截断", () => {
    const out = normalizeMemoryText("a".repeat(CLI_MEMORY_MAX_TEXT + 10));
    expect(out).toBe("a".repeat(CLI_MEMORY_MAX_TEXT - 1) + "…");
  });
});

describe("addCliMemory", () => {
  it("记一条会把文件写出来，并自动建 .heming 目录", async () => {
    const dir = tmpDir();
    const added = await addCliMemory(dir, "  以后都用中文回答  ");
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.added).toBe(true);
    expect(added.entry.text).toBe("以后都用中文回答");
    const raw = JSON.parse(readFileSync(path.join(dir, CLI_MEMORY_FILE), "utf8")) as { entries: CliMemoryEntry[] };
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0]!.id).toBe(added.entry.id);
  });

  it("同一句话不重复写（模型爱在相邻两轮里说同一件事）", async () => {
    const dir = tmpDir();
    await addCliMemory(dir, "别改 generated 目录");
    const again = await addCliMemory(dir, "别改 generated 目录");
    expect(again.ok && again.added).toBe(false);
    if (!again.ok) return;
    expect(again.total).toBe(1);
  });

  it("多行压成一行、超长截断", async () => {
    const dir = tmpDir();
    const added = await addCliMemory(dir, "第一行\n第二行\r\n第三行");
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.entry.text).toBe("第一行 第二行 第三行");

    const long = await addCliMemory(dir, "长".repeat(CLI_MEMORY_MAX_TEXT + 50));
    expect(long.ok).toBe(true);
    if (!long.ok) return;
    expect(long.entry.text.length).toBeLessThanOrEqual(CLI_MEMORY_MAX_TEXT + 1);
    expect(long.entry.text.endsWith("…")).toBe(true);
  });

  it("空内容拒绝", async () => {
    const added = await addCliMemory(tmpDir(), "   \n  ");
    expect(added.ok).toBe(false);
    if (added.ok) return;
    expect(added.error).toContain("空的");
  });

  it("文件坏了拒绝写入：宁可报错，也别覆盖掉还能救的内容", async () => {
    const dir = workspaceWith("{ 这不是 JSON");
    const added = await addCliMemory(dir, "随便记点什么");
    expect(added.ok).toBe(false);
    if (added.ok) return;
    expect(added.error).toContain("坏了");
    // 原文件逐字未变
    expect(readFileSync(path.join(dir, CLI_MEMORY_FILE), "utf8")).toBe("{ 这不是 JSON");
  });

  it("超过上限时丢最旧的", async () => {
    const dir = tmpDir();
    for (let index = 0; index < CLI_MEMORY_MAX_ENTRIES + 2; index += 1) {
      await addCliMemory(dir, `第 ${index} 条`);
    }
    const loaded = await loadCliMemory(dir);
    expect(loaded && loaded.ok).toBe(true);
    if (!loaded || !loaded.ok) return;
    expect(loaded.entries).toHaveLength(CLI_MEMORY_MAX_ENTRIES);
    expect(loaded.entries[0]!.text).toBe("第 2 条");
  });
});

describe("removeCliMemory", () => {
  it("认完整 id，也认从 1 开始的序号", async () => {
    const dir = tmpDir();
    const first = await addCliMemory(dir, "第一条");
    await addCliMemory(dir, "第二条");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const byId = await removeCliMemory(dir, first.entry.id);
    expect(byId.ok).toBe(true);
    if (!byId.ok) return;
    expect(byId.entry.text).toBe("第一条");
    expect(byId.total).toBe(1);

    const byOrdinal = await removeCliMemory(dir, "1");
    expect(byOrdinal.ok).toBe(true);
    if (!byOrdinal.ok) return;
    expect(byOrdinal.entry.text).toBe("第二条");
    expect(byOrdinal.total).toBe(0);
  });

  it("找不到时说清怎么办", async () => {
    const dir = tmpDir();
    await addCliMemory(dir, "只有这一条");
    const missing = await removeCliMemory(dir, "9");
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toContain("没有这条记忆");
    expect(missing.error).toContain("heming memory");
  });

  it("没有记忆文件时是一条人话，不是崩", async () => {
    const removed = await removeCliMemory(tmpDir(), "1");
    expect(removed.ok).toBe(false);
    if (removed.ok) return;
    expect(removed.error).toContain("还没有记过");
  });
});

describe("recallCliMemory / memorySection", () => {
  const entries = [
    entryOf("m-1", "以后都用中文回答", "2026-11-10T00:00:00.000Z"),
    entryOf("m-2", "跑测试用 pnpm test，不要用 yarn", "2026-11-12T00:00:00.000Z"),
    entryOf("m-3", "改完代码要跑 pnpm typecheck", "2026-11-15T00:00:00.000Z"),
  ];

  it("按共有的词捞，同分时新的优先", () => {
    const recalled = recallCliMemory(entries, "帮我跑一下测试");
    expect(recalled.map((entry) => entry.id)).toContain("m-2");

    const byNewest = recallCliMemory(entries, "pnpm");
    expect(byNewest.map((entry) => entry.id)).toEqual(["m-3", "m-2"]);
  });

  it("全不相干时一条都不带（不要拿噪声撑场面）", () => {
    expect(recallCliMemory(entries, "今天天气怎么样")).toEqual([]);
    expect(recallCliMemory(entries, "")).toEqual([]);
    expect(recallCliMemory([], "pnpm")).toEqual([]);
  });

  it("生成注入段：没有命中就是空串，绝不留下空标题", () => {
    expect(memorySection([])).toBe("");
    const section = memorySection([entries[1]!]);
    expect(section).toContain("长期记忆");
    expect(section).toContain("pnpm test");
  });

  it("注入段有字数上限：条数够多时不会无限长", () => {
    const many = Array.from({ length: 50 }, (_, index) => entryOf(`m-${index}`, `习惯 ${index}：${"细".repeat(80)}`));
    const section = memorySection(many);
    expect(section.length).toBeLessThan(1600);
  });
});

describe("describeCliMemory", () => {
  it("四态各说各的话", () => {
    expect(describeCliMemory(null)).toContain("还没有");
    expect(describeCliMemory({ ok: false, error: "坏了", source: ".heming/memory.json" })).toContain("读不出来");
    expect(describeCliMemory({ ok: true, entries: [], source: ".heming/memory.json" })).toContain("空的");
    const one = describeCliMemory({ ok: true, entries: [entryOf("m-1", "x")], source: ".heming/memory.json" });
    expect(one).toContain("1 条");
    expect(one).toContain(".heming/memory.json");
  });
});

describe("rememberSpec / rememberResultText", () => {
  it("spec 只要一个必填的 text", () => {
    const spec = rememberSpec() as {
      type: string;
      function: { name: string; parameters: { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> } };
    };
    expect(spec.type).toBe("function");
    expect(spec.function.name).toBe("remember");
    expect(spec.function.parameters.required).toEqual(["text"]);
    expect(spec.function.parameters.additionalProperties).toBe(false);
    expect(Object.keys(spec.function.parameters.properties)).toEqual(["text"]);
  });

  it("结果文案区分「记下了」「记过了」「没记成」", () => {
    const entry = entryOf("m-1", "以后都用中文回答");

    const added = rememberResultText({ ok: true, added: true, total: 3, entry });
    expect(added.ok).toBe(true);
    expect(added.text).toContain("已记下");
    expect(added.text).toContain("3 条记忆");

    const dup = rememberResultText({ ok: true, added: false, total: 3, entry });
    expect(dup.ok).toBe(true);
    expect(dup.text).toContain("已经记过");

    const failed = rememberResultText({ ok: false, error: "磁盘满了" });
    expect(failed.ok).toBe(false);
    expect(failed.text).toContain("没能记下来");
    expect(failed.text).toContain("磁盘满了");
    expect(failed.text).toContain("重试同样的调用不会好");
  });
});