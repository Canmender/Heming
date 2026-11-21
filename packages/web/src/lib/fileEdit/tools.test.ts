import { describe, expect, it } from "vitest";
import type { FileFsBridge, FileReadResponse, FileWriteOp } from "./bridge.js";
import type { FileRoot } from "./paths.js";
import { MAX_FILE_BYTES } from "./limits.js";
import { FILE_TOOLS, buildFileToolBridge, buildFileToolBridgeIfAvailable, visibleFileTools } from "./tools.js";

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

  it("有桥且有可写根时注入四个工具（读两个 + 写两个），风险分别是 write / read", () => {
    const bridge = buildFileToolBridgeIfAvailable({ bridge: fakeBridge(), roots: () => [ROOT] });
    expect(bridge).not.toBeNull();
    const names = (bridge!.tools as { function: { name: string } }[]).map((t) => t.function.name);
    // 假桥只有 read/write（老安装包形状）：file_glob / file_grep 按工具隐藏，
    // 而不是注入一个调用就报「不是函数」的工具。
    expect(names).toEqual(["file_patch", "file_read", "file_write", "file_edit"]);
    expect(bridge!.meta?.("file_patch")?.risk).toBe("write");
    expect(bridge!.meta?.("file_read")?.risk).toBe("read");
    expect(bridge!.meta?.("file_write")?.risk).toBe("write");
    expect(bridge!.meta?.("file_edit")?.risk).toBe("write");
  });

  it("桥支持 glob/grep 时搜索工具才出现（老安装包按工具降级）", () => {
    const bridge = buildFileToolBridgeIfAvailable({
      bridge: { ...fakeBridge(), async glob() { return { ok: true, root: ROOT.path, paths: [], truncated: false }; },
        async grep() { return { ok: true, root: ROOT.path, matches: [], truncated: false }; } },
      roots: () => [ROOT],
    });
    expect(bridge).not.toBeNull();
    const names = (bridge!.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).toEqual(["file_patch", "file_read", "file_write", "file_edit", "file_glob", "file_grep"]);
    expect(bridge!.meta?.("file_glob")?.risk).toBe("read");
    expect(bridge!.meta?.("file_grep")?.risk).toBe("read");
  });
});

describe("工具说明体积（P2-T14：schema 也是每轮输入）", () => {

  /**
   * 七个工具的 schema 合计预算（实测 2975）。
   *
   * 从两个工具（830）一路涨到这里，每一次都必须是产品决策：d.153 六个工具 2629（用户投诉
   * 「不能写文件」）、d.168 加上读图 2975（用户说「截图里哪里不对」时模型只能让用户描述）。
   * 预算的意义是「再多一个工具就要有人解释为什么」，不是「随便调大」。
   */
  const SCHEMA_BUDGET_CHARS = 3500;

  it("八个工具的 schema 合计不超过预算（否则每轮输入都会变贵）", () => {
    const spec = FILE_TOOLS.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    const chars = JSON.stringify(spec).length;
    expect(chars, `当前 ${chars} 字符`).toBeLessThanOrEqual(SCHEMA_BUDGET_CHARS);
  });

  it("瘦身不删格式约定：补丁语法关键字都还在", () => {
    const patch = FILE_TOOLS.find((t) => t.name === "file_patch")!;
    for (const token of ["*** Begin Patch", "*** Add File", "*** Update File", "*** Delete File", "@@", "*** End Patch"]) {
      expect(patch.description).toContain(token);
    }
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

  it("正文超长截断时不在 emoji 代理对中间劈开（d.412 回归）", async () => {
    // 让代理对的低代理正好落在第 20000 位之后：高代理是第 19999 个字符（0 基 19999）。
    const content = "a".repeat(19999) + "😀" + "TAIL";
    const fake = fakeBridge({ "D:/库/a.md": content });
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT] });
    const result = await run(bridge, "file_read", { path: "a.md" });
    expect(result.ok).toBe(true);
    // 逐 UTF-16 单元走一遍：任何高代理后面必须跟低代理，反之亦然。
    for (let i = 0; i < result.text.length; i += 1) {
      const c = result.text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = result.text.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        const prev = result.text.charCodeAt(i - 1);
        expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true);
      }
    }
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

describe("工具失败契约（P2-T9）：结构化 error_code + 一次改对的重试建议", () => {
  it("file_read 文件不存在：给 not-found，并明说「新建用 Add File」", async () => {
    const bridge = buildFileToolBridge({ bridge: fakeBridge(), roots: () => [ROOT] });
    const result = await run(bridge, "file_read", { path: "没有.md" });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("not-found");
    expect(result.text).toContain("可重试：");
    expect(result.text).toContain("Add File");
  });

  it("file_read 越界：path-escape 给「改成根内相对路径」的一次改法", async () => {
    const bridge = buildFileToolBridge({ bridge: fakeBridge(), roots: () => [ROOT] });
    const result = await run(bridge, "file_read", { path: "../外面的.md" });
    expect(result.error?.error_code).toBe("path-escape");
    expect(result.text).toContain("可重试：把 path 改成根内相对路径");
    // 原有文案不动（题集 sec-005 的断言依赖它）
    expect(result.text).toContain("路径不合法或越界：../外面的.md");
  });

  it("file_patch 锚点失败：match-failed + 「先 file_read 再重写锚点」，且结论仍是最后一句", async () => {
    const fake = fakeBridge({ "D:/库/a.md": "第一行\n第二行\n" });
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT] });
    const result = await run(bridge, "file_patch", { patch: UPDATE_PATCH });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("match-failed");
    expect(result.text).toContain("锚点匹配失败（match-failed）");
    expect(result.text).toContain("可重试：先 file_read");
    expect(result.text.trimEnd().endsWith("整份补丁未写入任何文件。")).toBe(true);
    expect(fake.written).toHaveLength(0);
  });

  it("file_patch 只读根：root-readonly 拒绝，只给提示、不给可重试，且不写盘", async () => {
    const fake = fakeBridge({ "D:/参考/a.md": "旧行\n" });
    const bridge = buildFileToolBridge({
      bridge: fake,
      roots: () => [ROOT, READ_ROOT],
    });
    const result = await run(bridge, "file_patch", { patch: UPDATE_PATCH, root: "参考" });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("root-readonly");
    expect(result.text).not.toContain("可重试：");
    expect(fake.written).toHaveLength(0);
  });

  it("未知工具：unknown-tool（不会静默成功）", async () => {
    const bridge = buildFileToolBridge({ bridge: fakeBridge(), roots: () => [ROOT] });
    const result = await bridge.execute({ name: "file_delete", arguments: "{}" });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("unknown-tool");
  });
});

