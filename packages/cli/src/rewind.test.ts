import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  CLI_REWIND_DIR,
  CLI_REWIND_MAX_RUNS,
  applyCliRewind,
  createCliRewindJournal,
  describeCliRewindResult,
  describeCliRewinds,
  dropCliRewindRuns,
  listCliRewinds,
  newRewindId,
  diffManifests,
  parseRewindRun,
  planCliRewind,
  scanWorkspaceFiles,
  rewindDir,
  rewindRunPath,
  type RewindRun,
} from "./rewind.js";

const TMP: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "heming-rewind-"));
  TMP.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

/** 造一份存档文件（列表/回退只看文件，不看内存）。 */
function writeRun(cwd: string, run: RewindRun): void {
  const dir = rewindDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(rewindRunPath(cwd, run.id), `${JSON.stringify({ version: 1, ...run }, null, 2)}\n`, "utf8");
}

function runOf(id: string, files: RewindRun["files"]): RewindRun {
  return { id, at: "2026-11-18T10:00:00.000Z", files };
}

describe("路径与 id", () => {
  it("回退目录与单轮文件都在工作区里", () => {
    const cwd = path.resolve("D:/work/proj");
    expect(rewindDir(cwd)).toBe("D:/work/proj/.heming/rewind");
    expect(rewindRunPath(cwd, "20261118100000-ab12")).toBe("D:/work/proj/.heming/rewind/20261118100000-ab12.json");
    expect(CLI_REWIND_DIR).toBe(".heming/rewind");
  });

  it("id 是「时间戳-随机四位」，字典序即时间序", () => {
    const a = newRewindId(new Date("2026-11-18T10:00:00.000Z"), () => 0);
    const b = newRewindId(new Date("2026-11-18T11:00:00.000Z"), () => 0);
    expect(a).toMatch(/^[0-9]{14}-[0-9a-f]{4}$/);
    expect(a < b).toBe(true);
  });

  it("存档里的坏条目被跳过，路径越界的条目不算", () => {
    const parsed = parseRewindRun({
      version: 1,
      id: "x",
      at: "2026-11-18T10:00:00.000Z",
      files: [
        { path: "src/a.ts", before: "old" },
        { path: "../escape.ts", before: "nope" },
        { path: "src/b.ts", before: null },
        { path: "src/c.ts", before: "x", skipped: "binary" },
        { path: 42, before: "bad" },
      ],
    });
    expect(parsed?.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    // 带 skipped 的条目一律当「没有原文」处理，避免把残缺内容盖回去。
    expect(parsed?.files[2]?.before).toBeNull();
    expect(parsed?.files[2]?.skipped).toBe("binary");
  });

  it("版本不对整份作废", () => {
    expect(parseRewindRun({ version: 2, id: "x", at: "t", files: [] })).toBeNull();
    expect(parseRewindRun({ version: 1, id: "", at: "t", files: [] })).toBeNull();
    expect(parseRewindRun("nope")).toBeNull();
  });
});

describe("抓取（journal）", () => {
  it("写工具动手之前抓到原文；同一个文件只留最早那份", async () => {
    const cwd = tmpDir();
    writeFileSync(path.join(cwd, "a.ts"), "第一版\n", "utf8");
    const journal = createCliRewindJournal({ cwd, now: () => new Date("2026-11-18T10:00:00.000Z"), random: () => 0 });

    await journal.note({ name: "file_write", arguments: JSON.stringify({ path: "a.ts", content: "第二版" }) });
    writeFileSync(path.join(cwd, "a.ts"), "第二版\n", "utf8");
    await journal.note({ name: "file_write", arguments: JSON.stringify({ path: "a.ts", content: "第三版" }) });

    const run = await journal.close();
    expect(run?.files).toEqual([{ path: "a.ts", before: "第一版\n" }]);
    expect(existsSync(rewindRunPath(cwd, run!.id))).toBe(true);
  });

  it("新建的文件记成 before=null（回退时删掉）", async () => {
    const cwd = tmpDir();
    const journal = createCliRewindJournal({ cwd, random: () => 0 });
    await journal.note({ name: "file_write", arguments: JSON.stringify({ path: "new/deep/b.ts", content: "hi" }) });
    const run = await journal.close();
    expect(run?.files).toEqual([{ path: "new/deep/b.ts", before: null }]);
  });

  it("只读工具与坏参数不抓", async () => {
    const cwd = tmpDir();
    const journal = createCliRewindJournal({ cwd, random: () => 0 });
    await journal.note({ name: "file_read", arguments: JSON.stringify({ path: "a.ts" }) });
    await journal.note({ name: "file_write", arguments: "{oops" });
    expect(journal.size()).toBe(0);
    expect(await journal.close()).toBeNull();
  });

  it("二进制与大文件记成 skipped，不当作可还原", async () => {
    const cwd = tmpDir();
    writeFileSync(path.join(cwd, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
    const big = "x".repeat(200_001);
    writeFileSync(path.join(cwd, "big.ts"), big, "utf8");
    const journal = createCliRewindJournal({ cwd, random: () => 0 });
    await journal.note({ name: "file_write", arguments: JSON.stringify({ path: "bin.dat", content: "y" }) });
    await journal.note({ name: "file_write", arguments: JSON.stringify({ path: "big.ts", content: "y" }) });
    const run = await journal.close();
    expect(run?.files).toEqual([
      { path: "big.ts", before: null, skipped: "too-large" },
      { path: "bin.dat", before: null, skipped: "binary" },
    ]);
  });

  it("工作区外的目标不进日志（闸门本来也会拒）", async () => {
    const cwd = tmpDir();
    const journal = createCliRewindJournal({ cwd, random: () => 0 });
    await journal.note({ name: "file_write", arguments: JSON.stringify({ path: "../outside.ts", content: "x" }) });
    expect(journal.size()).toBe(0);
  });

  it("超过上限时只留最近的 20 轮", async () => {
    const cwd = tmpDir();
    for (let index = 0; index < CLI_REWIND_MAX_RUNS + 2; index += 1) {
      writeRun(cwd, runOf(`2026111810${String(index).padStart(2, "0")}00-0000`, []));
    }
    const journal = createCliRewindJournal({ cwd, now: () => new Date("2026-11-18T23:00:00.000Z"), random: () => 0 });
    await journal.note({ name: "file_write", arguments: JSON.stringify({ path: "a.ts", content: "x" }) });
    await journal.close();
    const loaded = await listCliRewinds(cwd);
    expect(loaded?.ok && loaded.runs.length).toBe(CLI_REWIND_MAX_RUNS);
  });
});

describe("列出与规划", () => {
  it("没有目录时返回 null（不是错误）", async () => {
    expect(await listCliRewinds(tmpDir())).toBeNull();
  });

  it("新的在前，坏文件跳过", async () => {
    const cwd = tmpDir();
    writeRun(cwd, runOf("20261118100000-0000", []));
    writeRun(cwd, runOf("20261118110000-0000", []));
    writeFileSync(path.join(rewindDir(cwd), "broken.json"), "{ not json", "utf8");
    const loaded = await listCliRewinds(cwd);
    expect(loaded?.ok && loaded.runs.map((run) => run.id)).toEqual(["20261118110000-0000", "20261118100000-0000"]);
    expect(existsSync(rewindDir(cwd))).toBe(true);
  });

  it("退 N 轮时每个文件取窗口里最早的那份原文", () => {
    const runs = [
      runOf("3", [{ path: "a.ts", before: "v2" }, { path: "b.ts", before: null }]),
      runOf("2", [{ path: "a.ts", before: "v1" }]),
      runOf("1", [{ path: "c.ts", before: "c0" }]),
    ];
    const plan = planCliRewind(runs, 2);
    expect(plan).not.toBeNull();
    // a.ts 退回到 v1（两轮开始时），c.ts 不进窗口。
    expect(plan!.restore).toEqual([{ path: "a.ts", content: "v1" }]);
    expect(plan!.remove).toEqual(["b.ts"]);
  });

  it("轮数不合法或超过已有轮次时返回 null", () => {
    expect(planCliRewind([], 1)).toBeNull();
    expect(planCliRewind([runOf("1", [])], 0)).toBeNull();
    expect(planCliRewind([runOf("1", [])], 2)).toBeNull();
  });

  it("抓不到原文的文件进 skipped", () => {
    const plan = planCliRewind([runOf("1", [{ path: "big.ts", before: null, skipped: "too-large" }])], 1);
    expect(plan?.skipped).toEqual([{ path: "big.ts", reason: "too-large" }]);
    expect(plan?.restore).toEqual([]);
    expect(plan?.remove).toEqual([]);
  });
});

describe("执行回退", () => {
  it("写回原文、删掉当时还不存在的文件", async () => {
    const cwd = tmpDir();
    writeFileSync(path.join(cwd, "a.ts"), "现在的内容\n", "utf8");
    writeFileSync(path.join(cwd, "gone.ts"), "我不该在\n", "utf8");
    const plan = {
      turns: 1,
      restore: [{ path: "a.ts", content: "原来的内容\n" }],
      remove: ["gone.ts"],
      skipped: [],
    };
    const result = await applyCliRewind(cwd, plan);
    expect(result).toMatchObject({ ok: true, written: 1, deleted: 1 });
    expect(readFileSync(path.join(cwd, "a.ts"), "utf8")).toBe("原来的内容\n");
    expect(existsSync(path.join(cwd, "gone.ts"))).toBe(false);
  });

  it("路径跑出工作区的条目被拒，不碰盘", async () => {
    const cwd = tmpDir();
    const result = await applyCliRewind(cwd, {
      turns: 1,
      restore: [{ path: "../escape.ts", content: "nope" }],
      remove: [],
      skipped: [],
    });
    expect(result.ok).toBe(false);
    expect(existsSync(path.join(path.dirname(cwd), "escape.ts"))).toBe(false);
  });

  it("退过之后记录被删掉（退一次不能退第二次）", async () => {
    const cwd = tmpDir();
    writeRun(cwd, runOf("20261118100000-0000", [{ path: "a.ts", before: "old" }]));
    const loaded = await listCliRewinds(cwd);
    const removed = await dropCliRewindRuns(cwd, loaded?.ok ? loaded.runs.slice(0, 1) : []);
    expect(removed).toBe(1);
    expect(existsSync(rewindRunPath(cwd, "20261118100000-0000"))).toBe(false);
  });
});

describe("文案", () => {
  it("列表：没有记录 / 目录空 / 有条目", async () => {
    const empty = tmpDir();
    expect(describeCliRewinds(null, empty)).toContain("还没有任何回退记录");

    const cwd = tmpDir();
    writeRun(cwd, runOf("20261118100000-0000", [{ path: "src/a.ts", before: "x" }, { path: "big.ts", before: null, skipped: "too-large" }]));
    const loaded = await listCliRewinds(cwd);
    const text = describeCliRewinds(loaded, cwd, new Date("2026-11-18T10:30:00.000Z"));
    expect(text).toContain("共 1 轮");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("另有 1 个没抓到原文");
    expect(text).toContain("heming rewind 1");
  });

  it("回执：还原数、跳过项、记录已删除", () => {
    const text = describeCliRewindResult(
      { turns: 2, restore: [{ path: "a.ts", content: "" }], remove: ["b.ts"], skipped: [{ path: "big.ts", reason: "too-large" }] },
      { ok: true, written: 1, deleted: 1, failed: [] },
      2,
    );
    expect(text).toContain("已退回 2 轮：还原 1 个文件、删掉 1 个当时还不存在的文件");
    expect(text).toContain("抓不到原文、没有退：big.ts");
    expect(text).toContain("这 2 轮的记录已删除");
    expect(text).toContain("run_command");
  });

  it("回执：写盘失败时把失败的那条说出来", () => {
    const text = describeCliRewindResult(
      { turns: 1, restore: [{ path: "a.ts", content: "" }], remove: [], skipped: [] },
      { ok: true, written: 1, deleted: 0, failed: [{ path: "b.ts", error: "EACCES" }] },
      0,
    );
    expect(text).toContain("b.ts（EACCES）");
    expect(text).toContain("记录没能删除");
  });
});

describe("命令改动的范围（d.337）", () => {
  it("扫盘 + 差异：新建 / 改过 / 删掉都认得出来", async () => {
    const cwd = tmpDir();
    writeFileSync(path.join(cwd, "keep.ts"), "same", "utf8");
    writeFileSync(path.join(cwd, "edit.ts"), "before", "utf8");
    writeFileSync(path.join(cwd, "gone.ts"), "bye", "utf8");
    const before = await scanWorkspaceFiles(cwd);
    expect(before).not.toBeNull();

    writeFileSync(path.join(cwd, "edit.ts"), "after-and-longer", "utf8");
    rmSync(path.join(cwd, "gone.ts"));
    writeFileSync(path.join(cwd, "fresh.ts"), "new", "utf8");
    const after = await scanWorkspaceFiles(cwd);
    const diff = diffManifests(before!, after!);

    expect(diff.created).toEqual(["fresh.ts"]);
    expect(diff.modified).toEqual(["edit.ts"]);
    expect(diff.deleted).toEqual(["gone.ts"]);
  });

  it("扫盘跳过产物目录，也不会把自己那份存档算进去", async () => {
    const cwd = tmpDir();
    mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
    writeFileSync(path.join(cwd, "node_modules", "x.js"), "x", "utf8");
    mkdirSync(rewindDir(cwd), { recursive: true });
    writeFileSync(path.join(rewindDir(cwd), "20261118100000-0000.json"), "{}", "utf8");
    writeFileSync(path.join(cwd, "a.ts"), "a", "utf8");

    const manifest = await scanWorkspaceFiles(cwd);
    expect([...manifest!.keys()].sort()).toEqual(["a.ts"]);
  });

  it("条目太多时返回 null（扫不完就不报，免得清单骗人）", async () => {
    const cwd = tmpDir();
    for (let index = 0; index < 4; index += 1) writeFileSync(path.join(cwd, `f${index}.ts`), "x", "utf8");
    expect(await scanWorkspaceFiles(cwd, 3)).toBeNull();
  });

  it("journal 记下命令新建/改过/删掉的文件，并落进存档", async () => {
    const cwd = tmpDir();
    writeFileSync(path.join(cwd, "edit.ts"), "before", "utf8");
    writeFileSync(path.join(cwd, "gone.ts"), "bye", "utf8");
    const journal = createCliRewindJournal({ cwd, now: () => new Date("2026-11-18T10:00:00.000Z"), random: () => 0 });

    const before = await journal.beginCommand();
    writeFileSync(path.join(cwd, "edit.ts"), "after-and-longer", "utf8");
    rmSync(path.join(cwd, "gone.ts"));
    writeFileSync(path.join(cwd, "fresh.ts"), "new", "utf8");
    await journal.endCommand(before);

    const run = await journal.close();
    expect(run?.commandChanges).toEqual({ created: ["fresh.ts"], modified: ["edit.ts"], deleted: ["gone.ts"] });
    const saved = JSON.parse(readFileSync(rewindRunPath(cwd, run!.id), "utf8")) as Record<string, unknown>;
    expect((saved.commandChanges as Record<string, string[]>).created).toEqual(["fresh.ts"]);
  });

  it("beginCommand 失败（扫不完）时这条命令就不记范围", async () => {
    const cwd = tmpDir();
    writeFileSync(path.join(cwd, "a.ts"), "a", "utf8");
    const journal = createCliRewindJournal({ cwd, random: () => 0 });
    await journal.endCommand(null);
    expect(await journal.close()).toBeNull();
  });

  it("规划：命令新建的进删除清单，改过/删掉的进「退不回去」", async () => {
    const cwd = tmpDir();
    writeRun(cwd, {
      id: "20261118100000-0000",
      at: "2026-11-18T10:00:00.000Z",
      files: [],
      commandChanges: { created: ["dist/out.js", "lib/gen.ts"], modified: ["src/app.ts"], deleted: ["src/old.ts"] },
    });
    const loaded = await listCliRewinds(cwd);
    const plan = planCliRewind(loaded!.ok ? loaded!.runs : [], 1);
    expect(plan?.remove).toEqual(["dist/out.js", "lib/gen.ts"]);
    expect(plan?.commandLost).toEqual([
      { path: "src/app.ts", how: "modified" },
      { path: "src/old.ts", how: "deleted" },
    ]);
  });

  it("命令新建的文件真的被删掉；写入工具碰过的路径以工具原文为准", async () => {
    const cwd = tmpDir();
    mkdirSync(path.join(cwd, "lib"), { recursive: true });
    writeFileSync(path.join(cwd, "lib", "gen.ts"), "generated", "utf8");
    writeFileSync(path.join(cwd, "src.ts"), "现状", "utf8");
    writeRun(cwd, {
      id: "20261118100000-0000",
      at: "2026-11-18T10:00:00.000Z",
      files: [{ path: "src.ts", before: "原文" }],
      commandChanges: { created: ["lib/gen.ts", "src.ts"], modified: [], deleted: [] },
    });
    const loaded = await listCliRewinds(cwd);
    const plan = planCliRewind(loaded!.ok ? loaded!.runs : [], 1)!;
    expect(plan.remove).toEqual(["lib/gen.ts"]);
    expect(plan.restore).toEqual([{ path: "src.ts", content: "原文" }]);

    const applied = await applyCliRewind(cwd, plan);
    expect(applied).toMatchObject({ ok: true, written: 1, deleted: 1 });
    expect(existsSync(path.join(cwd, "lib", "gen.ts"))).toBe(false);
    expect(readFileSync(path.join(cwd, "src.ts"), "utf8")).toBe("原文");
  });

  it("文案：列表点上命令改动，回执说清哪些退不回去", async () => {
    const cwd = tmpDir();
    writeRun(cwd, {
      id: "20261118100000-0000",
      at: "2026-11-18T10:00:00.000Z",
      files: [],
      commandChanges: { created: ["a.ts"], modified: ["b.ts", "c.ts"], deleted: [] },
    });
    const loaded = await listCliRewinds(cwd);
    const list = describeCliRewinds(loaded, cwd, new Date("2026-11-18T10:10:00.000Z"));
    expect(list).toContain("命令新建 1 / 改过 2 / 删掉 0");

    const text = describeCliRewindResult(
      {
        turns: 1,
        restore: [],
        remove: ["a.ts"],
        skipped: [],
        commandLost: [
          { path: "b.ts", how: "modified" },
          { path: "c.ts", how: "modified" },
        ],
      },
      { ok: true, written: 0, deleted: 1, failed: [] },
      1,
    );
    expect(text).toContain("删掉 1 个当时还不存在的文件");
    expect(text).toContain("命令改过内容或删掉的 2 个文件没有原文");
    expect(text).toContain("b.ts、c.ts");
  });

  it("存档里形状不对的命令清单会被丢掉，不影响文件那半", () => {
    const parsed = parseRewindRun({
      version: 1,
      id: "x",
      at: "2026-11-18T10:00:00.000Z",
      files: [{ path: "a.ts", before: "x" }],
      commandChanges: { created: ["../evil.ts", 7], modified: "nope" },
    });
    expect(parsed?.files).toEqual([{ path: "a.ts", before: "x" }]);
    expect(parsed?.commandChanges).toBeUndefined();
  });
});