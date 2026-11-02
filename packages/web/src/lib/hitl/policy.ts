/**
 * HITL 策略存储：档位 + 会话授权。
 *
 * 两种「记忆」必须分开：
 * - **落盘策略**（档位、免问下限）走 localStorage，跨会话保留；
 * - **会话授权**（「本会话内允许此工具」）只在内存里，进程退出即失效——
 *   落盘的话「本会话」三个字就骗人了：下次启动用户会以为还有授权。
 */

import type { StorageLike } from "../memory/types.js";
import type {
  HitlCall,
  HitlMode,
  HitlRule,
  PolicyOutcome,
  PolicyScope,
  RiskLevel,
  RuleEffect,
} from "./types.js";
import { RISK_ORDER, ruleResource } from "./classify.js";
import { FILE_PATCH_TOOL, isFileEditTool, targetsOfCall } from "../fileEdit/ruleTargets.js";
import { normalizeRuleResource, resourceCovers, type FileRoot } from "../fileEdit/paths.js";
import { assessPatchSafety } from "../fileEdit/safety.js";
import { fileRootsStore } from "../fileEdit/roots.js";

/** 策略存储键（带版本后缀，便于将来迁移）。 */
export const HITL_KEY = "heming.hitl.v1";

/** 记住的规则（按工具 + 资源）。与档位分开存，清规则不影响档位。 */
export const HITL_RULES_KEY = "heming.hitl.rules.v1";

/** 规则上限：防止长期使用把 localStorage 撑爆；超出丢最旧的。 */
export const MAX_HITL_RULES = 200;

/** 资源通配：参数里没有可识别资源时，规则退化成「该工具的所有调用」。 */
export const RULE_WILDCARD = "*";

/** 策略默认值：受控（只读放行，写操作必问）。 */
export const DEFAULT_HITL_POLICY: HitlPolicy = {
  mode: "guarded",
  floor: "read",
  scope: "global",
};

/**
 * 生效中的策略。
 *
 * - `mode`：档位（见 `HitlMode`）；
 * - `floor`：免问下限——**风险不高于**此值的调用一律不问（`guarded` 下即 `read`）；
 * - `scope`：会话授权的作用域（按智能体 / 全局共用）。
 *
 * ★ `floor` 的**类型**仍是 `RiskLevel`（`danger` 是合法的风险等级），
 * 但它的**合法取值**比 `RiskLevel` 窄：只有 `read` / `write`。
 * 这条收窄由 `normalizePolicy` 在运行时强制（读侧与写侧都过这一道），
 * 类型上没有再往窄收，是为了不把「风险等级」与「下限取值」两个概念混成一个类型。
 */
export interface HitlPolicy {
  mode: HitlMode;
  floor: RiskLevel;
  scope: PolicyScope;
}

/** 合法档位（读回时逐字段校验，非法值回落默认）。★ 只有三档，没有「全放行」档。 */
const MODES: HitlMode[] = ["strict", "guarded", "trusted"];

/**
 * 合法免问下限。★ **没有 `danger`**。
 *
 * 为什么 `danger` 不能当下限：判定式是「风险**不高于**下限 ⇒ 免问」，
 * 下限取 `danger` 时，「不高于 danger」把 `danger` 本身也包了进去
 * ⇒ 所有档位恒真 ⇒ 等于一个设置页里的「全部放行」，
 * 与「没有全放行档」的红线冲突（见 `types.ts` 里 `HitlMode` 的注释）。
 *
 * ★ 注意区分两个概念：`danger` **仍是合法的 `RiskLevel`**
 * （分类、审计、界面文案都要用它），它只是**不是合法的下限值**。
 * 要表达「危险恒问」，正确的取值是 `write`——
 * `danger` 严格高于 `write`，不在免问范围内。
 *
 * ★ 导出给界面用：设置页的下拉选项**必须**与这份列表一致。
 * 两者各写一份就会漂移——界面多给一个选项，策略层又把它夹掉，
 * 用户点下去却发现值没变（或者反过来，界面少给一个，用户以为自己有更宽的档）。
 * 测试里有一条断言把两者钉在一起。
 */
export const FLOORS: RiskLevel[] = ["read", "write"];

