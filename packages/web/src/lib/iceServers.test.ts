import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEFAULT_ICE_SERVERS,
  fetchIceServers,
  getIceServers,
  setIceServers,
} from "./iceServers.js";

describe("iceServers（ICE 配置拉取与缓存）", () => {
  beforeEach(() => {
    // 缓存是模块级状态：每条用例前清空，避免相互污染
    setIceServers([]);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setIceServers([]);
  });

  it("拉取成功 → getIceServers 返回服务端给的列表（含 TURN 凭据）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [
            { urls: "stun:stun.example.com:3478" },
            { urls: "turn:turn.example.com:3478", username: "u1", credential: "c1" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await fetchIceServers();

    expect(getIceServers()).toEqual([
      { urls: "stun:stun.example.com:3478" },
      { urls: "turn:turn.example.com:3478", username: "u1", credential: "c1" },
    ]);
  });

  it("拉取失败（401）→ 静默回落公共 STUN，不抛", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchIceServers()).resolves.toBeUndefined();
    expect(getIceServers()).toEqual(DEFAULT_ICE_SERVERS);
  });

  it("拉取失败（网络错误）→ 静默回落公共 STUN，不抛", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    await expect(fetchIceServers()).resolves.toBeUndefined();
    expect(getIceServers()).toEqual(DEFAULT_ICE_SERVERS);
  });

  it("服务端返回空列表 → 不覆盖缓存，回落公共 STUN", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ iceServers: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await fetchIceServers();
    expect(getIceServers()).toEqual(DEFAULT_ICE_SERVERS);
  });

  it("默认兜底是公共 STUN（无缓存、无 preload 注入时）", () => {
    expect(getIceServers()).toEqual([{ urls: "stun:stun.miwifi.com:3478" }]);
  });
});
