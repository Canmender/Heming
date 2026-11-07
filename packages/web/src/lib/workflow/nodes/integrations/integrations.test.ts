import { describe, it, expect, beforeEach } from "vitest";
import { createFakeContext } from "../core/fakeContext.js";
import { clearNodeRegistry, registerNodeType } from "../../registry.js";
import { cryptoNode } from "./crypto.js";
import { dateTimeNode } from "./dateTime.js";
import { xmlNode } from "./xml.js";
import { integrationNodes } from "./harmony.js";
import { manualTrigger } from "../core/manualTrigger.js";
import { httpRequestNode } from "../core/httpRequest.js";
import { setNode } from "../core/set.js";
import { ifNode } from "../core/if.js";
import { scheduleTrigger } from "../core/scheduleTrigger.js";
import { errorTrigger } from "../core/errorTrigger.js";
import { WORKFLOW_TEMPLATES } from "../templates.js";
import { useNotificationStore, setNotificationStorage } from "../../../../store/notifications.js";
import { useLlmStore } from "../../../../store/llm.js";
import type { Item, NodeExecuteResult } from "../../types.js";

/**
 * 集成节点单测：只验证「节点自己的语义」，不验证引擎（引擎有自己的用例）。
 * 网络与边车一律不碰：InfoHub 在 jsdom 里天然不可用，正好覆盖「未连接时给可读错误」。
 */

/** 节点 execute 允许返回三种形状；测试里统一拿第一个输出口。 */
function firstOutput(result: NodeExecuteResult): Array<{ json: Record<string, unknown> }> {
  if (!result) return [];
  if (Array.isArray(result)) {
    // Item[]（单口）或 Item[][]（按口分组）都接受：取第一个输出口。
    const first = result[0];
    return (Array.isArray(first) ? first : result) as Array<{ json: Record<string, unknown> }>;
  }
  return (result.main[0] ?? []) as Array<{ json: Record<string, unknown> }>;
}

beforeEach(() => {
  setNotificationStorage(null);
  useNotificationStore.setState({ items: [] });
});

describe("日期时间节点", () => {
  it("格式化输出写到指定字段，并保留输入字段", async () => {
    const context = createFakeContext({
      parameters: { operation: "format", format: "yyyy-MM-dd", outputField: "day" },
      input: [{ json: { title: "示例" } }],
    });
    const json = firstOutput(await dateTimeNode.execute(context))[0].json;
    expect(json.title).toBe("示例");
    expect(String(json.day)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("加一天：结果晚于当前时间", async () => {
    const context = createFakeContext({
      parameters: { operation: "add", amount: 1, unit: "day", outputField: "at" },
      input: [],
    });
    const value = Date.parse(String(firstOutput(await dateTimeNode.execute(context))[0].json.at));
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(Date.now() + 20 * 3600 * 1000);
  });
});

describe("加密节点", () => {
  it("SHA-256 十六进制与已知值一致", async () => {
    const output = await cryptoNode.execute(
      createFakeContext({ parameters: { operation: "hash", value: "abc", algorithm: "SHA-256" } }),
    );
    expect(firstOutput(output)[0].json.result).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("Base64 编码后再解码回到原文", async () => {
    const encoded = firstOutput(
      await cryptoNode.execute(createFakeContext({ parameters: { operation: "base64Encode", value: "和鸣" } })),
    )[0].json.result;
    const decoded = firstOutput(
      await cryptoNode.execute(
        createFakeContext({ parameters: { operation: "base64Decode", value: String(encoded) } }),
      ),
    )[0].json.result;
    expect(decoded).toBe("和鸣");
  });

  it("HMAC 缺密钥时报可读错误", async () => {
    await expect(
      cryptoNode.execute(createFakeContext({ parameters: { operation: "hmac", value: "a", secret: "" } })),
    ).rejects.toThrow(/密钥/);
  });
});

describe("XML 节点", () => {
  it("解析 XML 成 JSON（属性与嵌套）", async () => {
    const context = createFakeContext({
      parameters: { operation: "parse", outputField: "data" },
      input: [{ json: { xml: '<root><a x="1">2</a><b>3</b></root>' } }],
    });
    expect(firstOutput(await xmlNode.execute(context))[0].json.data).toEqual({
      root: { a: { "@x": "1", "#text": "2" }, b: "3" },
    });
  });

  it("JSON 生成 XML 带声明与转义", async () => {
    const context = createFakeContext({
      parameters: { operation: "build", rootName: "order", outputField: "out" },
      input: [{ json: { title: "a&b" } }],
    });
    const xml = String(firstOutput(await xmlNode.execute(context))[0].json.out);
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain("<order>");
    expect(xml).toContain("a&amp;b");
  });
});

describe("站内通知节点", () => {
  it("推一条通知，并把输入继续传下去", async () => {
    const output = await integrationNodes[4].execute(
      createFakeContext({
        parameters: { title: "完成", body: "跑完了", passThrough: true },
        input: [{ json: { a: 1 } }],
      }),
    );
    expect(firstOutput(output)[0].json).toEqual({ a: 1 });
    const items = useNotificationStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("automation");
    expect(items[0].title).toBe("完成");
  });
});

describe("和鸣能力节点 · 未连接时的错误", () => {
  it("InfoHub 检索在非桌面/未连接时给中文提示", async () => {
    const node = integrationNodes[1];
    await expect(
      node.execute(createFakeContext({ parameters: { query: "免检单" }, input: [] })),
    ).rejects.toThrow(/信息中枢/);
  });

  it("大模型节点没有连接时报可读错误", async () => {
    useLlmStore.setState({ profiles: [] });
    await expect(
      integrationNodes[0].execute(createFakeContext({ parameters: { userPrompt: "你好" }, input: [] })),
    ).rejects.toThrow(/模型连接/);
  });
});

describe("起手模板", () => {
  beforeEach(() => {
    clearNodeRegistry();
    for (const node of [manualTrigger, httpRequestNode, setNode, ifNode, scheduleTrigger, errorTrigger]) {
      registerNodeType(node);
    }
    for (const node of integrationNodes) registerNodeType(node);
    registerNodeType(dateTimeNode);
    registerNodeType(cryptoNode);
    registerNodeType(xmlNode);
  });

  it("每个模板都能构建出有节点、有连接的工作流", () => {
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    for (const template of WORKFLOW_TEMPLATES) {
      const workflow = template.build();
      expect(workflow.nodes.length).toBeGreaterThan(0);
      expect(workflow.name).toBe(template.name);
      const links = Object.values(workflow.connections).reduce(
        (sum, ports) => sum + ports.main.reduce((n, list) => n + list.length, 0),
        0,
      );
      expect(links).toBeGreaterThan(0);
      for (const node of workflow.nodes) {
        expect([
          "manualTrigger",
          "httpRequest",
          "set",
          "notification",
          "scheduleTrigger",
          "infohubAgenda",
          "llm",
          "if",
          "errorTrigger",
        ]).toContain(node.type);
      }
    }
  });
});
