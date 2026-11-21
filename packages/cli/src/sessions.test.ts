import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  MAX_SESSIONS,
  MAX_STORED_MESSAGE_CHARS,
  MAX_STORED_TURNS,
  SESSION_DIR_ENV,
  appendTurn,
  describeSession,
  latestSession,
  listSessions,
  newSessionId,
  readSession,
  resolveSession,
  sessionDir,
  sessionFile,
  summarize,
  toHistory,
  writeSession,
  type SessionRecord,
} from "./sessions.js";

const sandboxes: string[] = [];

/** 检测字符串里是否有孤立代理对（高位后面不是低位，或低位前面不是高位）。 */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = value.charCodeAt(i - 1);
      if (!(prev >= 0xd800 && prev <= 0xdbff)) return true;
    }
  }
  return false;
}

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "heming-sessions-"));
  sandboxes.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of sandboxes) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  }
});

/** 一份最小可用存档：只填必填字段，具体轮次由用例自己加。 */
function recordOf(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1,
    id,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    cwd: "D:/repo",
    model: "test-model",
    turns: [],
    ...overrides,
  };
}

describe("newSessionId", () => {
  it("是「日期-时间-四位随机」的形状，且时间可读", () => {
    const id = newSessionId(new Date(2026, 10, 18, 14, 42, 30).getTime(), () => 0.5);
    expect(id).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(id.startsWith("20261118-144230-")).toBe(true);
  });

  it("随机数不同就得到不同的 id（同一秒也不撞车）", () => {
    const now = 1_700_000_000_000;
    const a = newSessionId(now, () => 0.1);
    const b = newSessionId(now, () => 0.9);
    expect(a).not.toBe(b);
  });
});

describe("sessionFile", () => {
  it("合法 id 得到 <dir>/<id>.json，并把大写归一成小写", () => {
    const dir = path.join("C:/tmp", "sessions");
    expect(sessionFile(dir, "20261118-144230-ab12")).toBe(path.join(dir, "20261118-144230-ab12.json"));
    expect(sessionFile(dir, "20261118-144230-AB12")).toBe(path.join(dir, "20261118-144230-ab12.json"));
  });

  it("带路径分隔符或形状不对的 id 一律拒绝（不让 --resume 的值拼出目录穿越）", () => {
    const dir = path.join("C:/tmp", "sessions");
    expect(sessionFile(dir, "../../etc/passwd")).toBeNull();
    expect(sessionFile(dir, "2026-11-18")).toBeNull();
    expect(sessionFile(dir, "")).toBeNull();
    expect(sessionFile(dir, "20261118-144230-ab12/../x")).toBeNull();
  });
});

