/**
 * MCP 资源的「订阅」与变更通知（d.327）。
 *
 * 协议里 `resources/subscribe` 的承诺是：这个文件变了，我会主动告诉你
 * （`notifications/resources/updated`），你不用轮询、也不用重启客户端。
 * 在这之前，`mcp serve` 交出去的 AGENTS.md 与命令文件是「一开始是什么就一直是什么」——
 * 用户在编辑器里改了约定，得重启才生效。
 *
 * 两个刻意的取舍：
 * - **只监听这几个目录，不递归**（工作区、`.heming`、`.heming/commands`）。工作区里可能有
 *   `node_modules` 这种几十万文件的目录，递归监听既慢又容易被系统文件句柄上限打回来。
 * - **按需建 watcher**：只有一个订阅都没有时，一个 watcher 都不建。
 */

import { existsSync, watch } from "node:fs";
import path from "node:path";

/** 通知的防抖窗口：编辑器保存一次常常触发两三条事件。 */
export const MCP_WATCH_DEBOUNCE_MS = 150;

/** 同时能被订阅的 URI 上限（防止客户端把整个工作区订阅一遍）。 */
export const MCP_WATCH_MAX_URIS = 200;

/** 资源 URI 的前缀，与 `mcpCatalog.ts` 保持一致。 */
const RESOURCE_PREFIX = "heming://workspace/";

export interface McpWatchRuntime {
  /** 测试注入用：默认是 `fs.watch(dir, {persistent: false})` 的 `close` 句柄。 */
  watchDir?: (dir: string) => { close: () => void };
  exists?: (absolutePath: string) => boolean;
}

export interface McpCatalogWatcherOptions {
  /** 工作区绝对路径（正斜杠）。 */
  cwd: string;
  /** 某个已订阅资源变了。 */
  onUpdated: (uri: string) => void;
  /** 命令文件的增减可能改变清单本身（`resources/list_changed`）。 */
  onListChanged?: () => void;
  debounceMs?: number;
  runtime?: McpWatchRuntime;
}

export interface McpCatalogWatcher {
  subscribe(uri: string): void;
  unsubscribe(uri: string): void;
  subscribed(): string[];
  close(): void;
}

interface WatchTarget {
  /** 目录绝对路径（正斜杠）。 */
  dir: string;
  /** 该目录下文件相对工作区的路径前缀（正斜杠，末尾带 `/`；工作区自己是空串）。 */
  prefix: string;
}

/** 把 URI 还原成工作区相对路径；不是本服务的 URI 就返回 null。 */
export function relOfResourceUri(uri: string): string | null {
  if (!uri.startsWith(RESOURCE_PREFIX)) return null;
  const rel = uri.slice(RESOURCE_PREFIX.length);
  // 只挡 `..` 路径段（含反斜杠形式），文件名里带两个点（a..b.md）仍可用。
  // 与 mcpCatalog.relOfResourceUri 保持同一口径，否则资源读得到却订不上变更。
  if (!rel || rel.split(/[\\/]/).includes("..") || rel.startsWith("/") || rel.includes("\\")) return null;
  return rel;
}

/**
 * 建一个「按订阅推送变更」的监听器。
 *
 * 只在第一次 `subscribe` 时把三个目录挂上 watcher：没人订阅就不占系统资源，
 * `close()` 之后所有 timer 与 watcher 一并清掉（`mcp serve` 收工时要干净退出）。
 */
