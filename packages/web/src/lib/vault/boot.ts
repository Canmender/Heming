/**
 * 知识库 ↔ 应用的粘合层（Lead 集成点）：**唯一**允许同时 import `lib/vault` 与 `lib/memory` 的文件。
 *
 * 为什么要有这一层：
 * - `lib/vault/**` 是索引/文件层，`lib/memory/**` 是记忆层，两边**互相不 import**（依赖倒置），
 *   各自由不同工作面并行实现；把「谁适配谁」的知识集中在这一个文件里，
 *   将来换存储（例如把 vault 索引进 worker）只改这里；
 * - 应用启动时只需要调一个函数：`bootVault()`。
 *
 * 三条纪律：
 * 1. **失败静默但可观测**：启动期的知识库/记忆失败不能让应用起不来（与记忆层既有口径一致），
 *    但要留下 `lastBootResult`，记忆页能显示「上次同步为什么没成」；
 * 2. **幂等**：重复调用 `bootVault()` 不重复注册 source、不叠加订阅；
 * 3. **浏览器临时模式**（无文件桥）照常工作，只是数据不落盘。
 */

import { resolveVaultBridge, isVaultEphemeral } from "./bridge.js";
import { useVaultStore, activeVaultMeta, type VaultState } from "./store.js";
import {
  hashVaultText,
  setVaultDocSource,
  syncVault,
  type VaultDocSource,
  type VaultSyncResult,
} from "../memory/vaultMemory.js";

/** 索引变化 → 记忆同步的合并窗口：连续编辑时只同步最后一次。 */
const SYNC_DEBOUNCE_MS = 1500;

export interface VaultBootResult {
  /** 首个库是否加载成功（false 表示没有库 / 读注册表失败）。 */
  loaded: boolean;
  /** 索引是否建成（大库可能要几秒）。 */
  indexed: boolean;
  /** 首次记忆同步结果；没库 / 关闭时可能为 null。 */
  sync: VaultSyncResult | null;
  /** 中文原因（为空表示一路顺利）。 */
  error: string;
}

let bootPromise: Promise<VaultBootResult> | null = null;
let installed = false;
let disposeSync: (() => void) | null = null;
let lastResult: VaultBootResult | null = null;

/** 最近一次启动结果（记忆页/设置卡用来解释「为什么没同步」）。 */
export function lastVaultBoot(): VaultBootResult | null {
  return lastResult;
}

/**
 * 把 vault store 适配成记忆层的 `VaultDocSource`。
 *
 * 注意 `docs()` 的语义是「当前库的全量文档」，**慢**（大库 = 几千次读盘），
 * 因此只在 boot、手动同步、watch 触发的增量同步里调，绝不在渲染路径里调。
 */
export function createStoreVaultSource(): VaultDocSource {
  const bridgeOrNull = () => resolveVaultBridge();
  const vaultIdOf = (): string => useVaultStore.getState().activeVaultId ?? "";

  return {
    async docs() {
      const state = useVaultStore.getState();
      // 索引没建就现建一次：记忆只能收录「进过索引」的页面（与界面口径一致）。
      if (!state.index) await state.buildIndexNow();
      const next = useVaultStore.getState();
      const vaultId = next.activeVaultId ?? "";
      const pages = next.index?.pages;
      const out: { vaultId: string; rel: string; mtime: string; hash: string; text: string }[] = [];
      for (const doc of next.snapshotDocs()) {
        const page = pages?.get(doc.rel);
        out.push({
          vaultId,
          rel: doc.rel,
          mtime: doc.mtime,
          // hash 以索引为准（同一份内容全应用只有一个口径）；索引没算到才现算。
          hash: page?.hash ?? hashVaultText(doc.text),
          text: doc.text,
        });
      }
      return out;
    },

    async read(rel) {
      const bridge = bridgeOrNull();
      const vaultId = vaultIdOf();
      if (!bridge || !vaultId) return null;
      const doc = await bridge.read(vaultId, rel);
      return doc?.text ?? null;
    },

    async write(req) {
      const bridge = bridgeOrNull();
      if (!bridge) throw new Error("当前没有文件桥，写回不可用");
      // 走**智能体通道**（vault:apply）：主进程会再判一次 writeDirs，
      // 记忆层的写回与模型工具走同一条收紧过的路，不给「内部调用」开后门。
      await bridge.apply({ vaultId: req.vaultId, rel: req.rel, text: req.text, mode: req.mode });
    },

    allowedWriteDirs() {
      return activeVaultMeta()?.writeDirs ?? [];
    },
  };
}

