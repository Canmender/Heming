import { describe, it, expect, vi, beforeEach } from "vitest";
import { listAgents, createAgent } from "./agentsApi.js";

describe("agentsApi", () => {
  beforeEach(() => { vi.restoreAllMocks(); localStorage.setItem("heming.token", "t"); });
  it("listAgents 带 Bearer 并返回数组", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ id: "a1", owner_id: null, name: "和小鸣", avatar: null, description: "" }]), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    const list = await listAgents();
    expect(list).toHaveLength(1);
    const auth = new Headers(fetchMock.mock.calls[0][1]?.headers as HeadersInit).get("authorization");
    expect(auth).toBe("Bearer t");
  });
  it("createAgent POST body 正确", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "a2", owner_id: "u1", name: "架构师", avatar: null, description: "d" }), {
        status: 201, headers: { "content-type": "application/json" },
      }),
    );
    const a = await createAgent({ name: "架构师", description: "d" });
    expect(a.id).toBe("a2");
    const init = fetchMock.mock.calls[0][1]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ name: "架构师", description: "d" });
  });
});
