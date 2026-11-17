import type { ToolBridge, ToolSource } from "../agentStream.js";
import type { RiskLevel } from "../hitl/types.js";
import type { TeamEvent, TeamPlanItem, TeamTask, TeamTaskComment, TeamWorkspaceSnapshot } from "@heming/shared";
import {
  addWorkspaceMember,
  createTeamPlan,
  createTeamTask,
  createTeamTaskComment,
  createWorkspaceTeam,
  fetchWorkspaceTeam,
  fetchWorkspaceTeams,
  fetchTeamEvents,
  fetchTeamTaskComments,
  isApiAbort,
  isApiTimeout,
  removeWorkspaceMember,
  transferWorkspaceTeamOwner,
  updateTeamPlan,
  updateTeamTask,
  updateWorkspaceTeam,
  type ApiRequestOptions,
} from "../api.js";
import { fmtLocalDateTime } from "../format/datetime.js";
import { describeAssigneeLoad, describeLoad, loadOf, memberLoads } from "../team/load.js";
import {
  FIND_TASK_LIMIT_DEFAULT,
  FIND_TASK_LIMIT_MAX,
  describeFindResult,
  findTeamTasks,
} from "../team/findTasks.js";
import { DIGEST_DEFAULT_DAYS, DIGEST_MAX_DAYS, buildTeamDigest } from "../team/digest.js";
import type { CapabilityProvider } from "./types.js";

/**
 * 团队工作台（d.92）的智能体工具。
 *
 * 两层「团队」不要混：
 * - 本文件操作的是**用户自建的团队**（名字 / 目标 / 方案 / 任务 / 成员）；
 * - 团队页那个「同队成员可见」的名册与动向摘要（d.152 起只对与你在同一工作台
 *   团队的同事可见；没有团队时只有你自己）是另一套（TeamRoster/TeamActivity），
 *   不在这里。
 *
 * 权限只在服务端判定（是否成员 / 是否 owner）；这里不做客户端越权判断，
 * 只做参数形状的友好校验，并把服务端的中文错误原样回给模型。
 *
 * 风险分级：读工具 `read`（不打断用户），写工具 `write`（走 HITL 确认）。
 * 另有两条 `danger`：`team_member_remove`（把别人移出团队）与 `team_owner_transfer`
 * （把队长交出去）——它们影响的是别人的访问权限和团队控制权，收不回来，
 * 所以每次都要人看一眼，不能被「记住允许」放行。
 * 删除团队/方案/任务仍然不提供给智能体（避免误删）。
 */

export interface TeamToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  riskHint: RiskLevel;
}

const str = (description: string) => ({ type: "string" as const, description });
/** 枚举参数（d.272）：给模型一个封闭取值表，避免它自己编别名叫法。 */
const enumStr = (values: string[], description: string) => ({
  type: "string" as const,
  enum: values,
  description,
});
/** 对象数组参数（d.270）：一次派多件任务时用，数组元素的字段与单件一致。 */
const objs = (description: string, itemProperties: Record<string, unknown>) => ({
  type: "array" as const,
  description,
  items: { type: "object" as const, properties: itemProperties, required: ["title"] },
});
const STATUS_ENUM = {
  type: "string" as const,
  enum: ["todo", "doing", "done", "blocked"],
  description: "状态：todo=待办 / doing=进行中 / done=已完成 / blocked=受阻",
};

const SHARED_HEAD =
  "这是「用户自建的团队工作台」（用户自己建的团队：名字、目标、方案、任务、成员），" +
  "不是团队页那个「同队成员可见的团队动向」（只对与你同属一个团队的同事可见）。" +
  "只操作用户自己的团队，不涉及同队名册与动向摘要。" +
  "若本轮工具列表里看不到 team_*，先调用 tool_search 搜「团队」再继续。" +
  "参数名两种写法都接受（team_id 或 teamId、plan_id 或 planId、task_id 或 taskId；" +
  "snake_case 与 camelCase 等价），但**不认识/拼错的参数会直接报错**，不会静默忽略——" +
  "报错时按提示里的可用参数名重试。";

/** 团队工具的单次请求超时：服务端 15 秒还没回就按超时处理，别让整轮对话挂死。 */
const TEAM_REQUEST_TIMEOUT_MS = 15_000;

/** 一次工具调用要传给 API 的请求控制：中断信号透传 + 统一超时。 */
function requestOf(signal: AbortSignal | undefined): ApiRequestOptions {
  return signal ? { signal, timeoutMs: TEAM_REQUEST_TIMEOUT_MS } : { timeoutMs: TEAM_REQUEST_TIMEOUT_MS };
}

