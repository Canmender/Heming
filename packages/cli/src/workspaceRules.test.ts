/**
 * 工作区权限规则在 CLI 里的落地（d.306）。
 *
 * 一半是**加载**：读 `.heming/permissions.json`、坏文件 fail-closed、大小上限；
 * 一半是**闸门**：deny 压过一切、ask 落成拒绝、allow 只在信任后放宽 danger 工具。
 *
 * 用真实临时目录，不 mock fs——要验的正是「文件真的那样写会怎样」。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FileRoot } from "../../../packages/web/src/lib/fileEdit/paths.js";
import type { WorkspaceRulesConfig } from "../../../packages/web/src/lib/hitl/workspaceRules.js";
import { createCliGate } from "./tooling.js";
import {
  CLI_WORKSPACE_RULES_MAX_BYTES,
  cliWorkspaceRulesPath,
  describeCliWorkspaceRules,
  loadCliWorkspaceRules,
} from "./workspaceRules.js";

const TMP: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heming-cli-rules-"));
  TMP.push(dir);
  return dir;
}

/** 在临时工作区里写一份规则文件（`text` 原样写入）。 */
function workspaceWith(text: string): string {
  const dir = tmpDir();
  mkdirSync(path.join(dir, ".heming"), { recursive: true });
  writeFileSync(path.join(dir, ".heming", "permissions.json"), text, "utf8");
  return dir;
}

afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

describe("cliWorkspaceRulesPath", () => {
  it("拼在 .heming/permissions.json 上，反斜杠统一成正斜杠", () => {
    expect(cliWorkspaceRulesPath("D:\\work\\proj")).toBe("D:/work/proj/.heming/permissions.json");
    expect(cliWorkspaceRulesPath("D:/work/proj/")).toBe("D:/work/proj/.heming/permissions.json");
  });
});

describe("loadCliWorkspaceRules", () => {
  it("没有规则文件 = 没有规则（不是错误）", async () => {
    expect(await loadCliWorkspaceRules(tmpDir(), false)).toBeNull();
  });

  it("有效规则：解析出条目数，allowActive 跟着信任开关走", async () => {
    const dir = workspaceWith(
      JSON.stringify({
        deny: [{ tool: "run_command", command: "git push*" }],
        ask: [{ tool: "file_write", path: "docs/**" }],
        allow: [{ tool: "file_write", path: "src/**" }],
      }),
    );

    const untrusted = await loadCliWorkspaceRules(dir, false);
    expect(untrusted?.ok).toBe(true);
    if (!untrusted || !untrusted.ok) throw new Error("应当加载成功");
    expect(untrusted.rules.source).toBe(".heming/permissions.json");
    expect(untrusted.rules.config.deny).toHaveLength(1);
    expect(untrusted.rules.config.ask).toHaveLength(1);
    expect(untrusted.rules.config.allow).toHaveLength(1);
    expect(untrusted.rules.allowActive).toBe(false);

    const trusted = await loadCliWorkspaceRules(dir, true);
    if (!trusted || !trusted.ok) throw new Error("应当加载成功");
    expect(trusted.rules.trusted).toBe(true);
    expect(trusted.rules.allowActive).toBe(true);
  });

  it("内容坏了 = ok:false（调用方要全拒，不能当没有规则）", async () => {
    const dir = workspaceWith("{ 这不是 JSON");
    const loaded = await loadCliWorkspaceRules(dir, false);
    expect(loaded && loaded.ok).toBe(false);
    if (!loaded || loaded.ok) throw new Error("应当失败");
    expect(loaded.source).toBe(".heming/permissions.json");
    expect(loaded.error.length).toBeGreaterThan(0);
  });

  it("文件太大直接判失败，不读进内存", async () => {
    const dir = workspaceWith("x".repeat(CLI_WORKSPACE_RULES_MAX_BYTES + 1));
    const loaded = await loadCliWorkspaceRules(dir, false);
    expect(loaded && loaded.ok).toBe(false);
    if (!loaded || loaded.ok) throw new Error("应当失败");
    expect(loaded.error).toContain("太大");
  });

  it("文件开头有 UTF-8 BOM 也能读（记事本/PS5 默认写法）", async () => {
    const dir = tmpDir();
    mkdirSync(path.join(dir, ".heming"), { recursive: true });
    writeFileSync(
      path.join(dir, ".heming", "permissions.json"),
      `\uFEFF${JSON.stringify({ deny: [{ tool: "run_command" }] })}`,
      "utf8",
    );
    const loaded = await loadCliWorkspaceRules(dir, false);
    if (!loaded || !loaded.ok) throw new Error("带 BOM 的规则应当能读");
    expect(loaded.rules.config.deny).toHaveLength(1);
  });

  it("同名路径是目录也算失败", async () => {
    const dir = tmpDir();
    mkdirSync(path.join(dir, ".heming", "permissions.json"), { recursive: true });
    const loaded = await loadCliWorkspaceRules(dir, false);
    expect(loaded && loaded.ok).toBe(false);
    if (!loaded || loaded.ok) throw new Error("应当失败");
    expect(loaded.error).toContain("不是文件");
  });
});

describe("describeCliWorkspaceRules", () => {
  it("报条目数、来源与 allow 是否生效；denyAll 单独点名", () => {
    const base = {
      config: {
        deny: [{ tool: "run_command" }],
        ask: [{ tool: "file_write" }],
        allow: [{ tool: "file_read" }, { tool: "file_glob" }],
      } as WorkspaceRulesConfig,
      source: ".heming/permissions.json",
      trusted: false,
      allowActive: false,
    };
    const untrusted = describeCliWorkspaceRules(base);
    expect(untrusted).toContain("deny 1 / ask 1 / allow 2");
    expect(untrusted).toContain("allow 未生效");
    expect(untrusted).toContain(".heming/permissions.json");

    const trusted = describeCliWorkspaceRules({ ...base, trusted: true, allowActive: true });
    expect(trusted).toContain("allow 已生效");

    const emergency = describeCliWorkspaceRules({
      ...base,
      config: { ...base.config, denyAll: true },
    });
    expect(emergency).toContain("denyAll");
  });
});

