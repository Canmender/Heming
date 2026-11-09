import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "./storage.js";
import { WORKFLOW_LIMITS, type WorkflowExecution } from "../types.js";
import { createWorkflow } from "../model.js";

/**
 * 本机存储（JSON 文件）自检：坏数据容错、级联删除、双淘汰、单条超限收缩、
 * 凭据加密、设置与静态数据持久化、通知追加。
 *
 * 这些是「服务端唯一有磁盘副作用」的地方，之前只有通过 HTTP 的间接覆盖；
 * 自检补成直接单测，避免接口层改动后存储行为悄悄漂移。
 */

let dir = "";
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-store-"));
  store = createStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function executionOf(id: string, workflowId: string, startedAt: number): WorkflowExecution {
  return {
    id,
    workflowId,
    workflowName: "测试工作流",
    mode: "manual",
    status: "success",
    startedAt,
    runData: {},
  };
}

describe("工作流存储", () => {
  it("创建/保存/读取/启停；重新打开 store 数据还在", () => {
    const workflow = store.createWorkflow({ name: "我的工作流" });
    expect(store.listWorkflows()).toHaveLength(1);
    workflow.description = "说明";
    const saved = store.saveWorkflow(workflow);
    expect(saved.description).toBe("说明");
    expect(store.setActive(workflow.id, true)?.active).toBe(true);

    const reopened = createStore(dir);
    expect(reopened.listWorkflows()[0]?.name).toBe("我的工作流");
    expect(reopened.listWorkflows()[0]?.active).toBe(true);
  });

  it("坏条目逐条丢弃，不因一条坏数据读不出整份列表", () => {
    writeFileSync(
      join(dir, "workflows.json"),
      JSON.stringify([
        { id: "w-bad", nodes: "not-an-array" },
        { id: "w-ok", name: "能读", nodes: [], connections: {}, settings: {}, tags: [] },
        "garbage",
      ]),
      "utf8",
    );
    const reopened = createStore(dir);
    const names = reopened.listWorkflows().map((item) => item.name);
    expect(names).toContain("能读");
    expect(names).not.toContain(undefined);
  });

  it("删除工作流级联删除执行记录", () => {
    const workflow = store.createWorkflow({ name: "级联" });
    store.saveExecution(executionOf("e1", workflow.id, 1));
    expect(store.listExecutions()).toHaveLength(1);
    expect(store.removeWorkflow(workflow.id)).toBe(true);
    expect(store.listExecutions()).toHaveLength(0);
  });

  it("markRun 只写 lastRunAt，不动 updatedAt（不把列表每 15 秒重排一次）", () => {
    const workflow = store.createWorkflow({ name: "调度记账" });
    const updatedAt = workflow.updatedAt;
    store.markRun(workflow.id, 12345);
    const after = store.getWorkflow(workflow.id);
    expect(after?.lastRunAt).toBe(12345);
    expect(after?.updatedAt).toBe(updatedAt);
  });
});

describe("执行记录存储", () => {
  it("最多保留 60 条，最新在前", () => {
    for (let i = 0; i < WORKFLOW_LIMITS.maxExecutions + 5; i += 1) {
      store.saveExecution(executionOf(`e${i}`, "w", i));
    }
    const list = store.listExecutions();
    expect(list).toHaveLength(WORKFLOW_LIMITS.maxExecutions);
    expect(list[0]?.startedAt).toBeGreaterThan(list[list.length - 1]?.startedAt ?? 0);
  });

  it("单条执行记录超过总上限时裁掉最早节点数据，保留元数据并标记 dataTruncated", () => {
    const big = "A".repeat(600 * 1024);
    const execution: WorkflowExecution = {
      ...executionOf("huge", "w", 1),
      runData: {
        n1: [
          {
            startTime: 1,
            executionTime: 1,
            executionIndex: 0,
            source: [{}],
            status: "success",
            itemsTotal: 1,
            data: { main: [[{ json: { big } }]] },
          },
          {
            startTime: 2,
            executionTime: 1,
            executionIndex: 1,
            source: [{}],
            status: "success",
            itemsTotal: 1,
            data: { main: [[{ json: { big } }]] },
          },
        ],
      },
    };
    store.saveExecution(execution);
    const reopened = createStore(dir);
    const saved = reopened.getExecution("huge");
    expect(saved).toBeTruthy();
    expect(saved?.dataTruncated).toBe(true);
    const raw = readFileSync(join(dir, "executions.json"), "utf8");
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(1024 * 1024);
    // 至少有一条运行的数据被裁掉（元数据仍在）
    const runs = Object.values(saved?.runData ?? {}).flat();
    expect(runs.length).toBe(2);
    expect(runs.some((run) => run.data === undefined)).toBe(true);
  });
});

describe("凭据存储（加密）", () => {
  it("值落盘为 AES-GCM 密文，可解密回原值", async () => {
    const meta = store.saveCredential({
      name: "测试凭据",
      type: "bearerToken",
      data: { token: "SECRET-TOKEN-123" },
    });
    expect(meta.id).toBeTruthy();
    const raw = readFileSync(join(dir, "credentials.json"), "utf8");
    expect(raw).not.toContain("SECRET-TOKEN-123");
    const stored = JSON.parse(raw) as Array<{ secret: string }>;
    expect(stored[0]?.secret).toContain('"v":1');
    const data = await store.getCredentialData("bearerToken", meta.id);
    expect(data).toEqual({ token: "SECRET-TOKEN-123" });
    // 类型不匹配不给数据
    expect(await store.getCredentialData("httpBasic", meta.id)).toBeNull();
  });

  it("非法字段/未知类型被拒绝（不静默丢字段）", () => {
    expect(() =>
      store.saveCredential({ name: "坏凭据", type: "bearerToken", data: { token: "x", extra: "y" } }),
    ).toThrow(/不属于/);
    expect(() => store.saveCredential({ name: "坏类型", type: "nope", data: {} })).toThrow(/不支持的凭据类型/);
  });

  it("凭据元数据读回（不含值）", () => {
    store.saveCredential({ name: "基本认证", type: "httpBasic", data: { username: "u", password: "p" } });
    const list = store.listCredentials();
    expect(list).toHaveLength(1);
    expect(list[0]?.type).toBe("httpBasic");
    expect(JSON.stringify(list)).not.toContain('"p"');
  });
});

