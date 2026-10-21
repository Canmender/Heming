/**
 * Registry 服务器的**安装风险**评级（供应链）。
 *
 * ★ 本文件只做 Registry 特有的一件事：**给「要不要装这个第三方包」评级**。
 * 工具级别的风险判定**不复用这里**——那件事由 `lib/hitl/classify.ts` 负责，
 * Registry 侧直接调用它（见 `riskOfTool` 的说明）。
 *
 * ## 为什么安装风险要单独评
 *
 * 工具风险回答「这次调用要不要问用户」，安装风险回答「要不要让一段第三方代码进本机」。
 * 后者风险面大得多：装上之后它的工具会被模型调用，而它的工具清单是我们**装完之后才知道**的。
 *
 * ## 判定依据的边界（重要）
 *
 * 本文件**只看可核实的客观事实**：传输类型、官方状态、来源域名与仓库域名是否一致。
 * **不看** `_meta` 里任何「自称」性质的字段。
 *
 * 特别是 `_meta.official.status === "active"`：**它只表示该条目未被下架，
 * 不是安全审核通过**（实测 120 条全是 active）。所以它只用于「要不要展示」，
 * 不参与评级加权——UI 上也必须写明这一点（验收里有这条断言）。
 */

import { resolveRisk, displayNameOf } from "../hitl/classify.js";
import type { InstallOption, RegistryEntry } from "./types.js";

/** 安装风险等级。 */
export type InstallRisk = "low" | "medium" | "high";

/** 评级结果。`level` 决定 UI 的强调程度，`message` 是给用户看的一句话。 */
export interface InstallVerdict {
  level: InstallRisk;
  /** 人话说明，直接可展示。**每一档都必须说明依据**，不能只给一个等级。 */
  message: string;
  /** 具体条目（域名不一致时告诉用户是哪两个域名）。 */
  detail?: string;
}

/** 从 URL 取主机名（去掉协议、端口、路径）。取不到返回空串。 */
export function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url.trim());
  if (!m) return "";
  const host = m[1];
  // 带端口就剥掉（IPv6 的 [::1]:8080 也覆盖）
  const cut = host.startsWith("[")
    ? host.indexOf("]") >= 0 ? host.slice(0, host.indexOf("]") + 1) : host
    : host.split(":")[0];
  return cut.toLowerCase();
}

/**
 * `server.name` 的**命名空间**（反向域名的 `/` 之前那段）。
 *
 * 例：`io.github.Digital-Defiance/mcp-filesystem` → `io.github.digital-defiance`。
 *
 * 用于「与仓库域名是否同源」的粗判。反向域名是**注册方自己声明的命名空间**，
 * 长度不固定（`io.github.foo` / `com.example.tool` 都合法），
 * 所以**不能假设它就是两段或三段**，也不能把末段当成顶级域。
 */
export function registryDomain(key: string): string {
  const head = (key.split("/")[0] ?? "").toLowerCase();
  return head;
}

/**
 * 命名空间与仓库主机是否**看不出矛盾**（弱信号）。
 *
 * 口径：把命名空间按 `.` 切成段，**跳过第一段**（`io` / `com` 这类段与仓库位置无关），
 * 任一剩余段（长度 ≥3）作为完整标签出现在仓库主机里即算「看不出矛盾」。
 *
 * ```
 * io.github.foo  → 段 [github, foo] → 仓库 github.com  命中 github → 不报 ✓
 * com.example.tool → 段 [example, tool] → 仓库 github.com → 找不到 → 报（可能是误报）
 * ```
 *
 * ★★ **这个信号不可靠，所以它不参与评级**（见 `rateInstall` 的说明）。
 * 真实世界里绝大多数 MCP 服务器托管在 GitHub，而命名空间是 `com.*` / `io.*` 居多，
 * 两者本来就**没有强对应关系** —— 误报率极高。
 * 标错 high 的危害比漏报大：用户会学会对「high」无脑点确认，安全提示就失效了。
 */
export function repoLooksMismatched(key: string, repoUrl?: string): boolean {
  if (!repoUrl) return false;                       // 缺证据 ≠ 有罪
  const ns = registryDomain(key);
  const host = hostOf(repoUrl);
  if (!ns || !host) return false;                   // 解析不出来就不判
  const labels = host.replace(/^\[|\]$/g, "").split(".");
  const segs = ns.split(".").filter(Boolean).slice(1);   // 跳过第一段
  if (segs.length === 0) return false;              // 只有一段 → 无可比性
  return !segs.some((s) => s.length >= 3 && labels.includes(s));
}

/**
 * 给一次安装评级。
 *
 * 三档口径：
 * - `low`：远程 http —— 不在本机装任何代码，只连一个地址；
 * - `medium`：stdio（npm / pypi）—— **会以本机进程运行**，可读写文件、执行命令；
 * - `high`：状态非 active。
 *
 * ★★ **域名不一致不参与评级**（`repoLooksMismatched` 只写进 `detail` 供 UI 提示）。
 *
 * 理由：反向域名与仓库位置**没有强对应关系**——真实世界里绝大多数 MCP 服务器托管在
 * GitHub，而命名空间多是 `com.*` / `io.*`，两者对不上是常态而非异常。
 * 把它计进评级会产生大量误报，而**误报的危害比漏报大**：
 * 用户会学会对 `high` 无脑点确认，安全提示就此失效。
 * 真正的防线是「安装前确认」本身，不是这个提示。
 */