const ROOTS: FileRoot[] = [{ path: path.resolve("D:/work/proj").replace(/\\/g, "/"), mode: "write", name: "work" }];

function rulesOf(config: Partial<WorkspaceRulesConfig>, allowActive = false) {
  return {
    config: { allow: [], deny: [], ask: [], ...config } as WorkspaceRulesConfig,
    source: ".heming/permissions.json",
    trusted: allowActive,
    allowActive,
  };
}

function gateWith(options: {
  rules?: ReturnType<typeof rulesOf> | null;
  allowDanger?: boolean;
  risk?: Record<string, string>;
}) {
  return createCliGate({
    roots: () => ROOTS,
    allowDanger: options.allowDanger ?? false,
    metaOf: (name) => {
      const risk = options.risk?.[name];
      return risk ? { risk } : undefined;
    },
    rules: options.rules ?? null,
  });
}

const writeCall = (target: string) => ({
  id: "c1",
  function: { name: "file_write", arguments: JSON.stringify({ path: target, content: "x" }) },
});

describe("createCliGate × 工作区规则", () => {
  it("deny 规则挡掉本来会被放行的写", async () => {
    const gate = gateWith({
      risk: { file_write: "write" },
      rules: rulesOf({ deny: [{ tool: "file_write", path: "docs/**" }] }),
    });
    const [outcome] = await gate([writeCall("docs/readme.md")]);
    expect(outcome?.kind).toBe("deny");
    if (outcome?.kind !== "deny") throw new Error("应当拒绝");
    expect(outcome.reason).toContain("工作区权限规则拒绝");
    expect(outcome.cause).toBe("rule");
  });

  it("deny 也管命令：命令后缀命中就不跑（哪怕 --allow-danger）", async () => {
    const gate = gateWith({
      allowDanger: true,
      risk: { run_command: "danger" },
      rules: rulesOf({ deny: [{ tool: "run_command", command: "git push*" }] }),
    });
    const [outcome] = await gate([
      { id: "c1", function: { name: "run_command", arguments: JSON.stringify({ command: "git push origin main" }) } },
    ]);
    expect(outcome?.kind).toBe("deny");

    const allowed = await gate([
      { id: "c2", function: { name: "run_command", arguments: JSON.stringify({ command: "git status" }) } },
    ]);
    expect(allowed[0]?.kind).toBe("allow");
  });

  it("ask 规则落在 CLI 里就是拒绝，并说清为什么", async () => {
    const gate = gateWith({
      risk: { file_read: "read" },
      rules: rulesOf({ ask: [{ tool: "file_read" }] }),
    });
    const [outcome] = await gate([
      { id: "c1", function: { name: "file_read", arguments: JSON.stringify({ path: "src/a.ts" }) } },
    ]);
    expect(outcome?.kind).toBe("deny");
    if (outcome?.kind !== "deny") throw new Error("应当拒绝");
    expect(outcome.reason).toContain("没有人可以确认");
  });

  it("denyAll 是紧急开关：只读也拒", async () => {
    const gate = gateWith({ risk: { file_read: "read" }, rules: rulesOf({ denyAll: true }) });
    const [outcome] = await gate([
      { id: "c1", function: { name: "file_read", arguments: JSON.stringify({ path: "src/a.ts" }) } },
    ]);
    expect(outcome?.kind).toBe("deny");
  });

  it("allow 只有在信任后才放宽 danger 工具，且规则要写 allowDanger", async () => {
    const rules = (allowActive: boolean) =>
      rulesOf({ allow: [{ tool: "self_mcp_add_server", allowDanger: true }] }, allowActive);
    const call = { id: "c1", function: { name: "self_mcp_add_server", arguments: "{}" } };

    const untrusted = await gateWith({ risk: { self_mcp_add_server: "danger" }, rules: rules(false) })([call]);
    expect(untrusted[0]?.kind).toBe("deny");

    const trusted = await gateWith({ risk: { self_mcp_add_server: "danger" }, rules: rules(true) })([call]);
    expect(trusted[0]?.kind).toBe("allow");

    // 规则没写 allowDanger：信任了也不放宽 danger。
    const noFlag = await gateWith({
      risk: { self_mcp_add_server: "danger" },
      rules: rulesOf({ allow: [{ tool: "self_mcp_add_server" }] }, true),
    })([call]);
    expect(noFlag[0]?.kind).toBe("deny");
  });

  it("allow 不绕过写路径安全：工作区外的写照样被挡", async () => {
    const outside = path.resolve("D:/other/secret.txt").replace(/\\/g, "/");
    const gate = gateWith({
      risk: { file_write: "write" },
      rules: rulesOf({ allow: [{ tool: "file_write" }] }, true),
    });
    const [outcome] = await gate([writeCall(outside)]);
    expect(outcome?.kind).toBe("deny");
  });

  it("没有规则时行为不变（只读放行、写工具走路径判定）", async () => {
    const gate = gateWith({ risk: { file_read: "read", file_write: "write" } });
    const read = await gate([
      { id: "c1", function: { name: "file_read", arguments: JSON.stringify({ path: "src/a.ts" }) } },
    ]);
    expect(read[0]?.kind).toBe("allow");
    const ok = await gate([writeCall("src/a.ts")]);
    expect(ok[0]?.kind).toBe("allow");
  });
});