export const TEAM_TOOLS: TeamToolSpec[] = [
  {
    name: "team_list",
    riskHint: "read",
    description:
      `${SHARED_HEAD}列出「我的团队」：每个团队的 team_id、名字、目标、成员数、任务数。` +
      "要操作某个团队但不知道 team_id 时，先调用它。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "team_get",
    riskHint: "read",
    description:
      `${SHARED_HEAD}读取一个团队的完整快照：目标、方案（plans）、任务（tasks）、成员（members，` +
      "含 username 与 role，可用来核对 assigneeId）。可用 team_id 精确取，或用 name 精确匹配；" +
      "都不知道时先调用 team_list。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（从 team_list 或 team_create 的返回里获取）。"),
        name: str("团队名称（精确匹配；与 team_id 二选一）。"),
      },
      required: [],
    },
  },
  {
    name: "team_task_find",
    riskHint: "read",
    description:
      `${SHARED_HEAD}在团队里按关键词 / 负责人 / 状态找任务（只读）。` +
      "快照里的任务只列前 20 条，任务多了要靠它：关键词按空格切开、每个词都要出现" +
      "（标题、需求、结论、进展、taskId 都算），可再按负责人与「是否逾期」筛。" +
      "只读列表，不会调用 tool_search 之外的任何工具。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        query: str("关键词（可多个，空格分隔；不区分大小写；不给 = 不限）。"),
        assignee: str("只看某个人名下的活：username 或显示名（不给 = 不限）。"),
        status: str("open（默认：未完成）/ done（只看已完成）/ all（全部）。"),
        overdue: { type: "boolean" as const, description: "true = 只看「已过截止、还没完成」的。" },
        limit: str("最多列几条（1–20，默认 10）。"),
      },
      required: [],
    },
  },
  {
    name: "team_task_comments",
    riskHint: "read",
    description:
      `${SHARED_HEAD}看一条任务下的讨论（按时间从早到晚）：组员与组长（连同各自的智能体）在这里问口径、补约束、回复疑问。` +
      "它和「最新进展」不同：进展是被覆盖的一条状态，讨论是追加的时间线，谁也不能改别人写过的话。" +
      "开工前先看一眼有没有新留言；有新要求也写在这里，对方的智能体下一轮能看到。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        task_id: str("任务 id（从 team_get / team_task_find 的 tasks 里拿）。"),
      },
      required: ["team_id", "task_id"],
    },
  },
  {
    name: "team_events",
    riskHint: "read",
    description:
      `${SHARED_HEAD}看团队最近发生了什么（只读，新的在前）：谁派了活、谁改了状态、谁催的、谁验收的、谁留了言、谁删了任务。` +
      "快照只说「现在是什么样」，要说清「为什么变成这样」就靠它——被改回去的任务、被拿走的活、被打回的版本，这里都有记录。" +
      "问「这周发生了什么」「怎么突然变成这样」先调它，不要凭快照猜。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        limit: str("最多看几条（1–50，默认 20）。"),
      },
      required: [],
    },
  },
  {
    name: "team_task_history",
    riskHint: "read",
    description:
      `${SHARED_HEAD}看某一件任务自己的历史（只读，新的在前）：谁建的、谁改过状态或负责人、谁催的、谁打回或验收的、谁删了又建。` +
      "团队动态是全队流水，这个只看一条活——排查「这件活为什么变回去了」「上次是谁打回的」用它。" +
      "要全队的来龙去脉用 team_events；要这件活的讨论用 team_task_comments。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        task_id: str("任务 id（从 team_get / team_task_find 的 tasks 里拿）。"),
        limit: str("最多看几条（1–50，默认 20）。"),
      },
      required: ["team_id", "task_id"],
    },
  },
  {
    name: "team_digest",
    riskHint: "read",
    description:
      `${SHARED_HEAD}把团队近 N 天的情况算成一份复盘摘要（只读）：完成了几件、谁在忙、什么逾期、什么被前置挡住、什么被退回待安排、什么催过没动。` +
      "用户问「这周团队怎么样」「给我一份周报/复盘」时先调它，再基于它给的数字总结，不要自己对着任务清单手工统计（清单会截断）。" +
      "只陈述事实与下一步，不替你决定派给谁。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        days: str(`回看天数（1–${DIGEST_MAX_DAYS}，默认 ${DIGEST_DEFAULT_DAYS}）；用户说「上周」就给 7、「这个月」给 30。`),
      },
      required: [],
    },
  },
  {
    name: "team_create",
    riskHint: "write",
    description:
      `${SHARED_HEAD}创建一个新团队，可同时写团队目标。创建后当前用户是 owner；` +
      "接着可用 team_member_add 拉人、team_plan_add 写方案、team_task_add 派任务。" +
      "这是写操作，执行前会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        name: str("团队名称（必填，最多 40 字）。"),
        goal: str("团队目标（可选，最多 500 字）。"),
      },
      required: ["name"],
    },
  },
  {
    name: "team_update",
    riskHint: "write",
    description:
      `${SHARED_HEAD}修改团队名称或目标（至少给一项）。只有 owner 能改；` +
      "写操作，执行前会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        name: str("新的团队名称（可选，最多 40 字）。"),
        goal: str("新的团队目标（可选，最多 500 字；空串 = 清空目标）。"),
      },
      required: ["team_id"],
    },
  },
  {
    name: "team_member_add",
    riskHint: "write",
    description:
      `${SHARED_HEAD}把已有用户按 username 加入团队（不发邀请、也不公开注册）。只有 owner 能加；` +
      "写操作，执行前会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        username: str("要加入的用户的用户名（不是显示名，例如 zhangsan）。"),
      },
      required: ["team_id", "username"],
    },
  },
  {
    name: "team_task_nudge",
    riskHint: "write",
    description:
      `${SHARED_HEAD}催办一件派给别人、还没完成的任务（只有组长能催）。` +
      "只是留一条提醒：不改状态、不改负责人。对方和它的智能体下一轮会看到「组长在什么时候催过、催过几次」，任务板上也会显示出来。写操作，执行前会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        task_id: str("任务 id（team_get 能看到）。"),
      },
      required: ["team_id", "task_id"],
    },
  },
  {
    name: "team_task_review",
    riskHint: "write",
    description:
      `${SHARED_HEAD}验收一件已完成的任务（只有组长能验收）：通过，或者打回重做。` +
      "打回必须写一句原因（note），会把任务状态改回「进行中」、保留上一版结论，做的人下一轮会看到要改什么。" +
      "写操作，执行前会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        task_id: str("任务 id（team_get 能看到）。"),
        verdict: enumStr(["approve", "changes"], "approve = 验收通过；changes = 打回重做（必须带 note）。"),
        note: str("验收意见：打回时说明要改什么；通过时可以留一句认可。"),
      },
      required: ["team_id", "task_id", "verdict"],
    },
  },
  {
    name: "team_member_remove",
    riskHint: "danger",
    description:
      `${SHARED_HEAD}把某个成员移出团队（只有 owner 能移；队长本人不能移）。` +
      "这会立刻收掉对方对这个团队的访问权限，收不回来；执行前一定会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        username: str("要移出的成员用户名（不是显示名，例如 linxiao）。"),
      },
      required: ["team_id", "username"],
    },
  },
  {
    name: "team_owner_transfer",
    riskHint: "danger",
    description:
      `${SHARED_HEAD}把队长身份转让给团队里的某位成员（只有 owner 能转让）。` +
      "转让后你变成普通成员，不能再加人/派活/删除；执行前一定会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        username: str("接任队长的成员用户名（不是显示名；必须是团队现有成员）。"),
      },
      required: ["team_id", "username"],
    },
  },
  {
    name: "team_task_comment",
    riskHint: "write",
    description:
      `${SHARED_HEAD}在任务下留一句话（追加，不覆盖别人写过的）：问口径、补约束、回复对方的疑问。` +
      "消息进任务讨论，对方的智能体下一轮在「团队任务」里能看到；说不清的需求不要靠猜，写在这里问。" +
      "写操作，执行前会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        task_id: str("任务 id（从 team_get / team_task_find 的 tasks 里拿）。"),
        text: str("要说的一句话（最多 2000 字）：说清在问什么、或补充什么约束。"),
      },
      required: ["team_id", "task_id", "text"],
    },
  },
  {
    name: "team_plan_add",
    riskHint: "write",
    description:
      `${SHARED_HEAD}给团队新增一条方案项（团队的「怎么做」）。写操作，执行前会请用户确认。`,
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        title: str("方案标题（必填，最多 120 字）。"),
        detail: str("方案说明（可选，最多 2000 字）。"),
        orderIndex: {
          type: "number",
          description: "排序值（可选，0–9999，小的在前）。",
        },
      },
      required: ["team_id", "title"],
    },
  },
  {
    name: "team_plan_update",
    riskHint: "write",
    description:
      `${SHARED_HEAD}更新一条方案项：标题 / 说明 / 状态 / 排序（至少给一项）。` +
      "写操作，执行前会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可）。"),
        plan_id: str("方案 id（plan_id 或 planId 均可；从 team_get 的 plans 里获取）。"),
        title: str("新标题（可选）。"),
        detail: str("新说明（可选）。"),
        status: STATUS_ENUM,
        orderIndex: {
          type: "number",
          description: "新的排序值（可选，0–9999）。",
        },
      },
      required: ["team_id", "plan_id"],
    },
  },
  {
    name: "team_task_add",
    riskHint: "write",
    description:
      `${SHARED_HEAD}给团队派一条任务：可挂到方案下（planId）、指派给成员` +
      "（assigneeId 必须是团队成员，可先用 team_get 查 members）、设置截止时间（dueAt，ISO 时间）。" +
      "只有组长能把任务派给别人（成员只能给自己派活或留空等认领）；派给谁，谁的智能体下一轮就会在「团队任务」里看到。" +
      "轻重缓急用 priority 标（low / normal / high，不填 = normal）：真正要插队的活标 high，别把什么都标高。" +
      "一个方案要拆成几步（2–8 件）时，用 tasks 一次派完，别一件一件调 team_task_add：每件都要有 title，可选 detail / assigneeId / dueAt / priority。" +
      "写操作，执行前会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        title: str("任务标题（必填，最多 120 字）。"),
        detail: str("任务说明（可选，最多 2000 字）。"),
        assigneeId: str(
          "指给谁做：团队成员的 userId（assigneeId 或 assignee_id 均可；必须是成员；不传 = 待认领；派给别人需要你是组长）。",
        ),
        planId: str("归属哪条方案（planId 或 plan_id 均可；不传 = 独立任务）。"),
        dueAt: str(
          "截止时间（dueAt 或 due_at 均可；ISO/UTC，例如 2026-11-10T18:00:00.000Z；不传 = 没定）。",
        ),
        attachmentFileId: str(
          "交付物文件 id（attachmentFileId 或 attachment_file_id 均可；来自共享文件库，可选）。",
        ),
        priority: str("优先级（可选）：low / normal / high；不填 = normal。真要抢时间的活才标 high。"),
        tasks: objs(
          "一次派多件时用（可选，最多 8 条）：每项 { title 必填, detail?, assigneeId?, dueAt?, priority? }。给了 tasks 就不要再给 title。",
          {
            title: str("这一件要做什么（必填，最多 120 字）。"),
            detail: str("任务说明（可选，最多 2000 字）。"),
            assigneeId: str("指给谁做（可选）：成员 userId；不传 = 待认领。"),
            dueAt: str("截止时间（可选）：ISO/UTC。"),
            priority: str("优先级（可选）：low / normal / high。"),
          },
        ),
      },
      required: ["team_id"],
    },
  },
  {
    name: "team_task_update",
    riskHint: "write",
    description:
      `${SHARED_HEAD}更新一条任务：状态 / 负责人 / 标题 / 说明 / 截止时间 / 交付物文件 id / 交付结论` +
      "（attachmentFileId 来自共享文件库）。负责人必须是团队成员。" +
      "改派给别人需要组长身份（成员只能改状态，或把任务改回待认领）；接手的队友智能体下一轮会看到这条任务。" +
      "做不了就退回：把 assigneeId 传空串，并在 return_note 里写一句为什么（权限不够 / 信息不足 / 不归你），" +
      "任务会回到「待认领」，组长在任务板上看到是谁退的、为什么——不要让它挂着不动。" +

      "任务级权限：成员只能改「自己名下」或「还没人认领」的任务，别人的任务会被拒绝——需要的话请让组长改派或调整，不要反复重试。" +
      "优先级可用 priority 调（low / normal / high）：情况变了就改，别让高优先级一直挂着。" +
      "做到一半就用 progress 留一句当前进展（做到哪、卡在哪）——它和 result（完成时的交付结论）不是一回事：" +
      "进展是给下一轮的你和组长看的，别拿它当结论。" +
      "标成 done 时必须一起给 result：写一句结论（做成什么样、怎么验证的），组长和其他人只看到状态，看不到你的过程；" +
      "不要拿 result 覆盖 detail（detail 是需求，result 是交付）。写操作，执行前会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可）。"),
        task_id: str("任务 id（task_id 或 taskId 均可；从 team_get 的 tasks 里获取）。"),
        title: str("新标题（可选）。"),
        detail: str("新说明（可选）。"),
        status: STATUS_ENUM,
        assigneeId: str(
          "新的负责人 userId（assigneeId 或 assignee_id 均可；必须是团队成员；空串 = 改为待认领）。",
        ),
        planId: str("改挂到哪条方案（planId 或 plan_id 均可；空串 = 独立任务）。"),
        dueAt: str("新的截止时间（dueAt 或 due_at 均可；ISO；空串 = 没定）。"),
        attachmentFileId: str(
          "交付物文件 id（attachmentFileId 或 attachment_file_id 均可；空串 = 清除交付物）。",
        ),
        result: str(
          "交付结论（标 done 时必填）：做成什么样、怎么验证的；≤2000 字。改回未完成时这条结论会作废。",
        ),
        progress: str(
          "最新进展（可选）：做到哪、卡在哪、下一步是什么；≤500 字；空串 = 清掉。与 result（交付结论）分开。",
        ),
        returnNote: str(
          "退回原因（assigneeId 传空串时用）：为什么做不了，≤500 字。组长会在任务板上看到这条原因。",
        ),
        priority: str("新优先级（可选）：low / normal / high。"),
      },
      required: ["team_id", "task_id"],
    },
  },
];

