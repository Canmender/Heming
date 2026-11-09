import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeContext } from "../core/fakeContext.js";
import { clearNodeRegistry, registerNodeType } from "../../registry.js";
import { cryptoNode } from "./crypto.js";
import { dateTimeNode } from "./dateTime.js";
import { xmlNode, parseXml } from "./xml.js";
import { integrationNodes } from "./harmony.js";
import { manualTrigger } from "../core/manualTrigger.js";
import { httpRequestNode } from "../core/httpRequest.js";
import { setNode } from "../core/set.js";
import { ifNode } from "../core/if.js";
import { scheduleTrigger } from "../core/scheduleTrigger.js";
import { errorTrigger } from "../core/errorTrigger.js";
import { WORKFLOW_TEMPLATES } from "../templates.js";
import type { Item, NodeExecuteResult } from "../../types.js";

/**
 * 集成节点单测（Node 环境）：只验证节点自己的语义，不依赖宿主。
 * 网络一律用 `vi.stubGlobal("fetch", …)` 打桩；通知写到临时目录。
 */

function firstOutput(result: NodeExecuteResult): Array<{ json: Record<string, unknown> }> {
  if (!result) return [];
  if (Array.isArray(result)) {
    const first = result[0];
    return (Array.isArray(first) ? first : result) as Array<{ json: Record<string, unknown> }>;
  }
  return (result.main[0] ?? []) as Array<{ json: Record<string, unknown> }>;
}

const originalEnv = { ...process.env };
let tempDir = "";

beforeEach(() => {
  process.env = { ...originalEnv };
  tempDir = mkdtempSync(join(tmpdir(), "wf-integ-"));
  process.env.WF_DATA_DIR = tempDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* Windows 上可能被占用，忽略 */
  }
});

