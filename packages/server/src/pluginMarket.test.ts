import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createMemoryStore } from "./store.js";
import { createApp } from "./app.js";
import {
  MAX_ASSET_BYTES,
  MAX_MARKET_INDEX_BYTES,
  createPluginMarketService,
  filterMarketByUpdatedSince,
} from "./pluginMarket.js";

/**
 * 市场索引 v2（d.105）：原样分发 / 宿主版本过滤 / 增量同步 / 详情与资源分发 /
 * PUT 鉴权与格式校验 / 路径穿越与大小上限。
 *
 * 和既有 `/api/plugins*` 的用例一样，全部用临时目录造数据，不碰仓库里的真实插件。
 */

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function version(version: string, overrides: Record<string, unknown> = {}) {
  return {
    version,
    publishedAt: "2026-11-01T00:00:00.000Z",
    schemaVersion: 5,
    engines: { heming: "d.100" },
    distribution: "manifest",
    sha256: SHA_A,
    size: 12,
    ...overrides,
  };
}

function plugin(id: string, versions: unknown[], overrides: Record<string, unknown> = {}) {
  return { id, title: `插件 ${id}`, versions, ...overrides };
}

function market(plugins: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    format: 1,
    title: "测试市场",
    generatedAt: "2026-11-08T00:00:00.000Z",
    plugins,
    ...overrides,
  };
}

function writeIndexFile(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "market.json"), body, "utf8");
}

/** 取原始响应体（supertest 对 application/json 会自动解析，这里要比较字节）。 */
async function rawGet(app: ReturnType<typeof createApp>, path: string) {
  return request(app)
    .get(path)
    .buffer(true)
    .parse((res, callback) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
      });
      res.on("end", () => callback(null, text));
    });
}

let root = "";
const KEY = "market-test-key";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heming-market-"));
  process.env.HEMING_PLUGIN_PUBLISH_KEY = KEY;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.HEMING_PLUGIN_PUBLISH_KEY;
});

function makeApp() {
  return createApp(createMemoryStore(), { pluginDir: root });
}

async function putIndex(app: ReturnType<typeof createApp>, body: string, key = KEY) {
  return request(app).put("/api/plugin-market").set("content-type", "application/json").set("x-publish-key", key).send(body);
}

describe("GET /api/plugin-market", () => {
  it("索引不存在时 404（客户端据此回落 v1 目录）", async () => {
    const res = await request(makeApp()).get("/api/plugin-market");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/市场索引不存在/);
  });

  it("原样返回 market.json 字节（不经 JSON 重排），并带 charset", async () => {
    // 故意用「非标准缩进 + 中文 + 尾随换行」证明服务端不重排
    const body = `{"format":1,"title":"和鸣插件目录","generatedAt":"2026-11-08T00:00:00.000Z","plugins":[]}\n`;
    writeIndexFile(root, body);
    const res = await rawGet(makeApp(), "/api/plugin-market");
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("application/json");
    expect(String(res.headers["content-type"])).toContain("charset=utf-8");
    expect(res.body).toBe(body);
  });

  it("索引损坏时 500（不静默返回空市场）", async () => {
    writeIndexFile(root, "{ 这不是 JSON");
    const res = await request(makeApp()).get("/api/plugin-market");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/市场索引损坏/);
  });

  it("?hostVersion= 过滤掉不兼容版本；一个兼容版本都不剩的插件整条移除", async () => {
    const index = market([
      plugin("acme.multi", [version("1.0.0", { engines: { heming: "d.100" } }), version("2.0.0", { engines: { heming: "d.200" } })]),
      plugin("acme.future", [version("1.0.0", { engines: { heming: "d.200" } })]),
      plugin("acme.ok", [version("1.0.0", { engines: { heming: "d.105" } })]),
    ]);
    const app = makeApp();
    expect((await putIndex(app, JSON.stringify(index))).status).toBe(200);

    const res = await request(app).get("/api/plugin-market").query({ hostVersion: "d.105" });
    expect(res.status).toBe(200);
    expect(res.body.plugins.map((item: { id: string }) => item.id)).toEqual(["acme.multi", "acme.ok"]);
    expect(res.body.plugins[0].versions.map((item: { version: string }) => item.version)).toEqual(["1.0.0"]);

    // 不带参数 = 全量（不过滤）
    const all = await request(app).get("/api/plugin-market");
    expect(all.body.plugins).toHaveLength(3);
  });

  it("?updatedSince= 按 plugins[].updatedAt 过滤；缺 updatedAt 的条目保留", async () => {
    const index = market([
      plugin("acme.old", [version("1.0.0")], { updatedAt: "2026-11-01T00:00:00.000Z" }),
      plugin("acme.new", [version("1.0.0")], { updatedAt: "2026-11-05T00:00:00.000Z" }),
      plugin("acme.unknown", [version("1.0.0")]),
    ]);
    const app = makeApp();
    expect((await putIndex(app, JSON.stringify(index))).status).toBe(200);

    const res = await request(app).get("/api/plugin-market").query({ updatedSince: "2026-11-03T00:00:00.000Z" });
    expect(res.status).toBe(200);
    expect(res.body.plugins.map((item: { id: string }) => item.id)).toEqual(["acme.new", "acme.unknown"]);
  });

  it("updatedSince 不是合法时间 → 400", async () => {
    const app = makeApp();
    expect((await putIndex(app, JSON.stringify(market([plugin("acme.a", [version("1.0.0")])])))).status).toBe(200);
    const res = await request(app).get("/api/plugin-market").query({ updatedSince: "前天" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/updatedSince/);
  });
});

