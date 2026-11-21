import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpBridgeResult, HttpRequestFn, HttpRequestInput } from "./http.js";
import {
  DEFAULT_SEARCH_MIN_INTERVAL_MS,
  MAX_SEARCH_RESULTS,
  collapseWhitespace,
  decodeHtmlEntities,
  mergeSearchResults,
  normalizeResultUrl,
  parseBingHtml,
  parseDuckDuckGoHtml,
  parseDuckDuckGoLite,
  resetSearchState,
  searchWeb,
  unwrapBingLink,
  unwrapDuckDuckGoLink,
  type SearchResult,
} from "./search.js";

// 缓存与限速是模块级状态，用例之间必须清干净，否则后面用例会命中前面用例的缓存
beforeEach(() => {
  resetSearchState();
});

/** DuckDuckGo HTML 版结果页片段：两条正常结果 + 一条广告 + 一条重复。 */
const HTML_FIXTURE = `
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">示例 &amp; 标题</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">摘要一 &#39;quoted&#39; <b>加粗</b></a>
  </div>
</div>
<div class="result results_links">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">第二条</a></h2>
  <a class="result__snippet" href="#">摘要二</a>
</div>
<div class="result results_links">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/y.js?ad_provider=x&amp;u3=ad">广告位</a></h2>
</div>
<div class="result results_links">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1">重复的第一条</a></h2>
</div>
`;

/** DuckDuckGo lite 版：标题仍是锚点，摘要在 `<td class='result-snippet'>` 里。 */
const LITE_FIXTURE = `
<table>
  <tr><td>1.</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example%2F1" class='result-link'>Lite 标题</a></td></tr>
  <tr><td>&nbsp;</td><td class='result-snippet'>Lite 摘要</td></tr>
</table>
`;

/** 必应结果页片段：一条直链结果 + 一条 ck/a 跳转结果 + 一条没有 h2 的视频位。 */
const BING_REDIRECT = `https://www.bing.com/ck/a?!&&p=abc&u=a1${btoa("https://cn.example/2")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/g, "")}`;
const BING_FIXTURE = `
<ol id="b_results">
  <li class="b_algo" data-id iid=SERP.5333>
    <div class="b_tpcn"><a class="tilk" href="https://baike.example/1">站点图标</a></div>
    <h2><a target="_blank" href="https://baike.example/1"><strong>和鸣</strong>（汉语词语）_示例百科</a></h2>
    <div class="b_caption"><p class="b_lineclamp2">和鸣是&nbsp;一个词 &#233; …</p></div>
  </li>
  <li class="b_algo b_algoBorder" data-id iid=SERP.5334>
    <h2><a href="${BING_REDIRECT}">第二条 结果</a></h2>
    <div class="b_caption"><p>必应跳转还原出来的地址</p></div>
  </li>
  <li class="b_algo"><div class="b_ans">视频位，没有 h2，跳过</div></li>
</ol>
`;

/** 必应「够用」的结果页：4 条，达到合并阈值，不该再去问 DuckDuckGo。 */
const BING_MANY_FIXTURE = `<ol id="b_results">${Array.from(
  { length: 4 },
  (_, i) =>
    `<li class="b_algo"><h2><a href="https://many.example/${i + 1}">多结果${i + 1}</a></h2><div class="b_caption"><p>摘要${i + 1}</p></div></li>`,
).join("")}</ol>`;

/** 必应「超量」结果页：10 条，用来验证条数上限被夹到 8。 */
const BING_TEN_FIXTURE = `<ol id="b_results">${Array.from(
  { length: 10 },
  (_, i) =>
    `<li class="b_algo"><h2><a href="https://ten.example/${i}">第${i}条</a></h2><div class="b_caption"><p>摘要${i}</p></div></li>`,
).join("")}</ol>`;

/** 与必应结果有重叠的 DuckDuckGo 页：第一条是必应第一条的「末尾多斜杠」写法。 */
const OVERLAP_HTML_FIXTURE = `
<div class="result">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbaike.example%2F1%2F">重复的那条</a></h2>
  <a class="result__snippet" href="#">重复摘要</a>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnew.example%2Fx">补充一</a></h2>
  <a class="result__snippet" href="#">补充摘要一</a>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnew.example%2Fy%23frag">补充二</a></h2>
  <a class="result__snippet" href="#">补充摘要二</a>
</div>
`;

