/**
 * 「上一次读到的内容」留一份在 localStorage 里。
 *
 * 模型页的每一块都要起一个内核进程去问（实测 `providers` 629ms、`accounts` 425ms），
 * 所以每次打开都要先空等半秒多才看到自己的来源。把上一次的原样输出留下来，
 * 打开时先用它画一版，再让真正的读取把画面替换掉——看起来就是「秒开」。
 *
 * 存的是**内核原话**而不是解析后的对象：解析规则改了、契约变了，缓存会跟着一起失效，
 * 不会出现「缓存里是旧形状、页面上是旧逻辑」这种两层不同步。
 *
 * 带时间戳：超过一天就不用它了。昨天改过的 Key、已经失效的登录，不该在今天的画面上先闪一下。
 *
 * 测试环境不读写缓存（`import.meta.env.MODE === "test"`）：否则同一文件里的用例会互相串数据。
 */

export const CACHE_VERSION = 2;

/** 超过这个岁数的缓存不拿来画：宁可多等半秒，也不要拿隔天的状态糊弄人。 */
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const PREFIX = `heming.modelpage.v${CACHE_VERSION}.`;

/** 缓存是否可用：单测里一律关掉，免得上一个用例的数据漏进下一个。 */
export function cacheEnabled(): boolean {
  try {
    return import.meta.env.MODE !== "test" && typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

/** 读一份缓存；没有、读坏了、形状不对、放太久了都当没有。 */
export function readCache(key: string, now = Date.now()): string | null {
  if (!cacheEnabled()) return null;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { at, text } = parsed as { at?: unknown; text?: unknown };
    if (typeof text !== "string" || text.length === 0) return null;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    if (now - at > CACHE_MAX_AGE_MS) return null;
    return text;
  } catch {
    return null;
  }
}

/** 存一份缓存；存不下（隐私模式、配额满）就当没这回事，绝不影响页面。 */
export function writeCache(key: string, text: string, now = Date.now()): void {
  if (!cacheEnabled()) return;
  if (text.length === 0) return;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ at: now, text }));
  } catch {
    /* 存不下就算了：这只是让下一次打开快一点。 */
  }
}

/** 清掉本页所有缓存（换账号、换机器、想强制重读时用）。 */
export function clearCache(): void {
  if (!cacheEnabled()) return;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    /* 同上。 */
  }
}
