import type { VaultIndex } from "../../lib/vault/types.js";
import { rankQuickOpen, type QuickOpenMatchKind } from "../../lib/vault/search.js";
import { baseName, parentOf } from "./model.js";

/**
 * 知识库「快速打开」的排序适配层（命令面板 vault 组 + 页面内 Ctrl+O 共用）。
 *
 * 排序与过滤**全部交给 W2 引擎的 `rankQuickOpen(index, query, limit, recent)`**
 * （标题 > 别名 > 路径 > 最近），这里只做两件界面需要的事：
 * 1. 补上 `dir`（命令面板副标题要显示所属目录）与展示用 label；
 * 2. 把「最近打开」作为 `recent` 传下去，空查询时按最近打开排序。
 *
 * 刻意不在这里再实现一套模糊匹配：两套排序迟早不一致，用户会觉得「命令面板和
 * Ctrl+O 找出来的顺序不一样」。
 */

export interface QuickOpenNote {
  rel: string;
  title: string;
  /** 所属目录（库根为空串）。 */
  dir: string;
  /** 命中方式（引擎给；界面用来标「标题/别名/路径/最近」）。 */
  matchKind: QuickOpenMatchKind;
}

/** 快速打开候选（同步；索引未建好时返回空数组）。 */
export function rankQuickOpenNotes(
  index: VaultIndex | null | undefined,
  query: string,
  limit = 8,
  recent: readonly string[] = [],
): QuickOpenNote[] {
  return rankQuickOpen(index ?? null, query, limit, recent).map((hit) => ({
    rel: hit.rel,
    title: hit.title,
    dir: parentOf(hit.rel),
    matchKind: hit.matchKind,
  }));
}

/** 展示名：文件名（不含 .md）；title 缺失时兜底。 */
export function quickOpenLabel(note: QuickOpenNote): string {
  return note.title || baseName(note.rel).replace(/\.md$/i, "");
}

/** 命中方式的中文说明（命令面板/Ctrl+O 的次要信息）。 */
export function matchKindLabel(kind: QuickOpenMatchKind): string {
  switch (kind) {
    case "title":
      return "标题";
    case "alias":
      return "别名";
    case "path":
      return "路径";
    case "recent":
      return "最近打开";
    default:
      return "";
  }
}
