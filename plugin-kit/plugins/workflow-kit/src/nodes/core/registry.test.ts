import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearNodeRegistry, getNodeType, listNodeTypes, requireNodeType } from "../../registry.js";
import { CORE_NODE_TYPES, registerCoreNodes } from "./index.js";
import { registerAllNodes } from "../index.js";
import type { NodeGroup } from "../../types.js";

/**
 * 注册表是引擎/调色板的唯一入口：这里钉住「核心节点齐不齐、type 唯一、
 * 描述字段可用、注册可重复调用不出错」，以及 nodes/index.ts 的总入口
 * 确实把 core 注册进去了、且调用一次集成注册。
 *
 * 为什么把 `../integrations/index.js` mock 掉：本文件只验「核心侧注册契约」，
 * 集成节点由 wf-nodes-app 自己负责实现与测试；直接 import 真实集成实现会让
 * 两边的改造进度互相卡住（旧宿主依赖一报错，核心注册测试就整个文件失败）。
 * mock 之后这里仍然能验证 registerAllNodes 是否**调用**了集成注册，且幂等。
 * 不依赖具体节点语义（各节点自己的测试负责），只验形状。
 */

const integrationRegister = vi.hoisted(() => vi.fn());

vi.mock("../integrations/index.js", () => ({
  registerIntegrationNodes: integrationRegister,
}));

const EXPECTED_TYPES = [
  // 触发器
  "manualTrigger",
  "scheduleTrigger",
  "errorTrigger",
  "executeWorkflowTrigger",
  "webhookTrigger",
  // 数据
  "set",
  "splitOut",
  "filter",
  "sort",
  "limit",
  "removeDuplicates",
  "aggregate",
  "itemLists",
  // 流程
  "if",
  "switch",
  "merge",
  "splitInBatches",
  "wait",
  "noOperation",
  // 集成核心
  "httpRequest",
  "code",
  "executeWorkflow",
  // 收尾
  "stopAndError",
];

const VALID_GROUPS: NodeGroup[] = ["trigger", "action", "transform", "flow", "ai", "output"];

beforeEach(() => {
  clearNodeRegistry();
  registerCoreNodes();
  integrationRegister.mockClear();
});

describe("核心节点注册", () => {
  it("核心 type id 全部注册", () => {
    const registered = listNodeTypes().map((nodeType) => nodeType.description.type);
    expect([...registered].sort()).toEqual([...EXPECTED_TYPES].sort());
  });

  it("重复调用 registerCoreNodes 不抛错且不重复注册", () => {
    expect(() => registerCoreNodes()).not.toThrow();
    expect(listNodeTypes()).toHaveLength(EXPECTED_TYPES.length);
  });

  it("每个节点都有可用的中文描述、图标与参数表", () => {
    for (const nodeType of CORE_NODE_TYPES) {
      const { description } = nodeType;
      expect(description.type.trim()).not.toBe("");
      expect(/[\u4e00-\u9fff]/.test(description.displayName)).toBe(true);
      expect(/[\u4e00-\u9fff]/.test(description.description)).toBe(true);
      expect(description.icon.trim()).not.toBe("");
      expect(VALID_GROUPS).toContain(description.group);
      expect(typeof nodeType.execute).toBe("function");
      expect(description.version).toBe(1);
      for (const property of description.properties) {
        expect(property.name.trim()).not.toBe("");
        expect(/[\u4e00-\u9fff]/.test(property.displayName)).toBe(true);
        expect(property.type.trim()).not.toBe("");
      }
    }
  });

  it("触发器没有输入口，非触发器至少一个输入口", () => {
    for (const nodeType of CORE_NODE_TYPES) {
      if (nodeType.description.isTrigger) {
        expect(nodeType.description.inputs).toBe(0);
      } else {
        expect(nodeType.description.inputs).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("双输出节点声明了两个输出口名", () => {
    const ifNode = requireNodeType("if");
    expect(ifNode.description.outputs).toBe(2);
    expect(ifNode.description.outputNames).toEqual(["true", "false"]);

    const loop = requireNodeType("splitInBatches");
    expect(loop.description.outputs).toBe(2);
    expect(loop.description.outputNames).toEqual(["循环", "完成"]);
  });

  it("动态输出的 switch 通过 getOutputCount 计算口数", () => {
    const nodeType = requireNodeType("switch");
    expect(typeof nodeType.getOutputCount).toBe("function");
    expect(nodeType.getOutputCount?.({ rules: [{}, {}] })).toBe(3);
  });

  it("调度触发器是唯一实现 getNextRun 的核心节点", () => {
    const withNextRun = CORE_NODE_TYPES.filter((nodeType) => typeof nodeType.getNextRun === "function");
    expect(withNextRun.map((nodeType) => nodeType.description.type)).toEqual(["scheduleTrigger"]);
  });
});

describe("节点库总入口", () => {
  it("registerAllNodes 注册 core、调用集成注册，且可安全重复调用", () => {
    clearNodeRegistry();
    integrationRegister.mockClear();
    expect(() => registerAllNodes()).not.toThrow();
    expect(getNodeType("manualTrigger")).toBeDefined();
    expect(getNodeType("httpRequest")).toBeDefined();
    expect(getNodeType("scheduleTrigger")).toBeDefined();
    expect(integrationRegister).toHaveBeenCalledTimes(1);
    // 幂等：第二次调用不再重复注册（否则 registry 会因 type 重复而抛错）。
    expect(() => registerAllNodes()).not.toThrow();
    expect(integrationRegister).toHaveBeenCalledTimes(1);
  });

  it("未注册的 type 返回 undefined / 抛错", () => {
    expect(getNodeType("notARealNode")).toBeUndefined();
    expect(() => requireNodeType("notARealNode")).toThrow(/未知的节点类型/);
  });
});