/* ------------------------------------------------------------------ 参数与格式化 */

/** snake_case ↔ camelCase：schema 里 id 用 snake、业务字段用 camel，两种写法都要认。 */
function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
function toCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** 解析模型给的 JSON 参数：解析不了要报错，不能默默当成 {}（否则模型以为传了、其实没传）。 */
function parseArgs(raw: string): { args: Record<string, unknown> } | { error: string } {
  const text = (raw ?? "").trim();
  if (!text) return { args: {} };
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      return { error: `参数必须是 JSON 对象（收到 ${typeof v}），例如 {"team_id":"t1"}。` };
    }
    return { args: v as Record<string, unknown> };
  } catch {
    return { error: `参数不是合法 JSON，无法执行：${text.slice(0, 120)}` };
  }
}

/** 工具可用参数的说明文案（报错时教模型怎么改）。 */
function allowedParamsText(spec: Pick<TeamToolSpec, "parameters">): string {
  const declared = Object.keys(
    (spec.parameters as { properties?: Record<string, unknown> }).properties ?? {},
  );
  return declared
    .map((key) => {
      const canonical = toCamel(key);
      return canonical === key ? key : `${key}（或 ${canonical}）`;
    })
    .join(" / ");
}

/**
 * 参数归一化（B3）：把 snake_case / camelCase 别名统一成内部 camelCase 规范键，
 * 并且**显式拒绝不认识的键**。
 *
 * 为什么必须拒绝：服务端 zod 对未知键是静默 strip 的，工具以前也跟着静默忽略——
 * 模型把 plan_id 传给 team_task_add 时，任务照建却不挂方案，还回「已创建」，
 * 用户看到的是「说做了其实没做」。宁可报错让模型改名重试。
 */
export function normalizeTeamArgs(
  spec: Pick<TeamToolSpec, "name" | "parameters">,
  raw: Record<string, unknown>,
): { args: Record<string, unknown> } | { error: string } {
  const declared = Object.keys(
    (spec.parameters as { properties?: Record<string, unknown> }).properties ?? {},
  );
  const canonicalOf = new Map<string, string>();
  for (const key of declared) {
    const canonical = toCamel(key);
    canonicalOf.set(key, canonical);
    canonicalOf.set(toSnake(key), canonical);
    canonicalOf.set(toCamel(key), canonical);
  }
  const keys = Object.keys(raw);
  if (declared.length === 0) {
    if (keys.length === 0) return { args: {} };
    return { error: `${spec.name} 不接受任何参数（收到：${keys.join("、")}）。` };
  }
  const allowed = allowedParamsText(spec);
  const out: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const canonical = canonicalOf.get(key);
    if (!canonical) {
      unknown.push(key);
      continue;
    }
    if (canonical in out) {
      return {
        error: `参数重复：「${key}」和另一种写法指向同一项（${canonical}），只给一个即可。`,
      };
    }
    out[canonical] = value;
  }
  if (unknown.length > 0) {
    return {
      error:
        `不认识的参数：${unknown.join("、")}。${spec.name} 可用参数：${allowed}` +
        "（snake_case / camelCase 等价）。",
    };
  }
  return { args: out };
}

/**
 * 把截止时间规范成 ISO 串；非法返回 `null`。空串表示「不设/清空」，原样返回 `""`。
 *
 * 接受：ISO 串、`YYYY-MM-DD`、10 位秒级时间戳、13 位毫秒时间戳（数字或数字串）。
 * 量级判断：`< 1e12` 视为秒，否则视为毫秒——覆盖 2001–2286 年，够用且不会把
 * 毫秒值再乘 1000 变成 5 万年后的日期。
 */
function normalizeDueAt(value: unknown): string | null {
  const toMs = (n: number): number => (n < 1e12 ? n * 1000 : n);
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "";
    if (text.length > 64) return null;
    const numeric = /^\d{10,13}$/.test(text);
    const ms = numeric ? toMs(Number(text)) : Date.parse(text);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return new Date(ms).toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return new Date(toMs(value)).toISOString();
  }
  return null;
}

/**
 * 参数类型校验与宽转（T2-04）。
 *
 * 为什么需要：`normalizeTeamArgs` 只统一键名、不管值类型，而 `argOptStr` / `argOptNum`
 * 遇到类型不符的值会静默返回 `undefined`——模型传 `dueAt: 1762776000000` 或
 * `orderIndex: "3"` 时字段凭空消失，任务照建、还回「已创建」。
 *
 * 规则（宁可报错让模型重试，也不猜）：
 * - string 字段收到 number / boolean → 报错（不做 `String()` 强转，避免 `123` 混进标题）；
 * - number 字段收到纯数字串 → 转数字；其它 → 报错；
 * - `dueAt` 额外接受 epoch 数字（秒/毫秒）→ 规范成 ISO；空串保留（= 清空）。
 *
 * 校验失败时调用方**不得发起任何请求**。
 */
export function validateTeamArgTypes(
  spec: Pick<TeamToolSpec, "name" | "parameters">,
  args: Record<string, unknown>,
): { args: Record<string, unknown> } | { error: string } {
  const props =
    (spec.parameters as { properties?: Record<string, { type?: string }> }).properties ?? {};
  // spec 里声明的键是 snake_case（team_id / order_index），而 args 已被 normalizeTeamArgs
  // 归一成 camelCase——先把声明键也归一再比对，否则永远查不到 type，校验会被整体跳过。
  const typeOf = new Map<string, string | undefined>();
  for (const [key, prop] of Object.entries(props)) typeOf.set(toCamel(key), prop?.type);
  const out: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (key === "dueAt") {
      const due = normalizeDueAt(value);
      if (due === null) {
        return {
          error:
            "截止时间格式不对：dueAt 要 ISO 时间（例如 2026-11-10T18:00:00.000Z）" +
            `或毫秒时间戳，收到 ${JSON.stringify(value)}。空串表示不设截止时间。`,
        };
      }
      out[key] = due;
      continue;
    }
    const type = typeOf.get(key);
    if (type === "string" && typeof value !== "string") {
      return {
        error:
          `参数类型不对：${key} 需要字符串（收到 ${typeof value}）。` +
          `${spec.name} 可用参数：${allowedParamsText(spec)}。`,
      };
    }
    if (type === "number") {
      if (typeof value === "number" && Number.isFinite(value)) continue;
      const text = typeof value === "string" ? value.trim() : "";
      if (/^-?\d+$/.test(text)) {
        out[key] = Number(text);
        continue;
      }
      return {
        error:
          `参数类型不对：${key} 需要数字（收到 ${typeof value}）。` +
          `${spec.name} 可用参数：${allowedParamsText(spec)}。`,
      };
    }
  }
  return { args: out };
}

