/**
 * CLI 读工作区约定文件（d.310）。
 *
 * 钉三件事：
 * - **口径与桌面端一致**：认哪些文件名、封顶多少、截断怎么说——这些来自
 *   `agentRuntime/projectRules.ts`，这里只验 CLI 这一层没把它用错；
 * - **CLI 的根就是 `--cwd`**：工作区 = 可写根，不再往上层找；
 * - **读不到不算错**：没文件、桥抛错、目录不存在，都只是「这一轮没有约定」。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FileFsBridge } from "../../../packages/web/src/lib/fileEdit/bridge.js";
import {
  MAX_PROJECT_RULE_CHARS,
  MAX_PROJECT_RULES_TOTAL_CHARS,
  PROJECT_RULES_HEADING,
} from "../../../packages/web/src/lib/agentRuntime/projectRules.js";
import { collectCliProjectRules, describeCliProjectRules } from "./projectRules.js";

const TMP: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heming-cli-rules-"));
  TMP.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

describe("collectCliProjectRules", () => {
  it("工作区里没有约定文件：空段、空摘要（不是错误）", async () => {
    const dir = workspace();
    const collected = await collectCliProjectRules({ cwd: dir });
    expect(collected.files).toEqual([]);
    expect(collected.section).toBe("");
    expect(describeCliProjectRules(collected)).toBe("");
  });

  it("读到 AGENTS.md：段落带标题与正文，摘要是「文件名（N 字）」", async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, "AGENTS.md"), "改完要跑 pnpm test。\n不要手改生成文件。\n", "utf8");

    const collected = await collectCliProjectRules({ cwd: dir });
    expect(collected.files.map((file) => file.rel)).toEqual(["AGENTS.md"]);
    expect(collected.section).toContain(PROJECT_RULES_HEADING);
    expect(collected.section).toContain("改完要跑 pnpm test。");
    expect(collected.section).toContain("不要手改生成文件。");
    expect(describeCliProjectRules(collected)).toBe(`项目约定：AGENTS.md（${collected.files[0]!.text.length} 字）`);
  });

  it("BOM 与 CRLF 归一到干净文本（Windows 上最常见的写法）", async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, "AGENTS.md"), "\uFEFF第一行\r\n第二行\r\n", "utf8");

    const collected = await collectCliProjectRules({ cwd: dir });
    const text = collected.files[0]?.text ?? "";
    expect(text.startsWith("\uFEFF")).toBe(false);
    expect(text).not.toContain("\r");
    expect(text).toBe("第一行\n第二行");
  });

  it("两份文件按声明顺序出现（AGENTS.md 先于 .heming/rules.md）", async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, "AGENTS.md"), "根上的规矩", "utf8");
    mkdirSync(path.join(dir, ".heming"), { recursive: true });
    writeFileSync(path.join(dir, ".heming", "rules.md"), "更细的规矩", "utf8");

    const collected = await collectCliProjectRules({ cwd: dir });
    expect(collected.files.map((file) => file.rel)).toEqual(["AGENTS.md", ".heming/rules.md"]);
    expect(describeCliProjectRules(collected)).toContain("AGENTS.md");
    expect(describeCliProjectRules(collected)).toContain(".heming/rules.md");
  });

  it("单文件超长：只留开头，并写清怎么接着读", async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, "AGENTS.md"), "甲".repeat(MAX_PROJECT_RULE_CHARS + 500), "utf8");

    const collected = await collectCliProjectRules({ cwd: dir });
    expect(collected.files[0]?.truncated).toBe(true);
    expect(collected.files[0]?.text.length).toBe(MAX_PROJECT_RULE_CHARS);
    expect(describeCliProjectRules(collected)).toContain("已截断");
    // 段落里要给出「怎么看剩下的」的方法，而不是悄悄截断。
    expect(collected.section).toContain("file_read");
  });

  it("总量封顶：后面的文件不进正文，但要在段尾点名", async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, "AGENTS.md"), "甲".repeat(MAX_PROJECT_RULE_CHARS), "utf8");
    mkdirSync(path.join(dir, ".heming"), { recursive: true });
    writeFileSync(path.join(dir, ".heming", "rules.md"), "乙".repeat(MAX_PROJECT_RULE_CHARS), "utf8");

    const collected = await collectCliProjectRules({ cwd: dir });
    // 4000 + 4000 > 6000：第二份放不下，只能进 omitted。
    expect(collected.files.map((file) => file.rel)).toEqual(["AGENTS.md"]);
    expect(collected.omitted).toContain(".heming/rules.md");
    expect(collected.files[0]!.text.length).toBeLessThan(MAX_PROJECT_RULES_TOTAL_CHARS);
    expect(describeCliProjectRules(collected)).toContain("没展开");
  });

  it("桥抛错、目录不存在：都只是「没有约定」，不往上抛", async () => {
    const broken: FileFsBridge = {
      read: async () => {
        throw new Error("桥挂了");
      },
      write: async () => ({ ok: true, results: [], written: 0, deleted: 0 }),
    } as unknown as FileFsBridge;

    const dir = workspace();
    const viaBroken = await collectCliProjectRules({ cwd: dir, bridge: broken });
    expect(viaBroken.files).toEqual([]);
    expect(viaBroken.section).toBe("");

    const missing = path.join(dir, "根本没这个目录");
    const viaMissing = await collectCliProjectRules({ cwd: missing });
    expect(viaMissing.files).toEqual([]);
  });
});

describe("describeCliProjectRules", () => {
  it("只有 omitted 时也要说出来（不是「一份都没有」这么一句带过）", () => {
    expect(describeCliProjectRules({ files: [], section: "", omitted: ["HEMING.md"] })).toBe(
      "项目约定：一份都没读到；另有 HEMING.md 没展开",
    );
  });
});
