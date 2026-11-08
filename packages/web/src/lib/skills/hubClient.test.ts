import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillHubDownload, SkillHubDetail, SkillHubPage, SkillHubStatus } from "@heming/shared";
import {
  HUB_KEY_STORAGE_KEY,
  SkillHubError,
  clearHubKey,
  downloadHubSkill,
  fetchHubDetail,
  fetchHubSkills,
  fetchHubStatus,
  readHubKeyState,
  registerHubAccount,
  safeExternalUrl,
  saveHubKey,
} from "./hubClient.js";

/**
 * 技能社区客户端（d.109）：五个调用 + 响应校验 + 中文错误 + Key 本机存储。
 * 全部注入 fetch；Key 存储用 jsdom localStorage / 假 secrets 桥。
 */

const SHA = "a".repeat(64);
const BASE = "https://heming.example";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function statusFixture(overrides: Partial<SkillHubStatus> = {}): SkillHubStatus {
  return {
    enabled: true,
    source: {
      id: "xiaping",
      name: "虾评",
      homepage: "https://xiaping.coze.com",
      docsUrl: "https://xiaping.coze.com/skill.md",
    },
    reachable: true,
    categories: ["写作", "效率"],
    ...overrides,
  };
}

function pageFixture(): SkillHubPage {
  return {
    skills: [
      {
        id: "xp-1",
        name: "周报助手",
        description: "写周报",
        triggers: ["周报"],
        categories: ["写作"],
        tags: ["官方"],
        ownerName: "虾评",
        version: "1.2.0",
        downloads: 1200,
        stars: 45,
        status: "official",
        requiresApiKey: false,
        featured: true,
        updatedAt: "2026-11-08T00:00:00.000Z",
      },
    ],
    total: 1,
    hasMore: false,
    fetchedAt: "2026-11-08T00:00:00.000Z",
  };
}

function downloadFixture(): SkillHubDownload {
  return {
    skillId: "xp-1",
    name: "周报助手",
    version: "1.2.0",
    skillMd: "---\nname: 周报助手\nversion: 1.2.0\n---\n写周报。",
    files: [{ path: "pages/ref.md", size: 100 }],
    zipSha256: SHA,
    size: 2048,
  };
}

describe("fetchHubStatus", () => {
  it("成功解析状态；缺省 reachable=true", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        enabled: true,
        source: statusFixture().source,
        categories: ["写作"],
      }),
    );
    const status = await fetchHubStatus({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(status.enabled).toBe(true);
    expect(status.reachable).toBe(true);
    expect(String((fetchImpl.mock.calls[0] as unknown as [unknown])[0])).toBe(`${BASE}/api/skill-hub`);
  });

  it("503：翻译成「技能社区未启用」", async () => {
    const fetchImpl = async () => jsonResponse({ error: "off" }, 503);
    await expect(fetchHubStatus({ fetchImpl })).rejects.toThrow(/技能社区未启用/);
  });

  it("网络错误 / 坏形状都转成中文，不把脏数据交给 UI", async () => {
    const network = async () => {
      throw new Error("connection refused");
    };
    await expect(fetchHubStatus({ fetchImpl: network })).rejects.toThrow(/技能社区请求失败/);

    const bad = async () => jsonResponse({ enabled: "yes" });
    await expect(fetchHubStatus({ fetchImpl: bad })).rejects.toThrow(/数据格式不对/);
  });
});

describe("fetchHubSkills", () => {
  it("带上 page/limit/search/category/sort 查询参数并解析分页", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(pageFixture()));
    const page = await fetchHubSkills({
      baseUrl: BASE,
      page: 2,
      limit: 24,
      search: "周报",
      category: "写作",
      sort: "stars",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(page.total).toBe(1);
    expect(page.skills[0]!.name).toBe("周报助手");
    const url = String((fetchImpl.mock.calls[0] as unknown as [unknown])[0]);
    expect(url).toContain("/api/skill-hub/skills?");
    expect(url).toContain("page=2");
    expect(url).toContain("limit=24");
    expect(url).toContain("search=%E5%91%A8%E6%8A%A5");
    expect(url).toContain("category=%E5%86%99%E4%BD%9C");
    expect(url).toContain("sort=stars");
  });
});

