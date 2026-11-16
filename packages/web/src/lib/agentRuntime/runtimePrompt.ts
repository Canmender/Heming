/**
 * 运行环境段（d.154）：让智能体知道自己「在哪、能做什么、现在有哪些工具、长任务怎么收口」。
 *
 * 为什么需要这一段：和鸣的内置智能体默认**没有系统提示词**（`prompts[agentId] ?? ""`），
 * 工具是以 OpenAI `tools` 数组单独下发的——模型能看见函数名，但不知道：
 * 自己在桌面端（写入会真的落盘）、当前是几点、会话工作区是哪个目录、哪些目录可写、
 * 这轮到底注入了几件工具、工具轮次有上限、做完要先验证。
 * 结果就是用户说的「仿佛网页端对话：不知道自己能做什么，也不知道自己的运行环境」。
 *
 * 三条约束：
 * - **纯函数**：输入快照、输出字符串，不读 window / localStorage / 时间（`now` 由调用方传），
 *   这样测试可复现，也便于在别的运行时（CLI、批处理）复用；
 * - **不撒谎**：只写调用方确认过的事实（桥可用、根存在、工具列表非空），拿不到的就不写；
 * - **可控体积**：工具最多列 `MAX_LISTED_TOOLS` 条，其余折成一句「还有 N 个」，
 *   本段整体目标 ≤ 1.2K 字符（每轮都进提示词，且尾部变化会打断前缀缓存）。
 */

import { LONG_TASK_MAX_ROUNDS, LONG_TASK_MAX_SEGMENTS } from "./longTask.js";

/** 工具清单最多逐条列出的数量：再多就折成「还有 N 个，可用 tool_search 检索」。 */
export const MAX_LISTED_TOOLS = 12;

/** 段标题：与记忆段（`## 长期记忆（语义）`）同层级，方便模型把整段当一个区块读。 */
export const RUNTIME_HEADING = "## 运行环境（本机）";

/** 调用方从 capability 桥取到的工具摘要（只要模型需要知道的部分）。 */
export interface RuntimeToolInfo {
  name: string;
  /** 中文显示名（HITL 里那份，例如「修改文件」）；缺省只用 name。 */
  title?: string;
  risk?: "read" | "write";
}

/** 一条可写/只读目录（来自 `currentFileRoots()`；`mode` 缺省按 write 理解）。 */
export interface RuntimeRootInfo {
  name: string;
  path: string;
  mode?: "read" | "write";
}

export interface RuntimeSectionInput {
  /** 桌面端（文件桥 `window.__heming_files` 可用）。浏览器端为 false → 不宣称能改本机文件。 */
  desktop?: boolean;
  /** 人读的平台名（`describePlatform(navigator.userAgent)` 的结果）；缺省不写系统。 */
  platform?: string;
  /** 当前时间：由调用方传，保证测试可复现。 */
  now?: Date;
  /** IANA 时区（`Intl.DateTimeFormat().resolvedOptions().timeZone`）。 */
  timeZone?: string;
  /** 会话工作区（未分组会话为 null/空）。 */
  workspace?: string | null;
  /** 本会话当前可写/只读目录。 */
  roots?: readonly RuntimeRootInfo[];
  /** 本轮真正注入的工具（必须来自桥本身，不是「理论上可能有」的清单）。 */
  tools?: readonly RuntimeToolInfo[];
  /** 工具目录超过阈值时会挂 tool_search（`agentStream.TOOL_SEARCH_THRESHOLD`）。 */
  toolSearchAvailable?: boolean;
  /** 每轮工具往返上限（`agentStream.MAX_TOOL_ROUNDS`）；缺省不写数字。 */
  maxToolRounds?: number;
  /**
   * 计划模式（d.173）：本轮用户要求「先方案、不改动」。
   *
   * 这一轮写类工具已经从桥里摘掉了（见 `agentRuntime/planMode.ts`），但**必须写进提示词**：
   * 否则模型看到工具少了会以为「权限没配好」，而不是「用户选了只读」——它会开始解释限制，
   * 而不是干活。用户要的是「先读清楚再给计划」，不是一段道歉。
   */
  planMode?: boolean;
}

