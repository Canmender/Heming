/**
 * 文件编辑原语 `file_patch` 的类型面。
 *
 * 依赖方向：本目录是**最底层**的纯逻辑（解析 / 匹配 / 路径 / 上限），
 * 不依赖 React、不依赖 store、不依赖 agentStream，也不 import hitl 的运行时模块——
 * HITL 反过来 import 这里的纯函数（见 `lib/hitl/policy.ts`）。
 * 这样 45+ 个用例可以全是纯函数单测，不需要 jsdom、不需要 mock 网络。
 *
 * 协议形状见规格 `docs/superpowers/specs/2026-11-02-d53-file-edit-primitive.md` §3。
 */

/** 补丁里的一行：上下文 / 新增 / 删除。 */
export interface PatchLine {
  kind: "context" | "add" | "del";
  /** 行内容（不含前导 `+`/`-`/空格 以外的任何标记；不含行尾）。 */
  text: string;
}

/**
 * 一个 `@@` 变更块。
 *
 * `lines` 保序：上下文行与删除行拼起来是**文件里连续的一段**，
 * 上下文行与新增行拼起来是**替换后的连续一段**（顺序与补丁里书写顺序一致）。
 */
export interface Hunk {
  /** `@@` 后面的说明文字（可为空，只用于报错与展示）。 */
  header: string;
  lines: PatchLine[];
  /** 该块在文件末尾（`*** End of File`）。 */
  atEof: boolean;
}

/** 新增文件：其下所有行必须是 `+`。 */
export interface AddOp {
  kind: "add";
  /** 模型写的原始路径（未归一化，报错时原样回显）。 */
  path: string;
  /** 文件内容行（不含行尾）。 */
  lines: string[];
}

/** 删除文件。 */
export interface DeleteOp {
  kind: "delete";
  path: string;
}

/** 修改文件（可带改名）。 */
export interface UpdateOp {
  kind: "update";
  path: string;
  /** `*** Move to:` 的目标路径；没有改名时为 undefined。 */
  moveTo?: string;
  hunks: Hunk[];
}

export type FileOp = AddOp | DeleteOp | UpdateOp;

/** 一份补丁的解析结果。 */
export interface PatchPlan {
  ops: FileOp[];
  /** `*** Begin Patch` 后面的说明文字（忽略内容，只留一行用于排查）。 */
  note: string;
}

/** 失败原因分类：给模型的可行动文案按这个分流（规格 §9）。 */
export type PatchErrorCode =
  | "invalid-patch" // 协议不合法（缺 Begin/End、Add 行前缀错、Move 位置错…）
  | "empty-patch" // 没有任何 hunk
  | "too-many-files" // 超过 20 个文件
  | "patch-too-large" // 补丁总量超过 4 MB
  | "file-too-large" // 单文件超过 2 MB
  | "hunk-too-large" // 单个 hunk 超过 200 行
  | "not-absolute-root" // 根路径不合法
  | "path-invalid" // 路径本身不合法（空、NUL、超长、绝对路径…）
  | "path-escape" // `..` / 解析后跑出根
  | "root-unknown" // `root` 参数指向不存在的根
  | "root-readonly" // 目标是只读根（mode=read）
  | "file-not-found" // Update/Delete 的目标不存在
  | "file-exists" // Add 的目标已存在
  | "binary-file" // 不是 UTF-8 文本
  | "match-failed" // 锚点匹配失败（原子性：整单不写盘）
  | "write-failed" // 写盘层失败
  | "bridge-missing"; // 不是桌面端 / 桥不可用

/** 带定位信息的失败。 */
export interface PatchError {
  code: PatchErrorCode;
  /** 给模型的可行动文案（中文，含下一步建议）。 */
  message: string;
  /** 出错的文件（原始路径）。 */
  path?: string;
  /** 出错的是该文件下第几个 `@@` 块（从 1 开始）。 */
  hunkIndex?: number;
  /** 期望的锚点前两行（匹配失败时给模型看「它以为原文长什么样」）。 */
  expected?: string[];
}

/** 解析结果（不抛异常：解析失败是常态，模型经常写错格式）。 */
export type ParseResult = { ok: true; plan: PatchPlan } | { ok: false; error: PatchError };

/** 一个文件的变更方向：新增 / 修改 / 删除。 */
export type ChangeKind = "A" | "M" | "D";

/**
 * 干跑产出的单文件变更。
 *
 * `oldText` / `newText` 是**完整内容**（不是 diff）：写盘层需要整份内容做
 * tmp+rename，确认卡需要两侧做行级 diff；只留 diff 的话这两件事都要再读一次盘。
 */
export interface FileChange {
  /** 绝对路径（归一化后的正斜杠形式，供规则匹配与展示）。 */
  abs: string;
  /** 相对所选根的路径（展示用）。 */
  rel: string;
  /** 所属根名。 */
  root: string;
  kind: ChangeKind;
  /** 改名前/删除/修改的原内容；新增为 null。 */
  oldText: string | null;
  /** 改名后/新增/修改的新内容；删除为 null。 */
  newText: string | null;
  /** 改名来源（`kv:kind === "M"` 且路径变了时有值）。 */
  movedFrom?: string;
}
