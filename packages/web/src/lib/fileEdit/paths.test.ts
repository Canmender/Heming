import { describe, expect, it } from "vitest";
import {
  commonDirPrefix,
  compareKey,
  foldSegments,
  isAbsolutePath,
  isInsideRoot,
  isPrefixResource,
  normalizeRuleResource,
  relFromRoot,
  resolveInsideRoot,
  resourceCovers,
  segmentsOf,
  toPosixPath,
  utf8Bytes,
} from "./paths.js";

describe("路径基本归一化", () => {
  it("反斜杠统一成正斜杠并压缩多余分隔符", () => {
    expect(toPosixPath("D:\\Obsidian\\\\学院事务\\a.md")).toBe("D:/Obsidian/学院事务/a.md");
  });

  it("绝对路径识别（盘符 / POSIX 根 / 相对）", () => {
    expect(isAbsolutePath("D:/a/b.md")).toBe(true);
    expect(isAbsolutePath("D:\\a\\b.md")).toBe(true);
    expect(isAbsolutePath("/etc/passwd")).toBe(true);
    expect(isAbsolutePath("notes/a.md")).toBe(false);
    expect(isAbsolutePath("../a.md")).toBe(false);
  });

  it("折掉 . 与 ..（保留越界后的前导 ..）", () => {
    expect(foldSegments("D:/a/b/../c")).toBe("D:/a/c");
    expect(foldSegments("D:/a/./b")).toBe("D:/a/b");
    expect(foldSegments("a/../../b")).toBe("../b");
    expect(foldSegments("D:/")).toBe("D:");
  });

  it("拆段忽略空段与单点", () => {
    expect(segmentsOf("D:/a//b/./c")).toEqual(["D:", "a", "b", "c"]);
  });

  it("比较键大小写不敏感且无尾斜杠", () => {
    expect(compareKey("D:/Obsidian/学院事务/")).toBe("d:/obsidian/学院事务");
  });

  it("UTF-8 字节数按编码计（中文占 3 字节）", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("中文")).toBe(6);
  });
});

describe("规则资源归一化（规则写入与匹配共用）", () => {
  it("保留尾斜杠（前缀规则的唯一标记）", () => {
    expect(normalizeRuleResource("D:\\Obsidian\\学院事务\\")).toBe("D:/Obsidian/学院事务/");
  });

  it("没有尾斜杠的是精确规则", () => {
    expect(normalizeRuleResource("D:/Obsidian/学院事务/a.md")).toBe("D:/Obsidian/学院事务/a.md");
  });

  it("折掉 .. 后再落库（避免幽灵规则）", () => {
    expect(normalizeRuleResource("D:/Obsidian/学院事务/../私人/")).toBe("D:/Obsidian/私人/");
  });

  it("通配与非法资源", () => {
    expect(normalizeRuleResource("*")).toBe("*");
    expect(normalizeRuleResource("")).toBe("*");
    expect(normalizeRuleResource("D:/a\u0000b")).toBe("*");
    expect(normalizeRuleResource("../..")).toBe("*");
  });

  it("盘符根不算前缀规则（否则 D:/ 会匹配整盘）", () => {
    expect(isPrefixResource("D:/")).toBe(false);
    expect(isPrefixResource("D:/Obsidian/")).toBe(true);
    expect(isPrefixResource("*")).toBe(false);
    expect(isPrefixResource("D:/a.md")).toBe(false);
  });
});

describe("规则资源覆盖判定", () => {
  it("精确规则只覆盖同一个文件", () => {
    expect(resourceCovers("D:/a/x.md", "D:/a/x.md")).toBe(true);
    expect(resourceCovers("D:/a/x.md", "D:/a/y.md")).toBe(false);
    expect(resourceCovers("D:/a/x.md", "D:/a/x.md/子")).toBe(false);
  });

  it("前缀规则覆盖目录下所有文件，也覆盖目录自身", () => {
    expect(resourceCovers("D:/Obsidian/学院事务/", "D:/Obsidian/学院事务/笔记/a.md")).toBe(true);
    expect(resourceCovers("D:/Obsidian/学院事务/", "D:/Obsidian/学院事务")).toBe(true);
    expect(resourceCovers("D:/Obsidian/学院事务/", "D:/Obsidian/学院事务二/a.md")).toBe(false);
  });

  it("大小写与分隔符差异不影响命中", () => {
    expect(resourceCovers("d:\\obsidian\\学院事务\\", "D:/OBSIDIAN/学院事务/a.md")).toBe(true);
  });

  it("通配覆盖一切", () => {
    expect(resourceCovers("*", "D:/任意/路径.md")).toBe(true);
  });
});

