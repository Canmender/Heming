/**
 * 输入框里的本地命令（d.184）：`/` 开头的「命令面板」。
 *
 * 为什么要做：d.183 加了 `/compact`，但用户得先知道这个字符串存在——在输入框里
 * 没有一个能「发现」它的入口。codex / Claude Code 都是打 `/` 就列出可用命令，
 * 这里对齐这个动作，并且把命令面板做成**纯本地**的：`/` 命令不发网络、不落库，
 * 只改本会话的界面状态或触发一次本地动作。
 *
 * 只认「以 `/` 开头、单行」的输入：正常消息里的斜杠（路径、日期、分数）不该弹面板。
 */

export interface SlashCommand {
  /** 用户输入的完整命令（含斜杠）。 */
  command: string;
  /** 面板里的一行标题。 */
  title: string;
  /** 一行说明：它会做什么。 */
  hint: string;
}

/** 计划模式的本地命令名（与 `planMode.ts` 的开关同源，避免两处各写一个字符串）。 */
export const PLAN_COMMAND = "/plan";
/** 环境自检（d.193）：一条命令说清模型/工作区/可写目录/预算/清单/作业/可撤回。 */
export const STATUS_COMMAND = "/status";
/** 会话目标（d.201）：`/goal <一句话>` 设定、`/goal done` 完成、`/goal off` 清除。 */
export const GOAL_COMMAND = "/goal";
/** 子代理写盘授权（d.202）：`/subagent write on|off`，不带参数就是看状态。 */
export const SUBAGENT_COMMAND = "/subagent";
/** 列出本地命令（面板之外的兜底：用户可能就是想看一遍完整列表）。 */
export const HELP_COMMAND = "/help";

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    command: "/compact",
    title: "压缩这段对话",
    hint: "把早期内容折成摘要，下一轮生效（会回报省了多少）",
  },
  {
    command: "/plan",
    title: "计划模式：只读，先给方案",
    hint: "这一轮只保留只读工具；再发一次切回正常",
  },
  {
    command: GOAL_COMMAND,
    title: "设定这次会话的目标",
    hint: "/goal 把登录改成扫码：一句话说清终点，会跨轮写进提示词；/goal done 完成、/goal off 清除",
  },
  {
    command: SUBAGENT_COMMAND,
    title: "允许子代理改文件（默认不允许）",
    hint: "/subagent write on 授权子代理改工作区内的文件（只能 file_write/file_edit，改动可整体撤回）；write off 收回",
  },
  {
    command: STATUS_COMMAND,
    title: "看当前环境与预算",
    hint: "模型、工作区、可写目录、上下文用量、清单与作业状态，一次列清",
  },
  {
    command: HELP_COMMAND,
    title: "列出本地命令",
    hint: "这些命令只在本机执行，不会发给模型",
  },
];

/**
 * 当前输入是否在「命令面板」状态：以 `/` 开头、单行、且还没打完命令名。
 * 打完整命令（例如 `/compact` 后跟空格）就不再弹面板——那时用户是在发命令本身。
 */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith("/")) return null;
  if (draft.includes("\n")) return null;
  // 打完命令再敲空格（`/compact `）：用户是在发这条命令本身，不是在找命令。
  // 注意 `trim()` 会把那个尾随空格吃掉，所以要拿原串比。
  if (draft !== draft.trimEnd()) return null;
  const body = draft.slice(1);
  if (/\s/.test(body)) return null;
  return body;
}

/** 按前缀匹配命令；空查询（只打了个 `/`）返回全部。 */
export function matchSlashCommands(draft: string, all: readonly SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const query = slashQuery(draft);
  if (query === null) return [];
  // 已经打完整条命令：面板收起，下一次 Enter 直接执行（面板留着会挡住「执行」这个动作）。
  if (all.some((item) => item.command === `/${query}`)) return [];
  const q = query.toLowerCase();
  return all.filter((item) => item.command.slice(1).toLowerCase().startsWith(q));
}
