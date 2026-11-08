import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeRel,
  createMemoryVaultBridge,
  describeVaultError,
  getVaultBridge,
  isInsideWriteDirs,
  isVaultEphemeral,
  isVaultErrorCode,
  resolveVaultBridge,
  toVaultBridgeError,
  VAULT_ERROR_TEXT,
} from "./bridge.js";
import { MAX_PATH_CHARS, MAX_TEXT_BYTES, VaultBridgeError, type VaultBridge } from "./types.js";

/**
 * vault 文件桥：桌面桥探测、内存降级实现的契约、错误归一化。
 *
 * 内存桥与桌面桥同形（`VaultBridge`），所以这里钉住的口径对桌面实现同样适用：
 * 路径守卫、扩展名分级、大小上限、writeDirs 边界、expectMtime、watch 通知与取消。
 */

const MEMORY_VAULT = "memory";

function stubDesktopBridge(bridge: VaultBridge | null): void {
  const target = window as unknown as { __heming_vault?: VaultBridge };
  if (bridge) target.__heming_vault = bridge;
  else delete target.__heming_vault;
}

afterEach(() => {
  stubDesktopBridge(null);
});

describe("桌面桥探测", () => {
  it("window.__heming_vault 存在时用它，否则返回 null", () => {
    expect(getVaultBridge()).toBeNull();
    expect(isVaultEphemeral()).toBe(true);

    const fake = createMemoryVaultBridge();
    stubDesktopBridge(fake);
    expect(getVaultBridge()).toBe(fake);
    expect(isVaultEphemeral()).toBe(false);
  });

  it("resolveVaultBridge 无桌面桥时降级到内存实现（且是单例）", () => {
    const bridge = resolveVaultBridge();
    expect(bridge).toBe(resolveVaultBridge());
    expect(typeof bridge.list).toBe("function");
  });
});

describe("错误归一化", () => {
  it("VaultBridgeError 原样返回", () => {
    const err = new VaultBridgeError("too-large", "太大了");
    expect(toVaultBridgeError(err)).toBe(err);
    expect(describeVaultError(err)).toBe("太大了");
  });

  it("IPC 拒绝时传的 { code, message } 纯对象也能归一", () => {
    const normalized = toVaultBridgeError({ code: "outside-write-dirs", message: "越界" });
    expect(normalized).toBeInstanceOf(VaultBridgeError);
    expect(normalized.code).toBe("outside-write-dirs");
    expect(normalized.message).toBe("越界");
    // 没给 message 时用默认中文文案
    expect(toVaultBridgeError({ code: "not-found" }).message).toBe(VAULT_ERROR_TEXT["not-found"]);
  });

  it("普通 Error / 字符串 / 未知值统一归到 io-error", () => {
    expect(toVaultBridgeError(new Error("boom")).code).toBe("io-error");
    expect(toVaultBridgeError(new Error("boom")).message).toBe("boom");
    expect(toVaultBridgeError("坏了").message).toBe("坏了");
    const unknown = toVaultBridgeError(undefined);
    expect(unknown.code).toBe("io-error");
    expect(unknown.message).toBe(VAULT_ERROR_TEXT["io-error"]);
  });

  it("isVaultErrorCode 只认合法码", () => {
    expect(isVaultErrorCode("stale-mtime")).toBe(true);
    expect(isVaultErrorCode("whatever")).toBe(false);
    expect(isVaultErrorCode(1)).toBe(false);
  });
});

describe("路径守卫", () => {
  it("拒绝绝对路径、盘符、..、NUL、隐藏目录、保留名与超长路径", () => {
    for (const bad of [
      "/abs/x.md",
      "C:/x.md",
      "../x.md",
      "a/../../x.md",
      "a\u0000b.md",
      ".obsidian/x.md",
      ".hidden.md",
      "CON.md",
      "a/com1.txt",
      "a/",
      `${"a".repeat(MAX_PATH_CHARS)}.md`,
    ]) {
      expect(() => assertSafeRel(bad)).toThrow(VaultBridgeError);
    }
  });

  it("规范化反斜杠并接受正常相对路径", () => {
    expect(assertSafeRel("a\\b\\c.md")).toBe("a/b/c.md");
    expect(assertSafeRel("inbox/记忆.md")).toBe("inbox/记忆.md");
  });

  it("writeDirs 边界：目录本身与其子路径算内，其余算外", () => {
    expect(isInsideWriteDirs("inbox", ["inbox"])).toBe(true);
    expect(isInsideWriteDirs("inbox/a.md", ["inbox"])).toBe(true);
    expect(isInsideWriteDirs("inbox/deep/a.md", ["inbox"])).toBe(true);
    expect(isInsideWriteDirs("inbox2/a.md", ["inbox"])).toBe(false);
    expect(isInsideWriteDirs("notes/a.md", ["inbox"])).toBe(false);
    expect(isInsideWriteDirs("notes/a.md", [])).toBe(false);
  });
});

