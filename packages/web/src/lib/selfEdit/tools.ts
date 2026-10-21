/**
 * 自我修改工具集（self.*）：让智能体按需修改自己的记忆、技能与 MCP 配置。
 *
 * 为什么是「工具」而不是「后台自动跑」：
 * - 复盘分身（review fork）是**事后**自审——任务做完了才回头沉淀；
 * - self.* 是**事中**修正——模型发现「我记错了」「这类问题我该有个固定流程」
 *   「这个工具正好能解决」时，当场就能改，不必攒到下一轮复盘。
 * 两者互补，不互相替代。
 *
 * 工具形状与既有 MCP 工具完全一致（OpenAI 的 `{type:"function",function:{name,description,
 * parameters}}` + `{name, arguments}` 调用），所以模型不需要学新协议，
 * agentStream 的工具循环也不用改。
 *
 * **授权范围（用户 2026-10-20 明确选择「完全放开」）**：
 * MCP 可新增/修改/删除服务，含 stdio 命令。
 * 保留的护栏只解决「写坏」而非「不许写」，见 lib/selfEdit/guards.ts：
 * 密钥类内容不落盘、单轮变更数上限、每次变更留痕。
 */

import type { ToolBridge } from "../agentStream.js";
import type { MemoryStore } from "../memory/store.js";
import type { SkillPool } from "../skills/store.js";
import type { McpRegistry } from "../mcp/store.js";
import type { McpTransport } from "../mcp/types.js";
import type { RiskLevel } from "../hitl/types.js";
import { toolKey } from "../mcp/store.js";
import {
  SELF_EDIT_MAX_PER_TURN,
  SelfEditBudget,
  SelfEditStore,
  anySensitive,
  appendAudit,
  type StorageLike,
} from "./guards.js";

/** self.* 工具的依赖。全部可注入，便于测试与多实例。 */
export interface SelfToolDeps {
  memory: MemoryStore;
  skills: SkillPool;
  mcp: McpRegistry;
  /** 留痕与开关用的存储（默认各自回落 localStorage）。 */
  storage?: StorageLike;
  /** 该智能体是否被允许自我修改（默认允许）。 */
  policy?: SelfEditStore;
  /** 单轮变更预算（默认新实例）。 */
  budget?: SelfEditBudget;
  now?: () => number;
}

/** 上下文：每次生成时传入，工具据此知道「现在是谁、在哪一轮」。 */
export interface SelfToolContext {
  agentId: string;
  conversationId: string;
}

/* ------------------------------------------------------------------ 工具声明 */

/** 工具声明。`riskHint` 供 HITL 闸门判风险（缺省按 write 处理）。 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * 风险标注：HITL 闸门据此决定该问用户还是免问。
   *
   * 缺省按 write 处理（安全默认）；`self_mcp_*` 五个必须显式标 danger——
   * 它们能改自己的执行环境，出错的代价远高于「多问一次」。
   */
  riskHint?: RiskLevel;
}

/** JSON Schema 里描述一个字符串参数（与下面的取值助手 str 同名易混，故叫 prop）。 */
const prop = (description: string) => ({ type: "string" as const, description });

/**
 * 工具清单。分成三组：memory / skill / mcp。
 *
 * 命名统一 `self_<域>_<动作>`，与 MCP 工具的 `服务__工具` 同风格，
 * 且带 `self_` 前缀便于在工具轨迹里一眼认出是自我修改而非外部调用。
 */
