/**
 * `mcpWatch.ts` 的用例（d.327）。
 *
 * 用真的临时目录与真的 `fs.watch`（不注入假实现）：这个模块的价值就在「操作系统真报了事件
 * 之后我们怎么反应」，用假 watcher 测等于只测了自己写的 if。代价是要轮询等一下事件，
 * 所以防抖窗口在测试里调到 20ms。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createMcpCatalogWatcher, relOfResourceUri, watchTargetsOf } from "./mcpWatch.js";

const TMP_DIRS: string[] = [];

function tmpWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "heming-watch-"));
  TMP_DIRS.push(dir);
  return dir.replace(/\\/g, "/");
}

afterAll(() => {
  for (const dir of TMP_DIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响结论 */
    }
  }
});

/** 轮询等待一个条件成立（真文件事件是异步的，没有确定的完成时刻）。 */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待超时（${timeoutMs}ms）`);
}

function watcherOf(cwd: string) {
  const updated: string[] = [];
  let listChanged = 0;
  const watcher = createMcpCatalogWatcher({
    cwd,
    debounceMs: 20,
    onUpdated: (uri) => updated.push(uri),
    onListChanged: () => {
      listChanged += 1;
    },
  });
  return { watcher, updated, listChanges: () => listChanged };
}

describe("资源 URI（d.327）", () => {
  it("认自己前缀下的相对路径，别的形状一律不认", () => {
    expect(relOfResourceUri("heming://workspace/AGENTS.md")).toBe("AGENTS.md");
    expect(relOfResourceUri("heming://workspace/.heming/commands/review.md")).toBe(
      ".heming/commands/review.md",
    );
    expect(relOfResourceUri("heming://workspace/")).toBeNull();
    expect(relOfResourceUri("file:///tmp/AGENTS.md")).toBeNull();
    expect(relOfResourceUri("heming://workspace/../secrets.md")).toBeNull();
    expect(relOfResourceUri("heming://workspace/.heming\\rules.md")).toBeNull();
    // 文件名里带两个点是合法文件，不该被 .. 越界判定误杀
    expect(relOfResourceUri("heming://workspace/docs/a..b.md")).toBe("docs/a..b.md");
  });

  it("列出会监听的三个目录（不递归到别处）", () => {
    expect(watchTargetsOf("D:/work/proj/")).toEqual([
      "D:/work/proj",
      "D:/work/proj/.heming",
      "D:/work/proj/.heming/commands",
    ]);
  });
});

describe("订阅后的变更推送（d.327）", () => {
  it("订阅了 AGENTS.md：改了它就推一条 updated", async () => {
    const cwd = tmpWorkspace();
    const file = path.join(cwd, "AGENTS.md");
    writeFileSync(file, "改完要跑 pnpm test。", "utf8");
    const { watcher, updated } = watcherOf(cwd);
    watcher.subscribe("heming://workspace/AGENTS.md");
    expect(watcher.subscribed()).toEqual(["heming://workspace/AGENTS.md"]);
    try {
      writeFileSync(file, "改完要跑 pnpm test。\n不要手改 generated。", "utf8");
      await waitFor(() => updated.length > 0);
      expect(updated).toEqual(["heming://workspace/AGENTS.md"]);
    } finally {
      watcher.close();
    }
  });

  it("订阅子目录里的资源：改了它也能推（模板 URI 不是假订阅，d.412.4.214）", async () => {
    const cwd = tmpWorkspace();
    mkdirSync(path.join(cwd, "src"), { recursive: true });
    const file = path.join(cwd, "src", "a.ts");
    writeFileSync(file, "export const a = 1;", "utf8");
    const { watcher, updated } = watcherOf(cwd);
    watcher.subscribe("heming://workspace/src/a.ts");
    try {
      writeFileSync(file, "export const a = 2;", "utf8");
      await waitFor(() => updated.includes("heming://workspace/src/a.ts"));
      expect(updated).toContain("heming://workspace/src/a.ts");
    } finally {
      watcher.close();
    }
  });

  it("深层子目录也能推；取消订阅后重新订阅仍工作（d.412.4.214）", async () => {
    const cwd = tmpWorkspace();
    mkdirSync(path.join(cwd, "docs", "api"), { recursive: true });
    const file = path.join(cwd, "docs", "api", "a.md");
    writeFileSync(file, "一", "utf8");
    const { watcher, updated } = watcherOf(cwd);
    const uri = "heming://workspace/docs/api/a.md";
    watcher.subscribe(uri);
    try {
      writeFileSync(file, "二", "utf8");
      await waitFor(() => updated.includes(uri));
      // 取消订阅 → 动态 target 回收 → 重新订阅，仍应能收到通知（回收不能破坏再次订阅）。
      watcher.unsubscribe(uri);
      expect(watcher.subscribed()).toEqual([]);
      watcher.subscribe(uri);
      writeFileSync(file, "三", "utf8");
      await waitFor(() => updated.filter((u) => u === uri).length >= 2);
    } finally {
      watcher.close();
    }
  });

  it("订阅了 .heming/rules.md：改它同样能推", async () => {
    const cwd = tmpWorkspace();
    mkdirSync(path.join(cwd, ".heming"), { recursive: true });
    const file = path.join(cwd, ".heming", "rules.md");
    writeFileSync(file, "先跑检查。", "utf8");
    const { watcher, updated } = watcherOf(cwd);
    watcher.subscribe("heming://workspace/.heming/rules.md");
    try {
      writeFileSync(file, "先跑检查，再提交。", "utf8");
      await waitFor(() => updated.includes("heming://workspace/.heming/rules.md"));
    } finally {
      watcher.close();
    }
  });

  it("命令目录里新增或删掉文件：推 list_changed（清单变了）", async () => {
    const cwd = tmpWorkspace();
    mkdirSync(path.join(cwd, ".heming", "commands"), { recursive: true });
    const { watcher, listChanges } = watcherOf(cwd);
    watcher.subscribe("heming://workspace/.heming/commands/review.md");
    try {
      writeFileSync(path.join(cwd, ".heming", "commands", "perf.md"), "# 性能\n看热点。", "utf8");
      await waitFor(() => listChanges() > 0);
    } finally {
      watcher.close();
    }
  });

  it("没订阅的文件变了不推（只推订阅过的）", async () => {
    const cwd = tmpWorkspace();
    writeFileSync(path.join(cwd, "AGENTS.md"), "一", "utf8");
    const { watcher, updated } = watcherOf(cwd);
    watcher.subscribe("heming://workspace/AGENTS.md");
    try {
      writeFileSync(path.join(cwd, "README.md"), "无关文件", "utf8");
      // 反过来验证：README 变了之后，再改 AGENTS.md 仍然只推它一条。
      writeFileSync(path.join(cwd, "AGENTS.md"), "二", "utf8");
      await waitFor(() => updated.length > 0);
      expect(updated).toEqual(["heming://workspace/AGENTS.md"]);
    } finally {
      watcher.close();
    }
  });

  it("取消订阅之后不再推", async () => {
    const cwd = tmpWorkspace();
    const file = path.join(cwd, "AGENTS.md");
    writeFileSync(file, "一", "utf8");
    const { watcher, updated } = watcherOf(cwd);
    watcher.subscribe("heming://workspace/AGENTS.md");
    watcher.unsubscribe("heming://workspace/AGENTS.md");
    expect(watcher.subscribed()).toEqual([]);
    try {
      writeFileSync(file, "二", "utf8");
      // 给事件一点时间：真推了的话这里会攒出条目。
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(updated).toEqual([]);
    } finally {
      watcher.close();
    }
  });

  it("close 之后不再推，订阅表也清空", async () => {
    const cwd = tmpWorkspace();
    const file = path.join(cwd, "AGENTS.md");
    writeFileSync(file, "一", "utf8");
    const { watcher, updated } = watcherOf(cwd);
    watcher.subscribe("heming://workspace/AGENTS.md");
    watcher.close();
    expect(watcher.subscribed()).toEqual([]);
    writeFileSync(file, "二", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(updated).toEqual([]);
  });

  it("不是本服务的 URI 收下也没用（不会挂 watcher）", () => {
    const cwd = tmpWorkspace();
    const { watcher } = watcherOf(cwd);
    try {
      watcher.subscribe("file:///etc/passwd");
      watcher.subscribe("heming://workspace/../x.md");
      expect(watcher.subscribed()).toEqual([]);
    } finally {
      watcher.close();
    }
  });
});