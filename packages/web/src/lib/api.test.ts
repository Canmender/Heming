import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  api,
  ApiError,
  setOnUnauthorized,
  setToken,
  resolveUrl,
  uploadFile,
  uploadEncryptedFile,
  downloadEncryptedFile,
  fetchFileBlobUrl,
  fetchFileBlobText,
  fetchFileUsage,
} from "./api.js";
import { hasSubtle, fromB64, toB64 } from "./e2eCrypto.js";

// E2E Task 5：hasSubtle 可翻转（附件加密/解密的无 subtle 拦截面），其余导出保持真身
vi.mock("./e2eCrypto.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./e2eCrypto.js")>();
  return { ...actual, hasSubtle: vi.fn(() => true) };
});

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

  it("uploadFile 413 quota_exceeded → 抛中文「超出存储配额」（非 ApiError，签名不变）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "quota_exceeded" }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const err = await uploadFile(new File(["x"], "x.txt", { type: "text/plain" })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as Error).message).toBe("超出存储配额");
  });

  it("uploadFile 413 非 quota_exceeded（如网关纯文本体）仍抛原 ApiError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Payload too large", { status: 413 }),
    );
    const err = await uploadFile(new File(["x"], "x.txt")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(413);
  });
});

describe("fetchFileUsage（右栏存储用量）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    setToken(null);
  });

  it("GET /api/files/usage 带 Bearer 并返回 {used,quota}", async () => {
    setToken("t1");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ used: 5, quota: 200 * 1024 * 1024 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const got = await fetchFileUsage();

    expect(got).toEqual({ used: 5, quota: 200 * 1024 * 1024 });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(resolveUrl("/api/files/usage"));
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer t1");
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

/** 预览文本/Markdown 内嵌：与 fetchFileBlobUrl 同鉴权，差异只在返回 res.text()。 */
describe("fetchFileBlobText（附件 content 带鉴权取纯文本）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setOnUnauthorized(null);
    localStorage.clear();
  });

  it("fetchFileBlobText 带 Authorization 请求 content 并返回 .text()", async () => {
    localStorage.clear();
    setToken("t1");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("# 标题", {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      }),
    );

    const text = await fetchFileBlobText("f9");

    expect(text).toBe("# 标题");
    const [req, init] = fetchSpy.mock.calls[0]!;
    expect(String(req)).toBe(resolveUrl("/api/files/f9/content"));
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer t1");
    expect(new Headers(init?.headers).get("Content-Type")).toBeNull(); // GET 不塞 JSON 头
  });

  it("fetchFileBlobText 401：触发全局 onUnauthorized 并抛 ApiError", async () => {
    setToken("t1");
    const onUnauthorized = vi.fn();
    setOnUnauthorized(onUnauthorized);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const err = await fetchFileBlobText("f9").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as Error).message).toBe("unauthorized");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

/**
 * E2E Task 5：附件密文上传与解密下载（规格 §2.4 文件边界——消息附件加密）。
 * AAD 常量与 api.ts 的 FILE_ENC_AAD 同源（"heming.e2e.file.v1"）：测试独立拼一份，
 * 锁死两侧口径（改生产常量不改测试 → GCM 校验失败，用例即红）。
 * IV 12B 前置于密文字节（contentBase64 = base64(iv || ciphertext||tag)）——往返用例锁此形状。
 */