/** 把 UA 翻成一句人话；认不出就退化成「未知系统」，绝不猜。 */
export function describePlatform(userAgent: string | undefined | null): string {
  const ua = typeof userAgent === "string" ? userAgent : "";
  if (!ua) return "";
  if (/Windows NT 10/.test(ua)) return "Windows 10/11";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iOS/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return "未知系统";
}

/** `YYYY-MM-DD HH:mm`，按给定时区渲染；时区非法/不传则用本地时区。 */
export function formatLocalTime(now: Date, timeZone?: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  let hh = now.getHours();
  let mm = now.getMinutes();
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(now);
      const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
      const h = Number(pick("hour"));
      const m = Number(pick("minute"));
      if (Number.isFinite(h) && Number.isFinite(m)) {
        hh = h % 24;
        mm = m;
      }
    } catch {
      // 时区名非法（老浏览器/异常输入）：用本地时间，别为了时区把整段弄崩。
    }
  }
  return `${date} ${pad(hh)}:${pad(mm)}`;
}

function toolLine(tool: RuntimeToolInfo): string {
  const title = tool.title && tool.title !== tool.name ? `（${tool.title}）` : "";
  const risk = tool.risk === "write" ? "·写" : tool.risk === "read" ? "·读" : "";
  return `- ${tool.name}${title}${risk}`;
}

/**
 * 拼出运行环境段；没有任何可写事实（无平台、无时间、无根、无工具）时返回空串，
 * 让 `buildAgentContext` 保持「零注入 = 原提示词逐字不变」的旧契约。
 */
