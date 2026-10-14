import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore, type Store } from "./store.js";
import { parseSeedUsers, seedUsers, seedUsersFromEnv } from "./seed.js";
import { verifyPassword } from "./app.js";

describe("parseSeedUsers", () => {
  it("解析 admin:admin,user2:pass2（displayName 默认 = username）", () => {
    expect(parseSeedUsers("admin:admin,user2:pass2")).toEqual([
      { username: "admin", password: "admin", displayName: "admin" },
      { username: "user2", password: "pass2", displayName: "user2" },
    ]);
  });

  it("容忍条目前后空格", () => {
    expect(parseSeedUsers(" alice:secret1 , bob:secret2 ")).toEqual([
      { username: "alice", password: "secret1", displayName: "alice" },
      { username: "bob", password: "secret2", displayName: "bob" },
    ]);
  });

  it.each([
    ["空串", ""],
    ["全空格", "   "],
    ["无冒号", "nocolon"],
    ["空用户名", ":pass"],
    ["空密码", "user:"],
    ["两个冒号（密码含冒号）", "a:b:c"],
    ["用户名过短", "ab:xyz123"],
    ["用户名含非法字符", "a b:xyz123"],
    ["尾随逗号", "alice:secret1,"],
  ])("非法输入抛错：%s", (_label, spec) => {
    expect(() => parseSeedUsers(spec)).toThrow();
  });
});

describe("seedUsers", () => {
  let store: Store;
  beforeEach(() => {
    store = createMemoryStore();
  });

  it("幂等：跑两次账号数不变（第二次全部跳过），密码可登录", () => {
    const users = parseSeedUsers("admin:admin123,user2:pass123");
    const first = seedUsers(store, users);
    expect(first.created).toEqual(["admin", "user2"]);
    expect(first.skipped).toEqual([]);

    const second = seedUsers(store, users);
    expect(second.created).toEqual([]);
    expect(second.skipped).toEqual(["admin", "user2"]);

    const row = store.findUserByUsername("admin");
    expect(row?.user.displayName).toBe("admin");
    expect(row && verifyPassword("admin123", row.passwordHash)).toBe(true);
    expect(store.findUserByUsername("user2")).not.toBeNull();
  });

  it("已存在的用户跳过，不覆盖密码与昵称", () => {
    store.createUser("alice", "old-hash", "旧名");
    const r = seedUsers(store, parseSeedUsers("alice:newpass123"));
    expect(r).toEqual({ created: [], skipped: ["alice"] });
    const row = store.findUserByUsername("alice")!;
    expect(row.passwordHash).toBe("old-hash");
    expect(row.user.displayName).toBe("旧名");
  });
});

describe("seedUsersFromEnv", () => {
  let store: Store;
  let logs: string[];
  beforeEach(() => {
    store = createMemoryStore();
    logs = [];
  });
  const log = (msg: string) => logs.push(msg);

  it("未设置/空 spec 不播种也不告警", () => {
    seedUsersFromEnv(store, undefined, log);
    seedUsersFromEnv(store, "", log);
    seedUsersFromEnv(store, "   ", log);
    expect(logs).toEqual([]);
    expect(store.findUserByUsername("admin")).toBeNull();
  });

  it("合法 spec 播种并记录 created", () => {
    seedUsersFromEnv(store, "admin:admin123", log);
    expect(store.findUserByUsername("admin")).not.toBeNull();
    expect(logs.join("\n")).toContain("created=admin");
  });

  it("非法 spec 打日志警告不崩溃、不播种", () => {
    expect(() => seedUsersFromEnv(store, "badspec", log)).not.toThrow();
    expect(logs.join("\n")).toContain("invalid HEMING_SEED_USERS");
    expect(store.findUserByUsername("badspec")).toBeNull();
  });

  it("密码长度不合规（<6，无法通过登录校验）仍播种但告警", () => {
    seedUsersFromEnv(store, "admin:admin", log);
    expect(store.findUserByUsername("admin")).not.toBeNull();
    expect(logs.join("\n")).toContain("admin");
    expect(logs.join("\n")).toMatch(/无法登录|login/);
  });
});