export const SELF_TOOLS: ToolSpec[] = [
  // —— 记忆 ——
  {
    name: "self_memory_list",
    riskHint: "read",
    description:
      "列出自己当前的长期语义记忆（所有智能体共用的那一份）。发现自己记错了、或要更新某条认知时，先读这里确认现状。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "self_memory_write",
    riskHint: "write",
    description:
      "写入或更新一条长期记忆。key 是主题（如「偏好-语言」），value 是事实内容。相同 key 会覆盖更新，不会重复新增。",
    parameters: {
      type: "object",
      properties: {
        key: prop("主题键，≤24 字。同 key 视为更新。"),
        value: prop("事实内容，≤500 字。"),
        reason: prop("为什么要记这条（可选，会记入变更留痕）。"),
      },
      required: ["key", "value"],
    },
  },
  {
    name: "self_memory_remove",
    riskHint: "write",
    description: "删除一条自己的长期记忆。记错了、或事实已过期时用。",
    parameters: {
      type: "object",
      properties: {
        key: prop("要删除的主题键。"),
        reason: prop("删除原因（可选）。"),
      },
      required: ["key"],
    },
  },
  // —— 技能 ——
  {
    name: "self_skill_list",
    riskHint: "read",
    description: "列出自己已分配的技能及其完整定义（指令正文）。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "self_skill_update",
    riskHint: "write",
    description:
      "改进一条已有技能（同名即更新）：补充指令正文、调整触发词或描述。当发现某类任务总要走同一套步骤时，把它固化成技能。",
    parameters: {
      type: "object",
      properties: {
        name: prop("技能名（用于定位已有技能）。"),
        instructions: prop("改进后的完整指令正文。省略则只改其它字段。"),
        description: prop("路由依据，一句话说明这个技能什么时候用（可选）。"),
        triggers: { type: "array", items: { type: "string" }, description: "触发词列表（可选）" },
        reason: prop("为什么要改（可选）。"),
      },
      required: ["name"],
    },
  },
  {
    name: "self_skill_create",
    riskHint: "write",
    description:
      "沉淀一条新技能：把这次摸索出的可复用流程写下来，下次遇到同类任务直接调用。",
    parameters: {
      type: "object",
      properties: {
        name: prop("技能名，≤32 字。"),
        description: prop("一句话说明这个技能什么时候用（路由依据）。"),
        instructions: prop("指令正文：具体怎么做这件事。"),
        triggers: { type: "array", items: { type: "string" }, description: "触发词列表" },
        tags: { type: "array", items: { type: "string" }, description: "标签（可选）" },
        reason: prop("为什么沉淀这条技能（可选）。"),
      },
      required: ["name", "description", "instructions"],
    },
  },
  // —— MCP ——
  {
    name: "self_mcp_list",
    riskHint: "read",
    description:
      "列出 MCP 服务与各自暴露的工具，以及当前哪些工具已启用。发现缺少能力时可以据此新增服务。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "self_mcp_enable",
    riskHint: "danger",
    description: "启用某个 MCP 工具（格式 serverId::toolName）。启用后下一轮即可调用它。",
    parameters: {
      type: "object",
      properties: {
        tool: prop("工具键，格式 serverId::toolName。"),
        reason: prop("为什么需要它（可选）。"),
      },
      required: ["tool"],
    },
  },
  {
    name: "self_mcp_disable",
    riskHint: "danger",
    description: "停用某个 MCP 工具。工具没用、有副作用或拖慢响应时用。",
    parameters: {
      type: "object",
      properties: {
        tool: prop("工具键，格式 serverId::toolName。"),
        reason: prop("为什么停用（可选）。"),
      },
      required: ["tool"],
    },
  },
  {
    name: "self_mcp_add_server",
    riskHint: "danger",
    description:
      "新增一台 MCP 服务。transport=http 填 url；transport=stdio 填 command（仅桌面端可用，可跑任意本机命令）。",
    parameters: {
      type: "object",
      properties: {
        name: prop("服务名。"),
        transport: { type: "string", enum: ["http", "stdio"], description: "传输方式" },
        url: prop("http 传输时的服务地址。"),
        command: prop("stdio 传输时要执行的命令，如 npx、python。"),
        args: { type: "array", items: { type: "string" }, description: "命令参数（stdio）" },
        headers: {
          type: "object",
          description: "额外请求头（http）。注意：不要在此填写密钥，会被护栏拒绝。",
        },
        reason: prop("为什么加这台服务（可选）。"),
      },
      required: ["name", "transport"],
    },
  },
  {
    name: "self_mcp_update_server",
    riskHint: "danger",
    description: "修改某台 MCP 服务的配置（地址、命令、请求头、启用状态）。",
    parameters: {
      type: "object",
      properties: {
        id: prop("服务 id。"),
        name: prop("新名称（可选）。"),
        url: prop("新地址（可选）。"),
        command: prop("新命令（可选）。"),
        args: { type: "array", items: { type: "string" }, description: "新参数（可选）" },
        headers: { type: "object", description: "新请求头（可选）" },
        enabled: { type: "boolean", description: "是否启用该服务（可选）" },
        reason: prop("为什么改（可选）。"),
      },
      required: ["id"],
    },
  },
  {
    name: "self_mcp_remove_server",
    riskHint: "danger",
    description: "删除一台 MCP 及其启用记录。确认某服务不再需要时用。",
    parameters: {
      type: "object",
      properties: {
        id: prop("服务 id。"),
        reason: prop("为什么删（可选）。"),
      },
      required: ["id"],
    },
  },
];

