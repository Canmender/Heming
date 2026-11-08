import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createMemoryStore } from "./store.js";
import { createApp } from "./app.js";
import { checkDownloadUrl, createSkillHubRouter, type SkillHubRouterOptions } from "./skillHub.js";

/**
 * 技能社区代理（d.109/d.110）：归一化 / 分页 / 失败映射 / 下载解包 / Key 校验 / 注册透传 /
 * SSRF 防护 / 上游 TTL 缓存。
 *
 * 全部用注入的假上游（`fetchImpl`）与注入时钟（`now`），不打真实网络、不真的等待；zip 由测试手工构造。
 */

const BASE = "https://hub.test";
const KEY = "sk_live_12345678";

interface MockResult {
  status?: number;
  body?: unknown;
  bytes?: Buffer;
  headers?: Record<string, string>;
}

interface MockCall {
  url: string;
  init?: RequestInit;
}

function makeFetch(handler: (url: string, init?: RequestInit) => MockResult) {
  const calls: MockCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: string }).url ?? input);
    calls.push({ url, init });
    const result = handler(url, init);
    if (result.bytes) {
      return new Response(new Uint8Array(result.bytes), {
        status: result.status ?? 200,
        headers: result.headers,
      });
    }
    return new Response(JSON.stringify(result.body ?? null), {
      status: result.status ?? 200,
      headers: { "content-type": "application/json", ...(result.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeApp(
  fetchImpl: typeof fetch,
  enabled = true,
  options: Pick<SkillHubRouterOptions, "allowHttp" | "now"> = {},
) {
  const app = express();
  app.use(express.json());
  app.use("/api/skill-hub", createSkillHubRouter({ baseUrl: BASE, enabled, fetchImpl, ...options }));
  return app;
}

function rawSkill(overrides: Record<string, unknown> = {}) {
  return {
    id: "8ccc5b0c-3a5f-4a3b-9158-8c822927b7dd",
    name: "全网新闻聚合助手",
    description: "新闻聚合",
    trigger: ["news", "全网新闻"],
    category: ["资讯阅读"],
    tags: ["新闻", "资讯"],
    owner_name: "科尔沁可汗虾",
    current_version: "1.0.0",
    downloads: 32012,
    avg_stars: 490,
    star_count: 3405,
    status: "official",
    security_status: "safe",
    requires_api_key: null,
    updated_at: "2026-11-08T04:33:58.936+08:00",
    is_featured: false,
    ...overrides,
  };
}

interface ZipInput {
  name: string;
  data?: Buffer;
  method?: 0 | 8;
}

/** 最小 zip 构造（与 zip.test.ts 同构；不校验 CRC）。 */
function makeZip(entries: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

const skillZip = () =>
  makeZip([
    { name: "SKILL.md", data: Buffer.from("---\nname: 新闻技能\n---\n\n# 用法\n正文", "utf8") },
    { name: "scripts/run.py", data: Buffer.from("print(1)", "utf8") },
  ]);

describe("GET /api/skill-hub（状态）", () => {
  it("分类可用：enabled/reachable/categories 与 source 元信息", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      body: { success: true, data: ["效率工具", "数据分析"] },
    }));
    const res = await request(makeApp(fetchImpl)).get("/api/skill-hub");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      reachable: true,
      categories: ["效率工具", "数据分析"],
      source: { id: "xiaping", name: "虾评" },
    });
    expect(calls[0].url).toBe(`${BASE}/api/categories`);
  });

  it("分类接口失败：不阻塞，reachable=false + 空分类", async () => {
    const { fetchImpl } = makeFetch(() => {
      throw new Error("network down");
    });
    const res = await request(makeApp(fetchImpl)).get("/api/skill-hub");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, reachable: false, categories: [] });
  });

  it("HEMING_SKILL_HUB=off 语义：enabled=false，其它接口 503", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ body: { success: true, data: [] } }));
    const app = makeApp(fetchImpl, false);
    const status = await request(app).get("/api/skill-hub");
    expect(status.body).toMatchObject({ enabled: false, reachable: false, categories: [] });
    expect((await request(app).get("/api/skill-hub/skills")).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe("GET /api/skill-hub/skills（列表）", () => {
  it("归一化上游字段 + 分页参数夹紧（limit 1–30）", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      body: {
        skills: [rawSkill(), rawSkill({ id: "", name: "坏条目" })],
        total: 42,
        hasMore: true,
      },
    }));
    const res = await request(makeApp(fetchImpl))
      .get("/api/skill-hub/skills")
      .query({ page: "2", limit: "999", search: "新闻", category: "资讯阅读", sort: "downloads" });

    expect(res.status).toBe(200);
    const upstreamUrl = new URL(calls[0].url);
    expect(upstreamUrl.origin + upstreamUrl.pathname).toBe(`${BASE}/api/skills`);
    expect(upstreamUrl.searchParams.get("page")).toBe("2");
    expect(upstreamUrl.searchParams.get("limit")).toBe("30");
    expect(upstreamUrl.searchParams.get("search")).toBe("新闻");
    expect(upstreamUrl.searchParams.get("category")).toBe("资讯阅读");
    expect(upstreamUrl.searchParams.get("sort")).toBe("downloads");

    expect(res.body.skills).toHaveLength(1); // 缺 id 的坏条目被跳过
    expect(res.body.skills[0]).toMatchObject({
      id: "8ccc5b0c-3a5f-4a3b-9158-8c822927b7dd",
      name: "全网新闻聚合助手",
      triggers: ["news", "全网新闻"],
      categories: ["资讯阅读"],
      tags: ["新闻", "资讯"],
      ownerName: "科尔沁可汗虾",
      version: "1.0.0",
      downloads: 32012,
      stars: 3405, // star_count，不是 avg_stars
      status: "official",
      requiresApiKey: false, // 上游 null → false
      featured: false,
    });
    expect(res.body.total).toBe(42);
    expect(res.body.hasMore).toBe(true);
    expect(Number.isNaN(Date.parse(res.body.fetchedAt))).toBe(false);
  });

  it("limit 缺省 20；page 非法回落到 1", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ body: { skills: [], total: 0 } }));
    const res = await request(makeApp(fetchImpl)).get("/api/skill-hub/skills?page=abc&limit=0");
    expect(res.status).toBe(200);
    const upstreamUrl = new URL(calls[0].url);
    expect(upstreamUrl.searchParams.get("page")).toBe("1");
    expect(upstreamUrl.searchParams.get("limit")).toBe("20");
  });

  it("上游 500 / 网络错误 → 502 + 中文错误", async () => {
    const bad = makeFetch(() => ({ status: 500, body: { success: false } }));
    const res1 = await request(makeApp(bad.fetchImpl)).get("/api/skill-hub/skills");
    expect(res1.status).toBe(502);
    expect(res1.body.error).toContain("技能社区暂时不可用");

    const thrown = makeFetch(() => {
      throw new Error("timeout");
    });
    const res2 = await request(makeApp(thrown.fetchImpl)).get("/api/skill-hub/skills");
    expect(res2.status).toBe(502);
  });

  it("上游 200 + success:false 也算失败（虾评约定）", async () => {
    const { fetchImpl } = makeFetch(() => ({ body: { success: false, error: "限流中" } }));
    const res = await request(makeApp(fetchImpl)).get("/api/skill-hub/skills");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("限流中");
  });
});