/**
 * **明确已下架**的状态。**不在此列的一律按正常处理。**
 *
 * ★ 为什么用「下架态白名单」而不是「非 active 即下架」：
 * - 我实测 **160 条 Registry 条目全是 `active`** —— 这个字段目前**没有实际区分度**，
 *   但 Registry 是开放注册中心，**随时可能新增状态值**。
 * - 用「排除法」（`!== "active" && !== "unknown"`）的话，将来一加新状态（比如 `pending`）
 *   就会把我们**正常的新条目**全判成高危——**误伤**。
 * - 用「白名单」则只有明确列出的才判坏；不认识的**静默按正常处理**。
 *
 * 清单依据：
 * - `deprecated` / `deleted` / `archived` —— 三个都是通用的「已废弃/已删除」语义，
 *   任何状态系统里出现它们都必然是这个意思，列入是安全的。
 * - **`inactive` 我没在实测样本里见到，所以不放进来**。理由：Registry 若用它表示
 *   「临时不可用」而非「已废弃」，那把「临时故障的服务」标成高危就是误伤。
 *   **不确定的就不列** —— 宁可漏判也不误判。
 *
 * ⚠️ 若将来 Registry 真的采用了某个新的下架态，**加进这个 Set 即可**，
 * 不要改成「非 active 即下架」。
 */
const DEPRECATED_STATUS = new Set(["deprecated", "deleted", "archived"]);

/** 该条目是否**明确**已下架（未知状态一律返回 false）。 */
export function isDeprecated(status: string): boolean {
  return DEPRECATED_STATUS.has(status);
}

export function rateInstall(entry: RegistryEntry, option: InstallOption): InstallVerdict {
  // ★ 只认白名单里的下架态；不认识的（新增状态值）静默按正常处理。
  const bad = isDeprecated(entry.status);

  if (bad) {
    return {
      level: "high",
      message: `该条目已标记为「${entry.status}」（已下架或已废弃），请确认你信任这个服务后再安装。`,
      detail: repoLooksMismatched(entry.key, entry.repoUrl)
        ? `另外，注册来源（${registryDomain(entry.key)}）与仓库地址看起来不一致`
        : undefined,
    };
  }

  const note: string[] = [];
  if (option.kind === "http") {
    note.push("远程服务：本机不安装任何代码，只连接一个外部地址。");
    if (repoLooksMismatched(entry.key, entry.repoUrl)) {
      // 只作提示，不改等级。措辞必须是「看起来不一致」而非「不可信」。
      note.push(`注册来源（${registryDomain(entry.key)}）与仓库地址看起来不一致，可自行核对。`);
    }
    return { level: "low", message: note.join(""), detail: entry.repoUrl };
  }

  note.push("安装后该服务以本机进程运行，可读写文件、执行命令，等于把本机权限交给它的作者。");
  if (repoLooksMismatched(entry.key, entry.repoUrl)) {
    note.push(`另外，注册来源（${registryDomain(entry.key)}）与仓库地址看起来不一致，可自行核对。`);
  }
  return { level: "medium", message: note.join(""), detail: entry.repoUrl };
}

/* -------------------------------------------------------------- 工具级判定（复用 HITL） */

/**
 * 工具级风险 → 直接委托给 HITL 的 `classify.ts`。
 *
 * ★ **这里绝不复用本文件的 `rateInstall`** —— 两者回答的是不同问题：
 * `rateInstall` 答「要不要装这个包」，`resolveRisk` 答「这次工具调用要不要问」。
 *
 * **为什么必须复用同一份判定**（主理人 2026-10-22 明确要求）：
 * 两套判定必然漂移，而漂移的后果是「有的服务器绕过确认、有的不绕过」——
 * 这是**安全问题**不是风格问题，且这类 bug 不报错、只是行为不一致，极难在测试里发现。
 *
 * @param toolName  MCP 的**裸工具名**（实测形如 `"App"`，没有 `服务__工具` 前缀——
 *                  那是我们**内部**给模型看的命名空间）。**不能靠名字判来源。**
 * @param selfTitle `annotations.title`。★ **规范明言 title 也不可信**
 *                  （"including descriptive properties like `title`"），
 *                  所以它**只进展示层**，不影响等级。
 */
export function riskOfTool(toolName: string, selfTitle?: string): { level: string; displayName: string } {
  const level = resolveRisk(toolName);
  const displayName = displayNameOf(toolName, selfTitle ? { displayName: selfTitle } : undefined);
  return { level, displayName };
}

/** 把 MCP 的 `annotations` 转成「仅用于展示」的说明文字。 */
export function selfClaimNote(annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }): string | null {
  if (!annotations) return null;
  // ★ 措辞必须是「自述」而不是断言 —— 规范明言这些字段不可信（含 title）。
  if (annotations.readOnlyHint === true) return "该服务器自述为只读工具（未经核实）";
  if (annotations.destructiveHint === true) return "该服务器自述可能造成破坏性变更";
  return null;
}