/** 只有一条、且与必应结果重叠的 DuckDuckGo 页：合并后仍不足，应继续试 lite 版。 */
const DUP_ONLY_HTML_FIXTURE = `
<div class="result">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbaike.example%2F1">还是那条</a></h2>
</div>
`;

/** 反爬页：结构完全对不上，解析必须返回空数组而不是抛错。 */
const ANTI_BOT_FIXTURE = `<html><body><div class="anomaly-modal">Unfortunately, bots use DuckDuckGo too.</div></body></html>`;

const ok = (body: string, statusCode = 200): HttpBridgeResult => ({
  ok: true,
  statusCode,
  headers: {},
  body,
  encoding: "utf8",
  truncated: false,
  size: body.length,
});

/** 合并用例里造一条结果（标题默认等于 URL，够用且好读）。 */
const result = (url: string, title = url): SearchResult => ({ title, url, snippet: "" });

describe("必应结果解析", () => {
  it("解析标题 / 网址 / 摘要，还原 ck/a 跳转，跳过没有标题的结果位", () => {
    const results = parseBingHtml(BING_FIXTURE);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "和鸣（汉语词语）_示例百科",
      url: "https://baike.example/1",
      snippet: "和鸣是 一个词 é …",
    });
    expect(results[1].url).toBe("https://cn.example/2");
    expect(results[1].snippet).toBe("必应跳转还原出来的地址");
  });

  it("必应链接还原：直链保留，站内/非法链接丢弃", () => {
    expect(unwrapBingLink("https://baike.example/1")).toBe("https://baike.example/1");
    expect(unwrapBingLink("//baike.example/1")).toBe("https://baike.example/1");
    expect(unwrapBingLink(BING_REDIRECT)).toBe("https://cn.example/2");
    expect(unwrapBingLink("https://www.bing.com/images/search?q=x")).toBe("");
    expect(unwrapBingLink("javascript:alert(1)")).toBe("");
    expect(unwrapBingLink("")).toBe("");
  });

  it("反爬页 / 空页解析出空结果（不抛错）", () => {
    expect(parseBingHtml(ANTI_BOT_FIXTURE)).toEqual([]);
    expect(parseBingHtml("")).toEqual([]);
  });
});

