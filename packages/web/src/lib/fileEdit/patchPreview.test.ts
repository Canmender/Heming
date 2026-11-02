import { describe, expect, it } from "vitest";
import type { FileFsBridge } from "./bridge.js";
import { PATCH_PREVIEW_MAX_LINES, buildPatchPreview } from "./patchPreview.js";
import type { FileRoot } from "./paths.js";

const ROOT: FileRoot = { name: "库", path: "D:/库", mode: "write" };

/** 内存桥（只读预览用；写入调用会被记下来，断言「预览不写盘」）。 */
function fakeBridge(files: Record<string, string>) {
  const bridge: FileFsBridge & { writes: number } = {
    writes: 0,
    async read({ path }) {
      if (path in files) {
        const content = files[path];
        return { ok: true, content, bytes: new TextEncoder().encode(content).length };
      }
      return { ok: false, code: "not-found", error: "文件不存在" };
    },
    async write() {
      bridge.writes += 1;
      return { ok: false, error: "预览不该写盘" };
    },
    async pickRoot() {
      return null;
    },
  };
  return bridge;
}

const patchArgs = (patch: string) => JSON.stringify({ patch });

const updatePatch = [
  "*** Begin Patch",
  "*** Update File: notes/a.md",
  "@@",
  "-旧的一行",
  "+新的一行",
  "*** End Patch",
].join("\n");

describe("补丁预览（确认卡）", () => {
  it("修改：给出 summary 与行级 diff（+ / − 行）", async () => {
    const bridge = fakeBridge({ "D:/库/notes/a.md": "第一行\n旧的一行\n第三行\n" });
    const preview = await buildPatchPreview(patchArgs(updatePatch), { bridge, roots: [ROOT] });
    expect(preview).not.toBeNull();
    expect(preview!.summary).toBe("将修改 1 个文件（1 个修改）");
    expect(preview!.files[0]).toMatchObject({ rel: "notes/a.md", kind: "M", added: 1, removed: 1 });
    const lines = preview!.files[0].lines.map((l) => `${l.kind}:${l.text}`);
    expect(lines).toContain("del:旧的一行");
    expect(lines).toContain("add:新的一行");
    // 上下文行取文件原文
    expect(lines).toContain("ctx:第一行");
  });

  it("新增与删除：新增全是 add 行，删除全是 del 行", async () => {
    const bridge = fakeBridge({ "D:/库/old.md": "旧内容\n第二行\n" });
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.md",
      "+甲",
      "+乙",
      "*** Delete File: old.md",
      "*** End Patch",
    ].join("\n");
    const preview = await buildPatchPreview(patchArgs(patch), { bridge, roots: [ROOT] });
    expect(preview!.summary).toBe("将修改 2 个文件（1 个新增、1 个删除）");
    expect(preview!.files[0]).toMatchObject({ rel: "new.md", kind: "A", added: 2, removed: 0 });
    expect(preview!.files[0].lines.every((l) => l.kind === "add")).toBe(true);
    expect(preview!.files[1]).toMatchObject({ rel: "old.md", kind: "D", added: 0, removed: 2 });
    expect(preview!.files[1].lines.every((l) => l.kind === "del")).toBe(true);
  });

  it("改名：标出 movedFrom", async () => {
    const bridge = fakeBridge({ "D:/库/a.md": "内容\n" });
    const patch = ["*** Begin Patch", "*** Update File: a.md", "*** Move to: b.md", "@@", "-内容", "+新内容", "*** End Patch"].join("\n");
    const preview = await buildPatchPreview(patchArgs(patch), { bridge, roots: [ROOT] });
    expect(preview!.files[1]).toMatchObject({ rel: "b.md", kind: "A", movedFrom: "a.md" });
  });

  it("脱敏：疑似密钥的行在预览里隐藏", async () => {
    const bridge = fakeBridge({
      "D:/库/配置.md": "普通行\napi_key=sk-1234567890abcdef\n旧行\n",
    });
    const patch = [
      "*** Begin Patch",
      "*** Update File: 配置.md",
      "@@",
      " 普通行",
      " api_key=sk-1234567890abcdef",
      "-旧行",
      "+新行",
      "*** End Patch",
    ].join("\n");
    const preview = await buildPatchPreview(patchArgs(patch), { bridge, roots: [ROOT] });
    const texts = preview!.files[0].lines.map((l) => l.text).join("\n");
    expect(texts).toContain("新行");
    expect(texts).toContain("已隐藏");
    expect(texts).not.toContain("sk-1234567890abcdef");
  });

  it(`超过 ${PATCH_PREVIEW_MAX_LINES} 行时截断并注明`, async () => {
    // 新增文件的所有行都会进预览，用它来构造超限最直接
    const body = Array.from({ length: PATCH_PREVIEW_MAX_LINES + 50 }, (_, i) => `+行 ${i}`);
    const patch = ["*** Begin Patch", "*** Add File: 大.md", ...body, "*** End Patch"].join("\n");
    const bridge = fakeBridge({});
    const preview = await buildPatchPreview(patchArgs(patch), { bridge, roots: [ROOT] });
    expect(preview!.files).toHaveLength(1);
    expect(preview!.truncated).toBe(true);
    expect(preview!.shownLines).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_LINES);
    expect(preview!.files[0].truncated).toBe(true);
  });

  it("补丁格式错：返回 error 且不显示文件", async () => {
    const bridge = fakeBridge({});
    const preview = await buildPatchPreview(
      patchArgs("*** Begin Patch\n*** Add File: a.md\n缺前缀\n*** End Patch"),
      { bridge, roots: [ROOT] },
    );
    expect(preview!.files).toEqual([]);
    expect(preview!.error).toContain("+");
  });

  it("锚点匹配失败：返回 error，不假装能改", async () => {
    const bridge = fakeBridge({ "D:/库/notes/a.md": "完全不同的内容\n" });
    const preview = await buildPatchPreview(patchArgs(updatePatch), { bridge, roots: [ROOT] });
    expect(preview!.files).toEqual([]);
    expect(preview!.error).toContain("找不到匹配的原文");
  });

  it("预览只读：绝不调用 write", async () => {
    const bridge = fakeBridge({ "D:/库/notes/a.md": "旧的一行\n" });
    await buildPatchPreview(patchArgs(updatePatch), { bridge, roots: [ROOT] });
    expect(bridge.writes).toBe(0);
  });

  it("没有桥 / 参数里没有补丁 → null（界面什么都不显示）", async () => {
    expect(await buildPatchPreview(JSON.stringify({ path: "a.md" }), { bridge: null, roots: [ROOT] })).toBeNull();
    expect(await buildPatchPreview(JSON.stringify({ patch: "随便" }), { bridge: fakeBridge({}), roots: [ROOT] })).toBeNull();
  });
});
