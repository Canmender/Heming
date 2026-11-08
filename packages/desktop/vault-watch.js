"use strict";
/**
 * 知识库（vault）目录变化的监听器（桌面端主进程）。
 *
 * 为什么单独一个模块：
 * - 索引层需要「文件被外部改动（Obsidian / 同步盘 / 用户编辑器）」的信号，
 *   而 `fs.watch` 在真实仓库里会成批抖动（git checkout、同步盘回写、编辑器保存多文件），
 *   直接把每条事件转发给渲染层会让索引 CPU 打满，所以必须在这里做去抖与批量上限；
 * - 去抖策略是纯定时器逻辑，抽成独立模块后可以注入假 `fs.watch` 做确定性单测，
 *   不必依赖真实磁盘事件的到达时间（那会让测试随机失败）。
 *
 * 行为约定（与 `packages/web/src/lib/vault/types.ts` 的 `VaultBridge.watch` 对齐）：
 * - 事件按 300ms 静默窗口合并（trailing debounce），一批里同一路径只报一次；
 * - 单批超过 200 条时回调空数组 `[]`，表示「变化太多，累加增量已不可信，请全量重建索引」；
 *   为什么用空数组而不是抛错：调用方本来就要处理「全量重建」这条路径，空数组是唯一不
 *   引入新错误码的表示法（契约里 watch 回调签名是 `(rel: string[]) => void`）；
 * - `close()` 之后定时器与底层 watcher 都被清掉，且不再触发任何回调；
 * - 忽略隐藏目录/文件（`.git`、`.obsidian`、`.trash` 等）、`node_modules` 与空路径：
 *   这些位置的写入绝大多数来自 git 或 Obsidian 自身，索引它们既没意义又会形成
 *   「读到变化 → 自己写回 → 又触发变化」的回声。注意 `.obsidian` 的读取由 vault-fs 单独判断，
 *   这里只是不把它的变化当成笔记变化。
 */
const fs = require("node:fs");

/** 默认合并窗口（毫秒）。与规格 §10「去抖 300ms」一致。 */
const DEFAULT_DEBOUNCE_MS = 300;
/** 默认单批上限。超过就退化为全量重建（规格 §10「单次最多重算 200 文件」）。 */
const DEFAULT_MAX_BATCH = 200;
/** 连路径事件都要忽略的目录段（隐藏段另按 `.` 前缀判断）。 */
const IGNORED_SEGMENTS = new Set(["node_modules"]);

/**
 * 把 `fs.watch` 给的文件名规整成库内相对路径；不可用/应忽略的返回 null。
 *
 * `filename` 在不同平台可能是 string / Buffer / null（部分平台对目录级事件给 null），
 * 所以先做类型收敛；反斜杠统一成 `/` 与 web 侧 rel 口径一致。
 *
 * @param {string|Buffer|null|undefined} raw
 * @returns {string|null}
 */
function normalizeWatchRel(raw) {
  if (raw === null || raw === undefined) return null;
  const text =
    typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  let rel = text.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
  if (!rel) return null;
  if (rel.includes("\0")) return null;
  const segments = rel.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  for (const segment of segments) {
    // 隐藏目录/文件与 node_modules 一律忽略（见文件头）
    if (segment.startsWith(".")) return null;
    if (IGNORED_SEGMENTS.has(segment)) return null;
  }
  return segments.join("/");
}

/**
 * 创建一个目录监听器。
 *
 * @param {object} options
 * @param {string} options.root 监听根目录（绝对路径）
 * @param {(rels: string[]) => void} options.onChange 去抖后的回调；`[]` 表示建议全量重建
 * @param {number} [options.debounceMs] 合并窗口，默认 300ms
 * @param {number} [options.maxBatch] 单批上限，默认 200
 * @param {Function} [options.watch] 可注入的 watch 实现（单测用；默认 `fs.watch`）
 * @returns {{close: () => void, closed: boolean}}
 */
function createVaultWatcher(options) {
  const opts = options && typeof options === "object" ? options : {};
  const root = opts.root;
  if (typeof root !== "string" || !root.trim()) throw new Error("监听的库根目录不能为空");
  if (typeof opts.onChange !== "function") throw new Error("监听回调必须是函数");
  const debounceMs =
    Number.isFinite(opts.debounceMs) && opts.debounceMs >= 0 ? Math.floor(opts.debounceMs) : DEFAULT_DEBOUNCE_MS;
  const maxBatch =
    Number.isFinite(opts.maxBatch) && opts.maxBatch > 0 ? Math.floor(opts.maxBatch) : DEFAULT_MAX_BATCH;
  const watchImpl = typeof opts.watch === "function" ? opts.watch : fs.watch;

  let closed = false;
  let timer = null;
  const pending = new Set();
  let watcher = null;

  function flush() {
    timer = null;
    if (closed) return;
    const rels = [...pending].sort();
    pending.clear();
    if (rels.length === 0) return;
    // 超过上限：增量集合本身已不可信（可能缺删改），让调用方全量重建
    if (rels.length > maxBatch) {
      opts.onChange([]);
      return;
    }
    opts.onChange(rels);
  }

  function schedule() {
    if (closed || timer) return;
    timer = setTimeout(flush, debounceMs);
    // unref：桌面端可能在关闭前仍有排队事件，不该因为这个定时器拖住进程退出。
    // （node:test 的假定时器对象同样带 unref，这里判一下类型更稳。）
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  try {
    watcher = watchImpl(root, { recursive: true }, (_eventType, filename) => {
      if (closed) return;
      const rel = normalizeWatchRel(filename);
      if (!rel) return;
      pending.add(rel);
      schedule();
    });
  } catch (error) {
    // 底层 watch 失败（目录不存在/权限/平台不支持递归）时把原始错误抛给调用方，
    // 由 vault-fs 统一转成结构化失败（中文 message + io-error）。
    throw error instanceof Error ? error : new Error(String(error));
  }

  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending.clear();
      try {
        if (watcher) watcher.close();
      } catch {
        // 已经关过或平台实现抛错：关闭动作本身不改变「已停止监听」这个结论
      }
      watcher = null;
    },
    get closed() {
      return closed;
    },
  };
}

module.exports = {
  createVaultWatcher,
  normalizeWatchRel,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_BATCH,
};