/**
 * 免问下限的回落值（读到的值非法时用）。
 *
 * ★ 回落 `write` 而不是回落默认值 `read`：
 * - 回落 `read` 会把用户的既有偏好**悄悄改严**。旧 localStorage 里存着 `danger` 的用户
 *   当初选它就是想少被打扰，夹回 `read` 等于替他重新选了最严的那一档，而且没征求过他；
 * - 回落 `write` 是「该字段可表达的最宽安全值」：既尊重了「别问那么多」的意图，
 *   又没打开全放行（`danger` 仍严格高于 `write`，恒要问）。
 *
 * 也就是说：`write` 是**这个字段**的回落值，不是**整个策略**的默认值——
 * 整个策略的默认值仍是 `DEFAULT_HITL_POLICY`（`floor: "read"`）。
 */
const FALLBACK_FLOOR: RiskLevel = "write";

/** 合法作用域。 */
const SCOPES: PolicyScope[] = ["per-agent", "global"];

/** localStorage 适配（隐私模式下静默降级）。 */
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
        /* 隐私模式：只在本次会话生效 */
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

/**
 * 逐字段规整：类型/取值不符的字段回落（好字段照样用）。
 *
 * ★ `floor` 的回落值是 `FALLBACK_FLOOR`（`write`），**不是** `DEFAULT_HITL_POLICY.floor`（`read`）——
 * 理由见 `FALLBACK_FLOOR` 的注释：回落 `read` 会把用户「少被打扰」的偏好悄悄改严。
 *
 * 这道校验是**读侧的红线**：只删界面上的 `danger` 选项不够，
 * 旧 localStorage 里存着 `floor:"danger"` 的用户仍会被放行，必须在这里夹住。
 */
function normalizePolicy(raw: unknown): HitlPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_HITL_POLICY };
  }
  const r = raw as Record<string, unknown>;
  return {
    mode: MODES.includes(r.mode as HitlMode) ? (r.mode as HitlMode) : DEFAULT_HITL_POLICY.mode,
    floor: FLOORS.includes(r.floor as RiskLevel) ? (r.floor as RiskLevel) : FALLBACK_FLOOR,
    scope: SCOPES.includes(r.scope as PolicyScope)
      ? (r.scope as PolicyScope)
      : DEFAULT_HITL_POLICY.scope,
  };
}

/**
 * 读回规则：逐条校验，坏条目直接丢弃（不因为一条脏数据清空全部规则）。
 */
function normalizeRules(raw: unknown): HitlRule[] {
  if (!Array.isArray(raw)) return [];
  const out: HitlRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.tool !== "string" || !r.tool.trim()) continue;
    if (typeof r.resource !== "string" || !r.resource.trim()) continue;
    if (r.effect !== "allow" && r.effect !== "deny") continue;
    out.push({
      tool: r.tool.trim().slice(0, 200),
      resource: r.resource.trim().slice(0, 200),
      effect: r.effect,
      at: typeof r.at === "string" ? r.at : "",
      ...(typeof r.agentId === "string" && r.agentId.trim()
        ? { agentId: r.agentId.trim().slice(0, 200) }
        : {}),
      ...(typeof r.agentName === "string" && r.agentName.trim()
        ? { agentName: r.agentName.trim().slice(0, 200) }
        : {}),
    });
    if (out.length >= MAX_HITL_RULES) break;
  }
  return out;
}

/**
 * 策略存储的可选依赖（全部可注入，便于单测）。
 *
 * - `roots`：可写根清单。文件工具（`file_patch`）的规则匹配与「全在写根内免问」
 *   都要它；不注入时读设置区的 `fileRootsStore`（localStorage）。
 * - `outOfRoot`：目标越界时的处理（ask / reject）。
 */
export interface HitlPolicyDeps {
  roots?: () => FileRoot[];
  outOfRoot?: () => "ask" | "reject";
}

/**
 * 策略与会话授权的存储。
 *
 * 会话授权**只放内存**（`Map`）：落盘就等于把「本会话」变成了「永久」，
 * 用户下次启动会以为某个危险工具还在授权列表里。
 */
export class HitlPolicyStore {
  private readonly storage: StorageLike;
  private readonly deps: HitlPolicyDeps;
  /** 会话授权：key = `${scope}:${agentId}:${toolName}`。 */
  private readonly session = new Map<string, number>();

  constructor(storage?: StorageLike, deps?: HitlPolicyDeps) {
    this.storage = storage ?? defaultStorage();
    this.deps = deps ?? {};
  }

  /** 当前根清单（读失败按「没有根」处理：宁可多问，不要误放行）。 */
  private roots(): FileRoot[] {
    try {
      return this.deps.roots ? this.deps.roots() : fileRootsStore.roots();
    } catch {
      return [];
    }
  }