export function createMcpCatalogWatcher(options: McpCatalogWatcherOptions): McpCatalogWatcher {
  const cwd = options.cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const debounceMs = options.debounceMs ?? MCP_WATCH_DEBOUNCE_MS;
  const exists = options.runtime?.exists ?? existsSync;
  const watchDir = options.runtime?.watchDir ?? ((dir: string) => watch(dir, { persistent: false }));

  const uris = new Set<string>();
  const watchers = new Map<string, { close: () => void }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let listTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const targets: WatchTarget[] = [
    { dir: cwd, prefix: "" },
    { dir: `${cwd}/.heming`, prefix: ".heming/" },
    { dir: `${cwd}/.heming/commands`, prefix: ".heming/commands/" },
  ];

  const flush = (uri: string): void => {
    timers.delete(uri);
    if (closed || !uris.has(uri)) return;
    options.onUpdated(uri);
  };

  const schedule = (uri: string): void => {
    if (closed || !uris.has(uri)) return;
    const existing = timers.get(uri);
    if (existing) clearTimeout(existing);
    timers.set(
      uri,
      setTimeout(() => flush(uri), debounceMs),
    );
  };

  const scheduleListChanged = (): void => {
    if (closed || !options.onListChanged) return;
    if (listTimer) clearTimeout(listTimer);
    listTimer = setTimeout(() => {
      listTimer = null;
      if (closed) return;
      options.onListChanged?.();
    }, debounceMs);
  };

  /** 一次目录事件可能牵连多个已订阅资源：`.heming/commands` 下任何变化都算。 */
  const affected = (target: WatchTarget, filename: string | null): string[] => {
    const rel = filename ? `${target.prefix}${filename.replace(/\\/g, "/")}` : null;
    const hits: string[] = [];
    for (const uri of uris) {
      const own = relOfResourceUri(uri);
      if (own === null) continue;
      if (rel === null) {
        // 只给了目录（没有文件名的平台）：该目录下所有订阅资源都可能变。
        if (own.startsWith(target.prefix)) hits.push(uri);
      } else if (own === rel) {
        hits.push(uri);
      }
    }
    return hits;
  };

  const ensureWatchers = (): void => {
    if (closed || watchers.size > 0) return;
    for (const target of targets) {
      if (!exists(target.dir)) continue;
      try {
        const handle = watchDir(target.dir);
        watchers.set(target.dir, handle);
        // `fs.watch` 的回调挂在句柄上：默认实现直接返回 `fs.FSWatcher`，它自己的
        // `on("change")` 由下面的包装接上。注入的假实现则通过 `emit` 触发（见测试）。
        const emitter = handle as unknown as {
          on?: (event: string, listener: (eventType: string, filename: string | null) => void) => void;
        };
        emitter.on?.("change", (_eventType, filename) => {
          if (closed) return;
          const name = typeof filename === "string" ? filename : null;
          for (const uri of affected(target, name)) schedule(uri);
          if (target.prefix === ".heming/commands/") scheduleListChanged();
        });
      } catch {
        // 监听挂不上（权限、句柄上限）不该影响服务本身：退化成「只有 list/read，没有推送」。
      }
    }
  };

  const releaseIfIdle = (): void => {
    if (uris.size > 0) return;
    for (const handle of watchers.values()) {
      try {
        handle.close();
      } catch {
        /* 关不掉也不该抛出去 */
      }
    }
    watchers.clear();
  };

  return {
    subscribe(uri: string): void {
      if (closed) return;
      if (relOfResourceUri(uri) === null) return;
      if (uris.size >= MCP_WATCH_MAX_URIS && !uris.has(uri)) return;
      uris.add(uri);
      ensureWatchers();
    },
    unsubscribe(uri: string): void {
      uris.delete(uri);
      const timer = timers.get(uri);
      if (timer) {
        clearTimeout(timer);
        timers.delete(uri);
      }
      releaseIfIdle();
    },
    subscribed(): string[] {
      return [...uris].sort();
    },
    close(): void {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      if (listTimer) {
        clearTimeout(listTimer);
        listTimer = null;
      }
      for (const handle of watchers.values()) {
        try {
          handle.close();
        } catch {
          /* 同上 */
        }
      }
      watchers.clear();
      uris.clear();
    },
  };
}

/** 资源相对路径的父目录（给「监听哪些目录」用；不在本服务 URI 内返回 null）。 */
export function resourceDirOfRel(rel: string): string {
  const index = rel.lastIndexOf("/");
  return index < 0 ? "" : rel.slice(0, index);
}

/** 仅供测试与排障：把这个工作区的监听目标列出来。 */
export function watchTargetsOf(cwd: string): string[] {
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return [root, `${root}/.heming`, path.posix.join(root, ".heming/commands")];
}