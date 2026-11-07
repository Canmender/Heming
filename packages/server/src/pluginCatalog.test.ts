import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createHash } from "node:crypto";
import { comparePluginVersions, createPluginCatalog } from "./pluginCatalog.js";
import { createMemoryStore } from "./store.js";
import { createApp } from "./app.js";

/**
 * 云端插件目录（d.86）：目录扫描 / 版本选择 / 原样分发 / 防穿越。
 *
 * 这些插件包**不随安装包分发**，服务端只负责把公开产物列出来并原样给出；
 * 客户端拿 sha256 自行校验。用例用临时目录造包，不碰仓库里的真实插件。
 */

function writePlugin(dir: string, id: string, version: string, body: unknown): Buffer {
  const path = join(dir, id, version);
  mkdirSync(path, { recursive: true });
  const bytes = Buffer.from(JSON.stringify(body, null, 2), "utf8");
  writeFileSync(join(path, "plugin.json"), bytes);
  return bytes;
}

function v4(id: string, version: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 4,
    id,
    name: `包 ${id}`,
    version,
    description: "测试包",
    author: "tester",
    permissions: { network: ["127.0.0.1:3425"], tools: "none", files: [] },
    contributions: { skills: [{ name: "s", instructions: "i" }] },
    ...overrides,
  };
}

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heming-plugins-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("comparePluginVersions", () => {
  it("数字段按数值比（1.10 > 1.9），非数字段按字符串比", () => {
    expect(comparePluginVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(comparePluginVersions("0.1.0", "0.1.0")).toBe(0);
    expect(comparePluginVersions("1.0.0-beta", "1.0.0-alpha")).toBeGreaterThan(0);
  });
});

describe("createPluginCatalog", () => {
  it("目录不存在时返回空列表（尚未发布任何插件是合法状态）", () => {
    const catalog = createPluginCatalog({ dir: join(root, "missing") });
    expect(catalog.list()).toEqual([]);
    expect(catalog.read("a.b", "1.0.0")).toBeNull();
  });

  it("每个 id 只出最新版本，并带正确的 sha256 / 字节数 / 计数", () => {
    writePlugin(root, "acme.old", "1.0.0", v4("acme.old", "1.0.0"));
    const newest = writePlugin(root, "acme.old", "1.10.0", v4("acme.old", "1.10.0"));
    writePlugin(root, "acme.other", "0.1.0", v4("acme.other", "0.1.0", {
      contributions: { skills: [{ name: "s", instructions: "i" }] },
      permissions: { network: [], tools: "read", files: [] },
    }));

    const catalog = createPluginCatalog({ dir: root });
    const list = catalog.list();
    expect(list.map((entry) => entry.id)).toEqual(["acme.old", "acme.other"]);
    const old = list[0];
    expect(old.version).toBe("1.10.0");
    expect(old.sha256).toBe(createHash("sha256").update(newest).digest("hex"));
    expect(old.size).toBe(newest.length);
    expect(old.contributions.skills).toBe(1);
    expect(list[1].contributions.skills).toBe(1);

    const read = catalog.read("acme.old", "1.10.0");
    expect(read?.sha256).toBe(old.sha256);
    expect(read?.bytes.equals(newest)).toBe(true);
    // 旧版本仍可下载（客户端拿着旧 entry 也能回退）
    expect(catalog.read("acme.old", "1.0.0")).not.toBeNull();
  });

  it("坏清单只跳过该条，其余仍在；损坏版本回退到更早版本", () => {
    writePlugin(root, "acme.good", "1.0.0", v4("acme.good", "1.0.0"));
    const badDir = join(root, "acme.good", "2.0.0");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "plugin.json"), "{not json");
    mkdirSync(join(root, "acme.broken", "1.0.0"), { recursive: true });
    writeFileSync(join(root, "acme.broken", "1.0.0", "plugin.json"), JSON.stringify({ nope: true }));

    const list = createPluginCatalog({ dir: root }).list();
    expect(list.map((entry) => entry.id)).toEqual(["acme.good"]);
    expect(list[0].version).toBe("1.0.0");
  });

  it("read 拒绝路径穿越与非法 id/版本", () => {
    writePlugin(root, "acme.safe", "1.0.0", v4("acme.safe", "1.0.0"));
    const catalog = createPluginCatalog({ dir: root });
    for (const [id, version] of [
      ["../etc", "1.0.0"],
      ["acme.safe", "../1.0.0"],
      ["acme/safe", "1.0.0"],
      ["acme.safe", "1.0.0/../../x"],
      ["", "1.0.0"],
    ] as const) {
      expect(catalog.read(id, version), `${id}@${version}`).toBeNull();
    }
  });

  it("publishedAt 取文件时间（同版本重发时客户端能看到变化）", () => {
    writePlugin(root, "acme.time", "1.0.0", v4("acme.time", "1.0.0"));
    const when = new Date("2026-11-07T12:00:00.000Z");
    utimesSync(join(root, "acme.time", "1.0.0", "plugin.json"), when, when);
    const entry = createPluginCatalog({ dir: root }).list()[0];
    expect(entry.publishedAt).toBe(when.toISOString());
  });
});

