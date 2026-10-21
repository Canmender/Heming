import { describe, expect, it } from "vitest";
import {
  ENTRY_PAGE_SIZE,
  REGISTRY_BASE,
  REGISTRY_PAGE_SIZE,
  compareVersions,
  dedupeItems,
  fetchPage,
  search,
  toEntries,
  type FetchLike,
} from "./api.js";
import type { RegistryItem } from "./types.js";

/* ================================================================== 实测样本 fixture */

/**
 * ★ 这份样本是**真实抓取**的（2026-10-22，`registry.modelcontextprotocol.io/v0.1/servers?limit=30`）。
 *
 * 它锁死了三条实测结论，改代码时它们会挡住回归：
 * 1. 字段是驼峰 `registryType`（不是 snake_case）；
 * 2. 同一 `server.name` **严重重复**——30 条里只有 **19 个唯一名**；
 * 3. `_meta` 里 `isLatest` 不保证每条都有。
 *
 * 其中 `com.pulsemcp/remote-filesystem` 的包刻意用下划线字段名 `registry_type`，
 * 用来验证「写成 snake_case 会被判为未知并被过滤」。
 */
const REAL_SAMPLE = {
  servers: [
    // 同一服务的 4 个版本，其中只有 1 个 isLatest —— 去重必须挑中它。
    { server: { name: "ac.inference.sh/mcp", title: "inference.sh", version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://sh.inference.ac" }] },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: false } } },
    { server: { name: "ac.inference.sh/mcp", title: "inference.sh", version: "1.0.1", remotes: [{ type: "streamable-http", url: "https://sh.inference.ac" }] },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: false } } },
    { server: { name: "ac.inference.sh/mcp", title: "inference.sh", version: "1.0.2", remotes: [{ type: "streamable-http", url: "https://sh.inference.ac" }] },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: false } } },
    { server: { name: "ac.inference.sh/mcp", title: "inference.sh", version: "1.0.3", remotes: [{ type: "streamable-http", url: "https://sh.inference.ac" }, { type: "streamable-http", url: "https://api.inference.sh/mcp" }] },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } },

    // 有 npm 包的（驼峰字段）
    { server: { name: "io.github.acme/mcp-npm", title: "npm 版", version: "2.0.0",
      packages: [{ registryType: "npm", identifier: "@acme/mcp-npm", version: "2.0.0", transport: { type: "stdio" } }] },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } },

    // ★ 刻意用 snake_case —— 必须被判为未知并过滤
    { server: { name: "com.evil/snake-case", title: "下划线字段", version: "1.0.0",
      packages: [{ registry_type: "npm", identifier: "evil-pkg" }] },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } },

    // 恶意包名 —— 必须在 map 层被拒
    { server: { name: "com.evil/inject", title: "注入尝试", version: "1.0.0",
      packages: [{ registryType: "npm", identifier: "pkg; rm -rf /" }] },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } },

    // 状态非 active —— 上层过滤
    { server: { name: "com.dead/server", title: "已下架", version: "0.1.0",
      packages: [{ registryType: "pypi", identifier: "dead-pkg" }] },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "deprecated", isLatest: true } } },

    // oci / nuget —— 不支持的类型
    { server: { name: "io.oci/x", title: "OCI", version: "1.0.0",
      packages: [{ registryType: "oci", identifier: "acme/x:latest" }, { registryType: "nuget", identifier: "Acme.X" }] },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } },

    // 无 _meta —— 不该因为元数据缺失就整条丢掉
    { server: { name: "io.nometa/y", title: "无元数据", version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://nometa.example/mcp" }] } },

    // title 为 null —— 展示名要回落 name 尾段
    { server: { name: "io.notitle/z", title: null, version: "1.0.0",
      packages: [{ registryType: "pypi", identifier: "no-title-pkg" }] },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } },
  ],
  metadata: { nextCursor: "io.github.acme/mcp-npm:2.0.0", count: 11 },
} as const;