describe("内存桥", () => {
  it("与 VaultBridge 同形：所有方法都在", () => {
    const bridge = createMemoryVaultBridge();
    const names: (keyof VaultBridge)[] = [
      "list",
      "pick",
      "remove",
      "rename",
      "tree",
      "read",
      "readBinary",
      "write",
      "apply",
      "create",
      "move",
      "delete",
      "reveal",
      "watch",
    ];
    for (const name of names) expect(typeof bridge[name]).toBe("function");
  });

  it("库的增删改名与默认库", async () => {
    const bridge = createMemoryVaultBridge({ now: () => 1000 });
    const list = await bridge.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: MEMORY_VAULT, writeDirs: ["inbox"] });

    const picked = await bridge.pick();
    expect(picked).not.toBeNull();
    expect((await bridge.list()).map((v) => v.id)).toContain(picked!.id);

    const renamed = await bridge.rename(picked!.id, "我的库");
    expect(renamed.name).toBe("我的库");

    expect(await bridge.remove(picked!.id)).toBe(true);
    expect(await bridge.remove("不存在")).toBe(false);
  });

  it("初始文件、目录树与读取", async () => {
    const bridge = createMemoryVaultBridge({
      files: {
        "a.md": "# A\n",
        "dir/b.md": "# B\n",
        "dir/deep/c.md": "# C\n",
        "img.png": "data:image/png;base64,AAA",
      },
    });
    const tree = await bridge.tree(MEMORY_VAULT);
    expect(tree.map((entry) => [entry.rel, entry.kind])).toEqual([
      ["dir", "dir"],
      ["a.md", "md"],
      ["img.png", "image"],
    ]);
    // 默认 depth=2：根的子项 + 目录的一层子项（目录在前，文件在后）
    expect(tree[0].children?.map((entry) => entry.rel)).toEqual(["dir/deep", "dir/b.md"]);
    expect(tree[0].children?.[0].children).toBeUndefined();

    const deepTree = await bridge.tree(MEMORY_VAULT, { depth: 8 });
    expect(deepTree[0].children?.[0].children?.map((entry) => entry.rel)).toEqual(["dir/deep/c.md"]);

    const doc = await bridge.read(MEMORY_VAULT, "dir/b.md");
    expect(doc).toMatchObject({ vaultId: MEMORY_VAULT, rel: "dir/b.md", text: "# B\n" });
    expect(doc?.size).toBe(4);
    expect(await bridge.read(MEMORY_VAULT, "nope.md")).toBeNull();

    const image = await bridge.readBinary(MEMORY_VAULT, "img.png");
    expect(image).toMatchObject({ rel: "img.png", mime: "image/png" });
  });

  it("写入 / 创建 / 改名 / 删除与 watch 通知", async () => {
    const bridge = createMemoryVaultBridge({ now: () => 1000 });
    const changes: string[][] = [];
    const off = bridge.watch(MEMORY_VAULT, (rels) => changes.push(rels));

    const written = await bridge.write(MEMORY_VAULT, "notes/a.md", "你好");
    expect(written.rel).toBe("notes/a.md");
    expect((await bridge.read(MEMORY_VAULT, "notes/a.md"))?.text).toBe("你好");

    await bridge.create(MEMORY_VAULT, "notes/b.md", "B");
    await expect(bridge.create(MEMORY_VAULT, "notes/b.md", "B")).rejects.toMatchObject({
      code: "io-error",
    });

    expect(await bridge.move(MEMORY_VAULT, "notes/b.md", "notes/c.md")).toBe(true);
    expect(await bridge.move(MEMORY_VAULT, "notes/c.md", "notes/a.md")).toBe(false);
    expect(await bridge.delete(MEMORY_VAULT, "notes/c.md")).toBe(true);
    // 删除只删单个文件，不认目录
    expect(await bridge.delete(MEMORY_VAULT, "notes")).toBe(false);

    expect(changes).toEqual([["notes/a.md"], ["notes/b.md"], ["notes/b.md", "notes/c.md"], ["notes/c.md"]]);

    off();
    await bridge.write(MEMORY_VAULT, "notes/d.md", "D");
    expect(changes).toHaveLength(4);
  });

  it("expectMtime：版本不一致拒绝覆盖，一致才写", async () => {
    const bridge = createMemoryVaultBridge({ now: () => 1000 });
    const first = await bridge.write(MEMORY_VAULT, "a.md", "第一版");
    const second = await bridge.write(MEMORY_VAULT, "a.md", "第二版", {
      expectMtime: first.mtime,
    });
    expect(second.mtime).not.toBe(first.mtime); // 单调时钟：同毫秒也能区分
    await expect(
      bridge.write(MEMORY_VAULT, "a.md", "第三版", { expectMtime: first.mtime }),
    ).rejects.toMatchObject({ code: "stale-mtime" });
    await expect(
      bridge.write(MEMORY_VAULT, "missing.md", "x", { expectMtime: first.mtime }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("智能体通道只允许 writeDirs，append 追加", async () => {
    const bridge = createMemoryVaultBridge();
    await expect(
      bridge.apply({ vaultId: MEMORY_VAULT, rel: "notes/a.md", text: "x" }),
    ).rejects.toMatchObject({ code: "outside-write-dirs" });

    await bridge.apply({ vaultId: MEMORY_VAULT, rel: "inbox/a.md", text: "第一段" });
    await bridge.apply({ vaultId: MEMORY_VAULT, rel: "inbox/a.md", text: "第二段", mode: "append" });
    expect((await bridge.read(MEMORY_VAULT, "inbox/a.md"))?.text).toBe("第一段\n第二段");
  });

  it("扩展名与大小上限", async () => {
    const bridge = createMemoryVaultBridge();
    await expect(bridge.read(MEMORY_VAULT, "a.exe")).rejects.toMatchObject({
      code: "forbidden-ext",
    });
    await expect(bridge.write(MEMORY_VAULT, "a.exe", "x")).rejects.toMatchObject({
      code: "forbidden-ext",
    });
    await expect(bridge.readBinary(MEMORY_VAULT, "a.md")).rejects.toMatchObject({
      code: "forbidden-ext",
    });
    await expect(
      bridge.write(MEMORY_VAULT, "big.md", "x".repeat(MAX_TEXT_BYTES + 1)),
    ).rejects.toMatchObject({ code: "too-large" });
  });

  it("未知库一律 no-vault", async () => {
    const bridge = createMemoryVaultBridge();
    await expect(bridge.read("nope", "a.md")).rejects.toMatchObject({ code: "no-vault" });
    await expect(bridge.tree("nope")).rejects.toMatchObject({ code: "no-vault" });
  });

  it("reveal 在浏览器里返回 false", async () => {
    const bridge = createMemoryVaultBridge();
    expect(await bridge.reveal(MEMORY_VAULT, "a.md")).toBe(false);
  });

  it("createDir：多级 mkdir -p、幂等、空目录出现在 tree 里", async () => {
    const bridge = createMemoryVaultBridge();
    const created = await bridge.createDir(MEMORY_VAULT, "新目录/子目录/更深");
    expect(created).toEqual({ rel: "新目录/子目录/更深", bytes: 0, mtime: expect.any(String) });

    const tree = await bridge.tree(MEMORY_VAULT, { depth: 4 });
    expect(tree.map((entry) => [entry.rel, entry.kind])).toEqual([
      ["新目录", "dir"],
    ]);
    expect(tree[0].children?.map((entry) => entry.rel)).toEqual(["新目录/子目录"]);
    expect(tree[0].children?.[0].children?.map((entry) => entry.rel)).toEqual([
      "新目录/子目录/更深",
    ]);
    // 空目录按 rel 拉子树：depth=1 只返回直接子目录（更深一层）
    expect(
      (await bridge.tree(MEMORY_VAULT, { rel: "新目录/子目录", depth: 1 })).map(
        (entry) => entry.rel,
      ),
    ).toEqual(["新目录/子目录/更深"]);

    // 幂等：重复创建成功且不产生重复节点
    await expect(bridge.createDir(MEMORY_VAULT, "新目录/子目录/更深")).resolves.toMatchObject({
      rel: "新目录/子目录/更深",
      bytes: 0,
    });
    const again = await bridge.tree(MEMORY_VAULT, { depth: 4 });
    expect(again).toHaveLength(1);
    expect(again[0].children?.[0].children).toHaveLength(1);
  });

  it("createDir 的路径守卫与文件写入一致", async () => {
    const bridge = createMemoryVaultBridge();
    for (const bad of ["../escape", "/abs", "C:/x", ".hidden/x", "a\u0000b", "CON"]) {
      await expect(bridge.createDir(MEMORY_VAULT, bad)).rejects.toMatchObject({
        code: "forbidden-path",
      });
    }
    await expect(bridge.createDir("nope", "a")).rejects.toMatchObject({ code: "no-vault" });
  });

  it("写文件时自动登记祖先目录（tree 不需要额外 createDir）", async () => {
    const bridge = createMemoryVaultBridge({ files: { "a/b/c.md": "正文\n" } });
    const tree = await bridge.tree(MEMORY_VAULT, { depth: 3 });
    expect(tree[0].rel).toBe("a");
    expect(tree[0].children?.[0].rel).toBe("a/b");
    expect(tree[0].children?.[0].children?.[0].rel).toBe("a/b/c.md");
  });
});