describe("file_image 执行（d.168）", () => {
  /** 带 image 的桥：返回一小段伪 base64，只关心形状与文案。 */
  const withImage = (impl?: (path: string) => unknown) => ({
    ...fakeBridge(),
    async image({ path }: { path: string }) {
      const custom = impl?.(path);
      if (custom) return custom as never;
      return { ok: true as const, mime: "image/png", bytes: 2048, base64: "iVBORw0KGgo=" };
    },
  });

  it("桥有 image 时 file_image 出现在清单末尾，且风险是 read", () => {
    const bridge = buildFileToolBridgeIfAvailable({ bridge: withImage(), roots: () => [ROOT] });
    expect(bridge).not.toBeNull();
    const names = (bridge!.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).toEqual(["file_patch", "file_read", "file_write", "file_edit", "file_image"]);
    expect(bridge!.meta?.("file_image")?.risk).toBe("read");
  });

  it("老安装包没有 image 方法：按工具隐藏，不让模型调用后拿到 undefined", () => {
    const bridge = buildFileToolBridgeIfAvailable({ bridge: fakeBridge(), roots: () => [ROOT] });
    const names = (bridge!.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).not.toContain("file_image");
    // 隐藏不等于不可见：真的调了也要有明确失败文案，而不是崩
    return run(bridge as ReturnType<typeof buildFileToolBridge>, "file_image", { path: "a.png" }).then((result) => {
      expect(result.ok).toBe(false);
      expect(result.error?.error_code).toBe("no-roots");
    });
  });

  it("执行成功：文本只给可核对的元信息，图片走 images 字段", async () => {
    const bridge = buildFileToolBridge({ bridge: withImage(), roots: () => [ROOT] });
    const result = await run(bridge, "file_image", { path: "截图/home.png" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("已读取图片 截图/home.png（根：库）：image/png，2 KB");
    expect(result.text).toContain("直接看图回答");
    // 图在 images 里（由视觉消息原样交给模型），文本不描述图里内容
    expect(result.images).toEqual([{ mimeType: "image/png", data: "iVBORw0KGgo=" }]);
    expect(result.text).not.toContain("iVBORw0KGgo=");
  });

  it("路径必须是根内相对：绝对路径与 .. 都被挡住", async () => {
    const bridge = buildFileToolBridge({ bridge: withImage(), roots: () => [ROOT] });
    const abs = await run(bridge, "file_image", { path: "D:/别处/a.png" });
    expect(abs.ok).toBe(false);
    expect(abs.error?.error_code).toBe("path-escape");
    const dotdot = await run(bridge, "file_image", { path: "../a.png" });
    expect(dotdot.ok).toBe(false);
    expect(dotdot.error?.error_code).toBe("path-escape");
  });

  it("不是图片：错误码 unsupported-image，并指到 file_read 看文字", async () => {
    const bridge = buildFileToolBridge({
      bridge: withImage(() => ({ ok: false, code: "unsupported-image", error: "这不是可读的图片" })),
      roots: () => [ROOT],
    });
    const result = await run(bridge, "file_image", { path: "笔记.png" });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("unsupported-image");
    expect(result.text).toContain("file_read");
  });

  it("空 path：invalid-path 而不是让主进程猜", async () => {
    const bridge = buildFileToolBridge({ bridge: withImage(), roots: () => [ROOT] });
    const result = await run(bridge, "file_image", { path: "  " });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("invalid-path");
  });
});

describe("file_undo（d.170 撤销上一次写入）", () => {
  function undoBridge(undo: (payload: { roots: FileRoot[]; path: string }) => Promise<unknown>) {
    return { ...fakeBridge(), undo } as unknown as FileFsBridge;
  }

  it("桥有 undo 时 file_undo 出现在写类清单里，且风险是 write", () => {
    const roots: FileRoot[] = [{ name: "工作区", path: "D:/工作区", mode: "write" }];
    const bridge = undoBridge(async () => ({ ok: true, path: "D:/工作区/a.md", restoredFrom: "2026-11-16T00:00:00.000Z", bytes: 3 }));
    const tool = buildFileToolBridge({ bridge, roots: () => roots, visibleTools: visibleFileTools(roots) });
    const names = (tool.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).toContain("file_undo");
    expect(tool.meta?.("file_undo")?.risk).toBe("write");
  });

  it("老安装包没有 undo 方法：按工具隐藏，不让模型调用后拿到 undefined", () => {
    const roots: FileRoot[] = [{ name: "工作区", path: "D:/工作区", mode: "write" }];
    const tool = buildFileToolBridgeIfAvailable({ bridge: fakeBridge(), roots: () => roots });
    const names = ((tool?.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).not.toContain("file_undo");
  });

  it("执行成功：报「回滚到哪一刻」并提示备份已用掉", async () => {
    const roots: FileRoot[] = [{ name: "工作区", path: "D:/工作区", mode: "write" }];
    const bridge = undoBridge(async () => ({
      ok: true,
      path: "D:/工作区/a.md",
      restoredFrom: "2026-11-16T03:00:00.000Z",
      bytes: 12,
    }));
    const tool = buildFileToolBridge({ bridge, roots: () => roots, visibleTools: visibleFileTools(roots) });
    const result = await tool.execute({ name: "file_undo", arguments: JSON.stringify({ path: "a.md" }) });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("已把 a.md（根：工作区）回滚");
    expect(result.text).toContain("12 字节");
    expect(result.text).toContain("备份已经用掉");
  });

  it("没有备份：error_code=no-backup，并明确「不要重试」", async () => {
    const roots: FileRoot[] = [{ name: "工作区", path: "D:/工作区", mode: "write" }];
    const bridge = undoBridge(async () => ({ ok: false, code: "no-backup", error: "没有「D:/工作区/a.md」的可撤销备份" }));
    const tool = buildFileToolBridge({ bridge, roots: () => roots, visibleTools: visibleFileTools(roots) });
    const result = await tool.execute({ name: "file_undo", arguments: JSON.stringify({ path: "a.md" }) });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("no-backup");
    expect(result.text).toContain("不要重试");
  });

  it("空 path：invalid-path，不去问主进程", async () => {
    const roots: FileRoot[] = [{ name: "工作区", path: "D:/工作区", mode: "write" }];
    const bridge = undoBridge(async () => {
      throw new Error("不该被调用");
    });
    const tool = buildFileToolBridge({ bridge, roots: () => roots, visibleTools: visibleFileTools(roots) });
    const result = await tool.execute({ name: "file_undo", arguments: JSON.stringify({}) });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("invalid-path");
  });

  it("绝对路径与 .. 都被挡住（撤销也只在根内）", async () => {
    const roots: FileRoot[] = [{ name: "工作区", path: "D:/工作区", mode: "write" }];
    const bridge = undoBridge(async () => {
      throw new Error("不该被调用");
    });
    const tool = buildFileToolBridge({ bridge, roots: () => roots, visibleTools: visibleFileTools(roots) });
    for (const bad of ["D:/工作区/a.md", "../外面.md"]) {
      const result = await tool.execute({ name: "file_undo", arguments: JSON.stringify({ path: bad }) });
      expect(result.ok).toBe(false);
      expect(result.error?.error_code).toMatch(/path-invalid|path-escape/);
    }
  });
});

describe("GBK 文本：读得到，但文案要说清「不能直接覆盖」（d.229）", () => {
  it("file_read 成功时带上编码提示，且正文照常显示", async () => {
    const fake = fakeBridge();
    fake.read = async () => ({ ok: true as const, content: "中文\n测试\n", bytes: 11, encoding: "gbk" as const });
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT] });
    const result = await run(bridge, "file_read", { path: "旧.txt" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("中文");
    expect(result.text).toContain("GBK 编码");
    expect(result.text).toContain("另存为新文件");
  });

  it("普通 UTF-8 文件不出现那句编码提示", async () => {
    const fake = fakeBridge({ "D:/库/a.md": "普通内容\n" });
    const bridge = buildFileToolBridge({ bridge: fake, roots: () => [ROOT] });
    const result = await run(bridge, "file_read", { path: "a.md" });
    expect(result.ok).toBe(true);
    expect(result.text).not.toContain("GBK");
  });
});