describe("设置 / 静态数据 / 通知", () => {
  it("全局变量持久化；模型 Key 落盘为密文", () => {
    store.saveSettings({ vars: { env: "test" }, llm: { baseUrl: "https://llm.example/v1", apiKey: "sk-SECRET", model: "m" } });
    const raw = readFileSync(join(dir, "settings.json"), "utf8");
    expect(raw).not.toContain("sk-SECRET");
    const reopened = createStore(dir);
    expect(reopened.getSettings().vars).toEqual({ env: "test" });
    expect(reopened.getSettings().llm?.model).toBe("m");
    expect(reopened.getSettings().llm?.apiKey).toBe("sk-SECRET");
  });

  it("静态数据跨 store 实例保留", () => {
    const record = store.getStaticData("w1", "n1");
    record.cursor = 42;
    store.saveStaticData("w1", "n1", { ...record });
    const reopened = createStore(dir);
    expect(reopened.getStaticData("w1", "n1").cursor).toBe(42);
  });

  it("通知追加并按最近读取", () => {
    store.addNotification({ title: "第一条", workflowId: "w1" });
    store.addNotification({ title: "第二条", body: "正文" });
    const list = store.listNotifications(10);
    expect(list.map((item) => item.title)).toEqual(["第二条", "第一条"]);
    expect(existsSync(join(dir, "notifications.jsonl"))).toBe(true);
  });
});

describe("路径/上限常量", () => {
  it("maxWorkflows 上限生效（超出拒绝而不是静默丢）", () => {
    for (let i = 0; i < WORKFLOW_LIMITS.maxWorkflows; i += 1) {
      store.createWorkflow({ name: `w${i}` });
    }
    expect(() => store.createWorkflow({ name: "overflow" })).toThrow(/最多保存/);
    expect(store.listWorkflows()).toHaveLength(WORKFLOW_LIMITS.maxWorkflows);
  });

  it("createWorkflow 的 from 会克隆节点（新 id）", () => {
    const source = store.createWorkflow({ name: "源" });
    source.nodes = [
      { id: "n1", name: "手动触发", type: "manualTrigger", position: { x: 0, y: 0 }, parameters: {} },
    ];
    store.saveWorkflow(source);
    const copy = store.createWorkflow({ from: store.getWorkflow(source.id), name: "副本" });
    expect(copy.name).toBe("副本");
    expect(copy.nodes[0]?.id).not.toBe("n1");
  });

  it("导出的工作流对象里不包含任何凭据值", () => {
    const workflow = createWorkflow({ name: "导出检查" });
    const saved = store.saveWorkflow(workflow);
    expect(JSON.stringify(saved)).not.toContain("password");
  });
});

describe("版本快照（P1）", () => {
  it("覆盖保存前留快照，可按 versionId 读取旧内容", () => {
    const workflow = store.createWorkflow({ name: "版本一" });
    const first = store.saveWorkflow(workflow);
    const second = store.saveWorkflow({ ...first, name: "版本二" });
    expect(second.name).toBe("版本二");
    // create 产出的 V0 与第一次 save 的 V1 都会在后续保存时留档，因此这里 2 条
    const versions = store.listVersions(first.id);
    expect(versions).toHaveLength(2);
    expect(versions.some((item) => item.versionId === first.versionId)).toBe(true);
    const old = store.getVersion(first.id, first.versionId);
    expect(old?.name).toBe("版本一");
  });

  it("每工作流最多保留 10 个历史版本", () => {
    const workflow = store.createWorkflow({ name: "多版本" });
    let current = store.saveWorkflow(workflow);
    for (let i = 0; i < 15; i += 1) {
      current = store.saveWorkflow({ ...current, name: `版本 ${i}` });
    }
    expect(store.listVersions(current.id).length).toBeLessThanOrEqual(10);
  });

  it("删除工作流时历史版本一并清掉", () => {
    const workflow = store.createWorkflow({ name: "待删版本" });
    const saved = store.saveWorkflow(workflow);
    store.saveWorkflow({ ...saved, name: "第二版" });
    expect(store.listVersions(saved.id).length).toBeGreaterThan(0);
    store.removeWorkflow(saved.id);
    expect(store.listVersions(saved.id)).toEqual([]);
    expect(store.getVersion(saved.id, saved.versionId)).toBeUndefined();
  });

  it("版本快照跨 store 实例持久化", () => {
    const workflow = store.createWorkflow({ name: "持久化版本" });
    const saved = store.saveWorkflow(workflow);
    store.saveWorkflow({ ...saved, name: "新版本" });
    const reopened = createStore(dir);
    const versions = reopened.listVersions(saved.id);
    expect(versions).toHaveLength(2);
    const entry = versions.find((item) => item.versionId === saved.versionId);
    expect(entry).toBeTruthy();
    expect(reopened.getVersion(saved.id, entry!.versionId)?.name).toBe("持久化版本");
  });
});