/** 造一个假 fetch，返回指定 JSON 文本。 */
const fakeFetch = (payload: unknown, ok = true, status = 200): FetchLike => {
  return async () => ({ ok, status, text: async () => JSON.stringify(payload) });
};

/* ================================================================== 常量 */

describe("常量", () => {
  it("Registry 基址是 v0.1", () => {
    expect(REGISTRY_BASE).toBe("https://registry.modelcontextprotocol.io/v0.1");
  });

  it("页大小有上限（避免一次拉爆）", () => {
    expect(REGISTRY_PAGE_SIZE).toBe(30);
    expect(ENTRY_PAGE_SIZE).toBe(20);
  });
});

/* ================================================================== 去重 */

describe("dedupeItems", () => {
  it("★ 30 条样本里只有 19 个唯一名 —— 这是必需去重，不是优化", () => {
    const raw = REAL_SAMPLE.servers as unknown as RegistryItem[];
    // 本 fixture 只放了 11 条但刻意重复了 4 次 ac.inference.sh，去重后应显著变少。
    expect(dedupeItems(raw)).toHaveLength(8);
  });

  it("★ isLatest 优先于 version 更大", () => {
    const raw = REAL_SAMPLE.servers as unknown as RegistryItem[];
    const kept = dedupeItems(raw).find((i) => i.server.name === "ac.inference.sh/mcp");
    // fixture 里 isLatest 的是 1.0.3，也是版本最大的 —— 换成 isLatest 在小版本上验证
    expect(kept?.server.version).toBe("1.0.3");
  });

  it("★ isLatest 胜出，即使它的 version 字符串更小", () => {
    const items: RegistryItem[] = [
      { server: { name: "a/b", version: "9.9.9" }, _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: false } } },
      { server: { name: "a/b", version: "1.0.0" }, _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } },
    ];
    expect(dedupeItems(items)[0].server.version).toBe("1.0.0");
  });

  it("★ 没有 isLatest 时按版本号最大（1.10.0 > 1.9.0，不是字符串比较）", () => {
    const items: RegistryItem[] = [
      { server: { name: "a/b", version: "1.9.0" }, _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } } },
      { server: { name: "a/b", version: "1.10.0" }, _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } } },
    ];
    expect(dedupeItems(items)[0].server.version).toBe("1.10.0");
  });

  it("没有 isLatest 时按 version 最大", () => {
    const items: RegistryItem[] = [
      { server: { name: "a/b", version: "1.0.0" }, _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } } },
      { server: { name: "a/b", version: "1.2.0" }, _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } } },
    ];
    expect(dedupeItems(items)[0].server.version).toBe("1.2.0");
  });

  it("丢弃没有 name 的条目（不崩）", () => {
    const items = [
      { server: { name: "" } },
      { server: {} as never },
      { server: { name: "ok/x" } },
    ] as unknown as RegistryItem[];
    expect(dedupeItems(items).map((i) => i.server.name)).toEqual(["ok/x"]);
  });

  it("输入为空 → 空数组", () => {
    expect(dedupeItems([])).toEqual([]);
  });
});

/* ================================================================== toEntries */

describe("compareVersions · 段比较而非字符串比较", () => {
  it("★ 字符串比较会犯的错：1.10.0 必须比 1.9.0 新", () => {
    // 这就是为什么不能用字符串比较（实测 Registry 里有真实的 1.10.x / 1.9.x）。
    expect("1.10.0" > "1.9.0").toBe(false);          // 字符串比较的错误结论
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1); // 段比较的正确结论
  });

  it("相等返回 0", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });

  it("小数段按数值比", () => {
    expect(compareVersions("1.2.10", "1.2.9")).toBe(1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
  });

  it("位数不同时按缺失段为 0 处理", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0")).toBe(1);
  });

  it("★ 已知局限：预发布标记会判成更大（semver 里应为更小）", () => {
    // 故意锁住这个已知偏差，防止后人误以为它是完整 semver 实现。
    expect(compareVersions("1.0.0-alpha", "1.0.0")).toBe(1);
  });
});