describe("把相对路径夹进根（wiki-fs 口径 + 更严的 .. 拒绝）", () => {
  const root = "D:/Obsidian/学院事务";

  it("根内正常路径解析成绝对路径", () => {
    expect(resolveInsideRoot(root, "notes/a.md")).toBe("D:/Obsidian/学院事务/notes/a.md");
    expect(resolveInsideRoot(root, "notes\\a.md")).toBe("D:/Obsidian/学院事务/notes/a.md");
    expect(resolveInsideRoot(root, "./notes/a.md")).toBe("D:/Obsidian/学院事务/notes/a.md");
  });

  it("含 .. 的路径一律拒绝（不折叠后放过）", () => {
    expect(resolveInsideRoot(root, "../a.md")).toBeNull();
    expect(resolveInsideRoot(root, "notes/../../a.md")).toBeNull();
    expect(resolveInsideRoot(root, "notes/../a.md")).toBeNull();
  });

  it("绝对路径拒绝（目标必须相对根）", () => {
    expect(resolveInsideRoot(root, "D:/Windows/system32/x.dll")).toBeNull();
    expect(resolveInsideRoot(root, "/etc/passwd")).toBeNull();
  });

  it("NUL、空、超长拒绝", () => {
    expect(resolveInsideRoot(root, "a\u0000b.md")).toBeNull();
    expect(resolveInsideRoot(root, "")).toBeNull();
    expect(resolveInsideRoot(root, "a".repeat(400))).toBeNull();
  });

  it("根本身与等价写法拒绝（不能把根当文件写）", () => {
    expect(resolveInsideRoot(root, "")).toBeNull();
    expect(resolveInsideRoot(root, ".")).toBeNull();
    expect(resolveInsideRoot(root, "./")).toBeNull();
  });
});

describe("根内判定与相对路径还原", () => {
  const root = "D:/Obsidian/学院事务";

  it("根内为真、根外为假、同前缀不同目录为假", () => {
    expect(isInsideRoot(root, "D:/Obsidian/学院事务/notes/a.md")).toBe(true);
    expect(isInsideRoot(root, "D:/Obsidian/学院事务二/a.md")).toBe(false);
    expect(isInsideRoot(root, "C:/Obsidian/学院事务/a.md")).toBe(false);
    expect(isInsideRoot(root, "D:/Obsidian/学院事务")).toBe(false); // 根本身不是文件
  });

  it("能还原相对路径", () => {
    expect(relFromRoot(root, "D:/Obsidian/学院事务/notes/a.md")).toBe("notes/a.md");
    expect(relFromRoot(root, "D:/别处/a.md")).toBeNull();
  });
});

describe("公共目录前缀", () => {
  it("同目录多个文件取该目录", () => {
    expect(commonDirPrefix(["D:/库/笔记/a.md", "D:/库/笔记/b.md"])).toBe("D:/库/笔记/");
  });

  it("跨目录取更深层的公共祖先", () => {
    expect(commonDirPrefix(["D:/库/笔记/a.md", "D:/库/草稿/b.md"])).toBe("D:/库/");
  });

  it("只到盘符时返回 null（不能把整盘当公共前缀）", () => {
    expect(commonDirPrefix(["D:/甲/a.md", "D:/乙/b.md"])).toBeNull();
    expect(commonDirPrefix(["C:/甲/a.md", "D:/乙/b.md"])).toBeNull();
  });

  it("空输入返回 null", () => {
    expect(commonDirPrefix([])).toBeNull();
  });
});
