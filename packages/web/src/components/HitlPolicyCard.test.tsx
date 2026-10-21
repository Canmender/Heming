import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { HitlPolicyCard } from "./HitlPolicyCard.js";
import { HitlPolicyStore, HITL_KEY } from "../lib/hitl/policy.js";
import { appendAudit, type StorageLike } from "../lib/selfEdit/guards.js";

/** 内存存储：每个测试一份，互不干扰。 */
class FakeStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

describe("HitlPolicyCard", () => {
  let storage: FakeStorage;
  let store: HitlPolicyStore;

  beforeEach(() => {
    storage = new FakeStorage();
    store = new HitlPolicyStore(storage);
  });

  it("展示档位选项，默认受控（guarded）", () => {
    render(<HitlPolicyCard policyStore={store} storage={storage} />);

    expect(screen.getByRole("radio", { name: "受控（默认）" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "严格" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "信任" })).not.toBeChecked();
  });

  it("切档位即时落盘", () => {
    render(<HitlPolicyCard policyStore={store} storage={storage} />);

    fireEvent.click(screen.getByRole("radio", { name: "严格" }));

    expect(store.get().mode).toBe("strict");
    expect(JSON.parse(storage.getItem(HITL_KEY) as string).mode).toBe("strict");
  });

  it("改免问下限即时落盘", () => {
    render(<HitlPolicyCard policyStore={store} storage={storage} />);

    fireEvent.change(screen.getByLabelText("免问下限"), { target: { value: "write" } });

    expect(store.get().floor).toBe("write");
    expect(JSON.parse(storage.getItem(HITL_KEY) as string).floor).toBe("write");
  });

  it("改授权作用域即时落盘", () => {
    render(<HitlPolicyCard policyStore={store} storage={storage} />);

    fireEvent.change(screen.getByLabelText("授权作用域"), { target: { value: "per-agent" } });

    expect(store.get().scope).toBe("per-agent");
  });

  it("没有「全部放行」档（它与自我修改工具组合后等于任意代码静默执行）", () => {
    render(<HitlPolicyCard policyStore={store} storage={storage} />);

    expect(screen.queryByRole("radio", { name: /全部放行/ })).not.toBeInTheDocument();
  });

  it("清空本会话授权：授权表清空", () => {
    store.grant("a1", "fs__write_file", "global");
    render(<HitlPolicyCard policyStore={store} storage={storage} />);

    fireEvent.click(screen.getByRole("button", { name: "清空本会话授权" }));

    expect(store.granted("a1", "fs__write_file", "global")).toBe(false);
  });

  it("审计列表能读出批准与拒绝记录（只显示 tool 作用域的）", () => {
    appendAudit(storage, {
      at: "2026-10-22T10:00:00.000Z",
      agentId: "a1",
      scope: "tool",
      action: "allow",
      target: "写文件（fs__write_file）",
    });
    appendAudit(storage, {
      at: "2026-10-22T10:01:00.000Z",
      agentId: "a1",
      scope: "tool",
      action: "deny",
      target: "删文件（fs__delete_file）",
      rejected: "用户拒绝",
    });
    // 别的作用域不该混进来
    appendAudit(storage, {
      at: "2026-10-22T10:02:00.000Z",
      agentId: "a1",
      scope: "memory",
      action: "write",
      target: "偏好-语言",
    });

    render(<HitlPolicyCard policyStore={store} storage={storage} />);

    expect(screen.getByText("写文件（fs__write_file）")).toBeInTheDocument();
    expect(screen.getByText("删文件（fs__delete_file）")).toBeInTheDocument();
    expect(screen.queryByText("偏好-语言")).not.toBeInTheDocument();
    expect(screen.getByText("已允许")).toBeInTheDocument();
    expect(screen.getByText("已拒绝")).toBeInTheDocument();
  });

  it("没有记录时给空态提示", () => {
    render(<HitlPolicyCard policyStore={store} storage={storage} />);

    expect(screen.getByText("还没有确认记录。")).toBeInTheDocument();
    expect(screen.getByText(/还没有记住的规则/)).toBeInTheDocument();
  });

  it("展示记住的规则，并可一键清空", () => {
    store.rememberRule("fs__write_file", "notes/a.md", "allow");
    store.rememberRule("fs__delete_file", "*", "deny");
    render(<HitlPolicyCard policyStore={store} storage={storage} />);

    expect(screen.getByText("notes/a.md")).toBeInTheDocument();
    expect(screen.getByText("所有调用")).toBeInTheDocument();
    expect(screen.getByText("fs__write_file")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清空记住的规则" }));
    // 清空不可撤销：先确认
    expect(store.rules().length).toBeGreaterThan(0);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "清空记住的规则" })).getByRole("button", {
        name: "清空",
      }),
    );

    expect(store.rules()).toEqual([]);
    expect(screen.queryByText("notes/a.md")).not.toBeInTheDocument();
  });
});
