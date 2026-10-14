import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NavRail, NavPeek } from "./NavRail.js";
import { useUiStore } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";

describe("NavRail 图标轨（A 方案）", () => {
  beforeEach(() => {
    useUiStore.setState({ page: "home", navCollapsed: false, activeConversationId: null });
    useAuthStore.setState({
      token: "t1",
      user: { id: "u1", username: "alice", displayName: "爱丽丝" },
      status: "authed",
      error: null,
    });
  });

  it("渲染 5 个带快捷键徽标的图标按钮（aria-label = 名称 + 快捷键）", () => {
    render(<NavRail />);
    for (const name of ["主页 Alt1", "工作区 Alt2", "接口区 Alt3", "记忆区 Alt4", "设置区 Alt5"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("导航区不出现产品名文字（A 方案无品牌位）", () => {
    render(<NavRail />);
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(nav.textContent).not.toMatch(/和鸣|Heming/);
  });

  it("点击切页，选中项为 ink 底反白", () => {
    render(<NavRail />);
    const homeBtn = screen.getByRole("button", { name: "主页 Alt1" });
    expect(homeBtn.className).toContain("bg-ink");
    expect(homeBtn.className).toContain("text-white");

    fireEvent.click(screen.getByRole("button", { name: "接口区 Alt3" }));
    expect(useUiStore.getState().page).toBe("interfaces");

    const intfBtn = screen.getByRole("button", { name: "接口区 Alt3" });
    expect(intfBtn.className).toContain("bg-ink");
    expect(intfBtn.className).toContain("text-white");
    expect(screen.getByRole("button", { name: "主页 Alt1" }).className).not.toContain("bg-ink");
  });

  it("悬停浮签内容常驻 DOM（名称 + 快捷键徽标，opacity 0 → group-hover 淡入）", () => {
    render(<NavRail />);
    const name = screen.getByText("主页"); // 浮签里的名称文本，供测试查询
    expect(screen.getByText("Alt1")).toBeInTheDocument(); // 快捷键徽标
    const tip = name.parentElement as HTMLElement;
    expect(tip.className).toContain("opacity-0");
    expect(tip.className).toContain("group-hover:opacity-100");
    expect(tip.className).toContain("duration-150");
    expect(tip.className).toContain("translate-x-1");
  });

  it("底部头像 aria-label 为「退出登录」，点击调 logout，浮签仍显示在线状态", () => {
    render(<NavRail />);
    const avatar = screen.getByRole("button", { name: "退出登录" });
    expect(screen.getByText("爱丽丝 · 在线")).toBeInTheDocument(); // 悬停浮签（span）
    expect(useAuthStore.getState().user).not.toBeNull();

    fireEvent.click(avatar);
    const s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.token).toBeNull();
    expect(localStorage.getItem("heming.token")).toBeNull();
  });

  it("有 user.avatar 时底部按钮渲染 <img>（圆形裁剪，src 为 data URL）", () => {
    useAuthStore.setState({
      user: {
        id: "u1",
        username: "alice",
        displayName: "爱丽丝",
        avatar: "data:image/png;base64,AAA",
      },
    });
    render(<NavRail />);
    const btn = screen.getByRole("button", { name: "退出登录" });
    const img = btn.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("data:image/png;base64,AAA");
    expect(img!.className).toContain("rounded-full");
    expect(img!.className).toContain("object-cover");
    expect(screen.getByText("爱丽丝 · 在线")).toBeInTheDocument();
  });

  it("无 user.avatar 时底部按钮显示默认人形图标（不渲染 img）", () => {
    render(<NavRail />);
    const btn = screen.getByRole("button", { name: "退出登录" });
    expect(btn.querySelector("img")).toBeNull();
    expect(btn.querySelector("svg")).not.toBeNull();
  });
});

describe("NavPeek 会话隐藏态呼出提示", () => {
  beforeEach(() => {
    useUiStore.setState({ page: "home", navCollapsed: true, activeConversationId: null });
  });

  it("窄条 + 呼出按钮，点击展开回图标轨", () => {
    render(<NavPeek />);
    expect(screen.queryByRole("button", { name: "主页 Alt1" })).not.toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "呼出导航" });
    fireEvent.click(btn);
    expect(useUiStore.getState().navCollapsed).toBe(false);
  });

  it("呼出提示内不出现产品名文字", () => {
    render(<NavPeek />);
    expect(screen.getByRole("button", { name: "呼出导航" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/和鸣|Heming/);
  });
});
