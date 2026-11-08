import { afterEach, describe, expect, it } from "vitest";
import type { ToolBridge } from "../agentStream.js";
import { createMemoryVaultBridge } from "./bridge.js";
import { resetVaultStore, setVaultBridge, useVaultStore } from "./store.js";
import { buildVaultToolBridge, validVaultPath, VAULT_TOOLS } from "./tools.js";
import type { VaultBridge } from "./types.js";

/**
 * 知识库工具：vault_search / vault_read / vault_write。
 *
 * 跑真实 store + 内存桥（并把桥挂到 window 上模拟桌面端），钉住：
 * - 检索命中行号（含 frontmatter 偏移）与来源脚注；
 * - 路径守卫（越界 / 绝对路径 / 非文本扩展名）；
 * - 写入只允许 writeDirs（`vault:apply` 通道），越界中文拒绝；
 * - 浏览器临时模式拒绝写入（不落盘的改动不给假承诺）。
 */

const FILES: Record<string, string> = {
  "inbox/已有.md": "---\ntags: [项目]\n---\n# 已有\n预算与风险记录。\n",
  "notes/笔记.md": "另一页\n",
};

function stubWindowBridge(bridge: VaultBridge | null): void {
  const target = window as unknown as { __heming_vault?: VaultBridge };
  if (bridge) target.__heming_vault = bridge;
  else delete target.__heming_vault;
}

async function boot(): Promise<VaultBridge> {
  resetVaultStore();
  const bridge = createMemoryVaultBridge({ files: FILES, now: () => 1000 });
  stubWindowBridge(bridge);
  setVaultBridge(bridge);
  await useVaultStore.getState().loadVaults();
  return bridge;
}

function toolBridge(): ToolBridge {
  return buildVaultToolBridge();
}

async function call(
  bridge: ToolBridge,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; ok: boolean; sources?: unknown[] }> {
  return bridge.execute({ name, arguments: JSON.stringify(args) });
}

afterEach(() => {
  stubWindowBridge(null);
});

describe("工具声明", () => {
  it("三个工具、名字与风险固定", () => {
    expect(VAULT_TOOLS.map((spec) => spec.name)).toEqual([
      "vault_search",
      "vault_read",
      "vault_write",
    ]);
    const bridge = toolBridge();
    expect(bridge.meta?.("vault_search")?.risk).toBe("read");
    expect(bridge.meta?.("vault_read")?.risk).toBe("read");
    expect(bridge.meta?.("vault_write")?.risk).toBe("write");
  });
});

describe("validVaultPath", () => {
  it("接受库内文本相对路径并规范化反斜杠", () => {
    expect(validVaultPath("inbox/会议.md")).toBe("inbox/会议.md");
    expect(validVaultPath("./inbox\\a.md")).toBe("inbox/a.md");
  });

  it("拒绝越界、绝对路径、盘符、NUL、隐藏目录与非文本扩展名", () => {
    for (const bad of [
      "../x.md",
      "a/../../x.md",
      "/abs.md",
      "C:/x.md",
      "a\u0000b.md",
      ".obsidian/x.md",
      "a.exe",
      "a",
      42,
      null,
    ]) {
      expect(validVaultPath(bad)).toBeNull();
    }
  });
});