/** 取字符串参数（trim 后）；非字符串/空串 → ""。 */
function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

/** 取可选字符串：undefined 与空串区分不开时按空串处理（调用方决定是否清空）。 */
function argOptStr(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === "string" ? String(args[key]).trim() : undefined;
}

/** 取布尔参数：接受 true/"true"/"1"/"yes"；其余（含没给）当 false。 */
function argBool(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  if (v === true) return true;
  if (typeof v === "string") {
    const text = v.trim().toLowerCase();
    return text === "true" || text === "1" || text === "yes";
  }
  return false;
}

/** 取对象数组参数（d.270）：非数组或元素不是对象的，直接丢弃那一个。 */
function argObjArray(args: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const v = args[key];
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item));
}

function argOptNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.trunc(v);
}

const STATUS_LABEL: Record<string, string> = {
  todo: "待办",
  doing: "进行中",
  done: "已完成",
  blocked: "受阻",
};
const STATUS_SET = new Set(Object.keys(STATUS_LABEL));

/**
 * 优先级（d.268）：只有三档，不给任意数字——数量一多就没法一眼看出轻重，
 * 而模型又必须能把它稳定地搬进工具参数与快照文本里。
 */
const PRIORITY_LABEL: Record<string, string> = { low: "低", normal: "普通", high: "高" };

/** 一次最多派几件（d.270）：再多就该拆成两次，否则参数一长模型容易漏字段。 */
const TEAM_TASK_BATCH_MAX = 8;

/** 讨论一次最多展开几条 / 单条最多展开多少字（d.271）：留言是补充信息，不该挤掉任务本身。 */
const COMMENT_TEXT_MAX = 10;
const COMMENT_CLIP = 200;
const PRIORITY_SET = new Set(Object.keys(PRIORITY_LABEL));

/** 成员角色：owner 叫「队长」，避免和任务的「负责人」撞词。 */
const ROLE_LABEL: Record<string, string> = { owner: "队长", member: "成员" };

/**
 * 快照里单条「说明」最多显示多少字。
 *
 * schema 允许每条 detail 2000 字；几十条任务就足以撞上 `truncateToolResult` 的
 * 8000 字符上限（中间被整段省略），模型会以为「没有这条任务」。所以列表视图只给摘要，
 * 完整说明留给用户到团队页看。
 */
const SNAPSHOT_DETAIL_MAX = 200;
/** 快照最多列多少条任务：超出部分用明确提示代替（而不是让截断悄悄发生）。 */
const SNAPSHOT_TASK_MAX = 20;

/** 单行说明截断：压成一行、超长加省略号，模型仍知道「还有内容没显示」。 */
function clipDetail(text: string): string {
  const flat = text.trim().replace(/\s*\r?\n\s*/g, " ");
  return flat.length > SNAPSHOT_DETAIL_MAX ? `${flat.slice(0, SNAPSHOT_DETAIL_MAX)}…` : flat;
}

/** 讨论时间：本地「MM-DD HH:mm」，面板与工具结果同一套写法。 */
function commentTime(iso: string): string {
  return fmtLocalDateTime(iso).slice(5, 16);
}

/**
 * 把一条任务下的讨论排成人话（d.271）。
 *
 * 最近 10 条、每条最多 200 字：留言多的时候优先给最新的，老的不占模型的上下文。
 */
function describeTaskComments(
  task: TeamTask | null,
  comments: TeamTaskComment[],
  members: TeamWorkspaceSnapshot["members"],
): string {
  const head = task === null ? "任务讨论" : `「${task.title}」的讨论`;
  if (comments.length === 0) return `${head}：还没有留言。有疑问就留一句，对方的智能体下一轮能看到。`;
  const shown = comments.slice(-COMMENT_TEXT_MAX);
  const lines = shown.map((comment) => {
    const name =
      members.find((m) => m.user.id === comment.authorId)?.user.displayName ?? comment.authorId;
    const text = comment.text.length > COMMENT_CLIP ? `${comment.text.slice(0, COMMENT_CLIP)}…` : comment.text;
    return `- ${name}（${commentTime(comment.createdAt)}）：${text}`;
  });
  const more = comments.length > shown.length ? `\n（还有 ${comments.length - shown.length} 条更早的没展开）` : "";
  return `${head}（共 ${comments.length} 条）：\n${lines.join("\n")}${more}`;
}

const EVENT_CLIP = 160;
const EVENT_KIND_LABEL: Record<TeamEvent["kind"], string> = {
  task_added: "派活",
  task_updated: "改动",
  task_removed: "删任务",
  task_comment: "留言",
  plan_added: "新方案",
  plan_updated: "改方案",
  plan_removed: "删方案",
  member_added: "加人",
  member_removed: "移人",
  owner_transferred: "换队长",
};

/**
 * 把团队动态排成人话（d.273）。
 *
 * 只给最近若干条、每条截断：动态可能很长，而模型要的是「刚刚发生了什么」，
 * 不是完整审计日志（审计请去服务端库）。
 */
function describeTeamEvents(
  events: TeamEvent[],
  members: TeamWorkspaceSnapshot["members"],
): string {
  if (events.length === 0) {
    return "团队动态：还没有记录。派活、改状态、催办、验收、留言、改方案、加人/移人都会记一条。";
  }
  const lines = events.map((event) => {
    const name = members.find((m) => m.user.id === event.actorId)?.user.displayName ?? event.actorId;
    const text = event.summary.length > EVENT_CLIP ? `${event.summary.slice(0, EVENT_CLIP)}…` : event.summary;
    return `- ${commentTime(event.createdAt)} · ${name}【${EVENT_KIND_LABEL[event.kind]}】${text}`;
  });
  return `团队动态（最近 ${events.length} 条，新的在前）：\n${lines.join("\n")}`;
}

/** 单件任务的历史（d.276）：只回这一条活的流水。 */
function describeTaskHistory(
  taskTitle: string,
  events: TeamEvent[],
  members: TeamWorkspaceSnapshot["members"],
): string {
  if (events.length === 0) {
    return `「${taskTitle}」还没有历史：派活、改状态、催办、验收、留言都会记一条。`;
  }
  const lines = events.map((event) => {
    const name = members.find((m) => m.user.id === event.actorId)?.user.displayName ?? event.actorId;
    const text = event.summary.length > EVENT_CLIP ? `${event.summary.slice(0, EVENT_CLIP)}…` : event.summary;
    return `- ${commentTime(event.createdAt)} · ${name}【${EVENT_KIND_LABEL[event.kind]}】${text}`;
  });
  return `「${taskTitle}」的历史（最近 ${events.length} 条，新的在前）：\n${lines.join("\n")}`;
}