  /** 读当前策略：缺键 / 损坏 / 存储抛错一律回落默认。 */
  get(): HitlPolicy {
    try {
      const raw = this.storage.getItem(HITL_KEY);
      if (!raw) return { ...DEFAULT_HITL_POLICY };
      return normalizePolicy(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_HITL_POLICY };
    }
  }

  /**
   * 写策略：存储抛错静默（本次会话内仍按内存态生效）。
   *
   * ★ 落盘前也过 `normalizePolicy`，所以**写侧同样被夹**：
   * `set({ floor: "danger" })` 存下去的是 `write`，不会把红线值写进 localStorage。
   * （只夹读侧不够——那样旧的 `danger` 会被原样留在存储里，下次读回才夹，等于放过一次。）
   */
  set(policy: HitlPolicy): void {
    try {
      this.storage.setItem(HITL_KEY, JSON.stringify(normalizePolicy(policy)));
    } catch {
      /* 存不下只影响「记住设置」，不影响本次生效 */
    }
  }

  /** 当前档位。 */
  mode(): HitlMode {
    return this.get().mode;
  }

  /** 会话授权 key。 */
  private key(agentId: string, toolName: string, scope: PolicyScope): string {
    return `${scope}:${agentId}:${toolName}`;
  }

  /** 该工具在本会话是否已授权。 */
  granted(agentId: string, toolName: string, scope: PolicyScope = "global"): boolean {
    return this.session.has(this.key(agentId, toolName, scope));
  }

  /** 授予本会话内该工具的通行权。 */
  grant(agentId: string, toolName: string, scope: PolicyScope = "global"): void {
    this.session.set(this.key(agentId, toolName, scope), Date.now());
  }

  /** 撤销全部会话授权（用户在设置区点「清空本会话授权」时用）。 */
  revokeAll(): void {
    this.session.clear();
  }

  /** 当前会话授权条数。设置区「清空」前报数用；只读，不暴露 key 结构。 */
  grantCount(): number {
    return this.session.size;
  }

  /**
   * 免问下限是否覆盖该风险（风险**不高于**下限 ⇒ 免问）。
   *
   * 注意是「不高于」而不是「低于」：`floor=read` 时只读免问，
   * 写与危险仍要问——这正是 `guarded` 的语义。
   *
   * ★ 判定式（`<=`）**不动**，被夹的是下限的**取值范围**（见 `FLOORS`）：
   * `floor=write` ⇒ 只读与写入免问，**危险严格高于 write ⇒ 恒要问**。
   * 换句话说，「危险恒问」是用 `floor=write` 精确表达的，
   * 不需要（也不允许）再加第四个下限值。
   */
  private underFloor(call: HitlCall, policy: HitlPolicy): boolean {
    return RISK_ORDER[call.risk] <= RISK_ORDER[policy.floor];
  }

  /**
   * 判定一次调用是否需要问用户。
   *
   * 档位语义：
   * - `strict`：全部询问（连只读也问）；
   * - `guarded`：免问下限之下的自动放行，其余询问；
   * - `trusted`：同 `guarded`，但**本会话授权**生效（已授权的工具直接放行）。
   *
   * ★ **没有「全部放行」档**。理由见 `types.ts` 里 `HitlMode` 的注释。
   * ★ 返回值用 `pass` 而非 `auto`：避免与已删除的档位同名两义。
   *
   * 记住的规则（`ruleFor`）不在这里判定：规则可以**跳过询问**（allow）
   * 或**直接拒绝**（deny），语义比 `pass/ask` 更宽，由闸门先查。
   */
  allowed(call: HitlCall, policy: HitlPolicy, agentId = ""): PolicyOutcome {
    if (policy.mode === "strict") return "ask";
    /*
     * 文件补丁：全在可写根内且不含删除 → 免问（规格 §6 的 AutoApprove）。
     *
     * 只读根 / 越界不在这里「免问」，也不在这里拒绝——拒绝由工具层按原因给文案，
     * 闸门这里只回答「免问」还是「问人」。
     * 补丁解析不出来（格式错、路径越界）时也返回 pass：那种补丁一定写不进磁盘，
     * 工具层会带着精确原因失败，没必要先弹一次窗。
     */
    if (call.name === "file_patch") {
      return this.patchVerdict(call) === "auto" ? "pass" : "ask";
    }
    if (this.underFloor(call, policy)) return "pass";
    if (policy.mode === "trusted" && this.granted(agentId, call.name, policy.scope)) {
      return "pass";
    }
    return "ask";
  }

