import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { startServer } from "./index.js";

const ENV = "HEMING_SEED_USERS";
let ctx: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  // admin:admin 刻意为 5 位短密码：登录端不规定密码策略，播种账号须可登录。
  process.env[ENV] = "root:rootpass1,admin:admin";
  ctx = await startServer(0);
});

afterAll(async () => {
  await ctx.close();
  delete process.env[ENV];
});

describe("startServer 环境变量播种接线", () => {
  it("HEMING_SEED_USERS 账号可登录，displayName 默认 = username", async () => {
    const login = await request(ctx.server)
      .post("/api/auth/login")
      .send({ username: "root", password: "rootpass1" });
    expect(login.status).toBe(200);
    expect(login.body.user.username).toBe("root");
    expect(login.body.user.displayName).toBe("root");
  });

  it("5 位短密码播种账号（admin/admin）可登录并拿到 token", async () => {
    const login = await request(ctx.server)
      .post("/api/auth/login")
      .send({ username: "admin", password: "admin" });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
    expect(login.body.user.username).toBe("admin");
  });

  it("未设 HEMING_ALLOW_REGISTER 时注册仍关闭", async () => {
    const res = await request(ctx.server).post("/api/auth/register").send({
      username: "eve2",
      password: "secret123",
      displayName: "Eve",
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "registration disabled" });
  });
});

describe("HOST 绑定地址可配（容器内 0.0.0.0 供 nginx 访问）", () => {
  let savedHost: string | undefined;

  beforeEach(() => {
    savedHost = process.env.HOST;
    delete process.env.HOST;
  });
  afterEach(() => {
    if (savedHost === undefined) delete process.env.HOST;
    else process.env.HOST = savedHost;
  });

  function boundAddress(c: Awaited<ReturnType<typeof startServer>>): string {
    const addr = c.server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("server not listening");
    return addr.address;
  }

  it("未设 HOST 时默认绑定 127.0.0.1（本地安全默认不变）", async () => {
    const c = await startServer(0);
    try {
      expect(boundAddress(c)).toBe("127.0.0.1");
    } finally {
      await c.close();
    }
  });

  it("HOST=0.0.0.0 时绑定全网卡，且 loopback 仍可访问", async () => {
    process.env.HOST = "0.0.0.0";
    const c = await startServer(0);
    try {
      expect(boundAddress(c)).toBe("0.0.0.0");
      const res = await request(c.server).get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    } finally {
      await c.close();
    }
  });

  it("HOST 空串视为未设置（回落 127.0.0.1）", async () => {
    process.env.HOST = "   ";
    const c = await startServer(0);
    try {
      expect(boundAddress(c)).toBe("127.0.0.1");
    } finally {
      await c.close();
    }
  });
});