describe("vault_search", () => {
  it("CJK 检索命中并给出路径、行号（含 frontmatter 偏移）与来源", async () => {
    await boot();
    const result = await call(toolBridge(), "vault_search", { query: "预算风险" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("路径：inbox/已有.md");
    expect(result.text).toContain("行号：5");
    expect(result.text).toContain("预算与风险");
    expect(result.sources).toEqual([
      { id: "inbox/已有.md", title: "已有", detail: "第 5 行", kind: "wiki" },
    ]);
  });

  it("支持 tag: 过滤与 limit", async () => {
    await boot();
    const tagged = await call(toolBridge(), "vault_search", { query: "tag:项目" });
    expect(tagged.text).toContain("inbox/已有.md");
    const limited = await call(toolBridge(), "vault_search", { query: "页", limit: 1 });
    expect(limited.ok).toBe(true);
  });

  it("空 query 报错，无命中返回 ok=true 的说明", async () => {
    await boot();
    expect((await call(toolBridge(), "vault_search", { query: "  " })).ok).toBe(false);
    const none = await call(toolBridge(), "vault_search", { query: "完全不存在的词" });
    expect(none.ok).toBe(true);
    expect(none.text).toContain("没有匹配");
  });

  it("索引没建时自动建索引再检索", async () => {
    const bridge = await boot();
    await bridge.write("memory", "inbox/新页.md", "新页里有独特词：独角兽\n");
    await useVaultStore.getState().reindexPaths(["inbox/新页.md"]);
    const result = await call(toolBridge(), "vault_search", { query: "独角兽" });
    expect(result.text).toContain("inbox/新页.md");
  });
});

describe("vault_read", () => {
  it("读取全文并带标题、路径、标签与大纲", async () => {
    await boot();
    const result = await call(toolBridge(), "vault_read", { path: "inbox/已有.md" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("# 已有");
    expect(result.text).toContain("路径：inbox/已有.md");
    expect(result.text).toContain("标签：项目");
    expect(result.text).toContain("预算与风险记录。");
    expect(result.sources).toEqual([
      { id: "inbox/已有.md", title: "已有", detail: "知识库", kind: "wiki" },
    ]);
  });

  it("非法路径与不存在的文件都返回 ok=false 与中文原因", async () => {
    await boot();
    const bad = await call(toolBridge(), "vault_read", { path: "../secret.md" });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("相对路径");
    const missing = await call(toolBridge(), "vault_read", { path: "inbox/没有.md" });
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("没有文件");
  });
});

describe("vault_write", () => {
  it("只允许 writeDirs：越界中文拒绝且不落盘", async () => {
    const bridge = await boot();
    const result = await call(toolBridge(), "vault_write", {
      path: "notes/新页.md",
      content: "越界内容",
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("拒绝写入");
    expect(await bridge.read("memory", "notes/新页.md")).toBeNull();
  });

  it("允许目录内写入并立刻进索引", async () => {
    const bridge = await boot();
    const result = await call(toolBridge(), "vault_write", {
      path: "inbox/新结论.md",
      content: "# 新结论\n预算结论已沉淀。\n",
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("已写入");
    expect((await bridge.read("memory", "inbox/新结论.md"))?.text).toContain("新结论");
    expect(useVaultStore.getState().index?.pages.has("inbox/新结论.md")).toBe(true);
  });

  it("append 模式追加而不覆盖", async () => {
    const bridge = await boot();
    const tools = toolBridge();
    await call(tools, "vault_write", { path: "inbox/追加.md", content: "第一段" });
    await call(tools, "vault_write", {
      path: "inbox/追加.md",
      content: "第二段",
      mode: "append",
    });
    expect((await bridge.read("memory", "inbox/追加.md"))?.text).toBe("第一段\n第二段");
  });

  it("空内容与浏览器临时模式都拒绝写入", async () => {
    await boot();
    const empty = await call(toolBridge(), "vault_write", {
      path: "inbox/a.md",
      content: "   ",
    });
    expect(empty.ok).toBe(false);

    stubWindowBridge(null); // 模拟浏览器临时模式
    const ephemeral = await call(toolBridge(), "vault_write", {
      path: "inbox/a.md",
      content: "内容",
    });
    expect(ephemeral.ok).toBe(false);
    expect(ephemeral.text).toContain("临时模式");
  });
});

describe("未知工具", () => {
  it("返回 ok=false 而不是抛错", async () => {
    await boot();
    const result = await call(toolBridge(), "vault_unknown", {});
    expect(result.ok).toBe(false);
    expect(result.text).toContain("未知工具");
  });
});
