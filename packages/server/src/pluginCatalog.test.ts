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
