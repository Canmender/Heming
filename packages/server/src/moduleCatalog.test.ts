import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createModuleCatalog } from "./moduleCatalog.js";
import { createMemoryStore } from "./store.js";
import { createApp } from "./app.js";

/**
 * 云端模块目录（d.117）：原生应用不再写死「内置模块」，只显示服务端真实提供的模块。
 * 目录可被 HEMING_MODULE_DIR / CreateAppOptions.moduleDir 覆盖；缺省回落到四条可选模块。
 */

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heming-modules-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeModule(dir: string, id: string, version: string, body: Record<string, unknown>): void {
  const path = join(dir, id, version);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "module.json"), JSON.stringify(body), "utf8");
}

describe("模块包下载（d.133）", () => {
  it("packagePath：只认目录里真实存在的 module.tgz，非法 id/版本/穿越返回 null", () => {
    const dir = join(root, "staff", "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "module.tgz"), Buffer.from("signed-module"));
    const catalog = createModuleCatalog({ dir: root });
    expect(catalog.packagePath("staff", "1.0.0")).toBe(join(dir, "module.tgz"));
    expect(catalog.packagePath("../staff", "1.0.0")).toBeNull();
    expect(catalog.packagePath("staff", "../1.0.0")).toBeNull();
    expect(catalog.packagePath("staff", "2.0.0")).toBeNull();
  });

  it("GET /api/modules/:id/:version/module.tgz 公开返回包字节", async () => {
    const dir = join(root, "staff", "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "module.tgz"), Buffer.from("signed-module"));
    const app = createApp(createMemoryStore(), { moduleDir: root, allowRegister: true });
    const ok = await request(app).get("/api/modules/staff/1.0.0/module.tgz");
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toContain("application/octet-stream");
    expect(ok.body.toString()).toBe("signed-module");
    expect((await request(app).get("/api/modules/staff/9.9.9/module.tgz")).status).toBe(404);
  });
});

describe("createModuleCatalog", () => {
  it("目录为空时回落到随服务端发布的四条可选模块", () => {
    const ids = createModuleCatalog({ dir: root }).list().map((entry) => entry.id);
    expect(ids).toEqual(["automations", "infohub", "staff", "workflows"]);
  });

  it("目录里的同名模块覆盖默认项；同一 id 只取最新版本；坏条目跳过", () => {
    writeModule(root, "staff", "1.0.0", {
      name: "幕僚（旧）",
      description: "旧版",
      engine: null,
    });
    writeModule(root, "staff", "1.10.0", {
      name: "幕僚（新）",
      description: "新版",
      engine: null,
    });
    writeModule(root, "acme.report", "1.0.0", {
      name: "报告模块",
      description: "第三方",
      engine: "acme.engine",
    });
    writeModule(root, "bad.module", "1.0.0", { name: "" });

    const entries = createModuleCatalog({ dir: root }).list();
    const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
    expect(byId.get("staff")?.name).toBe("幕僚（新）");
    expect(byId.get("staff")?.version).toBe("1.10.0");
    expect(byId.get("acme.report")?.engine).toBe("acme.engine");
    expect(byId.has("bad.module")).toBe(false);
  });
});

describe("GET /api/modules", () => {
  it("公开目录：不需要登录，返回模块与生成时间", async () => {
    writeModule(root, "staff", "1.0.0", { name: "幕僚", description: "d", engine: null });
    const app = createApp(createMemoryStore(), { moduleDir: root, allowRegister: true });
    const res = await request(app).get("/api/modules");
    expect(res.status).toBe(200);
    expect(res.body.modules.some((entry: { id: string }) => entry.id === "staff")).toBe(true);
    expect(typeof res.body.generatedAt).toBe("string");
  });
});