describe("DuckDuckGo 结果解析", () => {
  it("解析标题 / 网址 / 摘要，并去掉广告与重复项", () => {
    const results = parseDuckDuckGoHtml(HTML_FIXTURE);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "示例 & 标题",
      url: "https://example.com/a?x=1",
      snippet: "摘要一 'quoted' 加粗",
    });
    expect(results[1].url).toBe("https://example.org/b");
    expect(results[1].snippet).toBe("摘要二");
  });

  it("lite 版从 <td class='result-snippet'> 里取摘要", () => {
    const results = parseDuckDuckGoLite(LITE_FIXTURE);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: "Lite 标题",
      url: "https://lite.example/1",
      snippet: "Lite 摘要",
    });
  });

  it("标题截断落在 emoji 中间时不劈出落单代理（按码点切）", () => {
    // MAX_TITLE_CHARS=120：旧代码 slice(0,119) 会切在 emoji 的代理对中间。
    const longTitle = "a".repeat(118) + "😀" + "TAIL";
    const html = `<h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx">${longTitle}</a></h2>`;
    const results = parseDuckDuckGoHtml(html);
    expect(results).toHaveLength(1);
    const title = results[0].title;
    // 截断点前后都不能有落单代理（高代理后必须跟低代理，低代理前必须有高代理）。
    const hasLone = (s: string): boolean =>
      [...s].some((ch) => {
        const code = ch.charCodeAt(0);
        return ch.length === 1 && code >= 0xd800 && code <= 0xdfff;
      });
    expect(hasLone(title)).toBe(false);
    expect(title.endsWith("…")).toBe(true);
  });

  it("反爬页 / 空页解析出空结果（不抛错）", () => {
    expect(parseDuckDuckGoHtml(ANTI_BOT_FIXTURE)).toEqual([]);
    expect(parseDuckDuckGoHtml("")).toEqual([]);
    expect(parseDuckDuckGoLite(ANTI_BOT_FIXTURE)).toEqual([]);
  });

  it("结果链接解出目标地址；duckduckgo 自己的跳转与广告一律丢弃", () => {
    expect(unwrapDuckDuckGoLink("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fp")).toBe(
      "https://example.com/p",
    );
    expect(unwrapDuckDuckGoLink("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fq")).toBe(
      "https://example.com/q",
    );
    expect(unwrapDuckDuckGoLink("/l/?uddg=https%3A%2F%2Fexample.com%2Fr")).toBe("https://example.com/r");
    expect(unwrapDuckDuckGoLink("//duckduckgo.com/y.js?ad_provider=x")).toBe("");
    expect(unwrapDuckDuckGoLink("javascript:alert(1)")).toBe("");
    expect(unwrapDuckDuckGoLink("")).toBe("");
  });

  it("uddg 只解一层编码：目标 URL 里的 %20/%25 不能被二次解坏", () => {
    // uddg 的值是 percent-encoded 的目标地址，URLSearchParams.get() 已解一层；
    // 再 decodeURIComponent 会把目标里的 %20 变裸空格、%25 变裸 %。
    expect(
      unwrapDuckDuckGoLink("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%2520b&rut=x"),
    ).toBe("https://example.com/a%20b");
    expect(
      unwrapDuckDuckGoLink("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fs%3Fq%3D100%2525"),
    ).toBe("https://example.com/s?q=100%25");
  });

  it("HTML 实体解码：命名 / 十进制 / 十六进制；认不出的原样保留", () => {
    expect(decodeHtmlEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x4e2d;")).toBe(
      "a & b <c> \"d\" 'e' 中",
    );
    // HTML 允许大写 X：&#X41; 与 &#x41; 等价。
    expect(decodeHtmlEntities("&#X41;&#X1F600;")).toBe("A😀");
    expect(decodeHtmlEntities("&unknown;")).toBe("&unknown;");
    expect(collapseWhitespace("  a \n\t b  ")).toBe("a b");
  });

  it("代理区数字实体不解成落单代理（会进模型工具结果，d.412 回归）", () => {
    // String.fromCodePoint(0xD83D) 不抛错，但返回的是落单高代理——代理区不是合法标量值。
    // 这些实体原样保留；真正的字符（含代理对以上/以下的边界值）照常解码。
    for (const entity of ["&#xD83D;", "&#xD800;", "&#55296;", "&#xDE00;", "&#xDFFF;"]) {
      const out = decodeHtmlEntities(entity);
      expect(out).toBe(entity); // 原样保留，不含落单代理
      expect(out.split("").some((c) => {
        const code = c.charCodeAt(0);
        return (code >= 0xd800 && code <= 0xdfff);
      })).toBe(false);
    }
    // 边界合法值仍解码：D7FF（代理区前一个）与 E000（代理区后一个）
    expect(decodeHtmlEntities("&#xD7FF;&#xE000;")).toBe("\ud7ff\ue000");
    expect(decodeHtmlEntities("&#X1F600;")).toBe("😀");
  });
});

describe("结果 URL 归一（只用于去重）", () => {
  it("去末尾斜杠、去 hash、host 小写，保留路径大小写与查询串", () => {
    expect(normalizeResultUrl("https://example.com/a///")).toBe("https://example.com/a");
    expect(normalizeResultUrl("https://example.com/a/#frag")).toBe("https://example.com/a");
    expect(normalizeResultUrl("HTTPS://WWW.Example.com/Path/?q=1#x")).toBe("https://www.example.com/Path?q=1");
    expect(normalizeResultUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeResultUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeResultUrl("http://example.com/a/")).not.toBe(normalizeResultUrl("https://example.com/a"));
  });

  it("空值与解析不了的地址不抛错", () => {
    expect(normalizeResultUrl("")).toBe("");
    expect(normalizeResultUrl("   ")).toBe("");
    expect(normalizeResultUrl("#frag")).toBe("");
    expect(normalizeResultUrl("/relative/path///")).toBe("/relative/path");
  });
});

