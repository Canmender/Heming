import { describe, expect, it } from "vitest";
import {
  GROUP_SETTING_FIELDS,
  GROUP_TEMPLATES,
  groupSetArgs,
  groupTemplateArgs,
} from "./magpieGroups.js";

/** 路由分组：按模板建组、按需改设置的参数生成（纯函数，不发请求）。 */

describe("GROUP_TEMPLATES", () => {
  it("三套模板，kind 与内核 TemplateKinds 对齐，id 不重复", () => {
    expect(GROUP_TEMPLATES.map((template) => template.kind)).toEqual([
      "smart",
      "thrifty",
      "steady",
    ]);
    const ids = GROUP_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每套都说得清「建出来是干什么的」", () => {
    for (const template of GROUP_TEMPLATES) {
      expect(template.label).not.toBe("");
      expect(template.desc.length).toBeGreaterThan(8);
    }
  });
});

describe("groupTemplateArgs", () => {
  it("不填名字时让内核自己起——它会给被占用的名字编号，不会替换现有组", () => {
    expect(groupTemplateArgs("thrifty")).toEqual(["group", "template", "thrifty"]);
    expect(groupTemplateArgs("thrifty", "   ")).toEqual(["group", "template", "thrifty"]);
  });

  it("填了名字就带上，并去掉首尾空白", () => {
    expect(groupTemplateArgs("smart", "  省钱线  ")).toEqual([
      "group",
      "template",
      "smart",
      "省钱线",
    ]);
  });
});

describe("GROUP_SETTING_FIELDS", () => {
  it("键是内核认的那几个，不重复", () => {
    const keys = GROUP_SETTING_FIELDS.map((field) => field.key);
    expect(keys).toEqual(["stays", "listed", "effort", "context", "family"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("下拉项的 value 都是内核文档里写过的值", () => {
    const byKey = new Map(GROUP_SETTING_FIELDS.map((field) => [field.key, field]));
    expect(byKey.get("stays")?.options?.map((option) => option.value)).toEqual([
      "auto",
      "session",
      "turn",
      "off",
      "strict",
    ]);
    expect(byKey.get("listed")?.options?.map((option) => option.value)).toEqual(["yes", "no"]);
    expect(byKey.get("effort")?.options?.map((option) => option.value)).toEqual(["agent", "auto"]);
    // 文本项没有下拉，靠 placeholder 提示格式
    expect(byKey.get("context")?.options).toBeUndefined();
    expect(byKey.get("context")?.placeholder).toContain("272k");
  });
});

describe("groupSetArgs", () => {
  it("只发填了的项，按字段顺序，值去空白", () => {
    expect(groupSetArgs("fleet", { stays: " session ", listed: "", context: "272k" })).toEqual([
      "group",
      "set",
      "fleet",
      "stays=session",
      "context=272k",
    ]);
  });

  it("一个都没填就不发——空值等于把设置清成默认，那是另一件事", () => {
    expect(groupSetArgs("fleet", {})).toBeNull();
    expect(groupSetArgs("fleet", { stays: "  ", context: "" })).toBeNull();
  });

  it("没有组 ID 就不发（避免变成 group set 后跟一串 k=v）", () => {
    expect(groupSetArgs("   ", { stays: "auto" })).toBeNull();
  });

  it("未知键被忽略，不会把表单里的杂项硬塞给内核", () => {
    expect(groupSetArgs("fleet", { stays: "auto", bogus: "x" })).toEqual([
      "group",
      "set",
      "fleet",
      "stays=auto",
    ]);
  });
});