describe("GET /api/skill-hub/skills/:id（详情）", () => {
  it("补 created/versionCount/security/homepage 字段", async () => {
    const { fetchImpl } = makeFetch(() => ({
      body: {
        success: true,
        data: rawSkill({
          created_at: "2026-03-10T13:03:58.343762+08:00",
          version_count: 3,
          security_status: "safe",
          security_report: "## 安全报告\n无风险",
        }),
      },
    }));
    const res = await request(makeApp(fetchImpl)).get(
      "/api/skill-hub/skills/8ccc5b0c-3a5f-4a3b-9158-8c822927b7dd",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "8ccc5b0c-3a5f-4a3b-9158-8c822927b7dd",
      versionCount: 3,
      securityStatus: "safe",
      securityReport: "## 安全报告\n无风险",
      createdAt: "2026-03-10T13:03:58.343762+08:00",
    });
  });

  it("上游 404 → 404；坏 id → 400", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ status: 404, body: { success: false } }));
    const app = makeApp(fetchImpl);
    const missing = await request(app).get("/api/skill-hub/skills/not-found-id");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain("技能不存在");

    const badId = await request(app).get(`/api/skill-hub/skills/${encodeURIComponent("a/b")}`);
    expect(badId.status).toBe(400);
    expect(calls).toHaveLength(1); // 坏 id 不打上游
  });

  it("homepage 只保留 http(s)：javascript:/data:/ftp:/相对地址一律丢弃", async () => {
    const cases: Array<[unknown, boolean]> = [
      ["https://xiaping.coze.com/skills/abc", true],
      ["http://example.com/x", true],
      ["javascript:alert(1)", false],
      ["data:text/html,<script>alert(1)</script>", false],
      ["ftp://example.com/x", false],
      ["/relative/path", false],
      ["", false],
      [null, false],
    ];
    for (const [homepage, kept] of cases) {
      const { fetchImpl } = makeFetch(() => ({
        body: { success: true, data: rawSkill({ homepage }) },
      }));
      const res = await request(makeApp(fetchImpl)).get("/api/skill-hub/skills/abc");
      expect(res.status).toBe(200);
      if (kept) expect(res.body.homepage).toBe(homepage);
      else expect(res.body).not.toHaveProperty("homepage");
    }
  });
});

