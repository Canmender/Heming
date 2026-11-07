/**
 * 更新日志卡片的展示逻辑（设置区用）。
 *
 * 数据来自 `src/generated/changelog.ts`（由 CHANGELOG.md 构建期生成），
 * 因此**运行时不读文件、不发请求、也不引入 markdown 依赖**。
 */
import { CHANGELOG, type ChangelogEntry } from "../generated/changelog.js";
import { RELEASE_NOTES, type ReleaseNoteEntry } from "../generated/releaseNotes.js";

export type { ChangelogEntry, ReleaseNoteEntry };
export { CHANGELOG, RELEASE_NOTES };

/** 用户版发布说明按版本索引（docs/RELEASE-NOTES.md 生成；未收录的版本为 undefined）。 */
const NOTES_BY_VERSION = new Map<string, ReleaseNoteEntry>(
  RELEASE_NOTES.map((entry) => [entry.version, entry]),
);

/** 某个版本的用户版说明；没有收录时返回 null（界面只展示标题，不端出工程细节）。 */
export function userNotesFor(version: string): ReleaseNoteEntry | null {
  return NOTES_BY_VERSION.get(version) ?? null;
}

/**
 * 首页「最近更新」与关于页共用的用户视角摘要：取最新 N 个版本。
 *
 * 有用户版说明用它的标题，没有则回落 CHANGELOG 标题——**绝不把 bullets/paragraphs
 * 里的工程细节拿到用户侧**（根因、文件名、测试统计都属于 CHANGELOG）。
 */
export function latestUserUpdates(count: number): { version: string; date: string; title: string }[] {
  return CHANGELOG.slice(0, Math.max(0, count)).map((entry) => ({
    version: entry.version,
    date: entry.date,
    title: userNotesFor(entry.version)?.title ?? entry.title,
  }));
}

/** 行内片段：粗体 / 行内代码 / 普通文本。 */
export type InlineSegment =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "code"; text: string };

/**
 * 把 `**粗体**` 与 `` `代码` `` 解析成片段序列。
 * 未闭合的标记按普通文本处理（宁可少一点样式，也不显示原始符号）。
 */
export function parseInline(input: string): InlineSegment[] {
  const text = String(input ?? "");
  const out: InlineSegment[] = [];
  let i = 0;
  let buffer = "";
  const flush = () => {
    if (buffer) {
      out.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: "bold", text: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    buffer += text[i];
    i += 1;
  }
  flush();
  return out;
}

/** 去掉行内标记的纯文本（用于搜索/无障碍标签这类场景）。 */
export function stripInline(input: string): string {
  return parseInline(input)
    .map((s) => s.text)
    .join("");
}

/** 找不到条目时返回空数组，绝不抛——设置区不该因为日志数据问题白屏。 */
export function entriesUpTo(currentVersion: string | undefined): ChangelogEntry[] {
  if (!currentVersion) return CHANGELOG;
  const index = CHANGELOG.findIndex((e) => e.version === currentVersion);
  // 版本号对不上（开发分支 / 预发）就展示全部，不猜
  return index >= 0 ? CHANGELOG.slice(0, index + 1) : CHANGELOG;
}
/**
 * 展开状态：显式操作用户说了算；没动过的条目里，**当前版本那条默认展开**。
 * `state` 为空表示用户还没点过任何条目。
 */
export function logOpenState(
  state: Record<string, boolean>,
  version: string,
  isCurrent: boolean,
): boolean {
  const explicit = state[version];
  if (typeof explicit === "boolean") return explicit;
  return isCurrent && Object.keys(state).length === 0;
}

/** 点一下切换某条的展开状态，返回新状态（不改原对象）。 */
export function toggleLog(
  state: Record<string, boolean>,
  version: string,
  isCurrent: boolean,
): Record<string, boolean> {
  return { ...state, [version]: !logOpenState(state, version, isCurrent) };
}