  /**
   * 文件补丁的三态安全判定（规格 §6）。
   *
   * 走纯函数 `assessPatchSafety`：判定逻辑与「确认卡上怎么解释」共用同一份实现。
   */
  private patchVerdict(call: HitlCall): "auto" | "ask" | "reject" {
    const roots = this.roots();
    const targets = targetsOfCall(call, roots);
    if (!targets) return "auto"; // 解析不出来 ⇒ 工具层必定拒绝，不打扰用户
    return assessPatchSafety({
      targets: targets.absolute,
      deletions: targets.deletions,
      roots,
      ...(this.deps.outOfRoot ? { outOfRoot: this.deps.outOfRoot() } : {}),
    }).verdict;
  }

  /** 读回全部记住的规则（最坏情况下返回空数组，绝不抛错）。 */
  rules(): HitlRule[] {
    try {
      const raw = this.storage.getItem(HITL_RULES_KEY);
      if (!raw) return [];
      return normalizeRules(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  /**
   * 记住一条裁决。
   *
   * 同一 `{tool, resource, agentId}` 只保留最新一条：用户先拒绝后允许时，
   * 不该两条规则并存再靠「deny 优先」把新决定吃掉。
   * 不传 agent 时写的是全局规则（兼容旧调用方与旧存储）。
   */
  rememberRule(
    tool: string,
    resource: string,
    effect: RuleEffect,
    agent?: { id: string; name?: string },
  ): void {
    const t = tool.trim().slice(0, 200);
    if (!t) return;
    /*
     * 资源归一化与匹配共用 `normalizeRuleResource`（规格 §7）。
     * 不共用的话会出现「写进去匹配不上」的幽灵规则：用户明明点了允许，
     * 下次还是弹窗，而设置区里那条规则看着没毛病。
     */
    const r = normalizeRuleResource(resource.trim() || RULE_WILDCARD).slice(0, 200);
    /*
     * ★ 文件工具**不接受**「整个工具放行」（`*` 的 allow）。
     * 它们天然是多文件写，只能按路径前缀授权；这条兜底与 `rememberDecision`
     * 的分支一起挡住「某个调用方顺手传了 `*`」的情况。
     */
    if (effect === "allow" && r === RULE_WILDCARD && isFileEditTool(t)) return;
    const agentId = agent?.id.trim().slice(0, 200) || undefined;
    const next: HitlRule[] = [
      {
        tool: t,
        resource: r,
        effect,
        at: new Date().toISOString(),
        ...(agentId ? { agentId } : {}),
        ...(agentId && agent?.name ? { agentName: agent.name.slice(0, 200) } : {}),
      },
      ...this.rules().filter(
        (rule) => !(rule.tool === t && rule.resource === r && rule.agentId === agentId),
      ),
    ].slice(0, MAX_HITL_RULES);
    try {
      this.storage.setItem(HITL_RULES_KEY, JSON.stringify(next));
    } catch {
      /* 存不下退化为「仅本次生效」，不阻断对话 */
    }
  }

  /**
   * 一次写入多条规则（文件工具的「按目录前缀记住」）。
   *
   * 与 `rememberRule` 的区别：
   * - 归一化后**去重**（同一目录前缀只存一条，大小写不敏感）；
   * - **绝不写 `*`**：文件编辑只有路径前缀授权的形状（Lead 定稿）；
   * - 一次读写完成，避免多目标补丁产生 N 次 localStorage 往返。
   */
  rememberRules(
    tool: string,
    resources: string[],
    effect: RuleEffect,
    agent?: { id: string; name?: string },
  ): void {
    const t = tool.trim().slice(0, 200);
    if (!t) return;
    const fresh: HitlRule[] = [];
    const seen = new Set<string>();
    const at = new Date().toISOString();
    const agentId = agent?.id.trim().slice(0, 200) || undefined;
    for (const raw of resources) {
      const r = normalizeRuleResource(String(raw ?? "").trim()).slice(0, 200);
      if (!r || r === RULE_WILDCARD) continue;
      const key = r.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push({
        tool: t,
        resource: r,
        effect,
        at,
        ...(agentId ? { agentId } : {}),
        ...(agentId && agent?.name ? { agentName: agent.name.slice(0, 200) } : {}),
      });
    }
    if (fresh.length === 0) return;
    const freshKeys = new Set(fresh.map((rule) => rule.resource.toLowerCase()));
    const kept = this.rules().filter(
      (rule) =>
        !(
          rule.tool === t &&
          rule.agentId === agentId &&
          freshKeys.has(rule.resource.toLowerCase())
        ),
    );
    const next = [...fresh, ...kept].slice(0, MAX_HITL_RULES);
    try {
      this.storage.setItem(HITL_RULES_KEY, JSON.stringify(next));
    } catch {
      /* 同上：存不下只影响「记住」，不影响本次调用 */
    }
  }

  /** 一键清空全部规则（设置区「清空记住的规则」）。 */
  clearRules(): void {
    try {
      this.storage.removeItem(HITL_RULES_KEY);
    } catch {
      /* 隐私模式：存储不可用，内存里本就没有规则 */
    }
  }

  /**
   * 查规则：`deny` 永远优先于 `allow`。
   *
   * 作用域：规则带 `agentId` 时只对该智能体生效；不带（旧规则）时对所有智能体生效。
   * 不传 `agentId` 的调用方只能命中全局规则——这正是「宁可多问」的方向。
   *
   * ★ `allow` 规则**不覆盖 `danger`**：按资源记住一个危险工具，
   * 等于给该工具开了一个永久放行口子，与「没有全放行档」的红线冲突。
   * 危险操作始终会弹窗；用户若确实不想被打扰，可以改免问下限——
   * 那是显式、可见、可一键改回的全局设置。
   */
  ruleFor(call: HitlCall, agentId = ""): RuleEffect | null {
    // 规则按「工具 + 资源 + 作用域」三件事匹配：工具名对不上的一律不参与。
    const rules = this.rules().filter(
      (r) => r.tool === call.name && (!r.agentId || r.agentId === agentId),
    );
    const isPatch = call.name === FILE_PATCH_TOOL;
    const patchTargets = isPatch ? targetsOfCall(call, this.roots()) : null;
    const resources =
      isPatch && patchTargets && patchTargets.absolute.length > 0
        ? patchTargets.absolute
        : this.resourcesOf(call);

    /*
     * 1. `deny` 永远优先。
     *
     * 文件补丁的规则是**路径前缀**：只要有一个目标命中拒绝规则，整份补丁就拒绝——
     * 「补丁里一半在禁区、一半在外」时，按拒绝处理才是安全方向。
     * 通配 deny（`*`）也照旧生效：用户显式说「这个工具全拒」，那是收紧而不是放宽。
     */
    const denyHit = rules.some(
      (r) => r.effect === "deny" && resources.some((res) => resourceCovers(r.resource, res)),
    );
    if (denyHit) return "deny";

    // 2. `danger` 不按规则放行（红线不变：按资源记住危险工具 = 永久放行口子）
    if (call.risk === "danger") return null;

    const allows = rules.filter((r) => r.effect === "allow");
    /*
     * 3. 多目标写（file_patch）：**每个**目标都要被某条路径规则覆盖。
     *
     * 通配规则在这里不算数——「允许 file_patch 的所有调用」等于把整个工具放行，
     * 与规格 §7 的红线冲突；只能按路径前缀授权。
     *
     * ★ 含删除/改名语义时**不吃任何允许规则**：删除不可逆，
     *   用户当初记住「这个目录可以改」不会预期「删文件也不问」。
     *   这类补丁照旧走闸门问一次（deny 规则仍然优先，见上面第 1 步）。
     */
    if (isPatch) {
      if (!patchTargets || patchTargets.deletions > 0) return null;
      const pathAllows = allows.filter((r) => r.resource !== RULE_WILDCARD);
      if (resources.length === 0) return null;
      return resources.every((res) => pathAllows.some((r) => resourceCovers(r.resource, res)))
        ? "allow"
        : null;
    }

    if (allows.some((r) => resourceCovers(r.resource, resources[0]))) return "allow";
    return null;
  }

  /**
   * 本次调用用于规则匹配的资源清单。
   *
   * 文件工具用**解析后的绝对路径**（规则是按目录前缀写的，相对路径匹配不上）；
   * 其余工具沿用 `ruleResource` 的老口径（参数摘要字段），行为与改前一致。
   */
  private resourcesOf(call: HitlCall): string[] {
    if (isFileEditTool(call.name)) {
      try {
        const targets = targetsOfCall(call, this.roots());
        if (targets && targets.absolute.length > 0) return targets.absolute;
      } catch {
        /* 解析失败回落老口径 */
      }
    }
    return [ruleResource(call.argsJson)];
  }
}
