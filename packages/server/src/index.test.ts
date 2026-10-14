import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startServer } from "./index.js";

const ENV = "HEMING_SEED_USERS";
let ctx: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  process.env[ENV] = "root:rootpass1";
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