describe("fetchHubDetail / downloadHubSkill / registerHubAccount", () => {
  it("详情：404 中文提示，成功返回安全字段", async () => {
    const detail: SkillHubDetail = {
      ...pageFixture().skills[0]!,
      createdAt: "2026-11-01T00:00:00.000Z",
      versionCount: 1,
      securityStatus: "safe",
    };
    const fetchImpl = async () => jsonResponse(detail);
    await expect(fetchHubDetail("xp-1", { fetchImpl })).resolves.toMatchObject({
      securityStatus: "safe",
    });

    const missing = async () => jsonResponse({ error: "not found" }, 404);
    await expect(fetchHubDetail("xp-1", { fetchImpl: missing })).rejects.toThrow(/不存在或已下架/);
  });

  it("下载：必须带 x-skill-hub-key；空 Key 不发请求", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(downloadFixture()));
    const result = await downloadHubSkill("xp-1", "key-123", {
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.skillMd).toContain("周报助手");
    const init = (fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    expect((init.headers as Record<string, string>)["x-skill-hub-key"]).toBe("key-123");

    const emptyFetch = vi.fn();
    await expect(
      downloadHubSkill("xp-1", "   ", { fetchImpl: emptyFetch as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(SkillHubError);
    expect(emptyFetch).not.toHaveBeenCalled();
  });

  it("下载 401：翻译成「需要虾评 API Key」", async () => {
    const fetchImpl = async () => jsonResponse({ error: "unauthorized" }, 401);
    await expect(downloadHubSkill("xp-1", "bad", { fetchImpl })).rejects.toThrow(
      /需要虾评 API Key/,
    );
  });

  it("注册：POST {name} 并返回 apiKey", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ apiKey: "xp-key-12345678", name: "snake" }));
    const result = await registerHubAccount("snake", {
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.apiKey).toBe("xp-key-12345678");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/skill-hub/register`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-heming-client"]).toBe("1");
    expect(JSON.parse(String(init.body))).toEqual({ name: "snake" });
  });
});


describe("safeExternalUrl（P1-4 外部链接白名单）", () => {
  it("只放行 http/https；javascript/data/ftp/相对路径/空白/超长都返回 null", () => {
    expect(safeExternalUrl("http://ok")).toBe("http://ok");
    expect(safeExternalUrl("https://ok/path?q=1")).toBe("https://ok/path?q=1");
    expect(safeExternalUrl("  https://ok  ")).toBe("https://ok");

    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl(" JavaScript:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeExternalUrl("ftp://example.com/file")).toBeNull();
    expect(safeExternalUrl("/relative/path")).toBeNull();
    expect(safeExternalUrl("not a url")).toBeNull();
    expect(safeExternalUrl("   ")).toBeNull();
    expect(safeExternalUrl(undefined)).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl(`https://ok/${"a".repeat(500)}`)).toBeNull();
  });
});

describe("社区 Key 本机存储", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
  });
  afterEach(() => {
    localStorage.clear();
    delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
  });

  it("无 secrets 桥：明文兜底并如实返回 encrypted=false", async () => {
    const result = await saveHubKey("key-plain-123");
    expect(result.encrypted).toBe(false);
    const raw = JSON.parse(localStorage.getItem(HUB_KEY_STORAGE_KEY) as string) as {
      key: string;
    };
    expect(raw.key).toBe("key-plain-123");
    await expect(readHubKeyState()).resolves.toEqual({ kind: "plain", key: "key-plain-123" });

    clearHubKey();
    await expect(readHubKeyState()).resolves.toEqual({ kind: "missing" });
  });

  it("有 secrets 桥：加密成 {__hemingEnc} 并可读回；无桥读密文回落 locked", async () => {
    (window as unknown as { __heming_secrets: unknown }).__heming_secrets = {
      available: true,
      asyncAvailable: true,
      availableAsync: async () => true,
      encryptAsync: async (plain: string) => `enc:${plain}`,
      decryptAsync: async (cipher: string) => cipher.replace(/^enc:/, ""),
      encrypt: () => null,
      decrypt: () => null,
    };
    const result = await saveHubKey("key-enc-123");
    expect(result.encrypted).toBe(true);
    const raw = JSON.parse(localStorage.getItem(HUB_KEY_STORAGE_KEY) as string) as {
      __hemingEnc: string;
    };
    expect(raw.__hemingEnc).toBe("enc:key-enc-123");
    await expect(readHubKeyState()).resolves.toEqual({
      kind: "encrypted",
      key: "key-enc-123",
    });

    delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
    await expect(readHubKeyState()).resolves.toEqual({ kind: "locked" });
  });

  it("坏 JSON / 空值按 missing 处理（不把脏值当 Key 发出去）", async () => {
    localStorage.setItem(HUB_KEY_STORAGE_KEY, "not-json");
    await expect(readHubKeyState()).resolves.toEqual({ kind: "plain", key: "not-json" });
    localStorage.setItem(HUB_KEY_STORAGE_KEY, JSON.stringify({}));
    await expect(readHubKeyState()).resolves.toEqual({ kind: "missing" });
  });
});

describe("错误透传与超时/取消（d.113 P1-3 / P1-8）", () => {
  it("429 带 retryAfter：透出「上游限流，请约 N 秒后重试」，并保留原 status", async () => {
    const fetchImpl = async () => jsonResponse({ error: "too many requests", retryAfter: 5 }, 429);
    const error = await fetchHubStatus({ fetchImpl }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SkillHubError);
    expect((error as SkillHubError).status).toBe(429);
    expect((error as Error).message).toContain("上游限流，请约 5 秒后重试");
  });

  it("402：透出服务端中文 error；坏 JSON 错误体回落 HTTP 状态", async () => {
    const fetchImpl = async () => jsonResponse({ error: "余额不足，请充值后再下载" }, 402);
    const error = await fetchHubStatus({ fetchImpl }).catch((err: unknown) => err);
    expect((error as SkillHubError).status).toBe(402);
    expect((error as Error).message).toContain("余额不足，请充值后再下载");

    const brokenBody = async () => new Response("oops", { status: 500 });
    const fallback = await fetchHubStatus({ fetchImpl: brokenBody }).catch((err: unknown) => err);
    expect((fallback as SkillHubError).status).toBe(500);
    expect((fallback as Error).message).toContain("HTTP 500");
  });

  it("超时（可注入 timeoutMs）：转中文「请求超时」而不是挂死", async () => {
    const fetchImpl = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const abort = new Error("aborted");
          abort.name = "AbortError";
          reject(abort);
        });
      })) as unknown as typeof fetch;
    await expect(fetchHubStatus({ fetchImpl, timeoutMs: 20 })).rejects.toThrow(
      /技能社区请求超时/,
    );
  });

  it("外部取消：已 abort 的 signal 不再发请求，错误是「请求已取消」", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    await expect(
      fetchHubStatus({ fetchImpl: fetchImpl as unknown as typeof fetch, signal: controller.signal }),
    ).rejects.toThrow(/请求已取消/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