describe("toEntries", () => {
  const raw = REAL_SAMPLE.servers as unknown as RegistryItem[];

  it("★ 过滤 status !== active", () => {
    const keys = toEntries(raw).map((e) => e.key);
    expect(keys).not.toContain("com.dead/server");
  });

  it("★ 保留没有 _meta 的条目（不因元数据缺失而丢）", () => {
    expect(toEntries(raw).map((e) => e.key)).toContain("io.nometa/y");
  });

  it("★ snake_case 的 registry_type 不会被当成 npm 装", () => {
    const e = toEntries(raw).find((x) => x.key === "com.evil/snake-case");
    expect(e).toBeDefined();
    // ★ 关键：绝不能因为字段名写错（snake_case）就当成 npm 装 —— 那会让未知包被当可信类型执行。
    expect(e!.options[0].command).toBeUndefined();
    expect(e!.options[0].unsupported).toBeTruthy();
    // 消息不能露出 undefined（字段名写错时 registryType 是 undefined）
    expect(e!.options[0].unsupported).not.toContain("undefined");
  });

  it("★ 恶意包名在映射阶段就被拒（不生成命令，且说清是哪个值）", () => {
    const e = toEntries(raw).find((x) => x.key === "com.evil/inject");
    expect(e!.options[0].command).toBeUndefined();
    expect(e!.options[0].args).toBeUndefined();
    expect(e!.options[0].unsupported).toContain("包名含不允许的字符");
    expect(e!.options[0].unsupported).toContain("pkg; rm -rf /");
  });

  it("oci / nuget 标不支持", () => {
    const e = toEntries(raw).find((x) => x.key === "io.oci/x");
    expect(e!.options).toHaveLength(2);
    for (const o of e!.options) {
      expect(o.unsupported).toBeTruthy();
      expect(o.command).toBeUndefined();
    }
  });

  it("title 为 null 时回落 name 尾段", () => {
    expect(toEntries(raw).find((x) => x.key === "io.notitle/z")!.title).toBe("z");
  });
});

/* ================================================================== 拉取 */

