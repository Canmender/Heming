/**
 * 来源的「模型清单」三项规矩（d.363）：列不列给智能体、多久自己刷一次、新模型怎么收。
 *
 * 为什么单独放 lib：这三项各自是一条内核子命令（`provider listed` / `refresh-every` /
 * `auto-include`），参数形状固定、规则又多（auto-include 是 glob 列表，`none` 是清空），
 * 放进 ModelPage 里就只能靠读源码确认对不对。校验与拼参数放这里，单测钉住。
 *
 * 原则：**留空就是这次不改**。页面上的下拉首项是「不改」，只有用户真的选了才发命令——
 * 不看当前值、也不猜默认值，免得一保存就把人家原来的设置覆盖掉。
 */

export type SourceModelsKey = "listed" | "refreshEvery" | "autoInclude";

export interface SourceModelsField {
  key: SourceModelsKey;
  label: string;
  hint: string;
  /** 有 options 的渲染成下拉，没有的渲染成输入框。 */
  options?: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
}

export const SOURCE_MODELS_FIELDS: readonly SourceModelsField[] = [
  {
    key: "listed",
    label: "列给智能体",
    hint: "«只给分组用» 时它的模型不进智能体的可选清单，只能经它所在的分组被选中。",
    options: [
      { value: "yes", label: "列给智能体（默认）" },
      { value: "no", label: "只给分组用" },
    ],
  },
  {
    key: "refreshEvery",
    label: "多久自己刷一次清单",
    hint: "网关（magpie serve 或和鸣）跑着的时候才生效；«不自动刷» 就只在你点「重新读取」时拉。",
    options: [
      { value: "30m", label: "每 30 分钟" },
      { value: "6h", label: "每 6 小时" },
      { value: "1d", label: "每天" },
      { value: "off", label: "不自动刷" },
    ],
  },
  {
    key: "autoInclude",
    label: "新模型自动收",
    hint: "厂商后加的模型，id 命中这些规则就自动收进来；空格分开，* 当通配。填 none 清空。",
    placeholder: "如 claude-* gpt-4o*",
  },
];

const LISTED = new Set(["yes", "no"]);
const EVERY = new Set(["30m", "6h", "1d", "off"]);

/** 把「新模型自动收」那格拆成规则：空格、逗号、中文逗号都算分隔。 */
export function parseAutoInclude(raw: string): string[] {
  return raw
    .split(/[\s,，]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * 生成要发的命令（一项一条，顺序固定：列不列 → 刷不刷 → 收哪些）。
 * 没来源 id、或三项都没填时返回空数组——调用方据此把按钮置灰。
 */
export function sourceModelsCommands(
  id: string,
  values: Partial<Record<SourceModelsKey, string>>,
): string[][] {
  const providerId = id.trim();
  if (!providerId) return [];

  const commands: string[][] = [];

  const listed = (values.listed ?? "").trim();
  if (LISTED.has(listed)) commands.push(["provider", "listed", providerId, listed]);

  const every = (values.refreshEvery ?? "").trim();
  if (EVERY.has(every)) commands.push(["provider", "refresh-every", providerId, every]);

  const rules = parseAutoInclude(values.autoInclude ?? "");
  if (rules.length === 1 && /^(?:none|off)$/i.test(rules[0]!)) {
    // 内核认 none 与 off 两种写法清空；统一发 none，输出更好懂。
    commands.push(["provider", "auto-include", providerId, "none"]);
  } else if (rules.length > 0) {
    commands.push(["provider", "auto-include", providerId, ...rules]);
  }

  return commands;
}

/** 一眼看出发了几项，按钮上写「保存清单规矩（3 项）」。 */
export function sourceModelsSummary(commands: string[][]): string {
  if (commands.length === 0) return "保存清单规矩";
  return `保存清单规矩（${commands.length} 项）`;
}