export function buildRuntimeSection(input: RuntimeSectionInput): string {
  const lines: string[] = [RUNTIME_HEADING];
  const where: string[] = [];

  where.push(
    input.desktop
      ? "你现在运行在「和鸣」桌面智能体里（桌面端，工具会真的改本机文件），不是只能聊天的网页窗口"
      : "你现在运行在「和鸣」里；本轮没有桌面文件桥，暂时不能直接改本机文件",
  );
  if (input.platform) where.push(`系统：${input.platform}`);
  if (input.now) {
    const tz = input.timeZone ? `（${input.timeZone}）` : "";
    where.push(`当前时间：${formatLocalTime(input.now, input.timeZone)}${tz}`);
  }
  if (where.length) lines.push(`- ${where.join("；")}。`);

  const workspace = (input.workspace ?? "").trim();
  if (workspace) {
    lines.push(`- 本会话工作区：${workspace}（这个目录对本会话可写，文件默认写这里）。`);
  }

  const roots = (input.roots ?? []).filter((r) => r && typeof r.path === "string" && r.path.trim());
  if (roots.length) {
    const parts = roots
      .slice(0, 6)
      .map((r) => `${r.name || "未命名"}（${r.path}${r.mode === "read" ? "，只读" : ""}）`);
    const more = roots.length > 6 ? `，另有 ${roots.length - 6} 个` : "";
    lines.push(`- 可写/可读目录：${parts.join("、")}${more}；写到其它位置会先要求用户确认，或被直接拒绝。`);
  } else if (input.desktop) {
    lines.push(
      "- 当前没有可写目录：写文件前先让用户在「设置 → 文件编辑」加目录，或给会话选一个工作区；不要假装已经写入。",
    );
  }

  const tools = (input.tools ?? []).filter((t) => t && typeof t.name === "string" && t.name);
  if (tools.length) {
    lines.push("");
    const shown = tools.slice(0, MAX_LISTED_TOOLS);
    lines.push(`## 本轮可用工具（共 ${tools.length} 个）`);
    for (const tool of shown) lines.push(toolLine(tool));
    if (tools.length > shown.length) {
      const rest = tools.length - shown.length;
      lines.push(
        input.toolSearchAvailable
          ? `- 还有 ${rest} 个工具没有列出：用 tool_search 按关键词检索后再调用。`
          : `- 还有 ${rest} 个工具没有列出。`,
      );
    }
    lines.push(
      "- 只有这里列出、且调用返回成功的能力才算真做到；没列出的不要承诺（缺工具/缺权限就直接说，并给出用户可执行的下一步）。",
    );
  } else {
    lines.push("");
    lines.push("## 本轮可用工具（0 个）");
    lines.push(
      "- 这一轮没有注入任何工具：需要联网/文件/知识库时先如实说明现在用不了，并告诉用户去哪里打开（设置 → 工具授权 / 文件编辑 / MCP），不要编造查询结果。",
    );
  }

  // 计划模式（d.173）：开关在输入框上，用户一按就该看到「先计划、不改」。
  // 写在工具清单之后、长任务之前：它改的是「这一轮怎么干活」，不是怎么收尾。
  if (input.planMode) {
    lines.push("");
    lines.push("## 计划模式（本轮只读，不改东西）");
    lines.push(
      "- 这一轮用户开了计划模式：**只读不改**。先读文件、搜索、看图把事实弄清楚，然后给出改法计划（改哪些文件、按什么顺序、怎么验证、有什么风险）。",
    );
    lines.push(
      "- 写类工具这一轮没有提供给你（不是权限坏了，是用户选的）。不要调用、也不要假装已经改了：等用户确认计划、关掉计划模式后再动手。",
    );
  }

  lines.push("");
  lines.push("## 长任务怎么处理");
  lines.push(
    "- 需要多步就直接开始，不要反复问「要不要我做」；动手前用一两句话说明计划，然后逐步执行。",
  );
  // 有任务清单工具时，计划要落到 `todo_write` 上（d.154）：写在回复里的话会被上下文压缩吃掉，
  // 清单是模型唯一能「读回自己承诺过什么」的地方，也是用户能直接看到的进度。
  if (hasTodoTool(input.tools)) {
    lines.push(
      "- 多步任务（三步以上）开工前先用 `todo_write` 把步骤列出来，每完成一步就更新状态：这条清单会被保存下来，之后你能读回自己答应过什么，用户也能看到进度。",
    );
  }
  if (input.maxToolRounds && input.maxToolRounds > 0) {
    lines.push(
      `- 每轮对话最多 ${input.maxToolRounds} 次工具往返：快到上限时先给出「已完成 / 未完成 / 下一步」，不要假装做完。`,
    );
    // 自动续跑（d.157）：轮次到顶时系统会看任务清单——还有未完成项就接着跑，
    // 这件事必须写进提示词，否则模型到顶就习惯性收口（它以为「到上限=该停了」）。
    if (hasTodoTool(input.tools)) {
      lines.push(
        `- 任务清单里还有未完成项时，到达轮次上限会**自动接着做**（最多 ${LONG_TASK_MAX_SEGMENTS} 段、共 ${LONG_TASK_MAX_ROUNDS} 轮），不需要让用户催「继续」；清单已全部完成、或到了这个总上限，才如实收口给出「已完成 / 未完成 / 下一步」。`,
      );
    }
  }
  // 只读子代理（d.162）：同样只在真的注入了 `agent_task` 时才写。
  // 主对话的窗口比子会话贵得多——「先读二十个文件再回答」这种活应该交出去，
  // 否则原文全留在主历史里、之后每轮重付一遍 token，压缩后还会丢。
  if (hasAgentTaskTool(input.tools)) {
    lines.push(
      "- 要翻很多文件、多轮检索才能得出结论时，用 `agent_task` 派一个只读子代理：它自己读、只把结论带回来，别把几十个文件的原文都拉进主对话。",
    );
  }
  // 撤销（d.170）：只在真的注入了 `file_undo` 时才写——承诺了却调不到比不承诺更糟。
  if (hasUndoTool(input.tools)) {
    lines.push(
      "- 改错、覆盖错、误删了可以用 `file_undo` 把那个文件回滚到上一次写之前；一份备份只能用一次，回滚后先 `file_read` 复核。",
    );
  }

  // 看图片（d.168）：只在真的注入了 `file_image` 时才写。
  // 用户说「这张截图哪里不对」时，模型最容易的做法是让用户自己描述——那等于没看图。
  if (hasImageTool(input.tools)) {
    lines.push(
      "- 用户提到截图、设计稿、图表，或给了工作区里的图片路径时，用 `file_image` 直接打开看：看完照着图回答，不要要求用户描述，也不要凭文件名猜内容。",
    );
  }
  // 本机命令（d.164）：只在真的注入了 `run_command` 时才写。
  // 「每条命令都要用户点确认」必须提前说清：否则模型会把「等用户点确认」当成卡死，
  // 转而反复重试或绕过工具自己编输出——那比命令本身危险得多。
  if (hasShellTool(input.tools)) {
    lines.push(
      "- 需要装依赖、跑测试、看 git 状态或端口、构建时用 `run_command`：一条命令只做一件事；命令执行前会请用户确认（查数据的只读命令也要），所以看到等待就说明在等人，不要重复发；非零退出码先读错误输出再决定下一步，不要原样重跑同一条命令。",
    );
  }
  lines.push(
    "- 每一步都要拿到真实工具结果再往下走；同一件事别重复调用同一个工具碰运气。",    "- 声称「已完成」之前先验证：读回写入的文件、看命令输出、核对返回值；拿不到证据就明说「未验证」。",
    "- 结果用用户能核对的粒度汇报：改了哪个文件/哪几行、跑了什么、输出是什么、还剩什么没做。",
  );

  return lines.join("\n");
}

