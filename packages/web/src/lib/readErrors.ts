import { engineText } from "./engineText.js";
import { stripAnsi } from "./magpieCli.js";

/**
 * 哪一段没读到，以及内核当时说了什么。
 *
 * 内核没起来、安装包缺运行文件、命令超时，`cli.cli` 都会回 `ok: false` 且 stdout
 * 是空的。那时页面若照旧说「还没有来源」「还没有账号」，就是在骗人：**读失败**
 * 和**真的没有**是两件事，用户该做的动作也完全不同（一个去修服务，一个去登录）。
 */
export type ReadSection = "providers" | "accounts" | "quotas" | "agents";

/** 这一段的用户可见叫法，与页面上分区/卡片的措辞保持一致。 */
export const READ_SECTION_LABEL: Record<ReadSection, string> = {
  providers: "来源",
  accounts: "订阅账号",
  quotas: "其余额度",
  agents: "本机的智能体",
};

export type ReadErrors = Readonly<Record<string, string>>;

/**
 * 内核这次到底说了什么。
 *
 * stderr 常常是多行进度条/提示，取最后一行有内容的话；ANSI 先剥掉，
 * 引擎名字过一遍 `engineText`（用户不该在错误里看见外部引擎名），
 * 再压成一行、限长 120 字——提示条是一行字，不是日志窗口。
 */
export function readFailureDetail(stderr: string, error?: string): string {
  const text = stripAnsi(`${stderr || ""}\n${error || ""}`);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const last = lines.length > 0 ? lines[lines.length - 1]! : "";
  const said = engineText(last).replace(/\s+/g, " ").trim();
  if (said === "") return "没有说明原因";
  return said.length <= 120 ? said : `${said.slice(0, 119)}…`;
}

/** 失败时记下原因；成功时把这一段的旧原因抹掉。 */
export function setReadError(current: ReadErrors, section: ReadSection, detail: string | null): ReadErrors {
  if (detail === null) {
    if (!(section in current)) return current;
    return Object.fromEntries(Object.entries(current).filter(([key]) => key !== section));
  }
  const why = detail.trim() === "" ? "没有说明原因" : detail;
  return current[section] === why ? current : { ...current, [section]: why };
}

/** 给用户看的那一句：说清是「没读到」，不是「没有」。 */
export function readFailureText(section: ReadSection, detail: string): string {
  const why = detail.trim() === "" ? "没有说明原因" : detail;
  return `这次没读到${READ_SECTION_LABEL[section]}：${why}`;
}

/** 读失败的那几段，按固定顺序排（给「重读全部」按钮的说明用）。 */
export function failedSections(errors: ReadErrors): ReadSection[] {
  const order: ReadSection[] = ["providers", "accounts", "quotas", "agents"];
  return order.filter((section) => section in errors);
}

/** 几段同时失败时压成一句话；都没失败返回空串。 */
export function readFailuresText(errors: ReadErrors): string {
  const sections = failedSections(errors);
  if (sections.length === 0) return "";
  const labels = sections.map((section) => READ_SECTION_LABEL[section]).join("、");
  return `${labels}这次没读到。`;
}