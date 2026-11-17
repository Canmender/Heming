import { describe, expect, it } from "vitest";
import { parseToolFailure, failureNextStep, failureCode, FAILURE_HEADLINE_MAX } from "./toolFailure.js";

describe("工具失败的界面摘要（d.220）", () => {
  it("第一行就是标题，提示与可重试分别抽出来", () => {
    const note = parseToolFailure(
      [
        "路径不可用（path-escape）：D:/外面/x.md 不在可写根里",
        "可重试：把 path 改成工作区内的相对路径",
        "提示：这个目录没有被授权写入",
      ].join("\n"),
    );
    expect(note).toEqual({
      headline: "路径不可用（path-escape）：D:/外面/x.md 不在可写根里",
      hint: "这个目录没有被授权写入",
      retry: "把 path 改成工作区内的相对路径",
    });
  });

  it("只有标题时 hint/retry 都是 null", () => {
    expect(parseToolFailure("锚点匹配失败（match-failed）：没找到那一行")).toEqual({
      headline: "锚点匹配失败（match-failed）：没找到那一行",
      hint: null,
      retry: null,
    });
  });

  it("空串 / 空白 / 未定义 / null 都不算失败", () => {
    expect(parseToolFailure("")).toBeNull();
    expect(parseToolFailure("  \r\n \n ")).toBeNull();
    expect(parseToolFailure(undefined)).toBeNull();
    expect(parseToolFailure(null)).toBeNull();
  });

  it("超长标题按码点截断（不劈开代理对）并补省略号", () => {
    const long = `写入失败（write-failed）：${"😀".repeat(200)}`;
    const note = parseToolFailure(long);
    expect(note).not.toBeNull();
    const headline = note!.headline;
    expect([...headline]).toHaveLength(FAILURE_HEADLINE_MAX);
    expect(headline.endsWith("…")).toBe(true);
    expect(headline.includes("\uFFFD")).toBe(false);
  });

  it("多行说明只取第一行做标题，其余不拼进 headline", () => {
    const note = parseToolFailure("未知工具（unknown-tool）：没有叫 x 的工具\n第二行是说明\n第三行");
    expect(note?.headline).toBe("未知工具（unknown-tool）：没有叫 x 的工具");
  });

  it("空的「提示：」「可重试：」不当成有内容", () => {
    const note = parseToolFailure("写入失败（write-failed）：磁盘满了\n提示：\n可重试：   ");
    expect(note).toEqual({ headline: "写入失败（write-failed）：磁盘满了", hint: null, retry: null });
    expect(note && failureNextStep(note)).toBeNull();
  });

  it("下一步优先提示，其次可重试，都没有就是 null", () => {
    const both = parseToolFailure("x（y）：z\n可重试：换个写法\n提示：先选工作区");
    expect(both && failureNextStep(both)).toBe("先选工作区");
    const onlyRetry = parseToolFailure("x（y）：z\n可重试：换个写法");
    expect(onlyRetry && failureNextStep(onlyRetry)).toBe("可重试：换个写法");
    const none = parseToolFailure("x（y）：z");
    expect(none && failureNextStep(none)).toBeNull();
  });

  it("拒绝执行的文案也按同一套解析（用户看得到为什么没做）", () => {
    const note = parseToolFailure(
      "本次工具调用未执行（approval-denied）：这不是用户的选择\n提示：在弹窗里点「允许」后重发一次",
    );
    expect(note?.headline).toContain("approval-denied");
    expect(note && failureNextStep(note)).toContain("点「允许」");
  });
});

describe("从失败文本里取稳定错误码（d.221）", () => {
  it("取中文括号里的英文 kebab-case：路径越界", () => {
    expect(failureCode("路径不可用（path-escape）：D:/外面/x.md 不在可写根里\n提示：先选工作区")).toBe(
      "path-escape",
    );
  });

  it("没有可写根、锚点没匹配这类都取得出来", () => {
    expect(failureCode("写入失败（no-roots）：这个会话没有可写目录")).toBe("no-roots");
    expect(failureCode("锚点匹配失败（match-failed）：没找到那一行")).toBe("match-failed");
  });

  it("只看第一行：正文里的括号英文不会被当成错误码", () => {
    expect(failureCode("读取失败（read-failed）：文件不存在\n（detail）备注")).toBe("read-failed");
  });

  it("取不到就返回 null，不按中文猜", () => {
    expect(failureCode("写入失败：磁盘满了")).toBeNull();
    expect(failureCode("（某段中文）说明")).toBeNull();
    expect(failureCode("")).toBeNull();
    expect(failureCode(undefined)).toBeNull();
  });
});
