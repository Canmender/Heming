import { describe, it, expect, vi, beforeEach } from "vitest";
import { listAgents } from "./agentsApi.js";

describe("agentsApi", () => {
  beforeEach(() => { vi.restoreAllMocks(); localStorage.setItem("heming.token", "t"); });
  it("listAgents 带 Bearer 并返回数组（单智能体：恰一条内置智能体）", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ id: "system-assistant", owner_id: null, name: "和小鸣", avatar: null, description: "" }]), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    const list = await listAgents();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("system-assistant");
    const auth = new Headers(fetchMock.mock.calls[0][1]?.headers as HeadersInit).get("authorization");
    expect(auth).toBe("Bearer t");
  });
});