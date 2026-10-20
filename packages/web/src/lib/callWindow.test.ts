import { describe, it, expect } from "vitest";
import {
  buildCallWindowUrl,
  parseCallWindowParams,
  CALL_WINDOW_NAME,
} from "./callWindow.js";

describe("buildCallWindowUrl", () => {
  it("带上窗口标记、会话、对端与模式", () => {
    const url = buildCallWindowUrl("http://host/app/index.html?x=1#h", {
      conversationId: "c1",
      peerIds: ["u2", "u3"],
      mode: "video",
      title: "和鸣交流群",
    });
    expect(url.startsWith("http://host/app/index.html?")).toBe(true);
    const q = new URLSearchParams(url.split("?")[1]);
    expect(q.get("hemingWindow")).toBe("call");
    expect(q.get("conv")).toBe("c1");
    expect(q.get("peers")).toBe("u2,u3");
    expect(q.get("mode")).toBe("video");
    expect(q.get("title")).toBe("和鸣交流群");
  });

  it("去掉原有的 query 与 hash，保证是同一份页面", () => {
    const url = buildCallWindowUrl("app://heming/index.html?a=b#frag", {
      conversationId: "c1",
      peerIds: ["u2"],
      mode: "voice",
    });
    expect(url.startsWith("app://heming/index.html?")).toBe(true);
    expect(url).not.toContain("a=b");
    expect(url).not.toContain("#frag");
  });

  it("窗口名固定，重复点击复用同一个窗口", () => {
    expect(CALL_WINDOW_NAME).toBe("heming-call");
  });
});

describe("parseCallWindowParams", () => {
  it("与 buildCallWindowUrl 往返一致", () => {
    const url = buildCallWindowUrl("http://host/", {
      conversationId: "c9",
      peerIds: ["u1", "u2"],
      mode: "video",
      title: "张三",
    });
    const parsed = parseCallWindowParams("?" + url.split("?")[1]);
    expect(parsed).toEqual({
      conversationId: "c9",
      peerIds: ["u1", "u2"],
      mode: "video",
      title: "张三",
    });
  });

  it("非通话窗口（没有标记）返回 null", () => {
    expect(parseCallWindowParams("")).toBeNull();
    expect(parseCallWindowParams("?page=home")).toBeNull();
  });

  it("缺会话或缺对端返回 null（不开一个必然失败的通话窗）", () => {
    expect(parseCallWindowParams("?hemingWindow=call&peers=u1")).toBeNull();
    expect(parseCallWindowParams("?hemingWindow=call&conv=c1")).toBeNull();
    expect(parseCallWindowParams("?hemingWindow=call&conv=c1&peers=,,")).toBeNull();
  });

  it("mode 缺省或非法时按语音处理", () => {
    expect(parseCallWindowParams("?hemingWindow=call&conv=c1&peers=u1")?.mode).toBe("voice");
    expect(parseCallWindowParams("?hemingWindow=call&conv=c1&peers=u1&mode=xxx")?.mode).toBe("voice");
  });
});