describe("GET /api/plugin-market/:id/:version/detail", () => {
  it("返回 markdown 原文 + nosniff；不存在 404", async () => {
    const dir = join(root, "acme.pet", "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "detail.md"), "# 桌宠\n\n详细介绍。", "utf8");
    const app = makeApp();

    const res = await request(app).get("/api/plugin-market/acme.pet/1.0.0/detail");
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/markdown");
    expect(String(res.headers["content-type"])).toContain("charset=utf-8");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.text).toContain("# 桌宠");

    expect((await request(app).get("/api/plugin-market/acme.pet/9.9.9/detail")).status).toBe(404);
  });

  it("超过 64KB → 413", async () => {
    const dir = join(root, "acme.pet", "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "detail.md"), "x".repeat(64 * 1024 + 1), "utf8");
    const res = await request(makeApp()).get("/api/plugin-market/acme.pet/1.0.0/detail");
    expect(res.status).toBe(413);
  });

  it("索引 versions[].detail 指向别的单段 .md 时按索引取（约定 detail.md 优先）", async () => {
    const dir = join(root, "acme.pet", "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "intro.md"), "# 从索引指向的详情", "utf8");
    const index = market([
      plugin("acme.pet", [version("1.0.0", { detail: "intro.md" })]),
    ]);
    const app = makeApp();
    expect((await putIndex(app, JSON.stringify(index))).status).toBe(200);
    const res = await request(app).get("/api/plugin-market/acme.pet/1.0.0/detail");
    expect(res.status).toBe(200);
    expect(res.text).toContain("从索引指向的详情");
  });
});

describe("GET /api/plugin-market/assets/:id/:version/:file", () => {
  it("白名单扩展名原样返回，带 nosniff 与 10 分钟缓存", async () => {
    const dir = join(root, "acme.pet", "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await request(makeApp()).get("/api/plugin-market/assets/acme.pet/1.0.0/icon.png");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.headers["cache-control"])).toContain("max-age=600");
  });

  it("扩展名不在白名单 / 文件不存在 / 版本段非法 → 404", async () => {
    const dir = join(root, "acme.pet", "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "readme.html"), "<script>alert(1)</script>", "utf8");
    const app = makeApp();
    expect((await request(app).get("/api/plugin-market/assets/acme.pet/1.0.0/readme.html")).status).toBe(404);
    expect((await request(app).get("/api/plugin-market/assets/acme.pet/1.0.0/missing.png")).status).toBe(404);
    expect((await request(app).get("/api/plugin-market/assets/acme.pet/../icon.png")).status).toBe(404);
  });

  it("超过 2MB → 413", async () => {
    const dir = join(root, "acme.pet", "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "shot.png"), Buffer.alloc(MAX_ASSET_BYTES + 1));
    const res = await request(makeApp()).get("/api/plugin-market/assets/acme.pet/1.0.0/shot.png");
    expect(res.status).toBe(413);
  });
});

describe("pluginMarketService（纯函数/越界守卫）", () => {
  it("readAsset/readDetail 拒绝 `..` 与非法 id/版本（路径穿越双保险）", () => {
    mkdirSync(join(root, "acme.pet", "1.0.0"), { recursive: true });
    writeFileSync(join(root, "secret.png"), Buffer.from([1, 2, 3]));
    const service = createPluginMarketService({ dir: root });
    expect(service.readAsset("..", "1.0.0", "secret.png")).toBeNull();
    expect(service.readAsset("acme.pet", "..", "secret.png")).toBeNull();
    expect(service.readAsset("acme.pet", "1.0.0", "../secret.png")).toBeNull();
    expect(service.readAsset("acme.pet", "1.0.0", "..%2Fsecret.png")).toBeNull();
    expect(service.readDetail("acme.pet", "1.0.0")).toBeNull();
  });

  it("filterMarketByUpdatedSince 保留缺 updatedAt 的条目", () => {
    const index = market([
      plugin("acme.old", [version("1.0.0")], { updatedAt: "2026-11-01T00:00:00.000Z" }),
      plugin("acme.none", [version("1.0.0")]),
    ]) as Parameters<typeof filterMarketByUpdatedSince>[0];
    const filtered = filterMarketByUpdatedSince(index, Date.parse("2026-11-03T00:00:00.000Z"));
    expect(filtered.plugins.map((item) => item.id)).toEqual(["acme.none"]);
  });

  it("mtime 变化后缓存失效（换索引立刻生效）", () => {
    writeIndexFile(root, JSON.stringify(market([plugin("acme.a", [version("1.0.0")])])));
    const service = createPluginMarketService({ dir: root });
    expect(service.readIndex()?.index.plugins[0]?.id).toBe("acme.a");
    const path = join(root, "market.json");
    writeFileSync(path, JSON.stringify(market([plugin("acme.b", [version("1.0.0")])])), "utf8");
    // 同一毫秒内 mtime 可能不变：显式把 mtime 往后拨，模拟发布工具替换文件
    const future = new Date(Date.now() + 5_000);
    utimesSync(path, future, future);
    expect(statSync(path).mtimeMs).toBeGreaterThan(0);
    expect(service.readIndex()?.index.plugins[0]?.id).toBe("acme.b");
  });
});

describe("PUT /api/plugin-market", () => {
  it("未配置密钥 503、密钥错 401", async () => {
    delete process.env.HEMING_PLUGIN_PUBLISH_KEY;
    const noKeyApp = makeApp();
    expect((await request(noKeyApp).put("/api/plugin-market").send(JSON.stringify(market([])))).status).toBe(503);

    process.env.HEMING_PLUGIN_PUBLISH_KEY = KEY;
    const app = makeApp();
    expect((await putIndex(app, JSON.stringify(market([])), "wrong")).status).toBe(401);
  });

  it("不是 JSON / 不是对象 / 索引格式不对 → 400；成功 200 后 GET 能读到同样字节", async () => {
    const app = makeApp();
    expect((await putIndex(app, "{ 坏 JSON")).status).toBe(400);
    expect((await putIndex(app, JSON.stringify([1, 2, 3]))).status).toBe(400);
    expect((await putIndex(app, JSON.stringify({ format: 2, title: "x", generatedAt: "y", plugins: [] }))).status).toBe(400);

    const body = `{"format":1,"title":"新市场","generatedAt":"2026-11-08T00:00:00.000Z","plugins":[]}\n`;
    const created = await putIndex(app, body);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true });
    expect(created.body.size).toBe(Buffer.byteLength(body));

    const got = await rawGet(app, "/api/plugin-market");
    expect(got.body).toBe(body);
  });

  it("超过 4MB → 413", async () => {
    const app = makeApp();
    const huge = JSON.stringify({
      format: 1,
      title: "大市场",
      generatedAt: "2026-11-08T00:00:00.000Z",
      plugins: [],
      pad: "x".repeat(MAX_MARKET_INDEX_BYTES + 1024),
    });
    expect(Buffer.byteLength(huge)).toBeGreaterThan(MAX_MARKET_INDEX_BYTES);
    const res = await putIndex(app, huge);
    expect(res.status).toBe(413);
  });

  it("坏条目只丢该条并回 warnings（不让整份索引失效）", async () => {
    const app = makeApp();
    const index = market([
      plugin("acme.good", [version("1.0.0")]),
      plugin("Bad ID!", [version("1.0.0")]),
    ]);
    const res = await putIndex(app, JSON.stringify(index));
    expect(res.status).toBe(200);
    expect(res.body.warnings.length).toBeGreaterThan(0);
    // 裸 GET 是原样字节（坏条目仍在文件里，客户端解析时丢弃）；
    // 带过滤参数时走服务端解析视图，坏条目已被丢弃。
    const raw = await rawGet(app, "/api/plugin-market");
    expect(raw.body).toContain("Bad ID!");
    const filtered = await request(app).get("/api/plugin-market").query({ hostVersion: "d.105" });
    expect(filtered.body.plugins.map((item: { id: string }) => item.id)).toEqual(["acme.good"]);
  });
});
