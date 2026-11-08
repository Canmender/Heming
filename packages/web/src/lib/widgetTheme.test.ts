import { afterEach, describe, expect, it } from "vitest";
import { createWidgetThemeSync, currentTheme } from "./widgetTheme.js";

function fakeBridge() {
  const events: Array<{ kind: string; theme?: string }> = [];
  return {
    events,
    bridge: {
      publish: (event: { kind: "theme"; theme: "light" | "dark" }) => {
        events.push(event);
      },
    },
  };
}

function setTheme(theme: string | null) {
  if (theme === null) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

afterEach(() => setTheme(null));

describe("widgetTheme · 主窗 → widget 的主题同步", () => {
  it("currentTheme 读 <html data-theme>，缺省为 light", () => {
    expect(currentTheme()).toBe("light");
    setTheme("dark");
    expect(currentTheme()).toBe("dark");
    setTheme("whatever");
    expect(currentTheme()).toBe("light");
  });

  it("挂载即按当前主题发一次（不等第一次变化）", () => {
    setTheme("dark");
    const { events, bridge } = fakeBridge();
    const runtime = createWidgetThemeSync({ bridge, observe: () => () => {} });
    expect(events).toEqual([{ kind: "theme", theme: "dark" }]);
    runtime.stop();
  });

  it("同一主题不重复发（只发真正变化）", () => {
    setTheme("light");
    const holder: { cb: (() => void) | null } = { cb: null };
    const { events, bridge } = fakeBridge();
    const runtime = createWidgetThemeSync({
      bridge,
      observe: (cb) => {
        holder.cb = cb;
        return () => {
          holder.cb = null;
        };
      },
    });
    expect(events).toHaveLength(1);
    // 观察器回调但主题没变 → 不发
    holder.cb?.();
    expect(events).toHaveLength(1);
    setTheme("dark");
    holder.cb?.();
    expect(events).toEqual([
      { kind: "theme", theme: "light" },
      { kind: "theme", theme: "dark" },
    ]);
    holder.cb?.();
    expect(events).toHaveLength(2);
    runtime.stop();
  });

  it("没有 bridge（浏览器/旧 preload）时不发、不报错", () => {
    setTheme("dark");
    const runtime = createWidgetThemeSync({ bridge: null, observe: () => () => {} });
    expect(runtime.publish()).toBeNull();
    runtime.stop();
  });

  it("publish 抛错被吞掉（IPC 抖动不影响主窗）", () => {
    const runtime = createWidgetThemeSync({
      bridge: {
        publish: () => {
          throw new Error("ipc broken");
        },
      },
      observe: () => () => {},
      readTheme: () => "dark",
    });
    expect(() => runtime.publish()).not.toThrow();
    runtime.stop();
  });

  it("stop 之后观察器回调不再发布", () => {
    const holder: { cb: (() => void) | null } = { cb: null };
    const { events, bridge } = fakeBridge();
    const runtime = createWidgetThemeSync({
      bridge,
      observe: (cb) => {
        holder.cb = cb;
        return () => {
          holder.cb = null;
        };
      },
    });
    runtime.stop();
    setTheme("dark");
    holder.cb?.();
    expect(events).toHaveLength(1);
  });
});
