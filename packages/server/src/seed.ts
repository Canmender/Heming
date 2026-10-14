import type { Store } from "./store.js";
import { hashPassword } from "./app.js";

export interface SeedUser {
  username: string;
  password: string;
  displayName: string;
}

/** 用户名与注册规则对齐（3-32 位字母数字下划线），保证播种账号可通过登录接口。 */
const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

/**
 * 解析 HEMING_SEED_USERS："admin:admin,user2:pass2"
 * 每条恰为 user:pass（密码内不含冒号，故用 indexOf 取第一个冒号并禁止第二个），
 * displayName 默认 = username。任何一条非法即整体抛错（调用方负责告警降级）。
 * 注意：不校验密码长度——部署示例可能使用短密码；不合规者由 seedUsersFromEnv 告警。
 */
export function parseSeedUsers(spec: string): SeedUser[] {
  if (spec.trim() === "") throw new Error("empty spec");
  return spec.split(",").map((raw) => {
    const entry = raw.trim();
    if (entry === "") throw new Error("empty entry");
    const colon = entry.indexOf(":");
    if (colon <= 0) throw new Error(`invalid entry: ${entry}`);
    const username = entry.slice(0, colon).trim();
    const password = entry.slice(colon + 1).trim();
    if (password === "" || password.includes(":")) throw new Error(`invalid entry: ${entry}`);
    if (!USERNAME_RE.test(username)) throw new Error(`invalid username: ${username}`);
    return { username, password, displayName: username };
  });
}

/**
 * 幂等播种：用户已存在则跳过（不覆盖密码/昵称）。返回 created/skipped 的用户名列表。
 * 密码复用 app.ts 的 hashPassword（与注册路径同一散列格式）。
 */
export function seedUsers(
  store: Store,
  users: SeedUser[],
): { created: string[]; skipped: string[] } {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const u of users) {
    if (store.findUserByUsername(u.username)) {
      skipped.push(u.username);
      continue;
    }
    store.createUser(u.username, hashPassword(u.password), u.displayName);
    created.push(u.username);
  }
  return { created, skipped };
}

/**
 * 读 HEMING_SEED_USERS 并播种。未设置/空白则不播种；
 * 解析失败打警告日志且不抛出（进程不崩）。log 可注入便于测试。
 */
export function seedUsersFromEnv(
  store: Store,
  spec: string | undefined,
  log: (msg: string) => void = console.log,
): void {
  if (!spec || spec.trim() === "") return;
  try {
    const users = parseSeedUsers(spec);
    const { created, skipped } = seedUsers(store, users);
    log(`seed: created=${created.join(",") || "-"} skipped=${skipped.join(",") || "-"}`);
  } catch (e) {
    log(`seed: invalid HEMING_SEED_USERS ignored: ${(e as Error).message}`);
  }
}