describe("GET /api/plugins（公开）", () => {
  it("无 token 也能取目录；manifest 原样返回并带 sha256 头", async () => {
    const bytes = writePlugin(root, "acme.cloud", "0.2.0", v4("acme.cloud", "0.2.0"));
    const app = createApp(createMemoryStore(), { pluginDir: root });

    const listRes = await request(app).get("/api/plugins");
    expect(listRes.status).toBe(200);
    expect(listRes.body.plugins).toHaveLength(1);
    expect(listRes.body.plugins[0]).toMatchObject({ id: "acme.cloud", version: "0.2.0" });
    expect(typeof listRes.body.generatedAt).toBe("string");

    const manifestRes = await request(app).get("/api/plugins/acme.cloud/0.2.0/manifest");
    expect(manifestRes.status).toBe(200);
    expect(manifestRes.headers["x-plugin-sha256"]).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(Buffer.from(manifestRes.text, "utf8").equals(bytes)).toBe(true);

    const missing = await request(app).get("/api/plugins/acme.cloud/9.9.9/manifest");
    expect(missing.status).toBe(404);
  });
});

describe("仓库详情 / 发布 / 下线（d.95）", () => {
  it("detail：某插件的全部版本（新→旧），坏版本跳过；未知 id 返回 null", () => {
    writePlugin(root, "acme.repo", "1.0.0", v4("acme.repo", "1.0.0"));
    writePlugin(root, "acme.repo", "1.2.0", v4("acme.repo", "1.2.0"));
    writePlugin(root, "acme.repo", "1.1.0", v4("acme.repo", "1.1.0"));
    // 坏版本：非 JSON，应被跳过而不影响其它版本
    mkdirSync(join(root, "acme.repo", "9.9.9"), { recursive: true });
    writeFileSync(join(root, "acme.repo", "9.9.9", "plugin.json"), "not json");

    const catalog = createPluginCatalog({ dir: root });
    const detail = catalog.detail("acme.repo");
    expect(detail?.id).toBe("acme.repo");
    expect(detail?.versions.map((v) => v.version)).toEqual(["1.2.0", "1.1.0", "1.0.0"]);

    expect(catalog.detail("acme.none")).toBeNull();
    expect(catalog.detail("../etc")).toBeNull();
  });

  it("publish：校验 id/版本/大小/清单一致性，成功后 read 能拿到原样字节", () => {
    const catalog = createPluginCatalog({ dir: root });
    const manifest = v4("acme.pub", "0.1.0");
    const bytes = Buffer.from(JSON.stringify(manifest), "utf8");

    expect(catalog.publish("../evil", "0.1.0", bytes)).toBe("invalid_id");
    expect(catalog.publish("acme.pub", "../0.1.0", bytes)).toBe("invalid_version");
    expect(catalog.publish("acme.pub", "0.1.0", Buffer.alloc(0))).toBe("too_large");
    // 清单里 id 与发布参数不一致
    expect(catalog.publish("acme.pub", "0.1.1", bytes)).toBe("mismatch");

    const result = catalog.publish("acme.pub", "0.1.0", bytes);
    expect(result).toMatchObject({ id: "acme.pub", version: "0.1.0", created: true });
    expect(catalog.read("acme.pub", "0.1.0")?.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    // 同版本重发 = 覆盖（created=false），不产生第二个版本
    expect(catalog.publish("acme.pub", "0.1.0", bytes)).toMatchObject({ created: false });
    expect(catalog.detail("acme.pub")?.versions).toHaveLength(1);
  });

  it("remove：只下线指定版本，其它版本保留；不存在返回 not_found", () => {
    writePlugin(root, "acme.rm", "1.0.0", v4("acme.rm", "1.0.0"));
    writePlugin(root, "acme.rm", "1.1.0", v4("acme.rm", "1.1.0"));
    const catalog = createPluginCatalog({ dir: root });
    expect(catalog.remove("acme.rm", "1.0.0")).toBe("ok");
    expect(catalog.detail("acme.rm")?.versions.map((v) => v.version)).toEqual(["1.1.0"]);
    expect(catalog.remove("acme.rm", "1.0.0")).toBe("not_found");
    expect(catalog.remove("../etc", "1.0.0")).toBe("not_found");
  });
});

describe("仓库 REST（d.95）", () => {
  const KEY = "test-publish-key";

  function appWithRepo() {
    return createApp(createMemoryStore(), { pluginDir: root });
  }

  beforeEach(() => {
    process.env.HEMING_PLUGIN_PUBLISH_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.HEMING_PLUGIN_PUBLISH_KEY;
  });

  it("GET /api/plugins/:id：全版本；不存在 404", async () => {
    writePlugin(root, "acme.api", "1.0.0", v4("acme.api", "1.0.0"));
    writePlugin(root, "acme.api", "1.1.0", v4("acme.api", "1.1.0"));
    const app = appWithRepo();
    const res = await request(app).get("/api/plugins/acme.api");
    expect(res.status).toBe(200);
    expect(res.body.versions.map((v: { version: string }) => v.version)).toEqual(["1.1.0", "1.0.0"]);
    expect((await request(app).get("/api/plugins/none.here")).status).toBe(404);
  });

  it("PUT /api/plugins/:id/:version：密钥错 401、清单与路径不一致 400、首次 201、重发 200", async () => {
    const app = appWithRepo();
    const manifest = v4("acme.push", "0.3.0");

    expect(
      (await request(app).put("/api/plugins/acme.push/0.3.0").send(manifest)).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .put("/api/plugins/acme.push/0.3.0")
          .set("x-publish-key", "wrong")
          .send(manifest)
      ).status,
    ).toBe(401);

    // 路径与清单不一致：拒绝（防止发布到 A 路径的其实是 B 包）
    expect(
      (
        await request(app)
          .put("/api/plugins/other.id/0.3.0")
          .set("x-publish-key", KEY)
          .send(manifest)
      ).status,
    ).toBe(400);
    // 非法版本号（以 "." 开头，字符集不通过；仍是一个合法 URL 段）
    expect(
      (
        await request(app)
          .put("/api/plugins/acme.push/..0.3")
          .set("x-publish-key", KEY)
          .send({ ...manifest, version: "..0.3" })
      ).status,
    ).toBe(400);

    const ok = await request(app)
      .put("/api/plugins/acme.push/0.3.0")
      .set("x-publish-key", KEY)
      .send(manifest);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ id: "acme.push", version: "0.3.0", created: true });

    const again = await request(app)
      .put("/api/plugins/acme.push/0.3.0")
      .set("x-publish-key", KEY)
      .send(manifest);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false });

    const manifestRes = await request(app).get("/api/plugins/acme.push/0.3.0/manifest");
    expect(manifestRes.status).toBe(200);
  });

  it("未配置发布密钥时发布/下线一律 503（接口关闭），读接口照常", async () => {
    delete process.env.HEMING_PLUGIN_PUBLISH_KEY;
    const app = appWithRepo();
    expect((await request(app).put("/api/plugins/x.y/1.0.0").send(v4("x.y", "1.0.0"))).status).toBe(503);
    expect((await request(app).delete("/api/plugins/x.y/1.0.0")).status).toBe(503);
    expect((await request(app).get("/api/plugins")).status).toBe(200);
  });

  it("DELETE /api/plugins/:id/:version：401 / 404 / 204", async () => {
    writePlugin(root, "acme.del", "1.0.0", v4("acme.del", "1.0.0"));
    const app = appWithRepo();
    expect((await request(app).delete("/api/plugins/acme.del/1.0.0")).status).toBe(401);
    expect(
      (await request(app).delete("/api/plugins/acme.del/9.9.9").set("x-publish-key", KEY)).status,
    ).toBe(404);
    expect(
      (await request(app).delete("/api/plugins/acme.del/1.0.0").set("x-publish-key", KEY)).status,
    ).toBe(204);
    expect((await request(app).get("/api/plugins/acme.del")).status).toBe(404);
  });
});
