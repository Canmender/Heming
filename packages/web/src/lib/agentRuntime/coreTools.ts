/**
 * 「核心工具常驻」（d.191 起，d.207 改成注册时声明）。
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
 * ## 为什么改成「注册时声明」（d.207）
 *
 * d.191 的做法是在本文件里列一份**名字清单**。清单的问题不是「不好用」，而是
 * **会静默过期**：d.204 加了 `workflow_run`，没人想起来往清单里补，工具目录一过阈值
 * 它就落到按需发现里——模型得先检索才能看见自己刚学会的工作流工具。
 *
 * 现在的口径：
 * 1. **权威来源是工具桥的 `meta(name).core === true`**——声明写在工具定义旁边，
 *    新加核心工具时改动点只有一处；
 * 2. `CORE_TOOL_NAMES` 保留为**旧桥兜底**（第三方的、或还没补声明的桥），
 *    两者取并集，所以「漏补声明」最坏也只是像以前一样靠清单兜住，不会更差；
 * 3. 只认精确名字，不认前缀——MCP 工具名形如 `服务__工具`，按前缀匹配容易把
 *    无关的第三方 `file_*` 也钉死，反而挤掉真正的本地工具。
 */

import type { ToolBridge } from "../agentStream.js";

/**
 * 旧桥兜底名单（d.191 口径）。
 *
 * ⚠️ **新增内置核心工具时优先在工具定义处声明 `meta(name).core = true`**；
 * 这张表只在桥没有声明能力时兜底（老安装包、第三方桥、单测里的假桥）。
 */
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
  // 长任务编排（d.155/d.162/d.181/d.204）
  "todo_write",
  "agent_task",
  "tool_output_read",
  "workflow_run",
];

const CORE = new Set(CORE_TOOL_NAMES);

/** 桥侧声明查询：拿一个工具的 `meta`（缺省表示这个桥不声明）。 */
export type CoreMetaLookup = ToolBridge["meta"];

/** 这个名字是否属于常驻名单（声明优先，旧名单兜底）。 */
export function isCoreTool(name: string, metaOf?: CoreMetaLookup): boolean {
  if (metaOf?.(name)?.core === true) return true;
  return CORE.has(name);
}

/**
 * 从目录里挑出常驻工具，保持**目录原顺序**（与 `tools` 声明顺序一致，便于断言与缓存）。
 *
 * 目录里没有的（老安装包缺 `command_*`、子代理未注入等）自然被跳过——这里不假设
 * 任何工具一定存在。`metaOf` 缺省时只按旧名单判断（与 d.191 行为一致）。
 */
export function coreToolNames(names: readonly string[], metaOf?: CoreMetaLookup): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (out.includes(name)) continue;
    if (isCoreTool(name, metaOf)) out.push(name);
  }
  return out;
}
