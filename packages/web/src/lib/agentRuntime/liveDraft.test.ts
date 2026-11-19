import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLiveDraft,
  clearLiveDrafts,
  LIVE_DRAFT_CAP,
  listLiveDrafts,
  saveLiveDraft,
} from "./liveDraft.js";
import { msgCache } from "../e2eSession.js";

const CONV = "c1";

describe("流式草稿留底（d.363）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("短于阈值不写：刷一下重发更便宜，存了只会让「上次中断」误报", () => {
    expect(saveLiveDraft(CONV, { streamId: "s1", agentId: "a1", text: "好的" })).toBe(false);
    expect(listLiveDrafts(CONV)).toEqual([]);
  });

  it("存了能读回来，带上流、智能体与正文", () => {
    const text = "我先看一下入口文件在哪里，然后把整条调用链都理出来";
    expect(saveLiveDraft(CONV, { streamId: "s1", agentId: "a1", text }, 1_000)).toBe(true);
    expect(listLiveDrafts(CONV)).toEqual([{ streamId: "s1", agentId: "a1", at: 1_000, text }]);
  });

  it("同一个流再存一次是覆盖，不是追加（草稿是最新累计）", () => {
    saveLiveDraft(CONV, { streamId: "s1", agentId: "a1", text: "第一段已经足够长了，先存一版下来看看效果如何" }, 1_000);
    saveLiveDraft(CONV, { streamId: "s1", agentId: "a1", text: "第一段已经足够长了，后面又继续续了一大段内容" }, 2_000);
    const drafts = listLiveDrafts(CONV);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.text).toContain("后面又继续续了一大段");
  });

  it("收口/丢弃后列表里就没有了", () => {
    saveLiveDraft(CONV, { streamId: "s1", agentId: "a1", text: "这段正文足够长到会被留下来没问题" });
    clearLiveDraft(CONV, "s1");
    expect(listLiveDrafts(CONV)).toEqual([]);

    saveLiveDraft(CONV, { streamId: "s2", agentId: "a1", text: "另一段正文也足够长到会被留下来" });
    clearLiveDrafts(CONV);
    expect(listLiveDrafts(CONV)).toEqual([]);
  });

  it("最多认 4 条，按时间取最近的", () => {
    for (let i = 0; i < LIVE_DRAFT_CAP + 2; i += 1) {
      saveLiveDraft(
        CONV,
        { streamId: `s${i}`, agentId: "a1", text: `第 \$\{i\} 段草稿，长度足够被留下来了再看看` },
        1_000 + i,
      );
    }
    const drafts = listLiveDrafts(CONV);
    expect(drafts).toHaveLength(LIVE_DRAFT_CAP);
    expect(drafts.map((d) => d.streamId)).toEqual(["s2", "s3", "s4", "s5"]);
  });

  it("不碰别人的缓存条目：普通明文消息不会被当成草稿", () => {
    msgCache.append(CONV, {
      id: "m-real",
      senderId: "a1",
      at: 5_000,
      plain: { kind: "text", text: "这是一条真正的会话消息，不该出现在草稿里" },
    });
    expect(listLiveDrafts(CONV)).toEqual([]);
  });

  it("空会话 id 不写也不读", () => {
    expect(saveLiveDraft("", { streamId: "s1", agentId: "a1", text: "足够长的一段正文内容啊" })).toBe(false);
    expect(listLiveDrafts("")).toEqual([]);
  });
});