describe("加密节点", () => {
  it("SHA-256 与已知值一致", async () => {
    const output = await cryptoNode.execute(
      createFakeContext({ parameters: { operation: "hash", value: "abc", algorithm: "SHA-256" } }),
    );
    expect(firstOutput(output)[0].json.result).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("Base64 编解码往返（中文）", async () => {
    const encoded = firstOutput(
      await cryptoNode.execute(createFakeContext({ parameters: { operation: "base64Encode", value: "工作流" } })),
    )[0].json.result;
    const decoded = firstOutput(
      await cryptoNode.execute(
        createFakeContext({ parameters: { operation: "base64Decode", value: String(encoded) } }),
      ),
    )[0].json.result;
    expect(decoded).toBe("工作流");
  });

  it("HMAC 缺密钥时报可读错误", async () => {
    await expect(
      cryptoNode.execute(createFakeContext({ parameters: { operation: "hmac", value: "a", secret: "" } })),
    ).rejects.toThrow(/密钥/);
  });
});

describe("XML 节点（手写解析器）", () => {
  it("解析属性、嵌套与自闭合标签", () => {
    const root = parseXml('<root a="1"><item>2</item><empty/></root>');
    expect(root.name).toBe("root");
    expect(root.attributes.a).toBe("1");
    expect(root.children.map((child) => child.name)).toEqual(["item", "empty"]);
  });

  it("实体与 CDATA 被正确解码", async () => {
    const context = createFakeContext({
      parameters: { operation: "parse", outputField: "data" },
      input: [{ json: { xml: "<root><a>a&amp;b</a><b><![CDATA[x<y]]></b></root>" } }],
    });
    expect(firstOutput(await xmlNode.execute(context))[0].json.data).toEqual({
      root: { a: "a&b", b: "x<y" },
    });
  });

  it("同名兄弟元素聚合成数组", async () => {
    const context = createFakeContext({
      parameters: { operation: "parse", outputField: "data" },
      input: [{ json: { xml: "<root><i>1</i><i>2</i></root>" } }],
    });
    expect(firstOutput(await xmlNode.execute(context))[0].json.data).toEqual({ root: { i: ["1", "2"] } });
  });

  it("标签不匹配时报中文错误", () => {
    expect(() => parseXml("<root><a></root>")).toThrow(/不匹配/);
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

describe("大模型节点", () => {
  it("未配置连接时给中文错误", async () => {
    delete process.env.WF_LLM_BASE_URL;
    delete process.env.WF_LLM_MODEL;
    await expect(
      integrationNodes[0].execute(createFakeContext({ parameters: { userPrompt: "你好" }, input: [] })),
    ).rejects.toThrow(/还没有配置模型连接/);
  });

  it("配置后调用 OpenAI 兼容端点并写字段", async () => {
    process.env.WF_LLM_BASE_URL = "https://llm.example/v1";
    process.env.WF_LLM_MODEL = "test-model";
    process.env.WF_LLM_API_KEY = "k";
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "你好呀" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const output = await integrationNodes[0].execute(
      createFakeContext({ parameters: { userPrompt: "说句话", outputField: "text" }, input: [{ json: { q: 1 } }] }),
    );
    expect(firstOutput(output)[0].json).toEqual({ q: 1, text: "你好呀" });
    expect(calls[0].url).toBe("https://llm.example/v1/chat/completions");
    expect((calls[0].body as { model: string }).model).toBe("test-model");
  });
});

describe("本机通知节点", () => {
  it("写一条 JSONL 并把输入继续传下去", async () => {
    const output = await integrationNodes[1].execute(
      createFakeContext({
        parameters: { title: "完成", body: "跑完了", passThrough: true },
        input: [{ json: { a: 1 } }],
      }),
    );
    expect(firstOutput(output)[0].json).toEqual({ a: 1 });
    const lines = readFileSync(join(tempDir, "notifications.jsonl"), "utf8").trim().split("\n");
    const record = JSON.parse(lines[0]) as { title: string; workflowId: string };
    expect(record.title).toBe("完成");
    expect(record.workflowId).toBe("wf-test");
  });
});

describe("MCP 工具节点", () => {
  it("调 tools/call 并把文本结果写进字段", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "工具结果" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const output = await integrationNodes[2].execute(
      createFakeContext({
        parameters: { url: "http://127.0.0.1:9999/mcp", tool: "demo", arguments: { a: 1 } },
        input: [{ json: { seed: true } }],
      }),
    );
    const json = firstOutput(output)[0].json as { mcp: { tool: string; text: string } };
    expect(json.mcp.tool).toBe("demo");
    expect(json.mcp.text).toBe("工具结果");
  });

  it("isError 结果转成节点失败", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { isError: true, content: [{ type: "text", text: "坏了" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      integrationNodes[2].execute(
        createFakeContext({ parameters: { url: "http://127.0.0.1:9999/mcp", tool: "demo" }, input: [] }),
      ),
    ).rejects.toThrow(/坏了/);
  });
});

describe("起手模板", () => {
  beforeEach(() => {
    clearNodeRegistry();
    for (const node of [
      manualTrigger,
      httpRequestNode,
      setNode,
      ifNode,
      scheduleTrigger,
      errorTrigger,
      dateTimeNode,
      cryptoNode,
      xmlNode,
      ...integrationNodes,
    ]) {
      registerNodeType(node);
    }
  });

  it("每个模板都能构建出有节点、有连接的工作流", () => {
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    for (const template of WORKFLOW_TEMPLATES) {
      const workflow = template.build();
      expect(workflow.nodes.length).toBeGreaterThan(0);
      expect(workflow.name).toBe(template.name);
      const links = Object.values(workflow.connections).reduce(
        (sum, ports) => sum + ports.main.reduce((count, list) => count + list.length, 0),
        0,
      );
      expect(links).toBeGreaterThan(0);
      for (const node of workflow.nodes) {
        expect(["manualTrigger", "httpRequest", "set", "notification", "scheduleTrigger", "dateTime", "llm", "if", "errorTrigger"]).toContain(
          node.type,
        );
      }
    }
  });
});

export type { Item };