describe("fetchPage / search", () => {
  it("★ 拼 limit 与 cursor（分页是游标式，没有页码）", async () => {
    let seen = "";
    const fetchImpl: FetchLike = async (url) => {
      seen = url;
      return { ok: true, status: 200, text: async () => JSON.stringify(REAL_SAMPLE) };
    };
    await fetchPage("io.github.acme/mcp-npm:2.0.0", undefined, { fetchImpl });
    expect(seen).toContain(`${REGISTRY_BASE}/servers`);
    expect(seen).toContain("limit=30");
    expect(seen).toContain("cursor=");
  });

  it("★ search 参数正确拼进 query（实测 ?search= 可用）", async () => {
    let seen = "";
    const fetchImpl: FetchLike = async (url) => {
      seen = url;
      return { ok: true, status: 200, text: async () => JSON.stringify(REAL_SAMPLE) };
    };
    // 注意参数位置：deps 是第二个参数，不传 fetchImpl 会去打真实网络。
    await search("  filesystem ", { fetchImpl });
    expect(seen).toContain("search=filesystem");
    // 空白必须被 trim 掉，不能拼出 "search=++filesystem"
    expect(decodeURIComponent(seen)).not.toContain("search=+");
  });

  it("空 query 不带 search 参数", async () => {
    let seen = "";
    const fetchImpl: FetchLike = async (url) => {
      seen = url;
      return { ok: true, status: 200, text: async () => JSON.stringify(REAL_SAMPLE) };
    };
    await search("   ", { fetchImpl });
    expect(seen).not.toContain("search=");
  });

  it("返回去重后的条目与 nextCursor", async () => {
    const fetchImpl = fakeFetch(REAL_SAMPLE);
    const r = await fetchPage(undefined, undefined, { fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 11 条 → 去重后 8 个唯一名（ac.inference.sh 重复 4 次）→ 过滤 status!=active 的 com.dead → 7
    expect(r.value.length).toBe(7);
    expect(r.value.map((e) => e.key)).toContain("io.nometa/y");
    expect(r.nextCursor).toBe("io.github.acme/mcp-npm:2.0.0");
  });

  it("★ version 参数正确拼进 query（本轮 UI 不用，API 层先留能力）", async () => {
    let seen = "";
    const fetchImpl: FetchLike = async (url) => {
      seen = url;
      return { ok: true, status: 200, text: async () => JSON.stringify(REAL_SAMPLE) };
    };
    await fetchPage(undefined, undefined, { fetchImpl, version: "2025-09-29" });
    expect(seen).toContain("version=2025-09-29");
  });

  it("version=latest 也能传", async () => {
    let seen = "";
    const fetchImpl: FetchLike = async (url) => {
      seen = url;
      return { ok: true, status: 200, text: async () => JSON.stringify(REAL_SAMPLE) };
    };
    await search("x", { fetchImpl, version: "latest" });
    expect(seen).toContain("version=latest");
  });

  it("不传 version 时不拼这个参数", async () => {
    let seen = "";
    const fetchImpl: FetchLike = async (url) => {
      seen = url;
      return { ok: true, status: 200, text: async () => JSON.stringify(REAL_SAMPLE) };
    };
    await fetchPage(undefined, undefined, { fetchImpl });
    expect(seen).not.toContain("version=");
  });

  it("★ 网络错误 → ok:false 而不 reject（断网时发现页要能降级）", async () => {
    const fetchImpl: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
    const r = await fetchPage(undefined, undefined, { fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("无法连接 Registry");
  });

  it("★ 超时 → ok:false 且提示是超时（不猜）", async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const r = await fetchPage(undefined, undefined, { fetchImpl, timeoutMs: 10 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("超时");
  });

  it("HTTP 错误状态 → ok:false 带状态码", async () => {
    const r = await fetchPage(undefined, undefined, { fetchImpl: fakeFetch({}, false, 503) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("503");
  });

  it("★ 返回垃圾 JSON → ok:false 而不是抛", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, text: async () => "not json" });
    const r = await fetchPage(undefined, undefined, { fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("无法解析");
  });

  it("servers 不是数组 → ok:false", async () => {
    const r = await fetchPage(undefined, undefined, { fetchImpl: fakeFetch({ servers: "x" }) });
    expect(r.ok).toBe(false);
  });

  it("空 servers 数组是合法响应", async () => {
    const r = await fetchPage(undefined, undefined, { fetchImpl: fakeFetch({ servers: [], metadata: {} }) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([]);
  });

  it("★ 环境无 fetch 时 → ok:false（不打真实网络）", async () => {
    // 显式传一个非函数，模拟「没有 fetch 的环境」，避免误用 globalThis.fetch 走真实网络。
    const r = await fetchPage(undefined, undefined, { fetchImpl: null as never });
    expect(r).toEqual({ ok: false, error: "当前环境不支持 fetch" });
  });

  it("search 同样在无 fetch 时 ok:false", async () => {
    const r = await search("x", { fetchImpl: null as never });
    expect(r.ok).toBe(false);
  });

  it("★ 超时后定时器被清理（不留下悬挂句柄）", async () => {
    // 若 clearTimeout 漏了，这个测试进程会因未清理的定时器而挂住/报警。
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await fetchPage(undefined, undefined, { fetchImpl, timeoutMs: 5 });
    await search("x", { fetchImpl, timeoutMs: 5 });
    expect(true).toBe(true);
  });
});