describe("GET /api/skill-hub/skills/:id/download（下载 + 解包）", () => {
  const okUpstream = (zip: Buffer) =>
    makeFetch((url) => {
      if (url.endsWith("/download")) {
        return {
          body: {
            success: true,
            data: { download_url: "https://cdn.test/pack.zip", version: "2.0.0", coins_spent: 2 },
          },
        };
      }
      return { bytes: zip };
    });

  it("无 Key / 非法 Key → 401，且不请求上游", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ body: { success: true, data: {} } }));
    const app = makeApp(fetchImpl);
    const none = await request(app).get("/api/skill-hub/skills/abc/download");
    expect(none.status).toBe(401);
    expect(none.body.error).toContain("需要先在虾评注册并填写 API Key");
    const bad = await request(app)
      .get("/api/skill-hub/skills/abc/download")
      .set("x-skill-hub-key", "sk bad key");
    expect(bad.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("成功：带 Bearer 拉下载地址 → 下载 zip → 解出 SKILL.md 与文件清单", async () => {
    const zip = skillZip();
    const { fetchImpl, calls } = okUpstream(zip);
    const res = await request(makeApp(fetchImpl))
      .get("/api/skill-hub/skills/8ccc5b0c-3a5f-4a3b-9158-8c822927b7dd/download")
      .set("x-skill-hub-key", KEY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      skillId: "8ccc5b0c-3a5f-4a3b-9158-8c822927b7dd",
      name: "新闻技能",
      version: "2.0.0",
      size: zip.length,
      zipSha256: createHash("sha256").update(zip).digest("hex"),
      files: [{ path: "scripts/run.py", size: 8 }],
    });
    expect(res.body.skillMd).toContain("# 用法");
    expect(res.body.skillMd).not.toContain("print(1)");

    // Key 只出现在发给上游的 Authorization 头里，且不在 URL/响应里
    const downloadCall = calls[0];
    expect(downloadCall.url).toBe(
      `${BASE}/api/skills/8ccc5b0c-3a5f-4a3b-9158-8c822927b7dd/download`,
    );
    expect(new Headers(downloadCall.init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(calls[1].url).toBe("https://cdn.test/pack.zip");
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it("上游 401/402/403 透传成中文可读错误", async () => {
    const cases: Array<[number, string]> = [
      [401, "Key 无效"],
      [402, "代币不足"],
      [403, "拒绝"],
    ];
    for (const [status, keyword] of cases) {
      const { fetchImpl } = makeFetch(() => ({ status, body: { success: false } }));
      const res = await request(makeApp(fetchImpl))
        .get("/api/skill-hub/skills/abc/download")
        .set("x-skill-hub-key", KEY);
      expect(res.status).toBe(status);
      expect(res.body.error).toContain(keyword);
    }
  });

  it("zip 超过 5MB → 413", async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    const res = await request(makeApp(okUpstream(big).fetchImpl))
      .get("/api/skill-hub/skills/abc/download")
      .set("x-skill-hub-key", KEY);
    expect(res.status).toBe(413);
  });

  it("zip 里没有 SKILL.md / 路径穿越 / 坏 zip → 502", async () => {
    const noSkill = makeZip([{ name: "README.md", data: Buffer.from("x") }]);
    const res1 = await request(makeApp(okUpstream(noSkill).fetchImpl))
      .get("/api/skill-hub/skills/abc/download")
      .set("x-skill-hub-key", KEY);
    expect(res1.status).toBe(502);
    expect(res1.body.error).toContain("没有 SKILL.md");

    const traversal = makeZip([{ name: "../evil.txt", data: Buffer.from("x") }]);
    const res2 = await request(makeApp(okUpstream(traversal).fetchImpl))
      .get("/api/skill-hub/skills/abc/download")
      .set("x-skill-hub-key", KEY);
    expect(res2.status).toBe(502);
    expect(res2.body.error).toContain("不安全的文件路径");

    const res3 = await request(makeApp(okUpstream(Buffer.from("not a zip")).fetchImpl))
      .get("/api/skill-hub/skills/abc/download")
      .set("x-skill-hub-key", KEY);
    expect(res3.status).toBe(502);
    expect(res3.body.error).toContain("无法解析");
  });
});

describe("POST /api/skill-hub/register（注册）", () => {
  const CLIENT_HEADER = "x-heming-client";

  function postRegister(app: ReturnType<typeof makeApp>, body: unknown) {
    return request(app).post("/api/skill-hub/register").set(CLIENT_HEADER, "1").send(body);
  }

  it("成功：只回 Key 与上游最终用户名", async () => {
    let sentBody: unknown;
    const { fetchImpl } = makeFetch((_url, init) => {
      sentBody = init?.body ? JSON.parse(String(init.body)) : null;
      return {
        body: {
          success: true,
          data: {
            user: { name: "可爱的测试Agent", api_key: "sk_abc12345" },
            api_key: "sk_abc12345",
          },
        },
      };
    });
    const res = await postRegister(makeApp(fetchImpl), { name: "测试Agent" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ apiKey: "sk_abc12345", name: "可爱的测试Agent" });
    expect(sentBody).toEqual({ name: "测试Agent" });
  });

  it("名称不合法 → 400，且不打上游", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ body: { success: true, data: {} } }));
    const app = makeApp(fetchImpl);
    for (const name of ["", "   ", "bad<script>", "x".repeat(129)]) {
      const res = await postRegister(app, { name });
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("上游 429 原样分类；400 带上游错误文案", async () => {
    const limited = makeFetch(() => ({ status: 429, body: { success: false } }));
    const res1 = await postRegister(makeApp(limited.fetchImpl), { name: "测试Agent" });
    expect(res1.status).toBe(429);

    const rejected = makeFetch(() => ({ status: 400, body: { success: false, error: "用户名含敏感词" } }));
    const res2 = await postRegister(makeApp(rejected.fetchImpl), { name: "测试Agent" });
    expect(res2.status).toBe(400);
    expect(res2.body.error).toBe("用户名含敏感词");
  });

  it("缺少 x-heming-client 头 → 403「仅限和鸣客户端调用」，且不打上游", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      body: { success: true, data: { api_key: "sk_abc12345" } },
    }));
    const res = await request(makeApp(fetchImpl))
      .post("/api/skill-hub/register")
      .send({ name: "测试Agent" });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("仅限和鸣客户端");
    expect(calls).toHaveLength(0);
  });

  it("带自定义头但 Origin 不是本机 → 403；本机 Origin 放行", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      body: { success: true, data: { user: { name: "测试Agent" }, api_key: "sk_abc12345" } },
    }));
    const app = makeApp(fetchImpl);

    const evil = await request(app)
      .post("/api/skill-hub/register")
      .set(CLIENT_HEADER, "1")
      .set("origin", "https://evil.example.com")
      .send({ name: "测试Agent" });
    expect(evil.status).toBe(403);
    expect(calls).toHaveLength(0);

    const local = await request(app)
      .post("/api/skill-hub/register")
      .set(CLIENT_HEADER, "1")
      .set("origin", "http://localhost:5173")
      .send({ name: "测试Agent" });
    expect(local.status).toBe(200);
    expect(calls).toHaveLength(1);

    // 同源（远端部署的 Web 版）：Origin 与 Host 一致视为已知来源
    const sameOrigin = await request(app)
      .post("/api/skill-hub/register")
      .set(CLIENT_HEADER, "1")
      .set("host", "heming.example.com")
      .set("origin", "https://heming.example.com")
      .send({ name: "测试Agent" });
    expect(sameOrigin.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("本机限流：10 分钟内第 6 次 → 429，窗口滑过后恢复", async () => {
    let clockNow = Date.parse("2026-11-08T10:00:00.000Z");
    let registerCalls = 0;
    const { fetchImpl } = makeFetch((url) => {
      if (!url.endsWith("/api/auth/register")) {
        return { body: { success: true, skills: [], total: 0 } }; // 列表接口不参与计数
      }
      registerCalls += 1;
      return {
        body: { success: true, data: { user: { name: "测试Agent" }, api_key: "sk_abc12345" } },
      };
    });
    const app = makeApp(fetchImpl, true, { now: () => clockNow });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await postRegister(app, { name: "测试Agent" });
      expect(res.status, `第 ${attempt} 次`).toBe(200);
    }
    expect(registerCalls).toBe(5);

    const sixth = await postRegister(app, { name: "测试Agent" });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toContain("创建账号过于频繁");
    expect(registerCalls).toBe(5); // 限流后不打上游

    // 限流不影响其它接口
    expect((await request(app).get("/api/skill-hub/skills")).status).toBe(200);

    // 10 分钟窗口滑过后恢复
    clockNow += 10 * 60 * 1000 + 1;
    const afterWindow = await postRegister(app, { name: "测试Agent" });
    expect(afterWindow.status).toBe(200);
    expect(registerCalls).toBe(6);
  });
});

