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

/** 清单回灌上限（与 `lib/todo/store.ts` 的 `MAX_TODOS` 对齐；这里写死是为了不反向依赖）。 */
export const MAX_TODOS_IN_PROMPT = 20;

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
  /**
   * 本轮命令桥是否可用后台作业通道（d.180，`hasJobRuntime`）。
   *
   * 缺省 false：缺省时输出必须与加这个字段之前**逐字相同**（老桌面端没有作业通道，
   * 提示词里教它 `background: true` 只会换来一串 bridge-missing）。
   */
  hasBackgroundJobs?: boolean;
  /**
   * 本会话当前的任务清单（d.192）。
   *
   * 为什么要把清单回灌进提示词：清单存在本机（`lib/todo/store.ts`），但模型能「看见」它只有
   * 两种时刻——自己刚调用过 `todo_write`，或者历史里那条工具结果还没被压缩掉。长任务里
   * 上下文压缩、关窗重启续跑（d.189）、隔天接着做，都会让「我答应过要做什么」从视野里消失，
   * 于是模型从中间开始重做、或者漏掉最后一步。
   */
  todos?: readonly RuntimeTodoInfo[];
  /**
   * 本会话的目标（d.201）：一句话说明「这一切要达成什么」。
   *
   * 与清单的分工：清单是**步骤**，目标是**终点**。清单只能告诉模型「第 3 项还没打勾」，
   * 说不了「我们为什么做这一步」；长任务跑几十轮、上下文压缩几次之后，模型很容易把
   * 清单做完当成交付，或者半路拐去做顺手的另一件事。空字符串/只有空白时整段不写。
   */
  goal?: string;
}

/** 提示词里回灌的清单条目（与 `lib/todo/store.ts` 的 `TodoItem` 同形，避免反向依赖）。 */
export interface RuntimeTodoInfo {
  content: string;
  status: "pending" | "in_progress" | "completed";
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

  // 当前目标（d.201）：写在任务清单之前——先让模型看终点，再看步骤。
  // 空目标不写这段：没有目标时说一句「没有目标」只会让提示词变长、还可能被当成结论。
  const goal = typeof input.goal === "string" ? input.goal.replace(/\s+/g, " ").trim() : "";
  if (goal) {
    lines.push("");
    lines.push("## 当前目标（跨轮保持）");
    lines.push(`- 目标：${goal}`);
    lines.push(
      "- 这是这次会话的总目标，不是这一轮的起止点。任务清单是把它拆出来的步骤：清单全做完 ≠ 目标完成，收尾前回看这句目标本身。",
    );
    lines.push(
      "- 每一步都对着目标做：做完一步问一句「离目标更近了吗」；发现方向偏了，先用一两句话说明为什么偏、打算怎么回正，再继续。",
    );
    lines.push(
      "- 目标达成后，用一两句话总结「目标是什么、怎么验证它达成了」；没达成要如实说差在哪、下一步是什么，不要含糊收尾。用户说目标不做了就停下。",
    );
  }

  // 当前任务清单（d.192）：写在长任务说明之前，让模型先知道「已经答应过什么、做到哪了」，
  // 再谈这一轮怎么干。空清单不写这段——没有清单时多说一句只会让提示词变长。
  const todos = (input.todos ?? []).filter((t) => t && typeof t.content === "string" && t.content.trim());
  if (todos.length) {
    const done = todos.filter((t) => t.status === "completed").length;
    const doing = todos.filter((t) => t.status === "in_progress").length;
    lines.push("");
    lines.push(`## 当前任务清单（${done}/${todos.length} 已完成${doing ? `，${doing} 项进行中` : ""}）`);
    for (const todo of todos.slice(0, MAX_TODOS_IN_PROMPT)) {
      const mark = todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[>]" : "[ ]";
      lines.push(`- ${mark} ${todo.content.trim()}`);
    }
    if (todos.length > MAX_TODOS_IN_PROMPT) {
      lines.push(`- 另有 ${todos.length - MAX_TODOS_IN_PROMPT} 项未列出（清单上限 ${MAX_TODOS_IN_PROMPT} 条）。`);
    }
    lines.push(
      "- 以这条清单为进度基线：已经完成的不要再做一遍；接着做进行中的那一项，别从中间另起炉灶。清单和事实不一致时（例如文件已经改好了），先更新清单再继续。",
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
  // 长输出的「再读」（d.181）：截断是常态（一次 build 几千行日志、一次 grep 命中几百条），
  // 不给模型一条明确的「怎么读回」的路，它只会重复调用同一个工具，把预算烧在同一件事上。
  if (hasToolOutputTool(input.tools)) {
    lines.push(
      "- 工具结果过长时会被截断，返回文本里会给一个 `spill-<数字>` 的 handle：需要看中段就用 `tool_output_read` 按 offset/limit 分段读回，不要为了同样的内容把工具再调一次。",
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
  // 后台作业（d.180）：只有桥真的能起/读/列/停作业时才教它用。
  // 120 秒是前台命令的硬上限，长任务必须走后台，否则模型只有「超时」一条路。
  if (hasShellTool(input.tools) && input.hasBackgroundJobs) {
    lines.push(
      "- 构建、装依赖、跑整套测试这类可能超过两分钟的命令，用 `run_command` 的 `background: true` 起成后台作业，再用 `command_output` 轮询（可 wait_ms），别让一条命令卡在 120 秒超时上；作业跑完再读一次拿收尾输出。",
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

/** 这一轮是否注入了「读回被截断输出」的工具（d.181）。 */
function hasToolOutputTool(tools: RuntimeSectionInput["tools"] | undefined): boolean {
  if (!tools) return false;
  return tools.some((tool) => tool.name === "tool_output_read");
}