describe("writeSession / readSession", () => {
  it("写进去再读回来，轮次与元数据都在", async () => {
    const dir = await makeDir();
    const record = recordOf("20261118-144230-ab12", {
      turns: [
        { role: "user", text: "把登录改成扫码", at: 1 },
        { role: "assistant", text: "改好了", at: 2 },
      ],
    });
    const file = await writeSession(dir, record);
    expect(file).toBe(sessionFile(dir, record.id));

    const back = await readSession(dir, record.id);
    expect(back?.turns).toHaveLength(2);
    expect(back?.turns[0]?.text).toBe("把登录改成扫码");
    expect(back?.cwd).toBe("D:/repo");
    expect(back?.model).toBe("test-model");
  });

  it("超长回答被截断并注明，存档不会撑到几十 MB", async () => {
    const dir = await makeDir();
    const long = "字".repeat(MAX_STORED_MESSAGE_CHARS + 500);
    await writeSession(dir, recordOf("20261118-144230-ab13", {
      turns: [{ role: "assistant", text: long, at: 1 }],
    }));
    const raw = await readFile(sessionFile(dir, "20261118-144230-ab13")!, "utf8");
    const parsed = JSON.parse(raw) as SessionRecord;
    expect(parsed.turns[0]!.text.length).toBeLessThan(long.length);
    expect(parsed.turns[0]!.text).toContain("存档只留前面这些");
  });

  it("超长文本截断不劈开 emoji 代理对（d.412.4.212）", async () => {
    const dir = await makeDir();
    // 让第 MAX_STORED_MESSAGE_CHARS 个码元恰好是 emoji 的高位代理：slice 会把它劈成孤立代理。
    const before = "字".repeat(MAX_STORED_MESSAGE_CHARS - 1);
    const text = `${before}😀后面还有一大段内容`;
    await writeSession(dir, recordOf("20261118-144230-ab1f", {
      turns: [{ role: "assistant", text, at: 1 }],
    }));
    const back = await readSession(dir, "20261118-144230-ab1f");
    expect(hasLoneSurrogate(back!.turns[0]!.text)).toBe(false);
  });

  it("轮次超过上限只留最后这些（早期的让位）", async () => {
    const dir = await makeDir();
    const turns = Array.from({ length: MAX_STORED_TURNS + 10 }, (_, index) => ({
      role: "user" as const,
      text: `第 ${index} 条`,
      at: index,
    }));
    await writeSession(dir, recordOf("20261118-144230-ab14", { turns }));
    const parsed = JSON.parse(await readFile(sessionFile(dir, "20261118-144230-ab14")!, "utf8")) as SessionRecord;
    expect(parsed.turns).toHaveLength(MAX_STORED_TURNS);
    expect(parsed.turns[0]!.text).toBe(`第 ${10} 条`);
    expect(parsed.turns.at(-1)!.text).toBe(`第 ${MAX_STORED_TURNS + 9} 条`);
  });

  it("容量满了删最旧的一份，但刚写的这份一定留着", async () => {
    const dir = await makeDir();
    for (let index = 0; index < MAX_SESSIONS; index += 1) {
      const id = `20260101-0000${String(index).padStart(2, "0")}-aaaa`;
      await writeSession(dir, recordOf(id, { updatedAt: index }));
    }
    const fresh = "20261231-235959-zzzz";
    await writeSession(dir, recordOf(fresh, { updatedAt: 9_999 }));
    const records = await listSessions(dir);
    expect(records).toHaveLength(MAX_SESSIONS);
    expect(records.some((record) => record.id === fresh)).toBe(true);
    // 最旧那条（updatedAt=0）应该已经被清掉。
    expect(records.some((record) => record.id === "20260101-000000-aaaa")).toBe(false);
    // 关键：listSessions 默认只返回 50 条，光看它会被「已经裁到 50」骗过去。
    // 必须数磁盘上的文件——旧的裁剪实现用带上限的 listSessions 判断，
    // 结果 51 个 .json 全留在盘上，只是列表里看不到最旧那份而已。
    const onDisk = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    expect(onDisk).toHaveLength(MAX_SESSIONS);
    expect(onDisk).not.toContain("20260101-000000-aaaa.json");
  });
});

describe("listSessions", () => {
  it("按 updatedAt 从新到旧；坏 JSON 与形状不对的文件直接跳过", async () => {
    const dir = await makeDir();
    await writeSession(dir, recordOf("20261118-100000-aaaa", { updatedAt: 100 }));
    await writeSession(dir, recordOf("20261118-110000-bbbb", { updatedAt: 300 }));
    await writeFile(path.join(dir, "20261118-120000-cccc.json"), "{ 不是 JSON", "utf8");
    await writeFile(path.join(dir, "20261118-130000-dddd.json"), JSON.stringify({ id: "乱写" }), "utf8");
    await writeFile(path.join(dir, "notes.txt"), "忽略我", "utf8");

    const records = await listSessions(dir);
    expect(records.map((record) => record.id)).toEqual(["20261118-110000-bbbb", "20261118-100000-aaaa"]);
  });

  it("目录不存在时当空列表，不抛错", async () => {
    const dir = path.join(await makeDir(), "并不存在");
    await expect(listSessions(dir)).resolves.toEqual([]);
  });

  it("文件名与内部 id 不一致时按文件名认（用户 resume 的是文件名）", async () => {
    const dir = await makeDir();
    await mkdir(dir, { recursive: true });
    const wanted = "20261118-150000-eeee";
    const payload = { ...recordOf("20261118-155959-ffff"), id: "20261118-155959-ffff" };
    await writeFile(path.join(dir, `${wanted}.json`), JSON.stringify(payload), "utf8");
    const records = await listSessions(dir);
    expect(records[0]?.id).toBe(wanted);
  });
});