/** 把快照压成模型可读的文本：带 id（后续工具要用）、按方案/任务/成员分组。 */
export function formatTeamSnapshot(s: TeamWorkspaceSnapshot): string {
  const { team, members, plans, tasks } = s;
  const nameOf = (userId: string | null): string => {
    if (!userId) return "待认领";
    const m = members.find((x) => x.user.id === userId);
    return m ? `${m.user.displayName}（${m.user.username}）` : userId;
  };
  const lines: string[] = [];
  /*
   * 成员负载（d.264）：派活前先看清「谁手上还有活」。
   * 只数未完成的（已完成不构成压力），逾期单独说；口径与团队简报（d.256）一致。
   */
  const loads = memberLoads(tasks, Date.now());
  lines.push(`团队：${team.name}（teamId：${team.id}）`);
  if (team.goal.trim()) lines.push(`目标：${team.goal.trim()}`);
  else lines.push("目标：（还没写）");
  lines.push("");
  lines.push(`成员（${members.length}）：`);
  if (members.length === 0) lines.push("- （空）");
  members.forEach((m, i) => {
    lines.push(
      `- ${i + 1}. ${m.user.displayName}（@${m.user.username}，userId：${m.user.id}）· ` +
        `${ROLE_LABEL[m.role] ?? m.role} · 手上${describeLoad(loadOf(loads, m.user.id))}`,
    );
  });
  lines.push("");
  lines.push(`方案（${plans.length}）：`);
  if (plans.length === 0) lines.push("- （还没有方案）");
  plans.forEach((p, i) => {
    lines.push(`- ${i + 1}. [planId：${p.id}] ${p.title} · ${STATUS_LABEL[p.status] ?? p.status}`);
    if (p.detail.trim()) lines.push(`  说明：${clipDetail(p.detail)}`);
  });
  lines.push("");
  lines.push(`任务（${tasks.length}）：`);
  if (tasks.length === 0) lines.push("- （还没有任务）");
  // T2-05：只列前 N 条，超出部分明确提示（整个快照还要受 bridge 的 8000 字符上限约束）。
  tasks.slice(0, SNAPSHOT_TASK_MAX).forEach((t, i) => {
    const bits = [`[taskId：${t.id}] ${t.title} · ${STATUS_LABEL[t.status] ?? t.status}`];
    bits.push(`负责人：${nameOf(t.assigneeId)}`);
    if (t.planId) bits.push(`方案：${t.planId}`);
    // 截止时间给本地可读格式（快照以前直接打 UTC ISO，用户和模型都要自己换算时区）。
    if (t.dueAt) bits.push(`截止：${fmtLocalDateTime(t.dueAt) || t.dueAt}`);
    if (t.attachmentFileId) bits.push(`交付物：${t.attachmentFileId}`);
    lines.push(`- ${i + 1}. ${bits.join(" · ")}`);
    if (t.detail.trim()) lines.push(`  说明：${clipDetail(t.detail)}`);
  });
  if (tasks.length > SNAPSHOT_TASK_MAX) {
    lines.push(
      `- （另有 ${tasks.length - SNAPSHOT_TASK_MAX} 条任务未显示：全列出来会被工具结果长度上限截断。` +
        "要看具体某条请到团队页的任务看板，或先按方案缩小范围再问。）",
    );
  }
  lines.push("");
  lines.push("（上面 teamId / planId / taskId 可直接当参数回传：写 teamId 或 team_id 都可以。）");
  return lines.join("\n");
}

/**
 * 派活之后的一句话：这个人手上现在有多少活（d.264）。
 *
 * 派活是不可逆的分配动作：模型通常只看「谁合适」，不看「谁还有空」。
 * 把负载摆在工具结果里（而不是另起一轮提示词），它下一次派活时才知道要分散。
 */
function assigneeLoadNote(snap: TeamWorkspaceSnapshot, assigneeId: string | null): string {
  const member = snap.members.find((m) => m.user.id === assigneeId);
  const name =
    member === undefined ? "对方" : `${member.user.displayName}（@${member.user.username}）`;
  return describeAssigneeLoad(name, loadOf(memberLoads(snap.tasks, Date.now()), assigneeId));
}

function formatPlan(plan: TeamPlanItem): string {
  return `已新增方案项「${plan.title}」（planId：${plan.id}，状态：${
    STATUS_LABEL[plan.status] ?? plan.status
  }）。`;
}

const REVIEW_LABEL: Record<string, string> = {
  pending: "待验收",
  approved: "已验收",
  changes: "打回重做",
};

/** 验收状态只在「已完成」的任务上才有意义；老任务缺省 pending。 */
function reviewSuffix(task: TeamTask): string {
  if (task.status !== "done") return "";
  const state = task.reviewState ?? "pending";
  const label = REVIEW_LABEL[state] ?? state;
  const note = (task.reviewNote ?? "").trim();
  return note === "" ? `，验收：${label}` : `，验收：${label}（${note}）`;
}

function formatTask(task: TeamTask, members: TeamWorkspaceSnapshot["members"]): string {
  const assignee = task.assigneeId
    ? (members.find((m) => m.user.id === task.assigneeId)?.user.displayName ?? task.assigneeId)
    : "待认领";
  return (
    `已创建任务「${task.title}」（taskId：${task.id}，状态：${
      STATUS_LABEL[task.status] ?? task.status
    }，优先级：${PRIORITY_LABEL[task.priority ?? "normal"] ?? "普通"}，负责人：${assignee}${reviewSuffix(task)}）。`
  );
}

/** 失败统一文案：服务端中文错误原样透出，不吞成 "http 500"。 */
function failText(prefix: string, e: unknown): string {
  const msg = e instanceof Error && e.message ? e.message : String(e);
  return `${prefix}：${msg}`;
}

/**
 * 中断/超时不能按「团队操作失败」报：用户主动点中断是正常操作，
 * 超时则要让模型知道可以重试（而不是以为服务端拒绝了）。
 */
function interruptText(e: unknown): string | null {
  if (isApiAbort(e)) {
    return "用户已中断，团队操作已取消；若刚提交的内容可能已在服务端生效，可再用 team_get 核对。";
  }
  if (isApiTimeout(e)) return failText("团队操作超时", e);
  return null;
}

/** 写操作的统一收口：成功返回文本，失败把中文错误交给模型。 */
async function write(op: () => Promise<string>): Promise<{ text: string; ok: boolean }> {
  try {
    return { text: await op(), ok: true };
  } catch (e) {
    const interrupted = interruptText(e);
    if (interrupted) return { text: interrupted, ok: false };
    return { text: failText("团队操作失败", e), ok: false };
  }
}

/** 按 username（不区分大小写、允许带 @）在快照里找人；找不到返回 null。 */
function findMemberByUsername(
  snap: TeamWorkspaceSnapshot,
  username: string,
): TeamWorkspaceSnapshot["members"][number] | null {
  const wanted = username.trim().replace(/^@/, "").toLowerCase();
  if (!wanted) return null;
  return snap.members.find((m) => m.user.username.toLowerCase() === wanted) ?? null;
}

/** 成员名单一行文本（给模型看「现在都有谁」）；空团队写「（空）」。 */
function memberListText(snap: TeamWorkspaceSnapshot): string {
  if (snap.members.length === 0) return "（空）";
  return snap.members.map((m) => `${m.user.displayName}（@${m.user.username}）`).join("、");
}

/** 按 teamId 或 name 解析团队；两者都没给/找不到时给出下一步指引。 */
async function resolveTeamId(
  args: Record<string, unknown>,
  request: ApiRequestOptions,
): Promise<{ id: string } | { error: string }> {
  const id = argStr(args, "teamId");
  if (id) return { id };
  const name = argStr(args, "name");
  if (!name) {
    return {
      error:
        "请提供 team_id（或 teamId）；不知道 id 就先调用 team_list（也可以用 name 精确匹配）。",
    };
  }
  try {
    const list = await fetchWorkspaceTeams(request);
    const exact = list.teams.filter((t) => t.name === name);
    const hit = exact.length ? exact : list.teams.filter((t) => t.name.toLowerCase() === name.toLowerCase());
    if (hit.length === 1) return { id: hit[0].id };
    if (hit.length > 1) {
      return {
        error: `有 ${hit.length} 个团队都叫「${name}」，请改用 teamId：${hit
          .map((t) => t.id)
          .join("、")}`,
      };
    }
    return { error: `没有找到名为「${name}」的团队；可先调用 team_list 查看全部团队。` };
  } catch (e) {
    const interrupted = interruptText(e);
    if (interrupted) return { error: interrupted };
    return { error: failText("读取团队列表失败", e) };
  }
}

/* ------------------------------------------------------------------ 工具桥 */