describe("app 挂载（HEMING_SKILL_HUB）", () => {
  const saved = process.env.HEMING_SKILL_HUB;
  afterEach(() => {
    if (saved === undefined) delete process.env.HEMING_SKILL_HUB;
    else process.env.HEMING_SKILL_HUB = saved;
  });

  it("环境变量 off 时 /api/skill-hub 返回 enabled:false（不触网）", async () => {
    process.env.HEMING_SKILL_HUB = "off";
    const app = createApp(createMemoryStore());
    const res = await request(app).get("/api/skill-hub");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, reachable: false, categories: [] });
    expect((await request(app).get("/api/skill-hub/skills")).status).toBe(503);
  });
});

describe("上游 base URL", () => {
  it("只接受 http(s)；非法值回落到官方默认域名", async () => {
    const { fetchImpl } = makeFetch(() => ({ body: { success: true, data: [] } }));
    const app = express();
    app.use(express.json());
    app.use(
      "/api/skill-hub",
      createSkillHubRouter({ baseUrl: "file:///etc/passwd", enabled: true, fetchImpl }),
    );
    const res = await request(app).get("/api/skill-hub/skills");
    expect(res.status).toBe(200);
  });
});

describe("SSRF: checkDownloadUrl（下载地址第一道闸）", () => {
  const blocked = [
    "http://cdn.test/pack.zip", // 默认拒绝 http
    "https://localhost/pack.zip",
    "https://foo.localhost/pack.zip",
    "https://127.0.0.1/pack.zip",
    "https://127.8.9.10/pack.zip",
    "https://10.1.2.3/pack.zip",
    "https://172.16.0.9/pack.zip",
    "https://172.31.255.1/pack.zip",
    "https://192.168.1.1/pack.zip",
    "https://169.254.169.254/latest/meta-data",
    "https://0.0.0.0/pack.zip",
    "https://[::1]/pack.zip",
    "https://[fc00::1]/pack.zip",
    "https://[fe80::1]/pack.zip",
    "https://[::ffff:127.0.0.1]/pack.zip",
    "https://[::ffff:169.254.169.254]/pack.zip",
    "https://user:pass@cdn.test/pack.zip",
    "ftp://cdn.test/pack.zip",
    "file:///etc/passwd",
    "not-a-url",
  ];

  it("回环/私网/链路本地/元数据/账号信息/非 https 一律拒绝", () => {
    for (const url of blocked) {
      const checked = checkDownloadUrl(url);
      expect(checked.ok, url).toBe(false);
    }
  });

  it("公网 https 放行；http 仅在显式开启时放行", () => {
    const ok = checkDownloadUrl("https://cdn.test/pack.zip");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.url.hostname).toBe("cdn.test");

    expect(checkDownloadUrl("http://cdn.test/pack.zip")).toMatchObject({ ok: false });
    expect(checkDownloadUrl("http://cdn.test/pack.zip", { allowHttp: true }).ok).toBe(true);
    // 172.32/12 之外的地址不是私网
    expect(checkDownloadUrl("https://172.32.0.1/pack.zip").ok).toBe(true);
    expect(checkDownloadUrl("https://8.8.8.8/pack.zip").ok).toBe(true);
  });
});

