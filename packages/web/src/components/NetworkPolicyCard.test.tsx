import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NetworkPolicyCard } from "./NetworkPolicyCard.js";
import { getNetPolicy, resetNetPolicy } from "../lib/webtools/netPolicy.js";

/**
 * 设置卡「网络访问」（d.238）。
 *
 * 这张卡的每一条断言都对着一个「用户会踩的坑」：
 * 切到白名单但列表空着（会用不了联网）/ 加错写法没反馈 / 移除后还生效。
 */
describe("NetworkPolicyCard 网络访问", () => {
  beforeEach(() => {
    resetNetPolicy();
    localStorage.clear();
  });
  afterEach(() => {
    resetNetPolicy();
  });

  it("默认开放：单选选中「开放」，并说明内网仍然读不到", () => {
    render(<NetworkPolicyCard />);
    expect(screen.getByText("网络访问")).toBeInTheDocument();
    const open = screen.getByRole("radio", { name: /开放/ }) as HTMLInputElement;
    expect(open.checked).toBe(true);
    expect(screen.getByText(/内网与本机地址始终被挡/)).toBeInTheDocument();
    // 做到默认态就有「恢复默认」按钮，说明「已经偏离默认」了，是错的。
    expect(screen.queryByRole("button", { name: "恢复默认" })).toBeNull();
  });

  it("切到白名单且列表为空：明说「现在什么都读不了」", () => {
    render(<NetworkPolicyCard />);
    fireEvent.click(screen.getByRole("radio", { name: /仅允许列表里的域名/ }));
    expect(getNetPolicy().mode).toBe("allowlist");
    expect(screen.getByTestId("net-policy-empty")).toHaveTextContent("任何网页都读不了");
  });

  it("添加域名：归一化后进列表、清空输入框、给出提示", () => {
    render(<NetworkPolicyCard />);
    const input = screen.getByLabelText("添加域名");
    fireEvent.change(input, { target: { value: "https://Docs.Company.com/a" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(getNetPolicy().allow).toEqual(["docs.company.com"]);
    expect(screen.getByTestId("net-policy-rules")).toHaveTextContent("docs.company.com");
    expect(screen.getByTestId("net-policy-message")).toHaveTextContent("已加入：docs.company.com");
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("回车也能添加；一次贴多个用换行分隔", () => {
    render(<NetworkPolicyCard />);
    const input = screen.getByLabelText("添加域名");
    fireEvent.change(input, { target: { value: "a.com\n*.b.dev" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(getNetPolicy().allow).toEqual(["a.com", "*.b.dev"]);
  });

  it("加错的写法当场说清楚为什么没加进去（不静默丢弃）", () => {
    render(<NetworkPolicyCard />);
    const input = screen.getByLabelText("添加域名");
    fireEvent.change(input, { target: { value: "192.168.1.1" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(getNetPolicy().allow).toEqual([]);
    const message = screen.getByTestId("net-policy-message");
    expect(message).toHaveTextContent("这些写法用不了");
    expect(message).toHaveTextContent("只认域名");
    // 输入框保留原文，用户能改一个字符重试，而不是从头再打一遍。
    expect((input as HTMLInputElement).value).toBe("192.168.1.1");
  });

  it("移除规则：列表里消失，存储同步", () => {
    render(<NetworkPolicyCard />);
    const input = screen.getByLabelText("添加域名");
    fireEvent.change(input, { target: { value: "a.com b.com" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(getNetPolicy().allow).toEqual(["a.com", "b.com"]);
    fireEvent.click(screen.getByRole("button", { name: "移除 a.com" }));
    expect(getNetPolicy().allow).toEqual(["b.com"]);
    expect(screen.getByTestId("net-policy-rules")).not.toHaveTextContent("a.com");
    expect(screen.getByTestId("net-policy-rules")).toHaveTextContent("b.com");
  });

  it("「恢复默认」清空规则并回到开放", () => {
    render(<NetworkPolicyCard />);
    fireEvent.click(screen.getByRole("radio", { name: /仅允许列表里的域名/ }));
    fireEvent.change(screen.getByLabelText("添加域名"), { target: { value: "a.com" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(screen.getByRole("button", { name: "恢复默认" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(getNetPolicy()).toEqual({ mode: "open", allow: [] });
    expect((screen.getByRole("radio", { name: /开放/ }) as HTMLInputElement).checked).toBe(true);
  });
});
