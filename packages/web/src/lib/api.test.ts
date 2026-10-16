import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  api,
  ApiError,
  setOnUnauthorized,
  setToken,
  resolveUrl,
  uploadFile,
  fetchFileBlobUrl,
} from "./api.js";

describe("resolveUrl（API base 直连注入）", () => {
  it("base 为空：保持同源相对路径（本地 dev 走 vite 代理）", () => {
    expect(resolveUrl("/api/me", "", "localhost:3000")).toBe("/api/me");
    expect(resolveUrl("/api/auth/login", "", "localhost:3000")).toBe("/api/auth/login");
  });

  it("配置 base：拼接为绝对地址直连服务端", () => {
    expect(resolveUrl("/api/me", "http://47.92.39.184", "localhost:3000")).toBe(
      "http://47.92.39.184/api/me",
    );
  });

  it("base 为空且页面 host 为空（file:// 桌面页）→ 抛「未配置 VITE_API_BASE」", () => {
    expect(() => resolveUrl("/api/me", "", "")).toThrow(/未配置 VITE_API_BASE/);
  });

  it("base 缺 http(s) 协议（如 localhost:3000 伪协议）→ 抛统一「VITE_API_BASE 配置无效」", () => {
    expect(() => resolveUrl("/api/me", "localhost:3000", "x")).toThrow(
      /VITE_API_BASE 配置无效，需形如 http:\/\/host/,
    );
  });

  it("base 为垃圾值 → 抛统一「VITE_API_BASE 配置无效」", () => {
    expect(() => resolveUrl("/api/me", "not a url", "x")).toThrow(
      /VITE_API_BASE 配置无效，需形如 http:\/\/host/,
    );
  });

  it("模块常量 API_BASE 读取 VITE_API_BASE（stubEnv + 重载模块）", async () => {
    vi.stubEnv("VITE_API_BASE", "http://x");
    vi.resetModules();
    try {
      const mod = await import("./api.js");
      expect(mod.API_BASE).toBe("http://x");
      expect(mod.resolveUrl("/api/me")).toBe("http://x/api/me");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("api 401 全局回调", () => {
  beforeEach(() => {
    localStorage.clear();
    setToken("t1");
  });

  afterEach(() => {
    setOnUnauthorized(null);
    vi.restoreAllMocks();
  });

  it("401 响应触发 onUnauthorized 回调，且仍抛 ApiError（不吞错）", async () => {
    const onUnauthorized = vi.fn();
    setOnUnauthorized(onUnauthorized);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const err = await api("/api/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as Error).message).toBe("unauthorized");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("非 401 错误不触发 onUnauthorized", async () => {
    const onUnauthorized = vi.fn();
    setOnUnauthorized(onUnauthorized);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(api("/api/health")).rejects.toMatchObject({ status: 500 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("2xx 不触发 onUnauthorized", async () => {
    const onUnauthorized = vi.fn();
    setOnUnauthorized(onUnauthorized);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(api<{ ok: boolean }>("/api/health")).resolves.toEqual({ ok: true });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("uploadFile（附件上传下沉，App/Chat 共用）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploadFile POST base64 并返回 meta", async () => {
    const meta = {
      id: "f1",
      owner: "alice",
      name: "a.txt",
      mime: "text/plain",
      size: 2,
      updatedAt: "2026-10-17T00:00:00.000Z",
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(meta), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const got = await uploadFile(new File(["ab"], "a.txt", { type: "text/plain" }));

    expect(got).toEqual(meta);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(resolveUrl("/api/files"));
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as {
      name: string;
      mime: string;
      contentBase64: string;
    };
    expect(body).toEqual({
      name: "a.txt",
      mime: "text/plain",
      contentBase64: "YWI=", // btoa("ab")
    });
  });

  it("无 type 的文件回退 application/octet-stream", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "f2" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await uploadFile(new File(["x"], "无扩展名"));

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as { mime: string };
    expect(body.mime).toBe("application/octet-stream");
  });
});

/** 附件 content 路由 authOnly：裸 <img src>/<a href> 带不上 Bearer 会 401 → 走 fetch blob。 */
describe("fetchFileBlobUrl（附件 content 带鉴权取 objectURL）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setOnUnauthorized(null);
    localStorage.clear();
  });

  it("fetchFileBlobUrl 带 Authorization 请求 content 并把 blob 转成 objectURL", async () => {
    localStorage.clear();
    setToken("t1");
    const fakeBlob = { size: 3, type: "image/png" } as Blob;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => fakeBlob,
    } as unknown as Response);
    const createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:t1url");

    const url = await fetchFileBlobUrl("f9");

    expect(url).toBe("blob:t1url"); // 返回的是 objectURL 而非裸 content 地址
    const [req, init] = fetchSpy.mock.calls[0]!;
    expect(String(req)).toBe(resolveUrl("/api/files/f9/content"));
    // content 路由 authOnly：必须带 Bearer（裸 <img src>/<a href> 带不上 → 401 的根因）
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer t1");
    expect(new Headers(init?.headers).get("Content-Type")).toBeNull(); // GET 取二进制，不塞 JSON 头
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(fakeBlob);
  });

  it("fetchFileBlobUrl 401：触发全局 onUnauthorized 并抛 ApiError，不建 objectURL", async () => {
    setToken("t1");
    const onUnauthorized = vi.fn();
    setOnUnauthorized(onUnauthorized);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const createSpy = vi.spyOn(URL, "createObjectURL");

    const err = await fetchFileBlobUrl("f9").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as Error).message).toBe("unauthorized");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(createSpy).not.toHaveBeenCalled();
  });
});