/**
 * 安装记忆源 + 索引变化后的自动同步（幂等）。
 *
 * 为什么订阅 store 而不是自己监听 bridge.watch：
 * - watch 的去抖、增量/全量判定、索引重建都在 store 里（一处口径）；
 * - 这里只关心「索引这个对象换了」这个结果，换完再同步记忆，不会同步到半成品。
 */
export function installVaultMemorySource(): () => void {
  if (installed && disposeSync) return disposeSync;

  setVaultDocSource(createStoreVaultSource());
  installed = true;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastIndex = useVaultStore.getState().index;

  const unsubscribe = useVaultStore.subscribe((state: VaultState) => {
    if (state.index === lastIndex) return;
    lastIndex = state.index;
    if (!state.index) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void syncVault(createStoreVaultSource()).catch(() => {
        /* 同步失败不打扰用户：记忆页能看到 lastVaultSync 与错误 */
      });
    }, SYNC_DEBOUNCE_MS);
  });

  disposeSync = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    unsubscribe();
    setVaultDocSource(null);
    installed = false;
    disposeSync = null;
  };
  return disposeSync;
}

/**
 * 应用启动调用一次：加载库 → 建索引 → 注册记忆源 → 首次同步。
 *
 * 不抛异常（启动期任何失败都只写进返回值）：知识库坏掉不能让聊天与其它页面起不来。
 */
export function bootVault(): Promise<VaultBootResult> {
  if (bootPromise) return bootPromise;
  bootPromise = (async (): Promise<VaultBootResult> => {
    const result: VaultBootResult = { loaded: false, indexed: false, sync: null, error: "" };
    try {
      const state = useVaultStore.getState();
      if (!state.vaults.length) await state.loadVaults();
      result.loaded = useVaultStore.getState().vaults.length > 0;
      if (result.loaded) {
        await useVaultStore.getState().buildIndexNow();
        result.indexed = useVaultStore.getState().index !== null;
      }
      installVaultMemorySource();
      if (result.indexed) {
        result.sync = await syncVault(createStoreVaultSource());
        if (!result.sync.ok) result.error = "知识库同步失败";
      }
    } catch (e) {
      result.error = e instanceof Error ? e.message : "知识库启动失败";
    }
    if (isVaultEphemeral()) {
      result.error = result.error || "浏览器临时模式：知识库只存在于当前页面";
    }
    lastResult = result;
    // 失败后允许下次重试（成功则保持成功结果）
    if (result.error && !result.loaded) bootPromise = null;
    return result;
  })();
  return bootPromise;
}

/** 测试用：清掉启动态。 */
export function resetVaultBoot(): void {
  disposeSync?.();
  bootPromise = null;
  lastResult = null;
}

/**
 * 手动同步一次（记忆页「同步知识库」按钮用）。
 *
 * 与自动同步走同一条路（先确保 source 已注册），失败只回结果不抛：
 * 记忆页据 `ok/message` 给中文提示，不弹异常。
 */
export async function syncVaultMemoryNow(): Promise<VaultSyncResult> {
  try {
    installVaultMemorySource();
    const result = await syncVault(createStoreVaultSource());
    if (lastResult) lastResult.sync = result;
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : "知识库同步失败";
    return {
      ok: false,
      scanned: 0,
      added: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
      truncated: 0,
      truncatedReason: "",
      total: 0,
      at: new Date().toISOString(),
      error: message,
    };
  }
}