/* ------------------------------------------------------------------ 工具桥 */

/**
 * 构造 self.* 工具桥。
 *
 * 返回 null 表示「不提供」：策略关闭时返回空 tools 的桥（模型看不到工具），
 * 而不是返回 null——因为 null 在编排层意味着「没有工具」，会连带跳过后续合并。
 */
export function buildSelfToolBridge(
  deps: SelfToolDeps,
  ctx: SelfToolContext,
): ToolBridge {
  const storage = deps.storage ?? defaultStorage();
  const policy = deps.policy ?? new SelfEditStore(storage);
  const budget = deps.budget ?? new SelfEditBudget();
  const now = deps.now ?? (() => Date.now());

  const enabled = policy.allowed(ctx.agentId);

  const tools = enabled
    ? SELF_TOOLS.map((spec) => ({
        type: "function" as const,
        function: {
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
        },
      }))
    : [];

  /**
   * 变更前置检查：策略 → 预算 → 敏感信息。三关都过才允许写。
   * 任一关不过都**照常返回 ok:false 并说明原因**（工具失败不崩对话），
   * 并且被拒的尝试会留痕——「它想写什么但被拦下」比「什么都没发生」更值得知道。
   */
  const gate = (
    scope: "memory" | "skill" | "mcp" | "other",
    target: string,
    args: Record<string, unknown>,
  ): { ok: true } | { ok: false; text: string } => {
    if (!policy.allowed(ctx.agentId)) {
      audit(storage, now, ctx, scope, "reject", target, args, "该智能体未开启自我修改");
      return { ok: false, text: "自我修改已被用户关闭，无法改动。" };
    }
    if (budget.remaining(ctx.agentId, ctx.conversationId) <= 0) {
      audit(
        storage,
        now,
        ctx,
        scope,
        "reject",
        target,
        args,
        `已达单轮变更上限 ${SELF_EDIT_MAX_PER_TURN}`,
      );
      return {
        ok: false,
        text: `本轮自我修改次数已达上限（${SELF_EDIT_MAX_PER_TURN} 次）。请说明还需要改什么，由用户在下一轮继续。`,
      };
    }
    const hit = anySensitive(args);
    if (hit) {
      audit(storage, now, ctx, scope, "reject", target, args, `${hit} 字段含密钥类内容`);
      return {
        ok: false,
        text: `${hit} 里疑似包含密钥/口令，出于安全考虑不写入。请改用引用（如「密钥在环境变量 X」）而不是字面量。`,
      };
    }
    budget.consume(ctx.agentId, ctx.conversationId);
    return { ok: true };
  };

  const audit = (
    store: StorageLike,
    clock: () => number,
    context: SelfToolContext,
    scope: "memory" | "skill" | "mcp" | "other",
    action: string,
    target: string,
    args: Record<string, unknown>,
    rejected?: string,
  ) => {
    appendAudit(store, {
      at: new Date(clock()).toISOString(),
      agentId: context.agentId,
      scope,
      action,
      target,
      ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
      ...(rejected ? { rejected } : {}),
    });
  };

  return {
    tools,
    // HITL 闸门用：self.* 的风险由作者显式声明（riskHint），不靠名字猜。
    meta: (name) => {
      const spec = SELF_TOOLS.find((s) => s.name === name);
      return spec?.riskHint ? { risk: spec.riskHint } : undefined;
    },
    execute: async (call) => {
      if (!enabled) {
        return { text: "自我修改已被用户关闭。", ok: false };
      }
      const args = parseArgs(call.arguments);
      try {
        return await runSelfTool(call.name, args, {
          memory: deps.memory,
          skills: deps.skills,
          mcp: deps.mcp,
          gate,
          audit: (scope, action, target, rejected) =>
            audit(storage, now, ctx, scope, action, target, args, rejected),
        });
      } catch (e) {
        // 永不抛：工具失败应当让模型看到原因并换策略，而不是中断整轮
        return {
          text: `工具执行失败：${e instanceof Error ? e.message : String(e)}`,
          ok: false,
        };
      }
    },
  };
}