describe("uploadEncryptedFile / downloadEncryptedFile（E2E 附件加密）", () => {
  const AAD = new TextEncoder().encode("heming.e2e.file.v1");

  const serverMeta = (over: Record<string, unknown> = {}) => ({
    id: "f1",
    owner: "alice",
    name: ".enca.txt",
    mime: "application/octet-stream",
    size: 44,
    updatedAt: "2026-10-17T00:00:00.000Z",
    ...over,
  });

  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(hasSubtle).mockReturnValue(true);
    setOnUnauthorized(null);
    setToken(null);
    localStorage.clear();
  });

  it("上传：POST 体 mime 置 application/octet-stream、name 加 .enc 前缀、正文不含原文字节", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(serverMeta(), 201));

    const got = await uploadEncryptedFile(
      new File(["HEMING-SECRET-附件正文"], "a.txt", { type: "text/plain" }),
    );

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(resolveUrl("/api/files"));
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as {
      name: string;
      mime: string;
      contentBase64: string;
    };
    expect(body.mime).toBe("application/octet-stream"); // 服务端只见密文，不落明文类型
    expect(body.name).toBe(".enca.txt"); // .enc 前缀（原名保留在消息 payload，不进共享库）
    const raw = fromB64(body.contentBase64);
    expect(raw.length).toBeGreaterThan(12 + 16); // IV + GCM tag
    // 原文字节（ASCII 与 UTF-8）不得出现在上传体
    const tail = raw.subarray(12);
    expect(String.fromCharCode(...tail)).not.toContain("HEMING-SECRET");
    expect(new TextDecoder("utf-8", { fatal: false }).decode(tail)).not.toContain("附件正文");
    // 返回 meta：服务端形态 + 随消息进密文的 32B fileKey（base64）
    expect(got.id).toBe("f1");
    expect(got.name).toBe(".enca.txt");
    expect(got.mime).toBe("application/octet-stream");
    expect(fromB64(got.key)).toHaveLength(32);
  });

  it("往返：downloadEncryptedFile 用同一 key 解回原文（带鉴权、返回 Blob、IV 前置形状锁定）", async () => {
    setToken("t1");
    const plaintext = "端到端附件 roundtrip 明文";
    const captured: { contentBase64: string } = { contentBase64: "" };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url === resolveUrl("/api/files")) {
        captured.contentBase64 = (JSON.parse(String(init?.body)) as { contentBase64: string })
          .contentBase64;
        return Promise.resolve(json(serverMeta(), 201));
      }
      if (url === resolveUrl("/api/files/f1/content")) {
        const bytes = fromB64(captured.contentBase64);
        return Promise.resolve({
          ok: true,
          status: 200,
          blob: async () => new Blob([bytes.buffer as ArrayBuffer]),
        } as unknown as Response);
      }
      return Promise.resolve(json({ error: "not found" }, 404));
    });

    const got = await uploadEncryptedFile(
      new File([plaintext], "a.txt", { type: "text/plain" }),
    );
    const blob = await downloadEncryptedFile(got.id, got.key, "text/plain");

    expect(blob.type).toBe("text/plain");
    expect(new TextDecoder().decode(await blob.arrayBuffer())).toBe(plaintext);
    // content 请求与 fetchFileBlobUrl 同鉴权口径（Bearer + 不设 Content-Type）
    const contentCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes("/api/files/f1/content"),
    )!;
    expect(new Headers(contentCall[1]?.headers).get("Authorization")).toBe("Bearer t1");
    expect(new Headers(contentCall[1]?.headers).get("Content-Type")).toBeNull();
    // 同源 AAD 独立复解一遍：测试常量与生产 FILE_ENC_AAD 漂移时此处先红
    const raw = fromB64(captured.contentBase64);
    const ck = await crypto.subtle.importKey(
      "raw",
      fromB64(got.key).buffer as ArrayBuffer,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const manual = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.slice(0, 12), additionalData: AAD },
      ck,
      raw.slice(12),
    );
    expect(new TextDecoder().decode(manual)).toBe(plaintext);
  });

  it("解密失败（密钥错/密文被换）→ 抛可读「附件解密失败」，不建半吊子结果", async () => {
    setToken("t1");
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob([crypto.getRandomValues(new Uint8Array(64))]),
    } as unknown as Response);

    const wrongKey = toB64(crypto.getRandomValues(new Uint8Array(32)));
    const err = await downloadEncryptedFile("f1", wrongKey, "text/plain").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("附件解密失败");
  });

  it("AAD 绑定：换 AAD 加密的密文解不开（锁定 FILE_ENC_AAD 口径，防两处常量漂移）", async () => {
    setToken("t1");
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ck = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("heming.other.v1") },
        ck,
        new TextEncoder().encode("x"),
      ),
    );
    const sealed = new Uint8Array(iv.length + ct.length);
    sealed.set(iv, 0);
    sealed.set(ct, iv.length);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob([sealed]),
    } as unknown as Response);

    const err = await downloadEncryptedFile("f1", toB64(keyBytes)).catch((e: unknown) => e);
    expect((err as Error).message).toContain("附件解密失败");
  });

  it("解密下载 401：与 fetchFileBlobUrl 同口径触发 onUnauthorized 并抛 ApiError", async () => {
    setToken("t1");
    const onUnauthorized = vi.fn();
    setOnUnauthorized(onUnauthorized);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ error: "unauthorized" }, 401),
    );

    const err = await downloadEncryptedFile("f1", toB64(new Uint8Array(32))).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("无 subtle：上传与解密下载都拦截抛可读错误，且不发任何请求（不降级明文）", async () => {
    vi.mocked(hasSubtle).mockReturnValue(false);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ ok: true }, 200));

    const up = await uploadEncryptedFile(new File(["x"], "a.txt")).catch((e: unknown) => e);
    expect(up).toBeInstanceOf(Error);
    expect((up as Error).message).toMatch(/无法加密消息/);
    const down = await downloadEncryptedFile("f1", toB64(new Uint8Array(32))).catch(
      (e: unknown) => e,
    );
    expect(down).toBeInstanceOf(Error);
    expect((down as Error).message).toMatch(/无法加密消息/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
