import { describe, expect, it } from "vitest";
import { assessPatchSafety } from "./safety.js";
import type { FileRoot } from "./paths.js";

const WRITE: FileRoot = { name: "库", path: "D:/Obsidian/学院事务", mode: "write" };
const READ: FileRoot = { name: "参考", path: "D:/参考", mode: "read" };

describe("补丁三态安全判定", () => {
  it("全部目标在写根内、无删除 → AutoApprove", () => {
    const result = assessPatchSafety({
      targets: ["D:/Obsidian/学院事务/a.md", "D:/Obsidian/学院事务/notes/b.md"],
      deletions: 0,
      roots: [WRITE],
    });
    expect(result.verdict).toBe("auto");
  });

  it("目标在写根外 → 默认 AskUser（并说明是哪几个）", () => {
    const result = assessPatchSafety({
      targets: ["D:/别处/a.md"],
      deletions: 0,
      roots: [WRITE],
    });
    expect(result.verdict).toBe("ask");
    expect(result.reason).toContain("不在可写根内");
    // 必须给出出路（Lead 定稿文案）：只说「不能写」等于让用户去猜
    expect(result.reason).toContain("设置 → 文件编辑");
  });

  it("配置成 reject 时越界直接拒绝", () => {
    const result = assessPatchSafety({
      targets: ["D:/别处/a.md"],
      deletions: 0,
      roots: [WRITE],
      outOfRoot: "reject",
    });
    expect(result.verdict).toBe("reject");
    expect(result.reason).toContain("已按设置拒绝");
  });

  it("目标在只读根内 → Reject（mode=read 就是不许写，问也没用）", () => {
    const result = assessPatchSafety({
      targets: ["D:/参考/a.md"],
      deletions: 0,
      roots: [WRITE, READ],
    });
    expect(result.verdict).toBe("reject");
    expect(result.reason).toContain("只读根");
  });

  it("只读根的拒绝优先于「含删除要先问」", () => {
    const result = assessPatchSafety({
      targets: ["D:/参考/a.md"],
      deletions: 3,
      roots: [READ],
    });
    expect(result.verdict).toBe("reject");
  });

  it("含删除语义时即使全在写根内也要问（删除不可逆）", () => {
    const result = assessPatchSafety({
      targets: ["D:/Obsidian/学院事务/a.md"],
      deletions: 1,
      roots: [WRITE],
    });
    expect(result.verdict).toBe("ask");
    expect(result.reason).toContain("删除");
  });

  it("没有配置任何根 → Reject，并指出先加写根", () => {
    const result = assessPatchSafety({ targets: ["D:/a/b.md"], deletions: 0, roots: [] });
    expect(result.verdict).toBe("reject");
    expect(result.reason).toContain("设置 → 文件编辑");
  });

  it("没有目标 → Reject", () => {
    expect(assessPatchSafety({ targets: [], deletions: 0, roots: [WRITE] }).verdict).toBe("reject");
  });

  it("同前缀不同目录不算在根内", () => {
    const result = assessPatchSafety({
      targets: ["D:/Obsidian/学院事务二/a.md"],
      deletions: 0,
      roots: [WRITE],
    });
    expect(result.verdict).toBe("ask");
  });
});

describe("硬排除（ADR-3 / P2-T13）", () => {
  it("写可执行脚本即使在写根内也要问（.bat/.ps1/.cmd/.vbs/.exe 全列）", () => {
    for (const ext of [".bat", ".ps1", ".cmd", ".vbs", ".exe"]) {
      const result = assessPatchSafety({
        targets: [`D:/Obsidian/学院事务/evil${ext}`],
        deletions: 0,
        roots: [WRITE],
      });
      expect(result.verdict, ext).toBe("ask");
      expect(result.reason, ext).toContain("可执行脚本");
    }
  });

  it("大小写不敏感：EVIL.BAT 一样要问", () => {
    const result = assessPatchSafety({
      targets: ["D:/Obsidian/学院事务/EVIL.BAT"],
      deletions: 0,
      roots: [WRITE],
    });
    expect(result.verdict).toBe("ask");
  });

  it("改 package.json / 锁文件要问（脚本链路）", () => {
    for (const name of ["package.json", "pnpm-lock.yaml"]) {
      const result = assessPatchSafety({
        targets: [`D:/Obsidian/学院事务/${name}`],
        deletions: 0,
        roots: [WRITE],
      });
      expect(result.verdict, name).toBe("ask");
      expect(result.reason, name).toContain("依赖/构建/测试");
    }
  });

  it("普通文本文件不触发硬排除（不误伤）", () => {
    for (const name of ["notes/a.md", "报告.txt", "batch.md", "package.json.md"]) {
      const result = assessPatchSafety({
        targets: [`D:/Obsidian/学院事务/${name}`],
        deletions: 0,
        roots: [WRITE],
      });
      expect(result.verdict, name).toBe("auto");
    }
  });

  it("硬排除不放松已有判定：只读根仍是 reject，优先于硬排除的 ask", () => {
    const result = assessPatchSafety({
      targets: ["D:/参考/evil.bat"],
      deletions: 0,
      roots: [WRITE, READ],
    });
    expect(result.verdict).toBe("reject");
  });
});