/** 把团队工具桥起来：tools 声明 + meta 风险 + execute 分发。 */
export function buildTeamToolBridge(): ToolBridge {
  return {
    tools: TEAM_TOOLS.map((spec) => ({
      type: "function" as const,
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    })),
    meta: (name) => {
      const spec = TEAM_TOOLS.find((s) => s.name === name);
      return spec ? { risk: spec.riskHint } : undefined;
    },
    execute: async (call, opts) => {
      if (opts?.signal?.aborted) return { text: "用户已中断，团队操作未执行。", ok: false };
      const spec = TEAM_TOOLS.find((s) => s.name === call.name);
      if (!spec) return { text: `未知工具 ${call.name}`, ok: false };
      const parsed = parseArgs(call.arguments);
      if ("error" in parsed) return { text: parsed.error, ok: false };
      const normalized = normalizeTeamArgs(spec, parsed.args);
      if ("error" in normalized) return { text: normalized.error, ok: false };
      // T2-04：类型不符要报错（并在此处拒绝，绝不带着「消失的字段」去建记录）。
      const typed = validateTeamArgTypes(spec, normalized.args);
      if ("error" in typed) return { text: typed.error, ok: false };
      const args = typed.args;
      // B4：中断信号一路透传到 fetch（用户点中断后，在途请求真的收手），并给每次请求兜 15s 超时。
      const request = requestOf(opts?.signal);
      try {
        switch (call.name) {
          case "team_list": {
            const list = await fetchWorkspaceTeams(request);
            if (list.teams.length === 0) {
              return {
                text: "你还没有任何团队工作台。需要的话先调用 team_create 建一个（写操作，会请用户确认）。",
                ok: true,
              };
            }
            // 列表接口只包含团队本体；成员数/任务数按快照补（失败则标「未知」，不阻断列表）。
            const snaps = await Promise.all(
              list.teams.map((t) => fetchWorkspaceTeam(t.id, request).catch(() => null)),
            );
            const lines = [`我的团队（${list.teams.length}）：`];
            list.teams.forEach((t, i) => {
              const snap = snaps[i];
              const counts = snap
                ? `成员 ${snap.members.length} 人 · 任务 ${snap.tasks.length} 个`
                : "成员/任务数未知";
              lines.push(
                `- ${i + 1}. ${t.name}（teamId：${t.id}）· ${counts} · 目标：${
                  t.goal.trim() || "（未填写）"
                }`,
              );
            });
            lines.push("要细节用 team_get（传 team_id），要派活先看 team_get 的 members/plans。");
            return { text: lines.join("\n"), ok: true };
          }
          case "team_get": {
            const resolved = await resolveTeamId(args, request);
            if ("error" in resolved) return { text: resolved.error, ok: false };
            const snap = await fetchWorkspaceTeam(resolved.id, request);
            const sources: ToolSource[] = [{ id: snap.team.id, title: `团队：${snap.team.name}` }];
            return { text: formatTeamSnapshot(snap), ok: true, sources };
          }
          case "team_task_find": {
            const resolved = await resolveTeamId(args, request);
            if ("error" in resolved) return { text: resolved.error, ok: false };
            const snap = await fetchWorkspaceTeam(resolved.id, request);
            const statusText = argStr(args, "status").toLowerCase();
            const status =
              statusText === "done" || statusText === "all" ? statusText : ("open" as const);
            const assigneeText = argStr(args, "assignee");
            let assigneeId: string | null | undefined;
            if (assigneeText) {
              const wanted = assigneeText.replace(/^@/, "").toLowerCase();
              const member = snap.members.find(
                (m) =>
                  m.user.username.toLowerCase() === wanted ||
                  m.user.displayName.toLowerCase() === wanted,
              );
              if (!member) {
                return {
                  text: `团队里没有叫「${assigneeText}」的成员。当前成员：${memberListText(snap)}。`,
                  ok: false,
                };
              }
              assigneeId = member.user.id;
            }
            const limitText = argStr(args, "limit");
            const limit = limitText === "" ? FIND_TASK_LIMIT_DEFAULT : Number(limitText);
            if (!Number.isFinite(limit) || limit < 1) {
              return { text: `limit 要给数字（1–${FIND_TASK_LIMIT_MAX}）。`, ok: false };
            }
            const result = findTeamTasks({
              tasks: snap.tasks,
              ...(argStr(args, "query") ? { query: argStr(args, "query") } : {}),
              ...(assigneeId !== undefined ? { assigneeId } : {}),
              status,
              overdue: argBool(args, "overdue"),
              limit,
            });
            const nameOf = (id: string) =>
              snap.members.find((m) => m.user.id === id)?.user.displayName ?? id;
            return {
              text: describeFindResult(result, {
                query: argStr(args, "query"),
                memberName: nameOf,
                limit: FIND_TASK_LIMIT_MAX,
              }),
              ok: true,
              sources: [{ id: snap.team.id, title: `团队：${snap.team.name}` }],
            };
          }
          case "team_task_comments": {
            const teamId = argStr(args, "teamId");
            const taskId = argStr(args, "taskId");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            if (!taskId) return { text: "task_id 不能为空：先从 team_get 的 tasks 里拿。", ok: false };
            const snapshot = await fetchWorkspaceTeam(teamId, request);
            const task = snapshot.tasks.find((item) => item.id === taskId);
            if (!task) {
              return { text: `这个团队里没有任务 ${taskId}（用 team_get 看完整清单）。`, ok: false };
            }
            const list = await fetchTeamTaskComments(teamId, taskId, request);
            return { text: describeTaskComments(task, list.comments, snapshot.members), ok: true };
          }

          case "team_events": {
            const resolved = await resolveTeamId(args, request);
            if ("error" in resolved) return { text: resolved.error, ok: false };
            const limitText = argStr(args, "limit");
            const limit = limitText === "" ? 20 : Number(limitText);
            if (!Number.isFinite(limit) || limit < 1 || limit > 50) {
              return { text: "limit 要给 1–50 之间的数字。", ok: false };
            }
            const snap = await fetchWorkspaceTeam(resolved.id, request);
            const data = await fetchTeamEvents(resolved.id, request, Math.trunc(limit));
            return {
              text: describeTeamEvents(data.events, snap.members),
              ok: true,
              sources: [{ id: snap.team.id, title: `团队：${snap.team.name}` }],
            };
          }
          case "team_task_history": {
            const resolved = await resolveTeamId(args, request);
            if ("error" in resolved) return { text: resolved.error, ok: false };
            const taskId = argStr(args, "taskId");
            if (taskId === "") return { text: "要给 task_id（从 team_get 的 tasks 里拿）。", ok: false };
            const limitText = argStr(args, "limit");
            const limit = limitText === "" ? 20 : Number(limitText);
            if (!Number.isFinite(limit) || limit < 1 || limit > 50) {
              return { text: "limit 要给 1–50 之间的数字。", ok: false };
            }
            const snap = await fetchWorkspaceTeam(resolved.id, request);
            const task = snap.tasks.find((t) => t.id === taskId);
            if (!task) {
              return { text: `这个团队里没有任务 ${taskId}（用 team_get 看完整清单）。`, ok: false };
            }
            const data = await fetchTeamEvents(resolved.id, request, Math.trunc(limit), taskId);
            return {
              text: describeTaskHistory(task.title, data.events, snap.members),
              ok: true,
              sources: [{ id: task.id, title: `任务：${task.title}` }],
            };
          }
          case "team_digest": {
            const resolved = await resolveTeamId(args, request);
            if ("error" in resolved) return { text: resolved.error, ok: false };
            const snap = await fetchWorkspaceTeam(resolved.id, request);
            const daysText = argStr(args, "days");
            const days = daysText === "" ? DIGEST_DEFAULT_DAYS : Number(daysText);
            if (!Number.isFinite(days) || days < 1 || days > DIGEST_MAX_DAYS) {
              return { text: `days 要给 1–${DIGEST_MAX_DAYS} 之间的数字。`, ok: false };
            }
            const nameOf = (id: string) => {
              const member = snap.members.find((m) => m.user.id === id);
              return member ? `${member.user.displayName}（@${member.user.username}）` : id;
            };
            return {
              text: buildTeamDigest(snap, { days, memberName: nameOf }),
              ok: true,
              sources: [{ id: snap.team.id, title: `团队：${snap.team.name}` }],
            };
          }
          case "team_create": {
            const name = argStr(args, "name");
            if (!name) return { text: "name 不能为空：请给团队起个名字（最多 40 字）。", ok: false };
            const goal = argOptStr(args, "goal");
            return write(async () => {
              const snap = await createWorkspaceTeam({ name, ...(goal ? { goal } : {}) }, request);
              return `已创建团队「${snap.team.name}」（teamId：${snap.team.id}），目标：${
                snap.team.goal.trim() || "（还没写）"
              }。下一步：team_plan_add 写方案、team_task_add 派任务、team_member_add 拉人（都会请用户确认）。`;
            });
          }
          case "team_update": {
            const teamId = argStr(args, "teamId");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            const name = argOptStr(args, "name");
            const goal = argOptStr(args, "goal");
            if (name === undefined && goal === undefined) {
              return { text: "没有要修改的字段：至少提供 name 或 goal 之一。", ok: false };
            }
            return write(async () => {
              const snap = await updateWorkspaceTeam(
                teamId,
                {
                  ...(name !== undefined ? { name } : {}),
                  ...(goal !== undefined ? { goal } : {}),
                },
                request,
              );
              return `已更新团队「${snap.team.name}」：目标=${
                snap.team.goal.trim() || "（未填写）"
              }。`;
            });
          }
          case "team_member_add": {
            const teamId = argStr(args, "teamId");
            const username = argStr(args, "username");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            if (!username) return { text: "username 不能为空（用用户名，不是显示名）。", ok: false };
            return write(async () => {
              const snap = await addWorkspaceMember(teamId, username, request);
              const names = snap.members.map((m) => `${m.user.displayName}（@${m.user.username}）`);
              return `已把 @${username} 加入团队「${snap.team.name}」。当前成员 ${snap.members.length} 人：${names.join("、")}。`;
            });
          }
          case "team_task_nudge": {
            const resolved = await resolveTeamId(args, request);
            if ("error" in resolved) return { text: resolved.error, ok: false };
            const taskId = argStr(args, "taskId");
            if (!taskId) return { text: "task_id 不能为空（用 team_get 看任务 id）。", ok: false };
            const snap = await fetchWorkspaceTeam(resolved.id, request);
            const target = snap.tasks.find((t) => t.id === taskId);
            if (!target) return { text: `这个团队里没有任务 ${taskId}（用 team_get 看完整清单）。`, ok: false };
            return write(async () => {
              const after = await updateTeamTask(resolved.id, taskId, { nudge: true }, request);
              const times = after.nudgeCount ?? 1;
              return `已催办「${after.title}」：这是第 ${times} 次。对方和它的智能体下一轮会看到这条提醒；任务板上也会显示「谁催的、什么时候」。`;
            });
          }
          case "team_task_review": {
            const resolved = await resolveTeamId(args, request);
            if ("error" in resolved) return { text: resolved.error, ok: false };
            const taskId = argStr(args, "taskId");
            if (!taskId) return { text: "task_id 不能为空（用 team_get 看任务 id）。", ok: false };
            const verdict = argStr(args, "verdict");
            if (verdict !== "approve" && verdict !== "changes") {
              return { text: "verdict 只能是 approve（通过）或 changes（打回重做）。", ok: false };
            }
            const note = argStr(args, "note");
            if (verdict === "changes" && (!note || note.trim() === "")) {
              return { text: "打回重做要写一句原因（note），让做的人知道要改什么。", ok: false };
            }
            return write(async () => {
              const after = await updateTeamTask(
                resolved.id,
                taskId,
                { review: verdict, ...(note ? { reviewNote: note } : {}) },
                request,
              );
              if (verdict === "approve") {
                return `已验收通过「${after.title}」${note ? `：${note}` : "。"}任务保持已完成。`;
              }
              return `已把「${after.title}」打回重做：${after.reviewNote ?? note ?? ""}。任务状态已回到「进行中」，上一版结论还留着；对方下一轮会看到这条意见。`;
            });
          }
          case "team_member_remove": {
            const resolved = await resolveTeamId(args, request);
            if ("error" in resolved) return { text: resolved.error, ok: false };
            const username = argStr(args, "username");
            if (!username) return { text: "username 不能为空（用用户名，不是显示名）。", ok: false };
            const snap = await fetchWorkspaceTeam(resolved.id, request);
            const target = findMemberByUsername(snap, username);
            if (!target) {
              return {
                text: `团队里没有 @${username}。当前成员：${memberListText(snap)}。`,
                ok: false,
              };
            }
            if (snap.team.ownerId === target.user.id) {
              return {
                text: "不能把队长移出团队：要么先用 team_owner_transfer 把队长转给别人，要么解散团队。",
                ok: false,
              };
            }
            return write(async () => {
              const after = await removeWorkspaceMember(resolved.id, target.user.id, request);
              return `已把 ${target.user.displayName}（@${target.user.username}）移出团队「${after.team.name}」。当前成员 ${after.members.length} 人：${memberListText(after)}。`;
            });
          }
          case "team_owner_transfer": {
            const resolved = await resolveTeamId(args, request);
            if ("error" in resolved) return { text: resolved.error, ok: false };
            const username = argStr(args, "username");
            if (!username) return { text: "username 不能为空（用用户名，不是显示名）。", ok: false };
            const snap = await fetchWorkspaceTeam(resolved.id, request);
            const target = findMemberByUsername(snap, username);
            if (!target) {
              return {
                text: `团队里没有 @${username}。当前成员：${memberListText(snap)}。`,
                ok: false,
              };
            }
            if (snap.team.ownerId === target.user.id) {
              return { text: `@${username} 已经是队长了，不用转让。`, ok: false };
            }
            return write(async () => {
              const after = await transferWorkspaceTeamOwner(resolved.id, target.user.id, request);
              return `队长已转让给 ${target.user.displayName}（@${target.user.username}）。你现在是普通成员：还能看团队、认领任务，但不能再加人、派活或删除。`;
            });
          }
          case "team_task_comment": {
            const teamId = argStr(args, "teamId");
            const taskId = argStr(args, "taskId");
            const text = argStr(args, "text");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            if (!taskId) return { text: "task_id 不能为空：先从 team_get 的 tasks 里拿。", ok: false };
            if (!text) return { text: "要留的话不能为空：说清在问什么、或补充什么约束。", ok: false };
            return write(async () => {
              const comment = await createTeamTaskComment(teamId, taskId, text, request);
              const snapshot = await fetchWorkspaceTeam(teamId, request).catch(() => null);
              const task = snapshot?.tasks.find((item) => item.id === taskId);
              const line = snapshot === null
                ? ""
                : `\n${describeTaskComments(task ?? null, [comment], snapshot.members)}`;
              return `已在任务下留言（id：${comment.id}）。对方的智能体下一轮在「团队任务」里能看到；留言只能追加，谁也不能改别人写的话。` + line;
            });
          }

          case "team_plan_add": {
            const teamId = argStr(args, "teamId");
            const title = argStr(args, "title");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            if (!title) return { text: "title 不能为空：请给方案起个标题（最多 120 字）。", ok: false };
            const detail = argOptStr(args, "detail");
            const orderIndex = argOptNum(args, "orderIndex");
            return write(async () => {
              const plan = await createTeamPlan(
                teamId,
                {
                  title,
                  ...(detail ? { detail } : {}),
                  ...(orderIndex !== undefined ? { orderIndex } : {}),
                },
                request,
              );
              return formatPlan(plan);
            });
          }
          case "team_plan_update": {
            const teamId = argStr(args, "teamId");
            const planId = argStr(args, "planId");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            if (!planId) return { text: "plan_id 不能为空：先从 team_get 的 plans 里拿。", ok: false };
            const title = argOptStr(args, "title");
            const detail = argOptStr(args, "detail");
            const status = argStr(args, "status");
            const orderIndex = argOptNum(args, "orderIndex");
            if (status && !STATUS_SET.has(status)) {
              return {
                text: `status 不合法：只能是 ${[...STATUS_SET].join(" / ")}（收到「${status}」）。`,
                ok: false,
              };
            }
            if (
              title === undefined &&
              detail === undefined &&
              !status &&
              orderIndex === undefined
            ) {
              return {
                text: "没有要修改的字段：至少提供 title / detail / status / orderIndex 之一。",
                ok: false,
              };
            }
            return write(async () => {
              const plan = await updateTeamPlan(
                teamId,
                planId,
                {
                  ...(title !== undefined ? { title } : {}),
                  ...(detail !== undefined ? { detail } : {}),
                  ...(status ? { status: status as "todo" | "doing" | "done" | "blocked" } : {}),
                  ...(orderIndex !== undefined ? { orderIndex } : {}),
                },
                request,
              );
              return `已更新方案项「${plan.title}」（planId：${plan.id}，状态：${
                STATUS_LABEL[plan.status] ?? plan.status
              }）。`;
            });
          }
          case "team_task_add": {
            const teamId = argStr(args, "teamId");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            const title = argStr(args, "title");
            const batch = argObjArray(args, "tasks");
            const planId = argOptStr(args, "planId");
            const sharedAttachment = argOptStr(args, "attachmentFileId");
            if (batch.length > 0 && title) {
              return {
                text: "title 和 tasks 只能二选一：派一件就给 title，派多件就给 tasks（每件里写 title）。",
                ok: false,
              };
            }
            if (batch.length > TEAM_TASK_BATCH_MAX) {
              return {
                text: `一次最多派 ${TEAM_TASK_BATCH_MAX} 件；这次给了 ${batch.length} 件，请拆成两次派。`,
                ok: false,
              };
            }
            if (batch.length === 0 && !title) {
              return {
                text: "title 不能为空：请写清要做什么（最多 120 字）；要一次派多件就改用 tasks。",
                ok: false,
              };
            }
            const detail = argOptStr(args, "detail");
            const assigneeId = argOptStr(args, "assigneeId");
            const dueAt = argOptStr(args, "dueAt");
            const attachmentFileId = sharedAttachment;
            const priority = argStr(args, "priority");
            if (priority && !PRIORITY_SET.has(priority)) {
              return { text: "priority 不合法：只能是 low / normal / high。", ok: false };
            }
            // 多件模式（d.270）：逐件建，但一次调用、一份回执；失败的件如实点名，
            // 不因为中间一件失败就把前面已经建好的藏着不说。
            if (batch.length > 0) {
              const seen: string[] = [];
              const created: string[] = [];
              let failed = 0;
              return write(async () => {
                for (let index = 0; index < batch.length; index += 1) {
                  const item = batch[index]!;
                  const itemTitle = typeof item.title === "string" ? item.title.trim() : "";
                  if (itemTitle === "") {
                    failed += 1;
                    seen.push(`- 第 ${index + 1} 件：没有 title，跳过了`);
                    continue;
                  }
                  const itemPriority = typeof item.priority === "string" ? item.priority.trim() : "";
                  if (itemPriority !== "" && !PRIORITY_SET.has(itemPriority)) {
                    failed += 1;
                    seen.push(`- 第 ${index + 1} 件「${itemTitle}」：priority 不合法（只能是 low / normal / high）`);
                    continue;
                  }
                  try {
                    const task = await createTeamTask(
                      teamId,
                      {
                        title: itemTitle,
                        ...(typeof item.detail === "string" && item.detail.trim() !== ""
                          ? { detail: item.detail.trim() }
                          : {}),
                        ...(typeof item.assigneeId === "string" && item.assigneeId.trim() !== ""
                          ? { assigneeId: item.assigneeId.trim() }
                          : {}),
                        ...(planId ? { planId } : {}),
                        ...(typeof item.dueAt === "string" && item.dueAt.trim() !== ""
                          ? { dueAt: item.dueAt.trim() }
                          : {}),
                        ...(attachmentFileId ? { attachmentFileId } : {}),
                        ...(itemPriority
                          ? { priority: itemPriority as "low" | "normal" | "high" }
                          : {}),
                      },
                      request,
                    );
                    created.push(`- #${index + 1} ${task.title}（${task.id}）`);
                  } catch (error) {
                    failed += 1;
                    const reason = error instanceof Error ? error.message : "未知原因";
                    seen.push(`- 第 ${index + 1} 件「${itemTitle}」没建成：${reason}`);
                  }
                }
                if (created.length === 0) {
                  return `一件都没建成：\n${seen.join("\n")}`;
                }
                const head = failed === 0 ? `已派 ${created.length} 件任务：` : `派了 ${created.length} 件，另有 ${failed} 件没成：`;
                const lines = [head, ...created, ...seen];
                const snap = await fetchWorkspaceTeam(teamId, request).catch(() => null);
                if (snap !== null) {
                  const names = [
                    ...new Set(
                      batch
                        .map((item) => (typeof item.assigneeId === "string" ? item.assigneeId.trim() : ""))
                        .filter((value) => value !== ""),
                    ),
                  ];
                  for (const userId of names) lines.push(assigneeLoadNote(snap, userId));
                }
                return lines.join("\n");
              });
            }
            return write(async () => {
              const task = await createTeamTask(
                teamId,
                {
                  title,
                  ...(detail ? { detail } : {}),
                  ...(assigneeId ? { assigneeId } : {}),
                  ...(planId ? { planId } : {}),
                  ...(dueAt ? { dueAt } : {}),
                  ...(attachmentFileId ? { attachmentFileId } : {}),
                  ...(priority ? { priority: priority as "low" | "normal" | "high" } : {}),
                },
                request,
              );
              // 指派了人时顺带确认它确实是成员，便于模型下一步引用。
              if (!task.assigneeId) return formatTask(task, []);
              const snap = await fetchWorkspaceTeam(teamId, request).catch(() => null);
              const base = formatTask(task, snap?.members ?? []);
              // d.264：把「这个人手上现在有多少活」摆在派活结果里，下一次派活才知道要分散。
              return snap === null ? base : `${base}\n${assigneeLoadNote(snap, task.assigneeId)}`;
            });
          }
          case "team_task_update": {
            const teamId = argStr(args, "teamId");
            const taskId = argStr(args, "taskId");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            if (!taskId) return { text: "task_id 不能为空：先从 team_get 的 tasks 里拿。", ok: false };
            const title = argOptStr(args, "title");
            const detail = argOptStr(args, "detail");
            const status = argStr(args, "status");
            const assigneeId = argOptStr(args, "assigneeId");
            const planId = argOptStr(args, "planId");
            const dueAt = argOptStr(args, "dueAt");
            const attachmentFileId = argOptStr(args, "attachmentFileId");
            const result = argOptStr(args, "result");
            const returnNote = argOptStr(args, "returnNote");
            const progress = argOptStr(args, "progress");
            const priority = argStr(args, "priority");
            if (priority && !PRIORITY_SET.has(priority)) {
              return { text: "priority 不合法：只能是 low / normal / high。", ok: false };
            }
            const returning = assigneeId === "";
            if (status && !STATUS_SET.has(status)) {
              return {
                text: `status 不合法：只能是 ${[...STATUS_SET].join(" / ")}（收到「${status}」）。`,
                ok: false,
              };
            }
            const changed =
              title !== undefined ||
              detail !== undefined ||
              !!status ||
              assigneeId !== undefined ||
              planId !== undefined ||
              dueAt !== undefined ||
              attachmentFileId !== undefined ||
              result !== undefined ||
              returnNote !== undefined ||
              !!priority ||
              progress !== undefined;
            if (!changed) {
              return {
                text: "没有要修改的字段：至少提供 status / assigneeId / title / detail / dueAt / planId / attachmentFileId / result / returnNote / progress 之一。",
                ok: false,
              };
            }
            if (status === "done" && result === undefined) {
              return {
                text: "标完成前请用 result 写一句结论（做成什么样、怎么验证的）；团队里的其他人只看到状态，看不到你的过程。",
                ok: false,
              };
            }
            return write(async () => {
              const task = await updateTeamTask(
                teamId,
                taskId,
                {
                  ...(title !== undefined ? { title } : {}),
                  ...(detail !== undefined ? { detail } : {}),
                  ...(status ? { status: status as "todo" | "doing" | "done" | "blocked" } : {}),
                  ...(assigneeId !== undefined ? { assigneeId: assigneeId || null } : {}),
                  ...(planId !== undefined ? { planId: planId || null } : {}),
                  ...(dueAt !== undefined ? { dueAt: dueAt || null } : {}),
                  ...(attachmentFileId !== undefined
                    ? { attachmentFileId: attachmentFileId || null }
                    : {}),
                  ...(result !== undefined ? { result } : {}),
                  ...(returnNote !== undefined ? { returnNote } : {}),
                  ...(progress !== undefined ? { progress } : {}),
                  ...(priority ? { priority: priority as "low" | "normal" | "high" } : {}),
                },
                request,
              );
              if (returning) {
                return `已把「${task.title}」退回待认领（taskId：${task.id}）${returnNote ? "，原因：" + returnNote : "（没写原因，建议下次说明为什么做不了）"}。组长和其他成员会在待认领里看到，并知道这是被退回的。`;
              }
              const base = `已更新任务「${task.title}」（taskId：${task.id}，状态：${
                STATUS_LABEL[task.status] ?? task.status
              }）。`;
              // 改派给别人时（d.264）：把新负责人手上的负载说清，避免「一直逮着一个人派」。
              if (assigneeId !== undefined && assigneeId !== "") {
                const snap = await fetchWorkspaceTeam(teamId, request).catch(() => null);
                if (snap !== null) return `${base}\n${assigneeLoadNote(snap, task.assigneeId)}`;
              }
              return base;
            });
          }
          default:
            return { text: `未知工具 ${call.name}`, ok: false };
        }
      } catch (e) {
        // 永不抛：读工具失败也让模型知道原因（可改用 team_list 等继续），不中断整轮。
        const interrupted = interruptText(e);
        if (interrupted) return { text: interrupted, ok: false };
        return { text: failText("团队工具执行失败", e), ok: false };
      }
    },
  };
}

/**
 * 能力提供者：团队工具始终可用（服务端按 token 判权限；不依赖桌面桥/模块开关）。
 * 与其它提供者一致：返回的桥由注册表统一补 origin/providerId。
 */
export const teamProvider: CapabilityProvider = {
  id: "team",
  origin: "builtin",
  build: () => buildTeamToolBridge(),
};
