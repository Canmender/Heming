import {
  BACKUP_PARTS,
  RESTORE_PARTS,
  backupArgs,
  defaultBackupParts,
  defaultRestoreParts,
  describeBackupParts,
  describeRestoreParts,
  restoreArgs,
} from "./magpieBackupParts.js";

describe("备份带上什么", () => {
  it("默认：带 Key、带技能库、不带登录", () => {
    expect(defaultBackupParts()).toEqual({ keys: true, library: true, signIns: false });
    // 默认那一条就是内核的默认：不带任何 flag。
    expect(backupArgs("C:\\b.backup", defaultBackupParts())).toEqual([
      "backup",
      "C:\\b.backup",
    ]);
  });

  it("只看人勾了什么，flag 由默认值反着推", () => {
    expect(backupArgs("b", { keys: false, library: true, signIns: false })).toEqual([
      "backup",
      "--no-keys",
      "b",
    ]);
    // 登录是「勾上才带」，所以这里翻成 --sign-ins。
    expect(backupArgs("b", { keys: true, library: true, signIns: true })).toEqual([
      "backup",
      "--sign-ins",
      "b",
    ]);
    expect(backupArgs("b", { keys: false, library: false, signIns: true })).toEqual([
      "backup",
      "--no-keys",
      "--no-library",
      "--sign-ins",
      "b",
    ]);
  });

  it("flag 的顺序固定：先 keys 再 library 最后 signIns，路径永远在最后", () => {
    const args = backupArgs("out.backup", { keys: false, library: false, signIns: true });
    expect(args.indexOf("--no-keys")).toBeLessThan(args.indexOf("--no-library"));
    expect(args.indexOf("--no-library")).toBeLessThan(args.indexOf("--sign-ins"));
    expect(args[args.length - 1]).toBe("out.backup");
  });

  it("每一块都在清单里，且各带一句说明", () => {
    expect(BACKUP_PARTS.map((part) => part.key)).toEqual(["keys", "library", "signIns"]);
    for (const part of BACKUP_PARTS) {
      expect(part.label.length).toBeGreaterThan(0);
      expect(part.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("恢复覆盖什么", () => {
  it("默认三样都恢复，一条 flag 都没有", () => {
    expect(defaultRestoreParts()).toEqual({ agents: true, library: true, signIns: true });
    expect(restoreArgs("C:\\b.backup", defaultRestoreParts())).toEqual([
      "restore",
      "C:\\b.backup",
    ]);
  });

  it("取消哪块就加对应的 --no-", () => {
    expect(restoreArgs("b", { agents: false, library: true, signIns: true })).toEqual([
      "restore",
      "--no-agents",
      "b",
    ]);
    expect(restoreArgs("b", { agents: true, library: false, signIns: false })).toEqual([
      "restore",
      "--no-library",
      "--no-sign-ins",
      "b",
    ]);
  });

  it("恢复这头的三块与备份那头不混：agents 只在恢复里有", () => {
    expect(RESTORE_PARTS.map((part) => part.key)).toEqual(["agents", "library", "signIns"]);
    expect(BACKUP_PARTS.some((part) => (part.key as string) === "agents")).toBe(false);
  });
});

describe("给一句人话", () => {
  it("新建备份：带／不带一眼看明白", () => {
    expect(describeBackupParts(defaultBackupParts())).toBe("带Key、带技能库、不带登录");
    expect(describeBackupParts({ keys: false, library: false, signIns: true })).toBe(
      "不带Key、不带技能库、带登录",
    );
  });

  it("恢复：覆盖／不覆盖", () => {
    expect(describeRestoreParts(defaultRestoreParts())).toBe("覆盖工具设置、覆盖技能库、覆盖登录");
    expect(describeRestoreParts({ agents: false, library: true, signIns: false })).toBe(
      "不覆盖工具设置、覆盖技能库、不覆盖登录",
    );
  });
});
