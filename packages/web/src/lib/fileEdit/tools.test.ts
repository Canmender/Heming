import { describe, expect, it } from "vitest";
import type { FileFsBridge, FileReadResponse, FileWriteOp } from "./bridge.js";
import type { FileRoot } from "./paths.js";
import { MAX_FILE_BYTES } from "./limits.js";
import { buildFileToolBridge, buildFileToolBridgeIfAvailable } from "./tools.js";

const ROOT: FileRoot = { name: "库", path: "D:/库", mode: "write" };
const READ_ROOT: FileRoot = { name: "参考", path: "D:/参考", mode: "read" };

/** 内存桥：文件系统就是一个 `绝对路径 → 内容` 的对象。 */
function fakeBridge(initial: Record<string, string> = {}) {
  const files: Record<string, string> = { ...initial };
  const written: FileWriteOp[][] = [];
  const bridge: FileFsBridge & { written: FileWriteOp[][]; files: Record<string, string> } = {
    files,
    written,
    async read({ path }): Promise<FileReadResponse> {
      if (path in files) {
        const content = files[path];
        return { ok: true, content, bytes: new TextEncoder().encode(content).length };
      }
      return { ok: false, code: "not-found", error: "文件不存在" };
    },
    async write({ ops }) {
      written.push(ops);
      for (const op of ops) {
        if (op.kind === "write") files[op.path] = op.content ?? "";
        else delete files[op.path];
      }
      return {
        ok: true,
        results: ops.map((op) => ({ path: op.path, ok: true })),
        written: ops.filter((op) => op.kind === "write").length,
        deleted: ops.filter((op) => op.kind === "delete").length,
      };
    },
    async pickRoot() {
      return null;
    },
  };
  return bridge;
}

/** 执行一次调用（工具桥接口就是 `{name, arguments}`）。 */
async function run(
  bridge: ReturnType<typeof buildFileToolBridge>,
  name: string,
  args: unknown,
) {
  return bridge.execute({ name, arguments: JSON.stringify(args) });
}

const patchArgs = (patch: string, root?: string) => (root ? { patch, root } : { patch });

/** 一个最小可用的补丁（改 D:/库/a.md 的第二行）。 */
const UPDATE_PATCH = [
  "*** Begin Patch",
  "*** Update File: a.md",
  "@@",
  "-旧行",
  "+新行",
  "*** End Patch",
].join("\n");

describe("工具可见性（产品决策：桌面桥 + 至少一条可写根）", () => {
  it("没有桌面桥时不注入", () => {
    expect(buildFileToolBridgeIfAvailable({ bridge: undefined, roots: () => [ROOT] })).toBeNull();
  });

  it("有桥但没有可写根时不注入", () => {
    expect(buildFileToolBridgeIfAvailable({ bridge: fakeBridge(), roots: () => [] })).toBeNull();
  });

  it("只有只读根：file_read 可见，file_patch 不可见（只读根也有存在意义）", async () => {
    const bridge = buildFileToolBridgeIfAvailable({ bridge: fakeBridge(), roots: () => [READ_ROOT] });
    expect(bridge).not.toBeNull();
    const names = (bridge!.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).toEqual(["file_read"]);
    // 强行调用不可见的 file_patch 也要被拒，并给出「去设置区加写根」的出路
    const result = await run(bridge!, "file_patch", patchArgs(UPDATE_PATCH));
    expect(result.ok).toBe(false);
    expect(result.text).toContain("可写根");
    expect(result.text).toContain("设置 → 文件编辑");
  });

  it("没有任何根：两个工具都不注入", () => {
    expect(buildFileToolBridgeIfAvailable({ bridge: fakeBridge(), roots: () => [] })).toBeNull();
  });

  it("有桥且有可写根时注入两个工具，风险分别是 write / read", () => {
    const bridge = buildFileToolBridgeIfAvailable({ bridge: fakeBridge(), roots: () => [ROOT] });
    expect(bridge).not.toBeNull();
    const names = (bridge!.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).toEqual(["file_patch", "file_read"]);
    expect(bridge!.meta?.("file_patch")?.risk).toBe("write");
    expect(bridge!.meta?.("file_read")?.risk).toBe("read");
  });
});

