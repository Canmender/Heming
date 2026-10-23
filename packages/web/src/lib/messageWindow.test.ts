import { describe, it, expect } from "vitest";
import {
  DEFAULT_WINDOW,
  NEAR_TOP_PX,
  WINDOW_STEP,
  countToInclude,
  expandCount,
  shouldLoadMore,
  windowStart,
} from "./messageWindow.js";

/**
 * 消息窗口化的纯计算（d.33 · P2-2）。
 *
 * 组件里的滚动补偿不好断言，所以把「窗口从哪儿开始、该不该追加、要扩到多少」
 * 全部抽成纯函数——边界（0 条、不足一窗、恰好一窗、超出）在这里钉死。
 */
describe("windowStart（窗口起点）", () => {
  it("少于一个窗口时从头开始", () => {
    expect(windowStart(10, DEFAULT_WINDOW)).toBe(0);
    expect(windowStart(0, DEFAULT_WINDOW)).toBe(0);
  });

  it("超过一个窗口时贴着最新消息", () => {
    expect(windowStart(100, 60)).toBe(40);
    expect(windowStart(200, 200)).toBe(0); // 窗口覆盖全部
  });

  it("非法输入夹到合法范围", () => {
    expect(windowStart(-5, 10)).toBe(0);
    expect(windowStart(10, -3)).toBe(10); // 窗口 0 条 ⇒ 起点就是末尾
  });
});

describe("expandCount（追加窗口）", () => {
  it("按步长增加，但不超过总条数", () => {
    expect(expandCount(60, 200)).toBe(120);
    expect(expandCount(180, 200)).toBe(200);
    expect(expandCount(200, 200)).toBe(200); // 已全覆盖 ⇒ 不变
  });

  it("步长非法时按 1 处理（不会原地踏步）", () => {
    expect(expandCount(60, 200, 0)).toBe(61);
    expect(expandCount(60, 200, -5)).toBe(61);
  });

  it("自定义步长", () => {
    expect(expandCount(0, 100, 30)).toBe(30);
  });
});

describe("shouldLoadMore（滚动触发）", () => {
  it("贴顶且还有更早的消息 → 追加", () => {
    expect(shouldLoadMore(0, 200, 60)).toBe(true);
    expect(shouldLoadMore(NEAR_TOP_PX, 200, 60)).toBe(true);
  });

  it("离顶部超过阈值 → 不追加", () => {
    expect(shouldLoadMore(NEAR_TOP_PX + 1, 200, 60)).toBe(false);
    expect(shouldLoadMore(500, 200, 60)).toBe(false);
  });

  it("已覆盖全部消息 → 永不追加（防无限 setState）", () => {
    expect(shouldLoadMore(0, 60, 60)).toBe(false);
    expect(shouldLoadMore(0, 10, 60)).toBe(false);
  });

  it("负的 scrollTop（部分浏览器的回弹）按 0 处理", () => {
    expect(shouldLoadMore(-40, 200, 60)).toBe(true);
  });
});

describe("countToInclude（搜索跳转扩窗）", () => {
  it("目标在窗口内 → 不扩", () => {
    // 总 200、窗口 60 ⇒ 窗口覆盖下标 140..199
    expect(countToInclude(150, 200, 60)).toBe(60);
    expect(countToInclude(199, 200, 60)).toBe(60);
  });

  it("目标在窗口外 → 扩到刚好包含它（含上下文）", () => {
    // 下标 100 ⇒ 需要 200-100+2 = 102 条
    expect(countToInclude(100, 200, 60)).toBe(102);
  });

  it("永远不超过总条数", () => {
    expect(countToInclude(0, 200, 60)).toBe(200);
    expect(countToInclude(0, 3, 1, 10)).toBe(3);
  });

  it("非法下标不改变窗口", () => {
    expect(countToInclude(-1, 200, 60)).toBe(60);
    expect(countToInclude(200, 200, 60)).toBe(60);
  });
});