describe("SSRF: 下载路由（内网地址/重定向/次数上限）", () => {
  const meta = (downloadUrl: string) => ({
    body: { success: true, data: { download_url: downloadUrl, version: "1.0.0" } },
  });

  it("上游给内网/非 https 下载地址：502「下载地址不安全，已拒绝」且不发请求", async () => {
    for (const downloadUrl of [
      "http://localhost/pack.zip",
      "https://127.0.0.1/pack.zip",
      "https://10.0.0.5/pack.zip",
      "https://169.254.169.254/latest/meta-data",
      "https://user:pa@cdn.test/pack.zip",
      "https://[::1]/pack.zip",
    ]) {
      const { fetchImpl, calls } = makeFetch(() => meta(downloadUrl));
      const res = await request(makeApp(fetchImpl))
        .get("/api/skill-hub/skills/abc/download")
        .set("x-skill-hub-key", KEY);
      expect(res.status, downloadUrl).toBe(502);
      expect(res.body.error).toContain("下载地址不安全，已拒绝");
      // 只有「取下载地址」这一跳；被拒的地址根本没有被 fetch
      expect(calls.map((call) => call.url)).toEqual([`${BASE}/api/skills/abc/download`]);
    }
  });

  it("HEMING_SKILL_HUB_ALLOW_HTTP 语义（注入 allowHttp=true）：http 下载地址可用", async () => {
    const zip = skillZip();
    const { fetchImpl, calls } = makeFetch((url) =>
      url.endsWith("/download")
        ? meta("http://cdn.test/pack.zip")
        : { bytes: zip },
    );
    const res = await request(makeApp(fetchImpl, true, { allowHttp: true }))
      .get("/api/skill-hub/skills/abc/download")
      .set("x-skill-hub-key", KEY);
    expect(res.status).toBe(200);
    expect(calls[1].url).toBe("http://cdn.test/pack.zip");
  });

  it("HEMING_SKILL_HUB_ALLOW_HTTP=1 环境变量开启 http 下载", async () => {
    const saved = process.env.HEMING_SKILL_HUB_ALLOW_HTTP;
    process.env.HEMING_SKILL_HUB_ALLOW_HTTP = "1";
    try {
      const zip = skillZip();
      const { fetchImpl } = makeFetch((url) =>
        url.endsWith("/download") ? meta("http://cdn.test/pack.zip") : { bytes: zip },
      );
      const app = express();
      app.use(express.json());
      app.use("/api/skill-hub", createSkillHubRouter({ baseUrl: BASE, enabled: true, fetchImpl }));
      const res = await request(app)
        .get("/api/skill-hub/skills/abc/download")
        .set("x-skill-hub-key", KEY);
      expect(res.status).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.HEMING_SKILL_HUB_ALLOW_HTTP;
      else process.env.HEMING_SKILL_HUB_ALLOW_HTTP = saved;
    }
  });

  it("跟随重定向：每一跳重新校验，跳回私网被拒", async () => {
    const { fetchImpl, calls } = makeFetch((url) => {
      if (url.endsWith("/download")) return meta("https://cdn.test/a.zip");
      if (url === "https://cdn.test/a.zip") {
        return { status: 302, headers: { location: "http://127.0.0.1/secret.zip" } };
      }
      return { bytes: skillZip() };
    });
    const res = await request(makeApp(fetchImpl, true, { allowHttp: true }))
      .get("/api/skill-hub/skills/abc/download")
      .set("x-skill-hub-key", KEY);
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("下载地址不安全，已拒绝");
    // 重定向目标被拦在发起请求之前
    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}/api/skills/abc/download`,
      "https://cdn.test/a.zip",
    ]);
  });

  it("正常跟随 3 次重定向可以成功；第 4 次拒绝", async () => {
    const zip = skillZip();
    const chain = ["https://cdn.test/1.zip", "https://cdn.test/2.zip", "https://cdn.test/3.zip"];
    const follow = (hop: number) => {
      if (hop < chain.length) return { status: 302, headers: { location: chain[hop] } };
      return { bytes: zip };
    };
    const okFetch = makeFetch((url) => {
      if (url.endsWith("/download")) return meta("https://cdn.test/0.zip");
      if (url === "https://cdn.test/0.zip") return follow(0);
      if (url === "https://cdn.test/1.zip") return follow(1);
      if (url === "https://cdn.test/2.zip") return follow(2);
      return { bytes: zip };
    });
    const ok = await request(makeApp(okFetch.fetchImpl))
      .get("/api/skill-hub/skills/abc/download")
      .set("x-skill-hub-key", KEY);
    expect(ok.status).toBe(200);

    // 4 次重定向：0→1→2→3→4，跟随到第 3 次后仍有 302，拒绝
    const badFetch = makeFetch((url) => {
      if (url.endsWith("/download")) return meta("https://cdn.test/r0.zip");
      const hop = Number(/\/r(\d+)\.zip$/.exec(url)?.[1] ?? "x");
      if (Number.isInteger(hop) && hop < 4) {
        return { status: 302, headers: { location: `https://cdn.test/r${hop + 1}.zip` } };
      }
      return { bytes: zip };
    });
    const bad = await request(makeApp(badFetch.fetchImpl))
      .get("/api/skill-hub/skills/abc/download")
      .set("x-skill-hub-key", KEY);
    expect(bad.status).toBe(502);
    expect(bad.body.error).toContain("重定向次数过多");
  });
});

