import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TextField } from "./Field.js";

afterEach(() => cleanup());

describe("TextField 基元", () => {
  it("可见 label 与输入框绑定（不靠 placeholder 当名字）", () => {
    render(<TextField label="昵称" placeholder="例如：小明" />);
    expect(screen.getByLabelText("昵称")).toBeInTheDocument();
  });

  it("hint 常驻并与控件关联", () => {
    render(<TextField label="工作目录" hint="只影响本机，不会上传。" />);
    const input = screen.getByLabelText("工作目录");
    const hint = screen.getByText("只影响本机，不会上传。");
    expect(input).toHaveAttribute("aria-describedby", hint.id);
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("error 优先于 hint，并置 aria-invalid + role=alert", () => {
    render(<TextField label="昵称" hint="最多 64 字" error="昵称不能为空" />);
    const input = screen.getByLabelText("昵称");
    const err = screen.getByRole("alert");
    expect(err).toHaveTextContent("昵称不能为空");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", err.id);
    // 同一时刻只留一条说明，两句话不打架
    expect(screen.queryByText("最多 64 字")).toBeNull();
  });

  it("id 可外部指定，label 指向同一个 id", () => {
    render(<TextField label="端口" id="port-field" />);
    expect(screen.getByLabelText("端口")).toHaveAttribute("id", "port-field");
  });

  it("原生属性透传（maxLength / value / onChange）", () => {
    render(<TextField label="昵称" maxLength={64} defaultValue="设计评审" />);
    const input = screen.getByLabelText("昵称") as HTMLInputElement;
    expect(input.maxLength).toBe(64);
    expect(input.value).toBe("设计评审");
  });
});
