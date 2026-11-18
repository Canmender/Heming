/**
 * MCP 的 prompts / resources（d.325）。
 *
 * 这里测两件事：采集（命令文件 → 提示词 + 资源、约定文件、配置、超长截断、读不到就跳过）
 * 和协议翻译（能力声明、list/get/read 的形状、未知名字的错误码、URI 不能用来穿越）。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FileFsBridge } from "../../../packages/web/src/lib/fileEdit/bridge.js";
import {
  collectCliMcpCatalog,
  describeCliMcpCatalog,
  MCP_CATALOG_MAX_FILE_CHARS,
  MCP_RESOURCE_PREFIX,
  mimeOf,
  normalizeCatalogText,
  relOfResourceUri,
  resourceUriOf,
} from "./mcpCatalog.js";

const TMP_DIRS: string[] = [];

afterAll(async () => {
  await Promise.all(TMP_DIRS.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "heming-catalog-"));
  TMP_DIRS.push(dir);
  return dir;
}

/** 在临时工作区里写一份文件（自动建目录）。 */
async function put(dir: string, rel: string, text: string): Promise<void> {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, text, "utf8");
}

describe("资源 URI（d.325）", () => {
  it("相对路径与 URI 互相换算，反斜杠当正斜杠", () => {
    expect(resourceUriOf("AGENTS.md")).toBe(`${MCP_RESOURCE_PREFIX}AGENTS.md`);
    expect(resourceUriOf(".heming\\commands\\review.md")).toBe(`${MCP_RESOURCE_PREFIX}.heming/commands/review.md`);
    expect(relOfResourceUri(`${MCP_RESOURCE_PREFIX}.heming/rules.md`)).toBe(".heming/rules.md");
  });

  it("不是我们的命名空间、空路径、带 .. 的一律不认", () => {
    expect(relOfResourceUri("file:///etc/passwd")).toBeNull();
    expect(relOfResourceUri(MCP_RESOURCE_PREFIX)).toBeNull();
    expect(relOfResourceUri(`${MCP_RESOURCE_PREFIX}/abs.md`)).toBeNull();
    expect(relOfResourceUri(`${MCP_RESOURCE_PREFIX}../secrets.md`)).toBeNull();
  });

  it("按扩展名给 MIME", () => {
    expect(mimeOf("AGENTS.md")).toBe("text/markdown");
    expect(mimeOf(".heming/permissions.json")).toBe("application/json");
    expect(mimeOf("notes.txt")).toBe("text/plain");
  });
});

