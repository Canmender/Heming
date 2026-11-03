import { describe, expect, it } from "vitest";
import {
  DRAG_THRESHOLD_PX,
  classifyPointerUp,
  containsPoint,
  createFrameCoalescer,
  exceedsDragThreshold,
  isInteractiveAt,
  isPrimaryButtonDown,
  modelBoundsToHitBox,
  resolveInteractive,
  shouldBeginDrag,
  shouldReportChange,
} from "./petInteraction.js";

const stage = { x: 40, y: 10, width: 220, height: 400 };

describe("点与矩形", () => {
  it("落在内部与边界都算命中", () => {
    expect(containsPoint(stage, 100, 100)).toBe(true);
    expect(containsPoint(stage, 40, 10)).toBe(true); // 左上角
    expect(containsPoint(stage, 260, 410)).toBe(true); // 右下角
  });

  it("落在外部不命中", () => {
    expect(containsPoint(stage, 39, 100)).toBe(false);
    expect(containsPoint(stage, 261, 100)).toBe(false);
    expect(containsPoint(stage, 100, 9)).toBe(false);
    expect(containsPoint(stage, 100, 411)).toBe(false);
  });

  it("空矩形 / 退化矩形 / 非法数值一律不命中", () => {
    expect(containsPoint(null, 1, 1)).toBe(false);
    expect(containsPoint(undefined, 1, 1)).toBe(false);
    expect(containsPoint({ x: 0, y: 0, width: 0, height: 0 }, 0, 0)).toBe(false);
    expect(containsPoint({ x: 0, y: 0, width: -10, height: 10 }, 0, 0)).toBe(false);
    expect(containsPoint({ x: NaN, y: 0, width: 10, height: 10 }, 0, 0)).toBe(false);
    expect(containsPoint(stage, NaN, 100)).toBe(false);
  });
});

describe("多区域命中（角色 ∪ 气泡 ∪ 输入框）", () => {
  const bubble = { x: 0, y: 0, width: 300, height: 60 };

  it("落在任一区域即算可交互", () => {
    expect(isInteractiveAt([stage, bubble], 150, 30)).toBe(true); // 气泡
    expect(isInteractiveAt([stage, bubble], 150, 200)).toBe(true); // 角色
    expect(isInteractiveAt([stage, bubble], 150, 350)).toBe(true); // 角色下部
  });

  it("空白处（角色与气泡之间）不拦截鼠标", () => {
    expect(isInteractiveAt([stage, bubble], 5, 300)).toBe(false);
    expect(isInteractiveAt([stage, bubble], 290, 250)).toBe(false);
  });

  it("全部为空时一律不命中", () => {
    expect(isInteractiveAt([null, undefined], 150, 150)).toBe(false);
  });
});

describe("点击 vs 拖拽", () => {
  it("小位移算点击（手抖不该把点击变成拖拽）", () => {
    expect(classifyPointerUp(100, 100, 100, 100)).toBe("tap");
    expect(classifyPointerUp(100, 100, 101, 101)).toBe("tap");
    expect(classifyPointerUp(100, 100, 102, 101)).toBe("tap");
  });

  it("达到阈值算拖拽", () => {
    expect(classifyPointerUp(100, 100, 100 + DRAG_THRESHOLD_PX, 100)).toBe("drag");
    expect(classifyPointerUp(100, 100, 100, 100 + DRAG_THRESHOLD_PX)).toBe("drag");
    expect(classifyPointerUp(100, 100, 130, 140)).toBe("drag");
  });

  it("斜向也按欧氏距离判定", () => {
    // 3-4-5：位移恰好 5px
    expect(classifyPointerUp(0, 0, 3, 4)).toBe("drag");
    expect(classifyPointerUp(0, 0, 2, 2)).toBe("tap");
  });

  it("非法输入按点击处理（保守：宁可开对话也不要莫名移动窗口）", () => {
    expect(classifyPointerUp(NaN, 0, 0, 0)).toBe("tap");
    expect(classifyPointerUp(0, 0, undefined as unknown as number, 0)).toBe("tap");
  });
});