/**
 * 这一轮是否注入了任务清单工具。
 *
 * 只按名字判断（`todo_write`），不看前缀：清单工具是模型「外化计划」的唯一现实手段，
 * 提示词里不能承诺一个没注入的工具——所以这条只在真的有时才写。
 */
function hasTodoTool(tools: RuntimeSectionInput["tools"] | undefined): boolean {
  if (!tools) return false;
  return tools.some((tool) => tool.name === "todo_write");
}

/**
 * 这一轮是否注入了只读子代理工具（`agent_task`，d.162）。
 *
 * 与 `hasTodoTool` 同一个理由：提示词不承诺没注入的工具。这里写死名字而不是从
 * `subagent.ts` 引常量，是为了让本模块只依赖「工具清单」这一份数据、不反向依赖
 * 子代理实现（否则运行时提示词会顺着 import 链把 llmRoute 拉进来）。
 */
function hasAgentTaskTool(tools: RuntimeSectionInput["tools"] | undefined): boolean {
  if (!tools) return false;
  return tools.some((tool) => tool.name === "agent_task");
}

/**
 * 这一轮是否注入了本机命令工具（`run_command`，d.164）。
 *
 * 与上两个同理由：浏览器端没有命令桥、没有可写根时命令工具不注入，
 * 提示词却一条一句地教它跑命令，会让模型对着空气许愿。
 */
function hasUndoTool(tools: RuntimeSectionInput["tools"] | undefined): boolean {
  return !!tools && tools.some((tool) => tool.name === "file_undo");
}

function hasImageTool(tools: RuntimeSectionInput["tools"] | undefined): boolean {
  if (!tools) return false;
  return tools.some((tool) => tool.name === "file_image");
}

/**
 * 这一轮是否注入了本机命令工具（`run_command`，d.164）。
 *
 * 与上几个同理由：浏览器端没有命令桥、没有可写根时命令工具不注入，
 * 提示词却一条一句地教它跑命令，会让模型对着空气许愿。
 */
function hasShellTool(tools: RuntimeSectionInput["tools"] | undefined): boolean {
  if (!tools) return false;
  return tools.some((tool) => tool.name === "run_command");
}

/** OpenAI tools 形状（`{type:"function", function:{name}}`）的一个最小读法。 */
function specName(spec: unknown): string {
  if (!spec || typeof spec !== "object") return "";
  const fn = (spec as { function?: { name?: unknown } }).function;
  return fn && typeof fn.name === "string" ? fn.name : "";
}

/**
 * 把 capability 桥里的 OpenAI tools 数组翻成清单（name + 中文显示名 + 读写风险）。
 *
 * `metaOf` 传 `toolMetaOf` 时能带上 HITL 那份显示名/风险，模型读到的「写文件」和
 * 确认卡上写的是同一句话；读不到就只给 name，绝不猜风险（猜错会让提示词和实际闸门对不上）。
 */
export function runtimeToolsFromSpecs(
  specs: unknown[] | undefined,
  metaOf?: (
    name: string,
  ) => { risk?: "read" | "write" | "danger"; displayName?: string } | undefined,
): RuntimeToolInfo[] {
  const out: RuntimeToolInfo[] = [];
  const seen = new Set<string>();
  for (const spec of specs ?? []) {
    const name = specName(spec);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const meta = metaOf?.(name);
    // danger（确认卡上最重的那档）在运行环境里归到「写」：模型要读到的是「这个会改东西」，
    // 而不是一个它不认识的枚举值。
    const risk = meta?.risk === "read" ? "read" : meta?.risk ? "write" : undefined;
    out.push({ name, title: meta?.displayName, ...(risk ? { risk } : {}) });
  }
  return out;
}