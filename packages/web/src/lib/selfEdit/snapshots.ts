/**
 * 自我修改快照与回滚。
 *
 * 审计只记「改了什么」，回不了退；这里补上「改之前是什么」。
 * 每条快照只存**一项**变更的反向操作（不是整库复制）：
 * - 记忆：保留原条目或「原本不存在」+ 新建后的 id；
 * - 技能：新建的 id / 更新前的完整定义；
 * - MCP：新建的 id / 更新或删除前的完整配置 / 工具开关的旧值。
 *
 * 为什么按项而不是整库快照：localStorage 只有几 MB，
 * 整库复制几次就会把用户自己的数据挤掉。代价是记忆条目回滚后内部 id 会变
 *（内容、key、置顶状态照旧），以及不覆盖审计记录本身。
 */

import type { SemanticEntry } from "../memory/types.js";
import type { SkillDefinition } from "../skills/types.js";
import type { McpServerConfig } from "../mcp/types.js";
import type { MemoryStore } from "../memory/store.js";
import type { SkillPool } from "../skills/store.js";
import type { McpRegistry } from "../mcp/store.js";
import type { StorageLike } from "./guards.js";

/** 快照存储键（与留痕分开：清空快照不该抹掉审计）。 */
export const SNAPSHOT_KEY = "heming.selfEdit.snapshots.v1";

/** 快照上限：超出丢最旧的。 */
export const MAX_SNAPSHOTS = 50;

export type SnapshotScope = "memory" | "skill" | "mcp";

/** 一项变更的反向操作。 */
export type SnapshotPatch =
  | {
      kind: "memory-upsert";
      key: string;
      /** 写入前的原条目；`null` 表示这次是新建。 */
      prior: SemanticEntry | null;
      /** 本次写入产生的条目 id（新建回滚时按它删除）。 */
      createdId: string;
    }
  | { kind: "memory-remove"; entry: SemanticEntry }
  | { kind: "skill-create"; id: string }
  | { kind: "skill-update"; id: string; prior: SkillDefinition }
  | { kind: "mcp-tool"; serverId: string; toolName: string; prior: boolean }
  | { kind: "mcp-add-server"; id: string }
  | { kind: "mcp-update-server"; id: string; prior: McpServerConfig }
  | { kind: "mcp-remove-server"; prior: McpServerConfig };

export interface SelfSnapshot {
  id: string;
  at: string;
  agentId: string;
  scope: SnapshotScope;
  /** 原始动作（write/update/create/enable/…），用于展示与审计对齐。 */
  action: string;
  /** 变更对象（记忆 key / 技能名 / 服务 id）。 */
  target: string;
  /** 给人看的一句话。 */
  label: string;
  patch: SnapshotPatch;
}

export interface SnapshotTargets {
  memory: MemoryStore;
  skills: SkillPool;
  mcp: McpRegistry;
}

/** 快照仓库：读写都在注入的存储上，便于测试与隐私模式降级。 */
export class SelfSnapshotStore {
  private readonly storage: StorageLike;
  private readonly now: () => number;

  constructor(storage: StorageLike, now: () => number = () => Date.now()) {
    this.storage = storage;
    this.now = now;
  }