describe("file_patch 执行", () => {
  it("成功：写盘一次、结果里给出 A/M/D 清单", async () => {
    const fake = fakeBridge({ "D:/库/a.md": "旧行\n" });
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT] });
    const result = await run(bridge, "file_patch", patchArgs(UPDATE_PATCH));
    expect(result.ok).toBe(true);
    expect(result.text).toContain("将修改 1 个文件（1 个修改）");
    expect(result.text).toContain("M  a.md");
    expect(fake.files["D:/库/a.md"]).toBe("新行\n");
    expect(fake.written).toHaveLength(1);
  });

  it("多文件补丁：一次写入，A/M/D 都对", async () => {
    const fake = fakeBridge({ "D:/库/a.md": "旧行\n", "D:/库/old.md": "删\n" });
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT] });
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.md",
      "@@",
      "-旧行",
      "+新行",
      "*** Add File: b.md",
      "+新增内容",
      "*** Delete File: old.md",
      "*** End Patch",
    ].join("\n");
    const result = await run(bridge, "file_patch", patchArgs(patch));
    expect(result.ok).toBe(true);
    expect(result.text).toContain("1 个新增");
    expect(result.text).toContain("1 个修改");
    expect(result.text).toContain("1 个删除");
    expect(fake.files["D:/库/b.md"]).toBe("新增内容\n");
    expect("D:/库/old.md" in fake.files).toBe(false);
  });

  it("补丁格式错：回给模型格式原因，且一个字都没写", async () => {
    const fake = fakeBridge();
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT] });
    const result = await run(bridge, "file_patch", patchArgs("*** Add File: a.md\n少了前缀\n*** End Patch"));
    expect(result.ok).toBe(false);
    expect(result.text).toContain("补丁格式不合法");
    expect(result.text).toContain("整份补丁未写入任何文件");
    expect(fake.written).toHaveLength(0);
  });

  it("锚点匹配失败：文案带文件、块号与「先 file_read」建议", async () => {
    const fake = fakeBridge({ "D:/库/a.md": "完全不同的内容\n" });
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT] });
    const result = await run(bridge, "file_patch", patchArgs(UPDATE_PATCH));
    expect(result.ok).toBe(false);
    expect(result.text).toContain("锚点匹配失败");
    expect(result.text).toContain("file_read");
    expect(result.text).toContain("第 1 个");
    expect(fake.written).toHaveLength(0);
  });

  it("路径越界：被拒绝且不写盘，文案给出「加写根」的出路", async () => {
    const fake = fakeBridge();
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT] });
    const result = await run(
      bridge,
      "file_patch",
      patchArgs("*** Begin Patch\n*** Add File: ../逃逸.md\n+x\n*** End Patch"),
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain("路径越界");
    expect(result.text).toContain("目标不在可写根内；如需写入，请先在「设置 → 文件编辑」添加该目录为写根。");
    expect(fake.written).toHaveLength(0);
  });

  it("只读根：干跑阶段就按「只读根」拒绝（不给写入机会）", async () => {
    const fake = fakeBridge({ "D:/参考/a.md": "内容\n" });
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT, READ_ROOT] });
    const result = await run(
      bridge,
      "file_patch",
      patchArgs(
        ["*** Begin Patch", "*** Update File: a.md", "@@", "-内容", "+新", "*** End Patch"].join("\n"),
        "参考",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain("只读根");
    expect(result.text).toContain("整份补丁未写入任何文件");
    expect(fake.written).toHaveLength(0);
  });

  it("未配置可写根：提示去设置区添加", async () => {
    const bridge = buildFileToolBridge({ bridge: fakeBridge(), roots: () => [] });
    const result = await run(bridge, "file_patch", patchArgs(UPDATE_PATCH));
    expect(result.ok).toBe(false);
    expect(result.text).toContain("设置 → 文件编辑");
  });

  it("写盘层失败：把逐文件失败原因带回给模型", async () => {
    const fake = fakeBridge({ "D:/库/a.md": "旧行\n" });
    fake.write = async () => ({
      ok: false,
      error: "1 个文件未能完成（其余已写入）",
      results: [{ path: "D:/库/a.md", ok: false, error: "替换失败：占用中" }],
    });
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT] });
    const result = await run(bridge, "file_patch", patchArgs(UPDATE_PATCH));
    expect(result.ok).toBe(false);
    expect(result.text).toContain("替换失败");
    expect(result.text).toContain("占用中");
  });

  it("超大文件：拒绝并说明上限", async () => {
    const fake = fakeBridge();
    fake.read = async () => ({
      ok: false,
      code: "too-large",
      error: "超过单文件上限",
    });
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT] });
    const result = await run(bridge, "file_patch", patchArgs(UPDATE_PATCH));
    expect(result.ok).toBe(false);
    expect(result.text).toContain("文件过大");
    expect(result.text).toContain(String(Math.round(MAX_FILE_BYTES / 1024)));
  });
});

describe("file_read 执行", () => {
  it("成功：带路径、行号区间与内容", async () => {
    const fake = fakeBridge({ "D:/库/a.md": "第一行\n第二行\n第三行\n" });
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT] });
    const result = await run(bridge, "file_read", { path: "a.md" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("路径：a.md（根：库）");
    expect(result.text).toContain("共 3 行，本次显示第 1–3 行");
    expect(result.text).toContain("第二行");
    expect(result.sources?.[0]).toMatchObject({ id: "a.md", detail: "库" });
  });

  it("offset / limit 分段读取", async () => {
    const fake = fakeBridge({ "D:/库/a.md": "一\n二\n三\n四\n" });
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT] });
    const result = await run(bridge, "file_read", { path: "a.md", offset: 2, limit: 2 });
    expect(result.text).toContain("共 4 行，本次显示第 2–3 行");
    expect(result.text).toContain("二\n三");
    expect(result.text).not.toContain("一");
  });

  it("只读根可读", async () => {
    const fake = fakeBridge({ "D:/参考/a.md": "参考内容\n" });
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT, READ_ROOT] });
    const result = await run(bridge, "file_read", { path: "a.md", root: "参考" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("参考内容");
  });

  it("文件不存在：建议用 Add File 新建", async () => {
    const bridge = buildFileToolBridge({ bridge: fakeBridge(), roots: () => [ROOT] });
    const result = await run(bridge, "file_read", { path: "没有.md" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Add File");
  });

  it("路径越界：明确说只接受根内相对路径", async () => {
    const bridge = buildFileToolBridge({ bridge: fakeBridge(), roots: () => [ROOT] });
    const result = await run(bridge, "file_read", { path: "../外面的.md" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("相对路径");
    expect(result.text).toContain("不能包含");
  });

  it("二进制：说明只处理 UTF-8 文本", async () => {
    const fake = fakeBridge();
    fake.read = async () => ({ ok: false, code: "binary", error: "这不是文本文件" });
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT] });
    const result = await run(bridge, "file_read", { path: "a.bin" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("UTF-8");
  });

  it("根名不存在：列出可用根", async () => {
    const bridge = buildFileToolBridge({ bridge: fakeBridge(), roots: () => [ROOT] });
    const result = await run(bridge, "file_read", { path: "a.md", root: "不存在" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("库");
  });
});