describe("采集工作区内容（d.325）", () => {
  it("命令文件既是提示词也是资源，标题与说明来自文件头", async () => {
    const dir = await tmpDir();
    await put(dir, ".heming/commands/review.md", "# 安全审查\n> 只挑能被利用的问题\n按威胁模型逐条过入口。\n");
    const catalog = await collectCliMcpCatalog({ cwd: dir });
    expect(catalog.prompts).toHaveLength(1);
    const [prompt] = catalog.prompts;
    expect(prompt!.name).toBe("review");
    expect(prompt!.title).toBe("安全审查");
    expect(prompt!.description).toBe("只挑能被利用的问题");
    expect(prompt!.text).toContain("按威胁模型逐条过入口。");
    expect(prompt!.source).toBe(".heming/commands/review.md");
    expect(catalog.resources.map((r) => r.uri)).toContain(
      `${MCP_RESOURCE_PREFIX}.heming/commands/review.md`,
    );
  });

  it("约定文件与三份配置都进资源，命令按路径排序", async () => {
    const dir = await tmpDir();
    await put(dir, "AGENTS.md", "改完要跑 pnpm test。");
    await put(dir, ".heming/rules.md", "生成文件不许手改。");
    await put(dir, ".heming/permissions.json", '{"deny":[],"ask":[],"allow":[]}');
    await put(dir, ".heming/hooks.json", '{"hooks":[]}');
    await put(dir, ".heming/commands/b.md", "B 的正文");
    await put(dir, ".heming/commands/a.md", "A 的正文");
    const catalog = await collectCliMcpCatalog({ cwd: dir });
    expect(catalog.resources.map((r) => r.rel)).toEqual([
      ".heming/commands/a.md",
      ".heming/commands/b.md",
      "AGENTS.md",
      ".heming/rules.md",
      ".heming/permissions.json",
      ".heming/hooks.json",
    ]);
    expect(catalog.prompts.map((p) => p.name)).toEqual(["a", "b"]);
    // 资源正文就是文件原文，不做 markdown 处理。
    const agents = catalog.resources.find((r) => r.rel === "AGENTS.md")!;
    expect(agents.text).toBe("改完要跑 pnpm test。");
    expect(agents.mimeType).toBe("text/markdown");
    expect(agents.name).toBe("AGENTS.md");
  });

  it("没有 .heming 目录、没有约定文件时是空目录而不是报错", async () => {
    const dir = await tmpDir();
    const catalog = await collectCliMcpCatalog({ cwd: dir });
    expect(catalog.prompts).toEqual([]);
    expect(catalog.resources).toEqual([]);
    expect(describeCliMcpCatalog(catalog)).toBe("");
  });

  it("超长文件截断，并在末尾说明要用 file_read 读哪一份", async () => {
    const dir = await tmpDir();
    await put(dir, "AGENTS.md", "啊".repeat(MCP_CATALOG_MAX_FILE_CHARS + 10));
    const catalog = await collectCliMcpCatalog({ cwd: dir });
    const agents = catalog.resources.find((r) => r.rel === "AGENTS.md")!;
    expect(agents.text.length).toBeGreaterThan(MCP_CATALOG_MAX_FILE_CHARS);
    expect(agents.text).toContain(`超过 ${MCP_CATALOG_MAX_FILE_CHARS} 字`);
    expect(agents.text).toContain("file_read 读 AGENTS.md");
  });

  it("桥抛错就当这个工作区什么都没有", async () => {
    const dir = await tmpDir();
    const bridge = {
      glob: async () => {
        throw new Error("boom");
      },
      read: async () => {
        throw new Error("boom");
      },
    } as unknown as FileFsBridge;
    const catalog = await collectCliMcpCatalog({ cwd: dir, bridge });
    expect(catalog.prompts).toEqual([]);
    expect(catalog.resources).toEqual([]);
  });

  it("摘要说明条数与提示词名字", async () => {
    const dir = await tmpDir();
    await put(dir, ".heming/commands/review.md", "看安全");
    await put(dir, "AGENTS.md", "规矩");
    const line = describeCliMcpCatalog(await collectCliMcpCatalog({ cwd: dir }));
    expect(line).toContain("1 条提示词（review）");
    expect(line).toContain("2 份资源");
  });
});
describe("交给客户端之前的归一（d.325）", () => {
  it("去掉开头的 BOM、CRLF 折成 LF，其余照原样", () => {
    expect(normalizeCatalogText("\uFEFF# 标题\r\n正文\r\n")).toBe("# 标题\n正文\n");
    expect(normalizeCatalogText("没有 BOM 也不改。")).toBe("没有 BOM 也不改。");
  });

  it("带 BOM 写的命令文件也能认出标题和说明", async () => {
    const dir = await tmpDir();
    // PowerShell 5 / 记事本默认就是这个形状：BOM + CRLF。
    await put(dir, ".heming/commands/review.md", "\uFEFF# 安全审查\r\n> 只挑能被利用的问题\r\n按威胁模型逐条过入口。\r\n");
    const catalog = await collectCliMcpCatalog({ cwd: dir });
    const [prompt] = catalog.prompts;
    expect(prompt!.title).toBe("安全审查");
    expect(prompt!.description).toBe("只挑能被利用的问题");
    expect(prompt!.text).not.toContain("\uFEFF");
    expect(catalog.resources[0]!.text.startsWith("# 安全审查")).toBe(true);
  });
});