describe("mergeSearchResults（多源合并）", () => {
  it("必应结果在前，按归一 URL 去重并补足到 limit", () => {
    const merged = mergeSearchResults(
      [result("https://a.example/1"), result("https://a.example/2")],
      [result("https://a.example/1/"), result("https://b.example/1#x"), result("https://b.example/2")],
      4,
    );
    expect(merged.map((item) => item.url)).toEqual([
      "https://a.example/1",
      "https://a.example/2",
      "https://b.example/1#x",
      "https://b.example/2",
    ]);
  });

  it("limit 夹紧：0 条返回空，超过上限按 8 条截断", () => {
    const many = Array.from({ length: 12 }, (_, i) => result(`https://c.example/${i}`));
    expect(mergeSearchResults(many, [], 0)).toEqual([]);
    expect(mergeSearchResults(many, [], 99)).toHaveLength(MAX_SEARCH_RESULTS);
    expect(mergeSearchResults(many, many, 3)).toHaveLength(3);
  });

  it("坏数据（空标题 / 空地址）与重复项直接丢掉", () => {
    const merged = mergeSearchResults(
      [result("", "空地址"), { title: "  ", url: "https://d.example/1", snippet: "" }, result("https://d.example/2")],
      [result("https://d.example/2/")],
      5,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].url).toBe("https://d.example/2");
  });

  it("不改动入参数组", () => {
    const primary = [result("https://e.example/1")];
    const secondary = [result("https://e.example/1/")];
    mergeSearchResults(primary, secondary, 5);
    expect(primary).toHaveLength(1);
    expect(secondary).toHaveLength(1);
  });
});

