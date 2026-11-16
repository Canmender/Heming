/**
 * 「核心工具常驻」（d.191）。
 *
 * 工具目录超过 `TOOL_SEARCH_THRESHOLD` 时，`agentStream` 切到「按需发现」：
 * 只把一部分工具塞进请求，其余靠 `tool_search` 检索解锁。名额按「与用户这句话的
 * 相关度」排序——这对 MCP 服务是好事，但对**本地能力**是坏事：
 *
 * - 用户说「帮我查下笔记」（装了知识库 MCP）时，检索命中的是笔记工具与一堆 `srv__*`，
 *   第一轮可能根本看不见 `file_write` / `run_command`；
 * - 而这两样恰恰是长任务走到一半必须有的（写完要跑测试、跑完要再改）。
 *   模型这时只有两条路：先猜着调 `tool_search`，或者干脆停下说「我做不到」。
 *
 * 所以这里列一份**常驻名单**：名字命中就先占名额，剩下名额再按相关度与目录序补齐。
 * 只认精确名字，不认前缀——MCP 工具名形如 `服务__工具`，按前缀匹配容易把无关的
 * 第三方 `file_*` 也钉死，反而挤掉真正的本地工具。
 */

/** 本地内置工具里，长任务全程都可能用到的那批（名字与 `capability` 注册的一致）。 */
export const CORE_TOOL_NAMES: readonly string[] = [
  // 读写与检索（d.153/d.168）
  "file_read",
  "file_write",
  "file_edit",
  "file_patch",
  "file_undo",
  "file_glob",
  "file_grep",
  "file_image",
  // 本机命令与后台作业（d.164/d.165/d.180）
  "run_command",
  "command_output",
  "command_list",
  "command_kill",
  // 长任务编排（d.155/d.162/d.181）
  "todo_write",
  "agent_task",
  "tool_output_read",
];

const CORE = new Set(CORE_TOOL_NAMES);

/** 这个名字是否属于常驻名单。 */
export function isCoreTool(name: string): boolean {
  return CORE.has(name);
}

/**
 * 从目录里挑出常驻工具，保持**目录原顺序**（与 `tools` 声明顺序一致，便于断言与缓存）。
 *
 * 目录里没有的（老安装包缺 `command_*`、子代理未注入等）自然被跳过——这里不假设
 * 任何工具一定存在。
 */
export function coreToolNames(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (CORE.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