describe("上游 TTL 缓存", () => {
  function clock(start = "2026-11-08T10:00:00.000Z") {
    let value = Date.parse(start);
    return {
      now: () => value,
      advance: (ms: number) => {
        value += ms;
      },
    };
  }

  it("列表缓存 30 秒：命中不重复打上游，fetchedAt 保持实际拉取时间，过期后刷新", async () => {
    const time = clock();
    let calls = 0;
    const { fetchImpl } = makeFetch(() => {
      calls += 1;
      return { body: { skills: [], total: 0, hasMore: false } };
    });
    const app = makeApp(fetchImpl, true, { now: time.now });

    const first = await request(app).get("/api/skill-hub/skills?page=1&limit=20");
    expect(calls).toBe(1);
    const fetchedAt = first.body.fetchedAt as string;

    time.advance(10_000);
    const cached = await request(app).get("/api/skill-hub/skills?page=1&limit=20");
    expect(calls).toBe(1);
    expect(cached.body.fetchedAt).toBe(fetchedAt);

    time.advance(30_000); // 累计 40s > 30s TTL
    const refreshed = await request(app).get("/api/skill-hub/skills?page=1&limit=20");
    expect(calls).toBe(2);
    expect(refreshed.body.fetchedAt).not.toBe(fetchedAt);
  });

  it("不同参数用不同缓存键", async () => {
    let calls = 0;
    const { fetchImpl } = makeFetch(() => {
      calls += 1;
      return { body: { skills: [], total: 0 } };
    });
    const app = makeApp(fetchImpl);
    await request(app).get("/api/skill-hub/skills?search=a");
    await request(app).get("/api/skill-hub/skills?search=b");
    await request(app).get("/api/skill-hub/skills?search=a");
    expect(calls).toBe(2);
  });

  it("缓存最多 50 条：第 51 个键把最旧的淘汰", async () => {
    let calls = 0;
    const { fetchImpl } = makeFetch(() => {
      calls += 1;
      return { body: { skills: [], total: 0 } };
    });
    const app = makeApp(fetchImpl);
    for (let index = 1; index <= 51; index += 1) {
      await request(app).get(`/api/skill-hub/skills?search=k${index}`);
    }
    expect(calls).toBe(51);
    await request(app).get("/api/skill-hub/skills?search=k1"); // 最旧，已被淘汰
    expect(calls).toBe(52);
    await request(app).get("/api/skill-hub/skills?search=k51"); // 最近，仍命中
    expect(calls).toBe(52);
  });

  it("分类缓存 10 分钟（状态接口复用）", async () => {
    const time = clock();
    let calls = 0;
    const { fetchImpl } = makeFetch(() => {
      calls += 1;
      return { body: { success: true, data: ["效率工具"] } };
    });
    const app = makeApp(fetchImpl, true, { now: time.now });
    expect((await request(app).get("/api/skill-hub")).body.reachable).toBe(true);
    expect((await request(app).get("/api/skill-hub")).body.reachable).toBe(true);
    expect(calls).toBe(1);
    time.advance(10 * 60 * 1000 + 1);
    await request(app).get("/api/skill-hub");
    expect(calls).toBe(2);
  });

  it("下载/注册不缓存：每次请求都打上游", async () => {
    const zip = skillZip();
    const { fetchImpl, calls } = makeFetch((url) => {
      if (url.endsWith("/download")) {
        return { body: { success: true, data: { download_url: "https://cdn.test/p.zip", version: "1.0.0" } } };
      }
      if (url.endsWith("/api/auth/register")) {
        return { body: { success: true, data: { api_key: "sk_abc12345" } } };
      }
      return { bytes: zip };
    });
    const app = makeApp(fetchImpl);
    await request(app).get("/api/skill-hub/skills/abc/download").set("x-skill-hub-key", KEY);
    await request(app).get("/api/skill-hub/skills/abc/download").set("x-skill-hub-key", KEY);
    expect(calls.filter((call) => call.url.endsWith("/download"))).toHaveLength(2);
    expect(calls.filter((call) => call.url === "https://cdn.test/p.zip")).toHaveLength(2);

    await request(app)
      .post("/api/skill-hub/register")
      .set("x-heming-client", "1")
      .send({ name: "测试Agent" });
    await request(app)
      .post("/api/skill-hub/register")
      .set("x-heming-client", "1")
      .send({ name: "测试Agent" });
    expect(calls.filter((call) => call.url.endsWith("/api/auth/register"))).toHaveLength(2);
  });
});

