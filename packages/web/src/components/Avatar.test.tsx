import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Avatar } from "./Avatar.js";

describe("Avatar 圆形头像", () => {
  it("有 avatar 渲染圆形 <img>（object-cover，尺寸受控）", () => {
    const { container } = render(
      <Avatar user={{ displayName: "爱丽丝", avatar: "data:image/png;base64,AAA" }} size={28} />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("data:image/png;base64,AAA");
    expect(img!.className).toContain("rounded-full");
    expect(img!.className).toContain("object-cover");
    expect(img!.style.width).toBe("28px");
    expect(img!.style.height).toBe("28px");
  });

  it("无 avatar 渲染昵称首字圆底（浅灰 #f1f1f1，不渲染 img）", () => {
    const { container } = render(<Avatar user={{ displayName: "爱丽丝" }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("爱");
    const span = container.querySelector("span")!;
    expect(span.className).toContain("rounded-full");
    expect(span.className).toContain("bg-[#f1f1f1]");
  });

  it("img onError（加载失败）回退首字", () => {
    const { container } = render(
      <Avatar user={{ displayName: "鲍勃", avatar: "data:image/png;base64,BAD" }} />,
    );
    const img = container.querySelector("img")!;
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("鲍");
  });
});
