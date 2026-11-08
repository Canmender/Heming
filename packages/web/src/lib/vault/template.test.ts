import { describe, expect, it } from "vitest";
import {
  applyTemplate,
  DEFAULT_DATE_FORMAT,
  DEFAULT_TIME_FORMAT,
  formatDateTokens,
  renderTemplate,
} from "./template.js";

/**
 * 模板渲染：变量替换、日期格式子集、未知占位符原样保留并回报。
 *
 * 时间一律用固定 `Date`（本地 2026-11-08 16:34:05），保证跨机器确定性。
 */

const NOW = new Date(2026, 10, 8, 16, 34, 5);

describe("formatDateTokens", () => {
  it("默认格式：日期 YYYY-MM-DD、时间 HH:mm", () => {
    expect(formatDateTokens(NOW, DEFAULT_DATE_FORMAT)).toBe("2026-11-08");
    expect(formatDateTokens(NOW, DEFAULT_TIME_FORMAT)).toBe("16:34");
  });

  it("只做 Y/M/D/H/m/s 子集：单字母不补零、双字母补零", () => {
    expect(formatDateTokens(NOW, "YYYY/MM/DD")).toBe("2026/11/08");
    expect(formatDateTokens(NOW, "YY-M-D")).toBe("26-11-8");
    expect(formatDateTokens(NOW, "HH:mm:ss")).toBe("16:34:05");
    expect(formatDateTokens(NOW, "H:m:s")).toBe("16:34:5");
  });

  it("格式里的非字母原样输出（中文可用）", () => {
    expect(formatDateTokens(NOW, "YYYY年MM月DD日")).toBe("2026年11月08日");
    expect(formatDateTokens(NOW, "第MM周")).toBe("第11周");
  });

  it("非法日期回退到本地 1970-01-01（不随系统时区漂移）", () => {
    expect(formatDateTokens(new Date(Number.NaN), DEFAULT_DATE_FORMAT)).toBe("1970-01-01");
  });
});

describe("renderTemplate", () => {
  it("替换 title / date / time / vault", () => {
    const result = renderTemplate("# {{title}}\n{{date}} {{time}} @{{vault}}", {
      title: "会议纪要",
      date: NOW,
      vault: "和鸣知识库",
    });
    expect(result.text).toBe("# 会议纪要\n2026-11-08 16:34 @和鸣知识库");
    expect(result.unknown).toEqual([]);
  });

  it("花括号里允许空格，变量名大小写不敏感", () => {
    const result = renderTemplate("{{ title }}|{{TITLE}}|{{ Date }}", {
      title: "甲",
      date: NOW,
    });
    expect(result.text).toBe("甲|甲|2026-11-08");
  });

  it("{{date:FORMAT}} 用自定义格式", () => {
    const result = renderTemplate("{{date:YYYY年MM月DD日}} {{date:HH:mm}}", { date: NOW });
    expect(result.text).toBe("2026年11月08日 16:34");
  });

  it("空的 date: 格式回退默认日期", () => {
    expect(renderTemplate("{{date:}}", { date: NOW }).text).toBe("2026-11-08");
  });

  it("未知占位符原样保留，并去重回报 unknown", () => {
    const result = renderTemplate("{{foo}} {{foo}} {{bar}} {{title}}", { title: "甲" });
    expect(result.text).toBe("{{foo}} {{foo}} {{bar}} 甲");
    expect(result.unknown).toEqual(["foo", "bar"]);
  });

  it("空模板 / 没有变量时是确定性的空串替换", () => {
    expect(renderTemplate("")).toEqual({ text: "", unknown: [] });
    expect(renderTemplate("没有占位符").text).toBe("没有占位符");
    expect(renderTemplate("{{title}}|{{vault}}").text).toBe("|");
  });

  it("不匹配换行内的花括号（只处理单行占位符）", () => {
    const result = renderTemplate("{{a\nb}}", { title: "甲" });
    expect(result.text).toBe("{{a\nb}}");
    expect(result.unknown).toEqual([]);
  });
});

describe("applyTemplate", () => {
  it("固定 now 时输出确定；title/vault 缺省为空串", () => {
    expect(
      applyTemplate({
        template: "# {{title}}\n{{date}} {{time}} {{vault}}",
        title: "日记",
        now: NOW,
        vaultName: "库",
      }),
    ).toBe("# 日记\n2026-11-08 16:34 库");
    expect(applyTemplate({ template: "{{title}}{{vault}}", title: "" })).toBe("");
  });

  it("未知占位符按原样保留（applyTemplate 不分叉）", () => {
    expect(applyTemplate({ template: "{{unknown}} {{title}}", title: "甲", now: NOW })).toBe(
      "{{unknown}} 甲",
    );
  });
});