/* ------------------------------------------------------------------ 执行 */

interface RunDeps {
  memory: MemoryStore;
  skills: SkillPool;
  mcp: McpRegistry;
  gate: (
    scope: "memory" | "skill" | "mcp" | "other",
    target: string,
    args: Record<string, unknown>,
  ) => { ok: true } | { ok: false; text: string };
  audit: (
    scope: "memory" | "skill" | "mcp" | "other",
    action: string,
    target: string,
    rejected?: string,
  ) => void;
}

const ok = (text: string) => ({ text, ok: true as const });
const fail = (text: string) => ({ text, ok: false as const });

/**
 * 执行一个 self.* 工具。导出以便直接单测（不经 React、不经 agentStream）。
 */
export async function runSelfTool(
  name: string,
  args: Record<string, unknown>,
  deps: RunDeps,
): Promise<{ text: string; ok: boolean }> {
  switch (name) {
    /* ---------------------------------------------------------- 记忆 */
    case "self_memory_list": {
      const list = deps.memory.semanticGlobal();
      if (!list.length) return ok("当前没有长期记忆。");
      return ok(
        `长期记忆（${list.length} 条，所有智能体共用）：\n` +
          list
            .map(
              (e) =>
                `- ${e.key}：${e.value}` +
                `${e.pinned ? "（置顶）" : ""}` +
                `${e.source === "review" ? "（复盘沉淀）" : ""}`,
            )
            .join("\n"),
      );
    }
    case "self_memory_write": {
      const key = str(args.key, 24);
      const value = str(args.value, 500);
      if (!key || !value) return fail("key 与 value 都不能为空。");
      const g = deps.gate("memory", key, args);
      if (!g.ok) return fail(g.text);
      const existed = Boolean(deps.memory.findSemantic("", key));
      deps.memory.upsertSemantic({
        agentId: "",
        key,
        value,
        source: "review", // 与复盘沉淀同源：都是「智能体自己认定值得长期记住」
        scope: "user",
        confidence: 0.7,
      });
      deps.audit("memory", existed ? "update" : "write", key);
      return ok(existed ? `已更新记忆「${key}」。` : `已记住「${key}」。`);
    }
    case "self_memory_remove": {
      const key = str(args.key, 24);
      if (!key) return fail("key 不能为空。");
      const existing = deps.memory.findSemantic("", key);
      if (!existing) return fail(`没有找到记忆「${key}」，无需删除。`);
      const g = deps.gate("memory", key, args);
      if (!g.ok) return fail(g.text);
      deps.memory.removeSemantic("", existing.id);
      deps.audit("memory", "remove", key);
      return ok(`已删除记忆「${key}」。`);
    }

    /* ---------------------------------------------------------- 技能 */
    case "self_skill_list": {
      const assigned = deps.skills.assigned("");
      const mine = assigned
        .map((id) => deps.skills.get(id))
        .filter((s): s is NonNullable<typeof s> => Boolean(s));
      const list = mine.length ? mine : deps.skills.list();
      if (!list.length) return ok("当前没有任何技能。");
      return ok(
        list
          .map(
            (s) =>
              `## ${s.name}${s.enabled ? "" : "（已停用）"}\n` +
              `说明：${s.description}\n` +
              `触发词：${s.triggers.join("、") || "无"}\n` +
              `指令：${s.instructions}`,
          )
          .join("\n\n"),
      );
    }
    case "self_skill_create": {
      const skillName = str(args.name, 32);
      const description = str(args.description, 200);
      const instructions = str(args.instructions, 8000);
      if (!skillName || !description || !instructions) {
        return fail("name、description、instructions 三个字段都必须填。");
      }
      const g = deps.gate("skill", skillName, args);
      if (!g.ok) return fail(g.text);
      const created = deps.skills.create({
        name: skillName,
        description,
        instructions,
        triggers: strArray(args.triggers, 12),
        tags: strArray(args.tags, 12),
        enabled: true,
        version: "1.0.0",
        source: "distilled",
      });
      deps.audit("skill", "create", created.name);
      return ok(`已沉淀技能「${created.name}」，下次遇到同类任务会自动路由到它。`);
    }
    case "self_skill_update": {
      const skillName = str(args.name, 32);
      if (!skillName) return fail("name 不能为空。");
      // 同名优先改自己沉淀的，其次是自己分配的，最后才允许改内置（内置不可变，见下）
      const existing =
        deps.skills.list().find((s) => s.source === "distilled" && s.name === skillName) ??
        deps.skills.list().find((s) => s.name === skillName);
      if (!existing) return fail(`没有找到技能「${skillName}」。`);
      if (existing.builtin) {
        deps.audit("skill", "reject", skillName, "内置技能不可修改");
        return fail(
          `「${skillName}」是内置技能，不能直接改。要调整它，请用 self_skill_create 沉淀一条新技能。`,
        );
      }
      const g = deps.gate("skill", skillName, args);
      if (!g.ok) return fail(g.text);
      const updated = deps.skills.update(existing.id, {
        ...(typeof args.instructions === "string" && args.instructions.trim()
          ? { instructions: args.instructions.trim().slice(0, 8000) }
          : {}),
        ...(typeof args.description === "string" && args.description.trim()
          ? { description: args.description.trim().slice(0, 200) }
          : {}),
        ...(Array.isArray(args.triggers) ? { triggers: strArray(args.triggers, 12) } : {}),
      });
      deps.audit("skill", "update", updated.name);
      return ok(`已更新技能「${updated.name}」。`);
    }

    /* ---------------------------------------------------------- MCP */
    case "self_mcp_list": {
      const servers = deps.mcp.servers();
      if (!servers.length) return ok("当前没有配置任何 MCP 服务。");
      const enabled = new Set(deps.mcp.enabledTools().map((r) => toolKey(r.serverId, r.tool.name)));
      const lines: string[] = [];
      for (const s of servers) {
        const tools = deps.mcp.tools(s.id);
        lines.push(`## ${s.name}（id=${s.id}，${s.transport}${s.enabled ? "" : "，服务已停用"}）`);
        lines.push(s.url ? `地址：${s.url}` : s.command ? `命令：${s.command} ${(s.args ?? []).join(" ")}` : "");
        for (const t of tools) {
          const key = toolKey(s.id, t.name);
          lines.push(`- ${key}${enabled.has(key) ? " [已启用]" : ""}${t.description ? `：${t.description}` : ""}`);
        }
      }
      return ok(lines.filter(Boolean).join("\n"));
    }
    case "self_mcp_enable":
    case "self_mcp_disable": {
      const key = str(args.tool, 200);
      if (!key || !key.includes("::")) {
        return fail("tool 需要是 serverId::toolName 格式，可先调 self_mcp_list 查看。");
      }
      const [serverId, toolName] = key.split("::");
      const server = deps.mcp.get(serverId);
      if (!server) return fail(`找不到服务 ${serverId}。`);
      const known = deps.mcp.tools(serverId).some((t) => t.name === toolName);
      if (!known) return fail(`服务 ${serverId} 没有暴露工具 ${toolName}。`);
      const on = name === "self_mcp_enable";
      const g = deps.gate("mcp", key, args);
      if (!g.ok) return fail(g.text);
      deps.mcp.setToolEnabled(serverId, toolName, on);
      deps.audit("mcp", on ? "enable" : "disable", key);
      return ok(on ? `已启用 ${key}。` : `已停用 ${key}。`);
    }
    case "self_mcp_add_server": {
      const serverName = str(args.name, 64);
      const transport = args.transport === "stdio" ? "stdio" : "http";
      if (!serverName) return fail("name 不能为空。");
      if (transport === "http" && !str(args.url, 500)) {
        return fail("http 传输必须填 url。");
      }
      if (transport === "stdio" && !str(args.command, 200)) {
        return fail("stdio 传输必须填 command。");
      }
      const g = deps.gate("mcp", serverName, args);
      if (!g.ok) return fail(g.text);
      const created = deps.mcp.add({
        name: serverName,
        transport: transport as McpTransport,
        ...(transport === "http" ? { url: str(args.url, 500) } : {}),
        ...(transport === "stdio"
          ? { command: str(args.command, 200), args: strArray(args.args, 32) }
          : {}),
        headers: recordOf(args.headers),
      });
      deps.audit("mcp", "add_server", created.id);
      return ok(
        `已新增 MCP 服务「${created.name}」（id=${created.id}）。` +
          `需在接口区点一次「发现工具」拉取它暴露的工具，再启用需要的那些。`,
      );
    }
    case "self_mcp_update_server": {
      const id = str(args.id, 64);
      const server = id ? deps.mcp.get(id) : undefined;
      if (!server) return fail(`找不到服务 ${id}。`);
      const g = deps.gate("mcp", id, args);
      if (!g.ok) return fail(g.text);
      deps.mcp.update(id, {
        ...(typeof args.name === "string" && args.name.trim() ? { name: args.name.trim() } : {}),
        ...(typeof args.url === "string" && args.url.trim() ? { url: args.url.trim() } : {}),
        ...(typeof args.command === "string" && args.command.trim()
          ? { command: args.command.trim() }
          : {}),
        ...(Array.isArray(args.args) ? { args: strArray(args.args, 32) } : {}),
        ...(args.headers !== undefined ? { headers: recordOf(args.headers) } : {}),
        ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
      });
      deps.audit("mcp", "update_server", id);
      return ok(`已更新服务 ${id}。`);
    }
    case "self_mcp_remove_server": {
      const id = str(args.id, 64);
      if (!id || !deps.mcp.get(id)) return fail(`找不到服务 ${id}。`);
      const g = deps.gate("mcp", id, args);
      if (!g.ok) return fail(g.text);
      deps.mcp.remove(id);
      deps.audit("mcp", "remove_server", id);
      return ok(`已删除服务 ${id}。`);
    }

    default:
      return fail(`未知工具 ${name}。`);
  }
}

/* ------------------------------------------------------------------ 工具函数 */

function parseArgs(raw: string): Record<string, unknown> {
  const text = raw?.trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 取字符串并截断到上限；非字符串一律视为空（宁可缺字段也不要写入 [object Object]）。 */
function str(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

/** 取字符串数组：逐项裁剪、去空、去重、限量。非数组返回空数组。 */
function strArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** 取字符串映射：只保留字符串值，限量防注入超大对象。 */
function recordOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string" || !k) continue;
    out[k] = v;
    if (++count >= 20) break;
  }
  return Object.keys(out).length ? out : undefined;
}

function defaultStorage(): StorageLike {
  return {
    getItem: (k) => {
      try {
        return window.localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* 隐私模式 */
      }
    },
    removeItem: (k) => {
      try {
        window.localStorage.removeItem(k);
      } catch {
        /* 同上 */
      }
    },
  };
}