  /** 全部快照（最新在前）；损坏条目丢弃，不因为一条脏数据清空历史。 */
  list(agentId?: string): SelfSnapshot[] {
    try {
      const raw = this.storage.getItem(SNAPSHOT_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const out: SelfSnapshot[] = [];
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const s = item as Record<string, unknown>;
        if (typeof s.id !== "string" || !s.id) continue;
        if (typeof s.agentId !== "string") continue;
        if (!s.patch || typeof s.patch !== "object") continue;
        if (agentId && s.agentId !== agentId) continue;
        out.push(s as unknown as SelfSnapshot);
        if (out.length >= MAX_SNAPSHOTS) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  get(id: string): SelfSnapshot | undefined {
    return this.list().find((s) => s.id === id);
  }

  /** 记一条快照（在变更**成功后**调用：失败的变更没有可回滚的内容）。 */
  record(input: Omit<SelfSnapshot, "id" | "at">): SelfSnapshot {
    const snap: SelfSnapshot = {
      ...input,
      id: `snap-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date(this.now()).toISOString(),
    };
    const next = [snap, ...this.list()].slice(0, MAX_SNAPSHOTS);
    this.save(next);
    return snap;
  }

  remove(id: string): void {
    this.save(this.list().filter((s) => s.id !== id));
  }

  clear(agentId?: string): void {
    this.save(agentId ? this.list().filter((s) => s.agentId !== agentId) : []);
  }

  private save(list: SelfSnapshot[]): void {
    try {
      if (list.length === 0) this.storage.removeItem(SNAPSHOT_KEY);
      else this.storage.setItem(SNAPSHOT_KEY, JSON.stringify(list));
    } catch {
      /* 存不下只影响回滚能力，不阻断自我修改本身 */
    }
  }
}

/**
 * 执行一条快照的反向操作。
 *
 * 永不抛：目标可能已被用户手工改动 / 删除，失败时返回原因让调用方展示。
 */
export function rollbackSnapshot(
  snap: SelfSnapshot,
  targets: SnapshotTargets,
): { ok: boolean; text: string } {
  const patch = snap.patch;
  try {
    switch (patch.kind) {
      case "memory-upsert": {
        if (patch.prior) {
          targets.memory.upsertSemantic({
            agentId: patch.prior.agentId,
            key: patch.prior.key,
            value: patch.prior.value,
            source: patch.prior.source,
            confidence: patch.prior.confidence,
            scope: patch.prior.scope,
          });
        } else {
          targets.memory.removeSemantic("", patch.createdId);
        }
        break;
      }
      case "memory-remove": {
        targets.memory.upsertSemantic({
          agentId: patch.entry.agentId,
          key: patch.entry.key,
          value: patch.entry.value,
          source: patch.entry.source,
          confidence: patch.entry.confidence,
          scope: patch.entry.scope,
        });
        break;
      }
      case "skill-create": {
        targets.skills.remove(patch.id);
        break;
      }
      case "skill-update": {
        targets.skills.update(patch.id, {
          name: patch.prior.name,
          description: patch.prior.description,
          instructions: patch.prior.instructions,
          triggers: patch.prior.triggers,
          tags: patch.prior.tags,
          enabled: patch.prior.enabled,
          version: patch.prior.version,
          source: patch.prior.source,
        });
        break;
      }
      case "mcp-tool": {
        targets.mcp.setToolEnabled(patch.serverId, patch.toolName, patch.prior);
        break;
      }
      case "mcp-add-server": {
        targets.mcp.remove(patch.id);
        break;
      }
      case "mcp-update-server": {
        targets.mcp.update(patch.id, {
          name: patch.prior.name,
          url: patch.prior.url,
          command: patch.prior.command,
          args: patch.prior.args,
          headers: patch.prior.headers,
          enabled: patch.prior.enabled,
          origin: patch.prior.origin,
          registryName: patch.prior.registryName,
        });
        break;
      }
      case "mcp-remove-server": {
        targets.mcp.add({
          id: patch.prior.id,
          name: patch.prior.name,
          transport: patch.prior.transport,
          url: patch.prior.url,
          command: patch.prior.command,
          args: patch.prior.args,
          headers: patch.prior.headers,
          enabled: patch.prior.enabled,
          origin: patch.prior.origin,
          registryName: patch.prior.registryName,
        });
        break;
      }
      default:
        return { ok: false, text: "这条快照类型无法回滚。" };
    }
    return { ok: true, text: `已回滚：${snap.label}` };
  } catch (e) {
    return {
      ok: false,
      text: `回滚失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
