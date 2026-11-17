import { describe, expect, it } from "vitest";
import { summarizeMcpStatus, type McpConnectStatus } from "./summary.js";

const server = (id: string, name: string, enabled = true) => ({ id, name, enabled });

/** 用一张表假装「注册表最近一次连接结果」。 */
function statuses(entries: Record<string, McpConnectStatus>) {
  return (id: string) => entries[id];
}

describe("MCP 连接状况快照（d.223）", () => {
  it("没有配置服务时四项都是 0，工具数为 0", () => {
    expect(summarizeMcpStatus([], () => undefined, 0)).toEqual({
      total: 0,
      enabled: 0,
      connected: 0,
      failed: [],
      pending: 0,
      tools: 0,
    });
  });

  it("只统计已启用的服务：停用的不算没连上", () => {
    const got = summarizeMcpStatus(
      [server("a", "爬虫"), server("b", "知识库", false)],
      statuses({ a: { state: "connected" } }),
      3,
    );
    expect(got.total).toBe(2);
    expect(got.enabled).toBe(1);
    expect(got.connected).toBe(1);
    expect(got.failed).toEqual([]);
    expect(got.pending).toBe(0);
    expect(got.tools).toBe(3);
  });

  it("stale / error 都算没连上，原因原样带出来", () => {
    const got = summarizeMcpStatus(
      [server("a", "爬虫"), server("b", "知识库")],
      statuses({
        a: { state: "error", error: "连接超时" },
        b: { state: "stale", error: "进程已退出" },
      }),
      2,
    );
    expect(got.connected).toBe(0);
    expect(got.failed).toEqual([
      { name: "爬虫", state: "error", error: "连接超时" },
      { name: "知识库", state: "stale", error: "进程已退出" },
    ]);
  });

  it("没有连接记录的算 pending，不算失败", () => {
    const got = summarizeMcpStatus([server("a", "爬虫")], () => undefined, 0);
    expect(got.pending).toBe(1);
    expect(got.failed).toEqual([]);
  });

  it("名称为空时退回 id，不产出空名字", () => {
    const got = summarizeMcpStatus([server("srv-1", "")], statuses({ "srv-1": { state: "error" } }), 0);
    expect(got.failed[0]?.name).toBe("srv-1");
    expect(got.failed[0]).not.toHaveProperty("error");
  });

  it("工具数非法时归零，不把 NaN 写进自检", () => {
    expect(summarizeMcpStatus([], () => undefined, Number.NaN).tools).toBe(0);
    expect(summarizeMcpStatus([], () => undefined, -3).tools).toBe(0);
    expect(summarizeMcpStatus([], () => undefined, 2.7).tools).toBe(2);
  });
});