describe("resolveSession", () => {
  it("整串 id 直接命中", async () => {
    const dir = await makeDir();
    await writeSession(dir, recordOf("20261118-144230-ab12"));
    const resolved = await resolveSession(dir, "20261118-144230-ab12");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.record.id).toBe("20261118-144230-ab12");
  });

  it("唯一前缀也能接上（不必抄整串）", async () => {
    const dir = await makeDir();
    await writeSession(dir, recordOf("20261118-144230-ab12"));
    const resolved = await resolveSession(dir, "20261118-14");
    expect(resolved.ok).toBe(true);
  });

  it("前缀匹配到多份时列出来让人挑，而不是随便猜一个", async () => {
    const dir = await makeDir();
    await writeSession(dir, recordOf("20261118-144230-ab12"));
    await writeSession(dir, recordOf("20261118-144231-cd34"));
    const resolved = await resolveSession(dir, "20261118");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toContain("匹配到 2 个会话");
      expect(resolved.error).toContain("20261118-144230-ab12");
    }
  });

  it("目录还是空的时候说清「先跑一次」", async () => {
    const dir = await makeDir();
    const resolved = await resolveSession(dir, "20261118");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain("先跑一次 heming run");
  });

  it("没有任何匹配时提示去哪里看", async () => {
    const dir = await makeDir();
    await writeSession(dir, recordOf("20261118-144230-ab12"));
    const resolved = await resolveSession(dir, "20270101");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain("heming sessions");
  });

  it("id 里带非法字符直接拒绝，不去碰文件系统", async () => {
    const dir = await makeDir();
    const resolved = await resolveSession(dir, "../etc/passwd");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain("只能含数字、小写字母与短横线");
  });
});

describe("latestSession", () => {
  it("优先同一工作目录的最近一次（斜杠与大小写不敏感）", async () => {
    const dir = await makeDir();
    await writeSession(dir, recordOf("20261118-100000-aaaa", { cwd: "D:/other", updatedAt: 900 }));
    await writeSession(dir, recordOf("20261118-110000-bbbb", { cwd: "d:\\Repo", updatedAt: 100 }));
    const latest = await latestSession(dir, "D:/repo");
    expect(latest?.id).toBe("20261118-110000-bbbb");
  });

  it("没有同目录的就退到全局最近一次", async () => {
    const dir = await makeDir();
    await writeSession(dir, recordOf("20261118-100000-aaaa", { cwd: "D:/other", updatedAt: 100 }));
    const latest = await latestSession(dir, "D:/repo");
    expect(latest?.id).toBe("20261118-100000-aaaa");
  });

  it("一条都没有时返回 null", async () => {
    await expect(latestSession(await makeDir(), "D:/repo")).resolves.toBeNull();
  });
});

describe("toHistory", () => {
  it("只转文字轮次，空文本丢掉", () => {
    const record = recordOf("20261118-144230-ab12", {
      turns: [
        { role: "user", text: "问题一", at: 1 },
        { role: "assistant", text: "   ", at: 2 },
        { role: "user", text: "问题二", at: 3 },
        { role: "assistant", text: "回答二", at: 4 },
      ],
    });
    expect(toHistory(record)).toEqual([
      { role: "user", content: "问题一" },
      { role: "user", content: "问题二" },
      { role: "assistant", content: "回答二" },
    ]);
  });

  it("没有存档时给空数组（回到单轮模式）", () => {
    expect(toHistory(null)).toEqual([]);
  });
});

