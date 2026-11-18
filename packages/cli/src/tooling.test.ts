/**
 * `relativizeToolArgs`：把模型/MCP 客户端发来的绝对路径换成「相对工作区」的写法。
 *
 * 这条规则很窄但很重要：文件工具的契约是相对路径，而不改写就等于「一次合法的写」直接失败。
 * 同时它**不放松安全边界**——工作区外的绝对路径只是被改写成 `../…`，仍然会被越界检查挡下。
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { relativizeToolArgs } from "./tooling.js";

const CWD = path.resolve("D:/work/proj").replace(/\\/g, "/");

describe("relativizeToolArgs（d.288）", () => {
  it("相对路径、非路径字段、非 JSON 一律原样返回", () => {
    expect(relativizeToolArgs('{"path":"src/a.ts"}', CWD)).toBe('{"path":"src/a.ts"}');
    expect(relativizeToolArgs('{"command":"npm test"}', CWD)).toBe('{"command":"npm test"}');
    expect(relativizeToolArgs("不是 JSON", CWD)).toBe("不是 JSON");
    expect(relativizeToolArgs("[1,2]", CWD)).toBe("[1,2]");
    expect(relativizeToolArgs("null", CWD)).toBe("null");
  });

  it("工作区内的绝对路径改写成相对路径（只用正斜杠）", () => {
    const out = JSON.parse(relativizeToolArgs(JSON.stringify({ path: `${CWD}/src/a.ts`, content: "x" }), CWD));
    expect(out).toEqual({ path: "src/a.ts", content: "x" });

    // Windows 反斜杠写法也认。
    const win = JSON.parse(relativizeToolArgs(JSON.stringify({ path: `${CWD}\\src\\b.ts` }), CWD));
    expect(win.path).toBe("src/b.ts");

    // 正好是工作区本身 → "."（不是空串）。
    const atRoot = JSON.parse(relativizeToolArgs(JSON.stringify({ path: CWD }), CWD));
    expect(atRoot.path).toBe(".");
  });

  it("工作区外的绝对路径变成 ../… —— 仍然进越界检查，不会被「治好」", () => {
    const outside = path.resolve("D:/other/secret.txt").replace(/\\/g, "/");
    const out = JSON.parse(relativizeToolArgs(JSON.stringify({ path: outside }), CWD));
    expect(out.path.startsWith("..")).toBe(true);
    expect(out.path).toContain("secret.txt");
  });

  it("path / file / target / from / to 与 paths / files 数组都覆盖", () => {
    const inside = `${CWD}/a.md`;
    const json = JSON.stringify({
      path: inside,
      file: inside,
      target: inside,
      from: inside,
      to: inside,
      paths: [inside, "already/rel.md"],
      files: [inside],
    });
    const out = JSON.parse(relativizeToolArgs(json, CWD));
    expect(out.path).toBe("a.md");
    expect(out.file).toBe("a.md");
    expect(out.target).toBe("a.md");
    expect(out.from).toBe("a.md");
    expect(out.to).toBe("a.md");
    expect(out.paths).toEqual(["a.md", "already/rel.md"]);
    expect(out.files).toEqual(["a.md"]);
  });

  it("glob 模式剥掉工作区前缀；不在工作区下的模式不动", () => {
    const out = JSON.parse(relativizeToolArgs(JSON.stringify({ pattern: `${CWD}/**/*.ts` }), CWD));
    expect(out.pattern).toBe("**/*.ts");

    const rootOnly = JSON.parse(relativizeToolArgs(JSON.stringify({ glob: CWD }), CWD));
    expect(rootOnly.glob).toBe("**/*");

    const elsewhere = JSON.parse(
      relativizeToolArgs(JSON.stringify({ pattern: "D:/other/**/*.ts" }), CWD),
    );
    expect(elsewhere.pattern).toBe("D:/other/**/*.ts");
  });

  it("没有发生改写时返回原字符串（避免无意义的重序列化）", () => {
    const original = '{"path":  "src/a.ts",   "content":"x"}';
    expect(relativizeToolArgs(original, CWD)).toBe(original);
  });
});