describe("命中区换算", () => {
  const viewport = { width: 300, height: 420 };

  it("模型在画布内时原样换算", () => {
    expect(modelBoundsToHitBox({ x: 20, y: 30, width: 260, height: 380 }, viewport)).toEqual({
      x: 20,
      y: 30,
      width: 260,
      height: 380,
    });
  });

  it("模型超出画布时夹到窗口内（命中区不该延伸到窗口外）", () => {
    const box = modelBoundsToHitBox({ x: -50, y: -30, width: 400, height: 500 }, viewport);
    expect(box).toEqual({ x: 0, y: 0, width: 300, height: 420 });
  });

  it("部分超出时只夹被超出的一侧", () => {
    const box = modelBoundsToHitBox({ x: -10, y: 20, width: 200, height: 300 }, viewport);
    expect(box).toEqual({ x: 0, y: 20, width: 190, height: 300 });
  });

  it("完全在窗口外 / 退化 / 空值 → null", () => {
    expect(modelBoundsToHitBox({ x: 400, y: 0, width: 100, height: 100 }, viewport)).toBeNull();
    expect(modelBoundsToHitBox({ x: 0, y: 0, width: 0, height: 0 }, viewport)).toBeNull();
    expect(modelBoundsToHitBox(null, viewport)).toBeNull();
    expect(modelBoundsToHitBox({ x: NaN, y: 0, width: 10, height: 10 }, viewport)).toBeNull();
  });
});

describe("上报去重", () => {
  it("值不变不重复上报（mousemove 是高频事件）", () => {
    expect(shouldReportChange(true, true)).toBe(false);
    expect(shouldReportChange(false, false)).toBe(false);
  });
  it("值变化才上报", () => {
    expect(shouldReportChange(true, false)).toBe(true);
    expect(shouldReportChange(false, true)).toBe(true);
  });
});

describe("浮层与可交互判定（d.68 菜单点了没反应）", () => {
  const hitBox = { x: 40, y: 10, width: 220, height: 400 };
  const bubble = { x: 0, y: 0, width: 300, height: 60 };
  const menu = { x: 100, y: 200, width: 148, height: 220 };
  const error = { x: 8, y: 300, width: 284, height: 60 };
  const rects = [bubble, menu, error];

  it("命中区包含菜单：落在菜单上算可交互（旧实现漏了菜单，穿透态吃不到点击）", () => {
    expect(resolveInteractive(hitBox, rects, menu.x + 10, menu.y + 10, false)).toBe(true);
  });

  it("命中区包含错误条", () => {
    expect(resolveInteractive(hitBox, rects, error.x + 5, error.y + 5, false)).toBe(true);
  });

  it("空白处不拦截鼠标（不挡桌面点击）", () => {
    expect(resolveInteractive(hitBox, rects, 5, 300, false)).toBe(false);
  });

  it("浮层打开时整窗拦截：指针不在任何矩形上也返回 true（别把菜单点穿）", () => {
    expect(resolveInteractive(hitBox, rects, 5, 300, true)).toBe(true);
    expect(resolveInteractive(null, [], 0, 0, true)).toBe(true);
  });

  it("没有命中区（模型未加载）时只有浮层能触发拦截", () => {
    expect(resolveInteractive(null, [], 150, 200, false)).toBe(false);
  });
});

describe("拖拽起点的按键判据", () => {
  it("左键位：1 表示按下；0/2 表示没按（右键不算左键）", () => {
    expect(isPrimaryButtonDown(1)).toBe(true);
    expect(isPrimaryButtonDown(3)).toBe(true); // 左键 + 右键
    expect(isPrimaryButtonDown(0)).toBe(false);
    expect(isPrimaryButtonDown(2)).toBe(false);
    expect(isPrimaryButtonDown(undefined)).toBe(false);
    expect(isPrimaryButtonDown(NaN)).toBe(false);
  });

  it("越过阈值且左键仍按着才开始拖拽", () => {
    const session = { startX: 10, startY: 10, dragging: false };
    expect(shouldBeginDrag(session, 10 + DRAG_THRESHOLD_PX, 10, 1)).toBe(true);
    expect(shouldBeginDrag(session, 10, 10 + DRAG_THRESHOLD_PX, 1)).toBe(true);
  });

  it("tap 之后光标继续动（buttons=0）不判拖拽 —— 否则桌宠会被鼠标带着跑", () => {
    const session = { startX: 10, startY: 10, dragging: false };
    expect(shouldBeginDrag(session, 200, 200, 0)).toBe(false);
  });

  it("阈值内不算拖拽；没有按下会话也不算", () => {
    const session = { startX: 10, startY: 10, dragging: false };
    expect(shouldBeginDrag(session, 10 + DRAG_THRESHOLD_PX - 1, 10, 1)).toBe(false);
    expect(shouldBeginDrag(null, 200, 200, 1)).toBe(false);
  });

  it("已经在拖拽中就不再重复判定起点", () => {
    expect(shouldBeginDrag({ startX: 0, startY: 0, dragging: true }, 200, 200, 1)).toBe(false);
  });

  it("exceedsDragThreshold 与 classifyPointerUp 同一口径", () => {
    const far = DRAG_THRESHOLD_PX;
    expect(exceedsDragThreshold(0, 0, far, 0)).toBe(true);
    expect(exceedsDragThreshold(0, 0, far - 0.5, 0)).toBe(false);
    expect(classifyPointerUp(0, 0, far, 0)).toBe("drag");
    expect(classifyPointerUp(0, 0, 0, 0)).toBe("tap");
    expect(exceedsDragThreshold(0, 0, NaN, 0)).toBe(false);
  });
});

