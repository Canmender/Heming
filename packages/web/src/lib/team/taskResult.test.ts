import { describeTaskResult, TASK_RESULT_PREVIEW } from "./taskResult.js";

describe("任务结论怎么写成一行（d.252）", () => {
  it("有结论、有完成时间与提交人：一句话说全", () => {
    const note = describeTaskResult(
      { result: "把登录重试改成指数退避，pnpm test 全绿。", completedAt: "2026-11-17T09:30:00.000Z" },
      { who: "阿鸣", completedText: "11-17 17:30" },
    );
    expect(note?.text).toBe("结论：把登录重试改成指数退避，pnpm test 全绿。（阿鸣 交的，11-17 17:30）");
    expect(note?.full).toBe("把登录重试改成指数退避，pnpm test 全绿。");
  });

  it("只有完成时间没有结论：如实说没写，不编内容", () => {
    const note = describeTaskResult({ completedAt: "2026-11-17T09:30:00.000Z" }, { completedText: "11-17 17:30" });
    expect(note?.text).toContain("（没写结论）");
    expect(note?.full).toBe("（没写结论）");
  });

  it("既没完成时间也没结论：不渲染这一行", () => {
    expect(describeTaskResult({})).toBeNull();
    expect(describeTaskResult({ result: "   ", completedAt: null })).toBeNull();
  });

  it("任务被退回未完成：结论还在库里，但不再显示成「已提交」", () => {
    expect(describeTaskResult({ result: "上次的结论", completedAt: null })).toBeNull();
  });

  it("不知道提交人时说「已提交」，不硬塞名字", () => {
    const note = describeTaskResult({ result: "做完了", completedAt: "2026-11-17T09:30:00.000Z" }, { who: null });
    expect(note?.text).toBe("结论：做完了（已提交）");
  });

  it("超长结论按码点截断并保留完整正文", () => {
    const long = "😀".repeat(TASK_RESULT_PREVIEW + 5);
    const note = describeTaskResult({ result: long, completedAt: "2026-11-17T09:30:00.000Z" }, { who: "阿鸣" });
    expect(note?.text.startsWith(`结论：${"😀".repeat(TASK_RESULT_PREVIEW)}…`)).toBe(true);
    expect(note?.full).toBe(long);
    expect(note?.text).not.toContain("\uFFFD");
  });
});