describe("上游 429：中文限流文案 + Retry-After", () => {
  it("列表/详情透传 429 + retryAfter", async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 429,
      body: { success: false },
      headers: { "retry-after": "60" },
    }));
    const app = makeApp(fetchImpl);
    const list = await request(app).get("/api/skill-hub/skills");
    expect(list.status).toBe(429);
    expect(list.body.error).toContain("上游限流，请稍后重试");
    expect(list.body.retryAfter).toBe("60");

    const detail = await request(app).get("/api/skill-hub/skills/abc");
    expect(detail.status).toBe(429);
    expect(detail.body.retryAfter).toBe("60");
  });

  it("下载 429 也带 retryAfter；无 Retry-After 时不编造字段", async () => {
    const withHeader = makeFetch(() => ({
      status: 429,
      body: { success: false },
      headers: { "retry-after": "120" },
    }));
    const res = await request(makeApp(withHeader.fetchImpl))
      .get("/api/skill-hub/skills/abc/download")
      .set("x-skill-hub-key", KEY);
    expect(res.status).toBe(429);
    expect(res.body.error).toContain("上游限流，请稍后重试");
    expect(res.body.retryAfter).toBe("120");

    const noHeader = makeFetch(() => ({ status: 429, body: { success: false } }));
    const res2 = await request(makeApp(noHeader.fetchImpl))
      .get("/api/skill-hub/skills/abc/download")
      .set("x-skill-hub-key", KEY);
    expect(res2.status).toBe(429);
    expect(res2.body).not.toHaveProperty("retryAfter");
  });
});
