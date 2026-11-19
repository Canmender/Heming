/**
 * 路由分组的两件「不该让用户自己写」的事：按模板建组、按需改设置。
 *
 * 内核（`vendor/magpie-core/internal/provider/grouptemplate.go:39 TemplateKinds`）只认三套模板：
 * smart / thrifty / steady，各自的 id 由 `TemplateIDs`（:243）决定（smart-split / cheap-first /
 * never-stuck）——内核对得上，页面才给按钮；这里不自己发明第四套。
 *
 * `group set` 的键（`vendor/magpie-core/internal/cli/groups_cli.go:420-590`）比表单多得多，
 * 这里只收「用户能一句话说清」的五个：会话亲和、是否列给智能体、谁来定推理档、上下文、族标签。
 * 其余（weight / fast / classifier / intent-sure / pick）要跟模型清单一起才说得清，留给命令行。
 */

/** 三套模板：kind 是给内核的参数，label/desc 是给人看的。顺序与内核 TemplateKinds 一致。 */
export type GroupTemplate = {
  kind: "smart" | "thrifty" | "steady";
  /** 内核用这张表给组起 id（TemplateIDs）；页面上只用于说明「建出来叫什么」。 */
  id: string;
  label: string;
  desc: string;
};

export const GROUP_TEMPLATES: readonly GroupTemplate[] = [
  {
    kind: "smart",
    id: "smart-split",
    label: "难易分流",
    desc: "分类器先看这一轮难不难：难的上最强模型，容易的走便宜的",
  },
  {
    kind: "thrifty",
    id: "cheap-first",
    label: "先用便宜的",
    desc: "便宜的先用；要高强度推理、或者它答不了，再换最强的那一个",
  },
  {
    kind: "steady",
    id: "never-stuck",
    label: "不会卡住",
    desc: "最多三家各取最强的一个，一个接一个顶上",
  },
];

/**
 * `group template <kind> [name]`。
 *
 * 为什么名字可以留空：内核自己会用 `TemplateNames` 起一个（"Smart split" 之类），
 * 并且「名字或 id 已被占用就编号，绝不替换现有组」——所以留空比让用户硬编一个更安全。
 */
export function groupTemplateArgs(kind: string, name?: string): string[] {
  const trimmed = (name ?? "").trim();
  return trimmed ? ["group", "template", kind, trimmed] : ["group", "template", kind];
}

/** 一个组设置项：key 是内核认的键，options 有值时渲染成下拉。 */
export type GroupSettingField = {
  key: string;
  label: string;
  hint: string;
  /** 下拉选项；空值表示「不改」，不发给内核。 */
  options?: readonly { value: string; label: string }[];
  placeholder?: string;
};

export const GROUP_SETTING_FIELDS: readonly GroupSettingField[] = [
  {
    key: "stays",
    label: "会话亲和",
    hint: "同一个会话里，是不是一直用同一个账号",
    options: [
      { value: "auto", label: "自动（缓存还值的时候就跟着）" },
      { value: "session", label: "整个会话都用它" },
      { value: "turn", label: "只在这一轮里用它" },
      { value: "off", label: "每次请求都重新选" },
      { value: "strict", label: "绝不换：它休息了也照问" },
    ],
  },
  {
    key: "listed",
    label: "列给智能体",
    hint: "组里的模型还进不进给智能体看的清单",
    options: [
      { value: "yes", label: "列出来（默认）" },
      { value: "no", label: "不列，只通过这个组用" },
    ],
  },
  {
    key: "effort",
    label: "推理档谁说了算",
    hint: "智能体要多少就多少，还是让分类器按难易定",
    options: [
      { value: "agent", label: "智能体自己说（默认）" },
      { value: "auto", label: "分类器按难易定（要先设分类模型）" },
    ],
  },
  {
    key: "context",
    label: "上下文带宽",
    hint: "告诉智能体这个组能装多少，例如 272k；留空＝按最大那个模型",
    placeholder: "272k（可留空）",
  },
  {
    key: "family",
    label: "族标签",
    hint: "归到一个族里：智能体看到的是族，不是一个一个组",
    placeholder: "如 fast（可留空）",
  },
];

/**
 * `group set <id> k=v…`。空值不发——发了等于把它清成默认，那是另一件事。
 * 一个都没填就返回 null，调用方据此禁用按钮。
 */
export function groupSetArgs(
  id: string,
  values: Record<string, string | undefined>,
): string[] | null {
  const group = id.trim();
  if (!group) return null;
  const pairs: string[] = [];
  for (const field of GROUP_SETTING_FIELDS) {
    const value = (values[field.key] ?? "").trim();
    if (value) pairs.push(`${field.key}=${value}`);
  }
  if (!pairs.length) return null;
  return ["group", "set", group, ...pairs];
}