describe("appendTurn", () => {
  it("新会话：建记录、时间是这条消息的、问答成对", () => {
    const record = appendTurn(null, {
      id: "20261118-144230-ab12",
      cwd: "D:/repo",
      model: "test-model",
      prompt: "读一下 README",
      answer: "读完了",
      now: 1_700_000_000_000,
    });
    expect(record.id).toBe("20261118-144230-ab12");
    expect(record.createdAt).toBe(1_700_000_000_000);
    expect(record.updatedAt).toBe(1_700_000_000_000);
    expect(record.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  });

  it("回答为空（失败/中断）时只留提问，下次接上至少知道问过什么", () => {
    const record = appendTurn(null, {
      id: "20261118-144230-ab12",
      cwd: "D:/repo",
      model: "test-model",
      prompt: "跑一下测试",
      answer: "   ",
    });
    expect(record.turns).toHaveLength(1);
    expect(record.turns[0]!.role).toBe("user");
  });

  it("接着写：旧轮次保留，工作目录与模型可以换成本次的", () => {
    const base = recordOf("20261118-144230-ab12", {
      turns: [{ role: "user", text: "旧问题", at: 1 }],
      createdAt: 1,
      updatedAt: 1,
    });
    const next = appendTurn(base, {
      id: base.id,
      cwd: "D:/another",
      model: "another-model",
      prompt: "新问题",
      answer: "新回答",
      now: 2,
    });
    expect(next.createdAt).toBe(1);
    expect(next.turns.map((turn) => turn.text)).toEqual(["旧问题", "新问题", "新回答"]);
    expect(next.cwd).toBe("D:/another");
    expect(next.model).toBe("another-model");
  });
});

describe("summarize / describeSession", () => {
  it("摘要只留一眼能认出来的字段，最后一句取最后一条提问", () => {
    const record = recordOf("20261118-144230-ab12", {
      turns: [
        { role: "user", text: "第一问", at: 1 },
        { role: "assistant", text: "回答", at: 2 },
        { role: "user", text: "第二问", at: 3 },
      ],
    });
    const summary = summarize(record);
    expect(summary.turns).toBe(3);
    expect(summary.lastPrompt).toBe("第二问");
  });

  it("一行里能看出 id / 时间 / 条数 / 最后一句", () => {
    const line = describeSession(recordOf("20261118-144230-ab12", {
      updatedAt: new Date(2026, 10, 18, 14, 42, 30).getTime(),
      turns: [{ role: "user", text: "把登录改成扫码", at: 1 }],
    }));
    expect(line).toContain("20261118-144230-ab12");
    expect(line).toContain("2026-11-18 14:42");
    expect(line).toContain("1 条");
    expect(line).toContain("把登录改成扫码");
  });
});

describe("sessionDir", () => {
  it("显式参数优先于环境变量", () => {
    const previous = process.env[SESSION_DIR_ENV];
    process.env[SESSION_DIR_ENV] = "D:/from-env";
    try {
      expect(sessionDir("D:/explicit")).toBe(path.resolve("D:/explicit"));
      expect(sessionDir()).toBe(path.resolve("D:/from-env"));
    } finally {
      if (previous === undefined) delete process.env[SESSION_DIR_ENV];
      else process.env[SESSION_DIR_ENV] = previous;
    }
  });

  it("都没有时落在用户主目录下的 .heming/cli-sessions", async () => {
    const previous = process.env[SESSION_DIR_ENV];
    delete process.env[SESSION_DIR_ENV];
    try {
      expect(sessionDir()).toBe(path.join(os.homedir(), ".heming", "cli-sessions"));
    } finally {
      if (previous !== undefined) process.env[SESSION_DIR_ENV] = previous;
    }
  });
});

describe("存档目录里的临时文件", () => {
  it("写完不留下 .tmp（原子写不是把半截文件留在那）", async () => {
    const dir = await makeDir();
    await writeSession(dir, recordOf("20261118-144230-ab12"));
    const names = await readdir(dir);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});
