import { describe, expect, it } from "vitest";
import {
  ExecutionAbortedError,
  errorDescriptionOf,
  errorMessage,
  isAbortError,
  passThroughInput,
  routeErrorItemsToLastOutput,
  toNodeErrorInfo,
} from "./errors.js";
import { item } from "./testSupport.js";
import type { NodeErrorInfo } from "../types.js";

const node = { id: "n1", name: "设置字段", type: "set" };

describe("toNodeErrorInfo", () => {
  it("Error → 结构化错误（消息、节点、堆栈都带上）", () => {
    const error = new Error("连接超时");
    const info = toNodeErrorInfo(error, node);
    expect(info.message).toBe("连接超时");
    expect(info.nodeId).toBe("n1");
    expect(info.nodeName).toBe("设置字段");
    expect(info.nodeType).toBe("set");
    expect(info.stack).toBeTruthy();
  });

  it("带 statusCode 的错误 → httpCode 转成字符串（与 n8n 展示一致）", () => {
    const error = Object.assign(new Error("请求失败"), { statusCode: 429 });
    expect(toNodeErrorInfo(error, node).httpCode).toBe("429");
    const second = Object.assign(new Error("请求失败"), { httpCode: "401" });
    expect(toNodeErrorInfo(second).httpCode).toBe("401");
  });

  it("字符串/空对象异常也能得到可读消息（不让执行记录里出现 [object Object]）", () => {
    expect(errorMessage("炸了")).toBe("炸了");
    expect(errorMessage({ message: "对象里的消息" })).toBe("对象里的消息");
    expect(errorMessage({})).toBe("执行失败（错误对象为空）");
    expect(errorMessage(null)).toBe("执行失败");
  });

  it("补充说明与优先字段", () => {
    const info = toNodeErrorInfo(new Error("x"), node, {
      description: "检查凭据",
      itemIndex: 3,
    });
    expect(info.description).toBe("检查凭据");
    expect(info.itemIndex).toBe(3);
  });
});

describe("isAbortError", () => {
  it("识别取消哨兵与 AbortError，普通错误不算", () => {
    expect(isAbortError(new ExecutionAbortedError())).toBe(true);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isAbortError(abort)).toBe(true);
    expect(isAbortError(new Error("普通失败"))).toBe(false);
    expect(isAbortError("字符串")).toBe(false);
  });
});

describe("buildErrorItems / routeErrorItemsToLastOutput", () => {
  it("没有输入时也产出 1 条错误项（否则错误输出口为空、下游不会被调度）", () => {
    const info: NodeErrorInfo = { message: "失败了" };
    const output = routeErrorItemsToLastOutput(2, [], info);
    expect(output.main).toHaveLength(2);
    expect(output.main[0]).toEqual([]);
    expect(output.main[1]).toEqual([{ json: { error: "失败了" }, pairedItem: { item: 0 } }]);
  });

  it("有输入时合上游 json，并保留 pairedItem 指回输入序号", () => {
    const input = [item({ id: 1, name: "甲" }), item({ id: 2, name: "乙" })];
    const output = routeErrorItemsToLastOutput(3, input, { message: "校验失败" });
    expect(output.main).toHaveLength(3);
    expect(output.main[0]).toEqual([]);
    expect(output.main[1]).toEqual([]);
    expect(output.main[2]).toEqual([
      { json: { id: 1, name: "甲", error: "校验失败" }, pairedItem: { item: 0 } },
      { json: { id: 2, name: "乙", error: "校验失败" }, pairedItem: { item: 1 } },
    ]);
  });

  it("上游 json 里本来就有 error 键时，以本次错误消息为准", () => {
    const output = routeErrorItemsToLastOutput(2, [item({ error: "上游旧错误" })], {
      message: "本次错误",
    });
    expect(output.main[1]?.[0]?.json.error).toBe("本次错误");
  });

  it("输出口数量非法时至少铺一个输出口", () => {
    const output = routeErrorItemsToLastOutput(0, [], { message: "x" });
    expect(output.main).toHaveLength(1);
    expect(output.main[0]).toHaveLength(1);
  });

  it("continueRegularOutput 透传输入，且不共享外层数组", () => {
    const input = [item({ a: 1 })];
    const output = passThroughInput(input);
    expect(output.main[0]).toEqual(input);
    expect(output.main[0]).not.toBe(input);
  });
});

describe("errorDescriptionOf", () => {
  it("常见 HTTP 状态给一句人话说明", () => {
    expect(errorDescriptionOf({ message: "x", httpCode: "401" })).toContain("凭据");
    expect(errorDescriptionOf({ message: "x", httpCode: "429" })).toContain("频繁");
    expect(errorDescriptionOf({ message: "x", httpCode: "503" })).toContain("稍后重试");
    expect(errorDescriptionOf({ message: "x" })).toBeUndefined();
  });
});