describe("按帧合并移动上报（rAF 节流）", () => {
  function makeFakeFrames() {
    let nextId = 1;
    const queue = new Map<number, () => void>();
    const cancelled: number[] = [];
    return {
      schedule: (callback: () => void) => {
        const id = nextId++;
        queue.set(id, callback);
        return id;
      },
      cancel: (id: number) => {
        cancelled.push(id);
        queue.delete(id);
      },
      runFrame: () => {
        const pending = [...queue.entries()];
        queue.clear();
        for (const [, callback] of pending) callback();
      },
      pendingCount: () => queue.size,
      cancelled,
    };
  }

  it("同一帧内多次 request 只上报一次（这是残影/闪烁的根因修复）", () => {
    const frames = makeFakeFrames();
    let emitted = 0;
    const coalescer = createFrameCoalescer(() => {
      emitted += 1;
    }, frames);
    coalescer.request();
    coalescer.request();
    coalescer.request();
    expect(emitted).toBe(0); // 还没到下一帧
    expect(frames.pendingCount()).toBe(1);
    frames.runFrame();
    expect(emitted).toBe(1);
  });

  it("跨帧的移动各上报一次（不会把连续移动并成一帧）", () => {
    const frames = makeFakeFrames();
    let emitted = 0;
    const coalescer = createFrameCoalescer(() => {
      emitted += 1;
    }, frames);
    coalescer.request();
    frames.runFrame();
    coalescer.request();
    frames.runFrame();
    expect(emitted).toBe(2);
  });

  it("flush 在帧未执行时立刻补一次终值，并取消已排队的帧（不重发）", () => {
    const frames = makeFakeFrames();
    let emitted = 0;
    const coalescer = createFrameCoalescer(() => {
      emitted += 1;
    }, frames);
    coalescer.request();
    coalescer.flush();
    expect(emitted).toBe(1);
    expect(frames.cancelled).toHaveLength(1);
    expect(frames.pendingCount()).toBe(0);

    frames.runFrame(); // 已取消，不该再发
    expect(emitted).toBe(1);
  });

  it("flush 没有待发移动时不上报（光标没动就别发 IPC）", () => {
    const frames = makeFakeFrames();
    let emitted = 0;
    const coalescer = createFrameCoalescer(() => {
      emitted += 1;
    }, frames);
    coalescer.flush();
    expect(emitted).toBe(0);
    expect(frames.cancelled).toHaveLength(0);
  });

  it("帧已执行后再 flush 不重复上报", () => {
    const frames = makeFakeFrames();
    let emitted = 0;
    const coalescer = createFrameCoalescer(() => {
      emitted += 1;
    }, frames);
    coalescer.request();
    frames.runFrame();
    coalescer.flush();
    expect(emitted).toBe(1);
  });

  it("cancel 丢弃待发移动（拖拽被取消/组件卸载）", () => {
    const frames = makeFakeFrames();
    let emitted = 0;
    const coalescer = createFrameCoalescer(() => {
      emitted += 1;
    }, frames);
    coalescer.request();
    coalescer.cancel();
    frames.runFrame();
    expect(emitted).toBe(0);
    expect(frames.cancelled).toHaveLength(1);
  });
});