describe("searchWeb（注入假请求，不碰网络）", () => {
  it("必应优先：解析出结果就不再问 DuckDuckGo", async () => {
    const calls: string[] = [];
    const request: HttpRequestFn = async (input) => {
      calls.push(`${input.method} ${input.url}`);
      return ok(BING_FIXTURE);
    };
    const outcome = await searchWeb("heming", { limit: 1, request, minIntervalMs: 0 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].title).toBe("和鸣（汉语词语）_示例百科");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("bing.com/search");
  });

  it("必应请求带中文市场参数，并保留 Accept-Language", async () => {
    const inputs: HttpRequestInput[] = [];
    const request: HttpRequestFn = async (input) => {
      inputs.push(input);
      return ok(BING_MANY_FIXTURE);
    };
    const outcome = await searchWeb("和鸣 中文", { limit: 5, request, minIntervalMs: 0 });
    expect(outcome.ok).toBe(true);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].url).toContain("mkt=zh-CN");
    expect(inputs[0].url).toContain("setlang=zh-Hans");
    expect(inputs[0].url).toContain(encodeURIComponent("和鸣 中文"));
    expect(inputs[0].headers?.["Accept-Language"]).toContain("zh-CN");
  });

  it("必应失败时退回 DuckDuckGo 网页版", async () => {
    const calls: string[] = [];
    const request: HttpRequestFn = async (input) => {
      calls.push(`${input.method} ${input.url}`);
      if (input.url.includes("bing.com")) return { ok: false, error: "请求超时（12000 毫秒）" };
      return ok(HTML_FIXTURE);
    };
    const outcome = await searchWeb("heming", { request, minIntervalMs: 0 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.results[0].url).toBe("https://example.com/a?x=1");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("bing.com/search");
    expect(calls[1].startsWith("POST ")).toBe(true);
  });

  it("必应与 DDG 网页版都失败时退回 lite 版", async () => {
    const calls: string[] = [];
    const request: HttpRequestFn = async (input) => {
      calls.push(`${input.method} ${input.url}`);
      if (input.url.includes("bing.com")) return ok(ANTI_BOT_FIXTURE);
      if (input.method === "POST") return { ok: false, error: "请求失败：ECONNRESET" };
      return ok(LITE_FIXTURE);
    };
    const outcome = await searchWeb("heming", { request, minIntervalMs: 0 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.results[0].url).toBe("https://lite.example/1");
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain("lite.duckduckgo.com");
  });

  it("必应结果不足 3 条时合并 DuckDuckGo：必应在前、重复项去掉、不再试 lite", async () => {
    const calls: string[] = [];
    const request: HttpRequestFn = async (input) => {
      calls.push(`${input.method} ${input.url}`);
      if (input.url.includes("bing.com")) return ok(BING_FIXTURE);
      return ok(OVERLAP_HTML_FIXTURE);
    };
    const outcome = await searchWeb("合并", { limit: 5, request, minIntervalMs: 0 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 必应 2 条 + DDG 3 条，其中 1 条与必应第一条归一后相同 → 合并 4 条
    expect(outcome.results.map((item) => item.url)).toEqual([
      "https://baike.example/1",
      "https://cn.example/2",
      "https://new.example/x",
      "https://new.example/y#frag",
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1].startsWith("POST ")).toBe(true);
  });

  it("合并后仍不足 3 条时再试 lite 版补足", async () => {
    const calls: string[] = [];
    const request: HttpRequestFn = async (input) => {
      calls.push(`${input.method} ${input.url}`);
      if (input.url.includes("bing.com")) return ok(BING_FIXTURE);
      if (input.method === "POST") return ok(DUP_ONLY_HTML_FIXTURE);
      return ok(LITE_FIXTURE);
    };
    const outcome = await searchWeb("补足", { limit: 5, request, minIntervalMs: 0 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.results.map((item) => item.url)).toEqual([
      "https://baike.example/1",
      "https://cn.example/2",
      "https://lite.example/1",
    ]);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain("lite.duckduckgo.com");
  });

  it("必应结果够 3 条时不去补源（省一次外网请求）", async () => {
    const calls: string[] = [];
    const request: HttpRequestFn = async (input) => {
      calls.push(`${input.method} ${input.url}`);
      return ok(BING_MANY_FIXTURE);
    };
    const outcome = await searchWeb("够用", { limit: 5, request, minIntervalMs: 0 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.results).toHaveLength(4);
    expect(calls).toHaveLength(1);
  });

  it("全都失败：返回 ok=false 与中文原因，不抛错", async () => {
    const request: HttpRequestFn = async () => ({ ok: false, error: "请求超时（12000 毫秒）" });
    const outcome = await searchWeb("heming", { request, minIntervalMs: 0 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("请求超时");
    expect(outcome.error).toContain("必应");
  });

  it("空关键词直接失败，不发请求", async () => {
    let called = 0;
    const request: HttpRequestFn = async () => {
      called += 1;
      return ok(BING_FIXTURE);
    };
    const outcome = await searchWeb("   ", { request, minIntervalMs: 0 });
    expect(outcome.ok).toBe(false);
    expect(called).toBe(0);
  });

  it("limit 夹紧：上限 8 条，下限 1 条", async () => {
    const request: HttpRequestFn = async () => ok(BING_TEN_FIXTURE);
    const many = await searchWeb("上限", { limit: 99, request, minIntervalMs: 0 });
    expect(many.ok).toBe(true);
    if (!many.ok) return;
    expect(many.results).toHaveLength(MAX_SEARCH_RESULTS);

    const few = await searchWeb("下限", { limit: 0, request, minIntervalMs: 0 });
    expect(few.ok).toBe(true);
    if (!few.ok) return;
    expect(few.results).toHaveLength(1);
  });

  it("同一 query+limit 命中缓存：不再发请求，且大小写/空白不影响命中", async () => {
    let calls = 0;
    const request: HttpRequestFn = async () => {
      calls += 1;
      return ok(BING_MANY_FIXTURE);
    };
    const first = await searchWeb("缓存命中", { limit: 5, request, minIntervalMs: 0 });
    expect(first.ok).toBe(true);
    expect(calls).toBe(1);

    const second = await searchWeb("  缓存命中  ", { limit: 5, request, minIntervalMs: 0 });
    expect(second.ok).toBe(true);
    expect(calls).toBe(1);
    if (!first.ok || !second.ok) return;
    expect(second.results).toEqual(first.results);

    // 缓存是拷贝出来的：调用方改结果不该污染下一次命中
    first.results[0].title = "被改坏了";
    const third = await searchWeb("缓存命中", { limit: 5, request, minIntervalMs: 0 });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.results[0].title).toBe("多结果1");
  });

  it("limit 不同视为不同缓存条目", async () => {
    let calls = 0;
    const request: HttpRequestFn = async () => {
      calls += 1;
      return ok(BING_MANY_FIXTURE);
    };
    await searchWeb("缓存键", { limit: 3, request, minIntervalMs: 0 });
    await searchWeb("缓存键", { limit: 4, request, minIntervalMs: 0 });
    expect(calls).toBe(2);
  });

  it("失败不进缓存：下一次还会重试", async () => {
    let calls = 0;
    let failing = true;
    const request: HttpRequestFn = async () => {
      calls += 1;
      return failing ? { ok: false, error: "请求超时（12000 毫秒）" } : ok(BING_MANY_FIXTURE);
    };
    const first = await searchWeb("失败重试", { limit: 5, request, minIntervalMs: 0 });
    expect(first.ok).toBe(false);
    // 第一次失败要打满 3 个源
    expect(calls).toBe(3);

    failing = false;
    const second = await searchWeb("失败重试", { limit: 5, request, minIntervalMs: 0 });
    expect(second.ok).toBe(true);
    // 第二次成功只打必应，说明失败没有被缓存
    expect(calls).toBe(4);
  });

  it("缓存 5 分钟后失效", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      let calls = 0;
      const request: HttpRequestFn = async () => {
        calls += 1;
        return ok(BING_MANY_FIXTURE);
      };
      await searchWeb("过期", { limit: 5, request, minIntervalMs: 0 });
      expect(calls).toBe(1);

      nowSpy.mockReturnValue(1_000_000 + 4 * 60_000);
      await searchWeb("过期", { limit: 5, request, minIntervalMs: 0 });
      expect(calls).toBe(1);

      nowSpy.mockReturnValue(1_000_000 + 5 * 60_000 + 1);
      await searchWeb("过期", { limit: 5, request, minIntervalMs: 0 });
      expect(calls).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("缓存最多 16 条，超了淘汰最久未用的", async () => {
    let calls = 0;
    const request: HttpRequestFn = async () => {
      calls += 1;
      return ok(BING_MANY_FIXTURE);
    };
    for (let i = 0; i < 17; i += 1) {
      await searchWeb(`淘汰${i}`, { limit: 5, request, minIntervalMs: 0 });
    }
    expect(calls).toBe(17);

    // 最早的那条已被挤出：再搜要重新请求
    await searchWeb("淘汰0", { limit: 5, request, minIntervalMs: 0 });
    expect(calls).toBe(18);
    // 最后一条还在缓存里：不再请求
    await searchWeb("淘汰16", { limit: 5, request, minIntervalMs: 0 });
    expect(calls).toBe(18);
  });

  it("默认最小间隔是 1500ms", () => {
    expect(DEFAULT_SEARCH_MIN_INTERVAL_MS).toBe(1500);
  });

  it("两次真实搜索之间至少等 minIntervalMs（假计时器，不真睡）", async () => {
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      const request: HttpRequestFn = async () => {
        starts.push(Date.now());
        return ok(BING_MANY_FIXTURE);
      };
      const first = searchWeb("间隔甲", { limit: 5, request, minIntervalMs: 1500 });
      await first;
      expect(starts).toHaveLength(1);

      const second = searchWeb("间隔乙", { limit: 5, request, minIntervalMs: 1500 });
      await vi.advanceTimersByTimeAsync(1000);
      // 还没到 1.5 秒，第二个请求不该发出（是等待，不是直接失败）
      expect(starts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(600);
      const outcome = await second;
      expect(outcome.ok).toBe(true);
      expect(starts).toHaveLength(2);
      expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1500);
    } finally {
      vi.useRealTimers();
    }
  });

  it("并发搜索排队串行，不会同时发请求", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const request: HttpRequestFn = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return ok(BING_MANY_FIXTURE);
    };
    await Promise.all([
      searchWeb("并发甲", { limit: 5, request, minIntervalMs: 0 }),
      searchWeb("并发乙", { limit: 5, request, minIntervalMs: 0 }),
    ]);
    expect(maxInFlight).toBe(1);
  });
});
