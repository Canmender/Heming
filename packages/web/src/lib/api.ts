import type {
  User,
  SharedFileMeta,
  Message,
  Conversation,
  Workspace,
  E2eKeysResponse,
  PutE2eKeysBody,
  ReencryptBody,
  TeamActivityInput,
  TeamActivityList,
  TeamActivityWriteResult,
  TeamRoster,
  TeamUsageInput,
  TeamUsageRange,
  TeamUsageResponse,
  TeamUsageWriteResult,
  TeamUsageClearResult,
  WorkspaceTeamList,
  TeamWorkspaceSnapshot,
  TeamPlanItem,
  TeamTask,
  CreateWorkspaceTeamBody,
  UpdateWorkspaceTeamBody,
  CreateTeamPlanBody,
  UpdateTeamPlanBody,
  CreateTeamTaskBody,
  UpdateTeamTaskBody,
} from "@heming/shared";
import { hasSubtle, toB64, fromB64 } from "./e2eCrypto.js";

/**
 * API 直连地址：构建时由 VITE_API_BASE 注入（vite 对 VITE_ 前缀 env 天然内联，无需 define）。
 * 留空 = 同源相对路径（本地 dev 由 vite 代理 /api）；公网部署/桌面 file:// 页面必须配置绝对地址。
 */
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

/** VITE_API_BASE 形状不合法（无法解析 / 缺 http(s) 协议）时的统一错误文案。 */
export const INVALID_API_BASE_ERROR =
  "VITE_API_BASE 配置无效，需形如 http://host（不含末尾斜杠）";

/** 校验并解析非空 base：必须是可解析的 http(s) 绝对地址（可测纯函数）。 */
export function parseApiBase(base: string): URL {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new Error(INVALID_API_BASE_ERROR);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(INVALID_API_BASE_ERROR);
  }
  return u;
}

/**
 * 拼接请求 URL（可测纯函数）：
 * - base 非空 → 先做形状校验（http(s) 绝对地址），再 `${base}${path}` 直连；
 * - base 为空且页面 host 非空 → 保持同源相对路径；
 * - base 为空且 host 为空（file:// 桌面页未配置）→ 抛清晰错误。
 */
export function resolveUrl(
  path: string,
  base: string = API_BASE,
  host: string = typeof location !== "undefined" ? location.host : "",
): string {
  if (base) {
    parseApiBase(base);
    return `${base}${path}`;
  }
  if (!host) throw new Error("未配置 VITE_API_BASE：file:// 页面需指向服务端绝对地址");
  return path;
}

let token: string | null = localStorage.getItem("heming.token");

export function setToken(t: string | null): void {
  token = t;
  if (t) localStorage.setItem("heming.token", t);
  else localStorage.removeItem("heming.token");
}

export function getToken(): string | null {
  return token;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 运行中收到 401（token 失效/被撤销）时的全局回调，由 auth store 注册为 logout。 */
let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/**
 * `api()` 的可选请求控制。**默认一个都不传 = 与旧行为完全一致**（不中断、不超时），
 * 所以其它调用方不需要改。
 */
export interface ApiRequestOptions {
  /** 外部中断信号（用户点「中断」/组件卸载）：触发后立刻中止在途请求。 */
  signal?: AbortSignal;
  /** 超时毫秒（>0 生效）：超时后中止请求并抛「请求超时」。 */
  timeoutMs?: number;
}

/** 因「调用方取消」失败时的 status（0 不是合法 HTTP 码，用来和网络/服务端错误区分）。 */
export const API_CANCELLED_STATUS = 0;
/** 因 `timeoutMs` 超时失败时的 status。 */
export const API_TIMEOUT_STATUS = 408;
/** 被中断时的统一文案：工具层据此回「用户已中断」，不把取消说成失败。 */
export const API_CANCELLED_MESSAGE = "操作已取消";

export function apiTimeoutMessage(timeoutMs: number): string {
  return `请求超时（${Math.max(1, Math.round(timeoutMs / 1000))} 秒），请稍后重试`;
}

/** 这次失败是不是「调用方主动中断」：用于把取消和真失败分开提示。 */
export function isApiAbort(e: unknown): boolean {
  return e instanceof ApiError && e.status === API_CANCELLED_STATUS;
}

/** 这次失败是不是「超时」。 */
export function isApiTimeout(e: unknown): boolean {
  return e instanceof ApiError && e.status === API_TIMEOUT_STATUS;
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
  options: ApiRequestOptions = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  // 模块级 token 优先；为空时回退 localStorage（测试环境 setToken 未先行、模块加载早于写入的场景）
  const t = token ?? localStorage.getItem("heming.token");
  if (t) headers.set("Authorization", `Bearer ${t}`);

  // 中断与超时都在这一层收口：任一触发都走同一个 controller，fetch 抛出的 AbortError
  // 在这里被翻译成可读的 ApiError（不把 DOMException / "signal is aborted" 丢给上层）。
  const controller = new AbortController();
  const linked = [options.signal, init.signal].filter((s): s is AbortSignal => Boolean(s));
  const onAbort = () => controller.abort();
  for (const s of linked) {
    if (s.aborted) controller.abort();
    else s.addEventListener("abort", onAbort, { once: true });
  }
  let timedOut = false;
  const timer =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.timeoutMs)
      : undefined;

  try {
    const res = await fetch(resolveUrl(path), { ...init, headers, signal: controller.signal });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      if (res.status === 401 && onUnauthorized) onUnauthorized();
      throw new ApiError(res.status, body.error ?? `http ${res.status}`);
    }
    return body as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (controller.signal.aborted) {
      throw timedOut && options.timeoutMs !== undefined
        ? new ApiError(API_TIMEOUT_STATUS, apiTimeoutMessage(options.timeoutMs))
        : new ApiError(API_CANCELLED_STATUS, API_CANCELLED_MESSAGE);
    }
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    for (const s of linked) s.removeEventListener("abort", onAbort);
  }
}

type AuthResponse = { token: string; user: User };

export const login = (username: string, password: string) =>
  api<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });

export const fetchMe = () => api<User>("/api/me");
/** 更新个人资料：avatar 为 data URL base64 字符串；省略 avatar 时服务端保留原头像。 */
export const updateProfile = (displayName: string, avatar?: string) =>
  api<User>("/api/me", {
    method: "PUT",
    body: JSON.stringify({ displayName, ...(avatar !== undefined ? { avatar } : {}) }),
  });
export const fetchConversations = (options: { limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.offset !== undefined) query.set("offset", String(options.offset));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return api<Conversation[]>(`/api/conversations${suffix}`);
  };
/**
 * 建智能体会话。
 *
 * 缺省仍是幂等语义（同一智能体复用原会话，老入口行为不变）；传 `fresh: true` 则每次新开
 * 一段会话（Claude Code 式「同一智能体多段对话」）。标题可在创建时带上，也可之后 PATCH。
 */
export const createAgentConversation = (
  agentId: string,
  options: { fresh?: boolean; title?: string; workspace?: string } = {},
) =>
  api<Conversation>("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ agentId, ...options }),
  });

/** 左栏工作区清单（本机文件夹路径；「未分组」是隐式组，不在清单里）。 */
export const fetchWorkspaces = () => api<Workspace[]>("/api/workspaces");

/** 加工作区（同一路径幂等，服务端只刷新 updated_at）。 */
export const addWorkspace = (path: string) =>
  api<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ path }) });

/** 删工作区：还有会话挂在它下面时服务端回 409（调用方先让用户挪走）。 */
export const removeWorkspace = (path: string) =>
  api<void>(`/api/workspaces?path=${encodeURIComponent(path)}`, { method: "DELETE" });

/** 把会话挪到别的 工作区（null/空串 = 未分组）；返回更新后的会话。 */
export const updateConversationWorkspace = (convId: string, workspace: string | null) =>
  api<Conversation>(`/api/conversations/${encodeURIComponent(convId)}/workspace`, {
    method: "PATCH",
    body: JSON.stringify({ workspace }),
  });

/** 删除整段会话（消息一并删，服务端 204 无响应体）。 */
export const deleteConversation = (convId: string) =>
  api<void>(`/api/conversations/${encodeURIComponent(convId)}`, { method: "DELETE" });

/** 改会话标题（空串 = 清除）；返回更新后的会话。 */
export const updateConversationTitle = (convId: string, title: string) =>
  api<Conversation>(`/api/conversations/${encodeURIComponent(convId)}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
export const fetchMessages = (convId: string) =>
  api<Message[]>(`/api/conversations/${convId}/messages`);

/** 会话内容搜索的一条命中（d.197）：只带片段，不带整条正文。 */
export interface ConversationContentHit {
  conversationId: string;
  conversationTitle: string | null;
  lastMessageAt: string | null;
  messageId: string;
  senderType: string;
  createdAt: string;
  snippet: string;
}

/** 会话内容搜索的响应：`truncated` 表示「会话/消息太多，只搜了最近的一部分」。 */
export interface ConversationContentSearchResult {
  hits: ConversationContentHit[];
  truncated: boolean;
  scanned: number;
}

/**
 * 按消息正文搜会话（d.197）。
 *
 * 服务端只在「我所在的会话」里找，且只回命中片段——侧栏要的是「哪段会话说过」，
 * 点进去再看原文。搜索词少于 2 个字符时服务端 400，调用方应先自行短路。
 */
export const searchConversationContent = (
  query: string,
  options: { limit?: number } & ApiRequestOptions = {},
) => {
  const params = new URLSearchParams({ q: query });
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  return api<ConversationContentSearchResult>(`/api/conversations/search?${params.toString()}`, {}, options);
};

export const fetchFiles = () => api<SharedFileMeta[]>("/api/files");

/**
 * 团队名册：同队成员 + 在线态 + 最近活跃。
 *
 * `teamId` 给了就**只看这个团队**（一个人可以同时在多个团队里，团队页用页头切换）；
 * 不给则是「我所在的全部团队」成员的并集——旧调用方与首页卡片保持原口径。
 */
export const fetchTeam = (
  opts: { teamId?: string } = {},
  request?: ApiRequestOptions,
) => {
  const q = new URLSearchParams();
  if (opts.teamId) q.set("teamId", opts.teamId);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return api<TeamRoster>(`/api/team${suffix}`, {}, request);
};

/**
 * 团队动向流：默认 50 条，按 `occurredAt DESC, id DESC` 倒序。
 *
 * 翻页游标是**组合游标**：`before` 取上一页最后一条的 `occurredAt`；同时间戳可能有多条，
 * 再带上它的 `id` 作 `beforeId`，否则同刻的剩余条目永远翻不到（老调用只传 `before` 仍可用）。
 */
export const fetchTeamActivities = (
  opts: {
    limit?: number;
    before?: string;
    beforeId?: string;
    actorId?: string;
    /** 只看这个团队的动向；不给则是全部同队成员的并集。 */
    teamId?: string;
  } = {},
  request?: ApiRequestOptions,
) => {
  const q = new URLSearchParams();
  if (opts.limit !== undefined) q.set("limit", String(opts.limit));
  if (opts.teamId) q.set("teamId", opts.teamId);
  if (opts.before) q.set("before", opts.before);
  if (opts.beforeId) q.set("beforeId", opts.beforeId);
  if (opts.actorId) q.set("actorId", opts.actorId);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return api<TeamActivityList>(`/api/team/activities${suffix}`, {}, request);
};

/** 上报本机摘要（≤50 条/次，按 sourceId 幂等去重）。 */
export const uploadTeamActivities = (items: TeamActivityInput[], request?: ApiRequestOptions) =>
  api<TeamActivityWriteResult>(
    "/api/team/activities",
    {
      method: "POST",
      body: JSON.stringify({ items }),
    },
    request,
  );

/** 撤回本人已上传的全部动向。 */
export const clearMyTeamActivities = (request?: ApiRequestOptions) =>
  api<void>("/api/team/activities/mine", { method: "DELETE" }, request);

/**
 * 团队用量（②-3）：只上报白名单摘要（自然日/模型名/连接名/token 数/未上报轮数），
 * 按 `(actor, date, model)` 覆盖式幂等——重复同步同一份数据不会翻倍。
 */
export const uploadTeamUsage = (items: TeamUsageInput[], request?: ApiRequestOptions) =>
  api<TeamUsageWriteResult>(
    "/api/team/usage",
    {
      method: "POST",
      body: JSON.stringify({ items }),
    },
    request,
  );

/** 本人用量明细 + 同队成员排行（没有团队时只有自己）；`to` 传本地今天（服务端不猜时区）。 */
export const fetchTeamUsage = (
  opts: { range?: TeamUsageRange; to?: string; teamId?: string } = {},
  request?: ApiRequestOptions,
) => {
  const q = new URLSearchParams();
  if (opts.range) q.set("range", opts.range);
  if (opts.to) q.set("to", opts.to);
  // 排行按团队收口：一个人可能同时在多个团队里，不传则是并集（首页卡片）。
  if (opts.teamId) q.set("teamId", opts.teamId);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return api<TeamUsageResponse>(`/api/team/usage${suffix}`, {}, request);
};

/** 删除本人已上传的全部用量行（关闭共享不删数据，删除必须是显式动作）。 */
export const clearMyTeamUsage = (request?: ApiRequestOptions) =>
  api<TeamUsageClearResult>("/api/team/usage/mine", { method: "DELETE" }, request);

/* ══════════════════════════════════════════════════════════════════════
 * 团队工作台（d.92 · 用户自建团队）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 与上面「同队成员可见」的 TeamRoster/TeamActivity 是两层东西：
 * 这里是用户自己建的工作组（名字 / 目标 / 方案 / 任务 / 成员），权限判定只在
 * 服务端（是否成员 / 是否 owner）。智能体能力提供者 `team_*`（lib/capability/teamTools.ts）
 * 与 UI 走同一套 REST 封装，错误口径一致（ApiError，中文 message 原样上抛）。
 */

/**
 * 下面这批 REST 封装都带一个**可选**的 `request`（中断信号 / 超时）：
 * 智能体工具（teamTools.ts）传 `opts.signal` 后，用户点「中断」会真的收手；
 * 其它调用方不传时行为与以前完全一致。
 */
/** 我加入/拥有的团队列表（不含方案与任务明细）。 */
export const fetchWorkspaceTeams = (request?: ApiRequestOptions) =>
  api<WorkspaceTeamList>("/api/teams", {}, request);

/** 新建团队；返回完整快照（含 owner 自己在 members 里）。 */
export const createWorkspaceTeam = (body: CreateWorkspaceTeamBody, request?: ApiRequestOptions) =>
  api<TeamWorkspaceSnapshot>("/api/teams", { method: "POST", body: JSON.stringify(body) }, request);

/** 单个团队的完整工作台快照（team + members + plans + tasks）。 */
export const fetchWorkspaceTeam = (id: string, request?: ApiRequestOptions) =>
  api<TeamWorkspaceSnapshot>(`/api/teams/${id}`, {}, request);

/** 改团队名/目标；返回更新后的快照。 */
export const updateWorkspaceTeam = (
  id: string,
  body: UpdateWorkspaceTeamBody,
  request?: ApiRequestOptions,
) =>
  api<TeamWorkspaceSnapshot>(
    `/api/teams/${id}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
    request,
  );

/** 解散团队（owner 才能删）；成功无响应体。 */
export const deleteWorkspaceTeam = (id: string, request?: ApiRequestOptions) =>
  api<void>(`/api/teams/${id}`, { method: "DELETE" }, request);

/** 按用户名把已有用户拉进团队；返回更新后的快照。 */
export const addWorkspaceMember = (
  id: string,
  username: string,
  request?: ApiRequestOptions,
) =>
  api<TeamWorkspaceSnapshot>(
    `/api/teams/${id}/members`,
    {
      method: "POST",
      body: JSON.stringify({ username }),
    },
    request,
  );

/** 把某个成员移出团队（owner 才能移）；返回更新后的快照。 */
export const removeWorkspaceMember = (id: string, userId: string, request?: ApiRequestOptions) =>
  api<TeamWorkspaceSnapshot>(
    `/api/teams/${id}/members/${userId}`,
    { method: "DELETE" },
    request,
  );

/**
 * 自己退出团队（成员自救；owner 不能直接退，服务端 409 要求先转让或解散）。
 * 成功无响应体：退出后这个团队对本人就不可见了，要重新加入得队长再拉一次。
 */
export const leaveWorkspaceTeam = (id: string, request?: ApiRequestOptions) =>
  api<void>(`/api/teams/${id}/leave`, { method: "POST" }, request);

/** 把队长转让给团队里的某位成员（仅 owner）；返回更新后的快照。 */
export const transferWorkspaceTeamOwner = (
  id: string,
  userId: string,
  request?: ApiRequestOptions,
) =>
  api<TeamWorkspaceSnapshot>(
    `/api/teams/${id}/owner`,
    {
      method: "POST",
      body: JSON.stringify({ userId }),
    },
    request,
  );

/** 新增方案项（团队的「怎么做」）。 */
export const createTeamPlan = (
  teamId: string,
  body: CreateTeamPlanBody,
  request?: ApiRequestOptions,
) =>
  api<TeamPlanItem>(
    `/api/teams/${teamId}/plans`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    request,
  );

/** 改方案项（标题/说明/状态/排序）。 */
export const updateTeamPlan = (
  teamId: string,
  planId: string,
  body: UpdateTeamPlanBody,
  request?: ApiRequestOptions,
) =>
  api<TeamPlanItem>(
    `/api/teams/${teamId}/plans/${planId}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
    request,
  );

/** 删方案项（归属该方案的任务由服务端决定如何处理）。 */
export const deleteTeamPlan = (teamId: string, planId: string, request?: ApiRequestOptions) =>
  api<void>(`/api/teams/${teamId}/plans/${planId}`, { method: "DELETE" }, request);

/** 派任务（可挂在方案下、可指派给成员）。 */
export const createTeamTask = (
  teamId: string,
  body: CreateTeamTaskBody,
  request?: ApiRequestOptions,
) =>
  api<TeamTask>(
    `/api/teams/${teamId}/tasks`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    request,
  );

/** 改任务（状态/负责人/标题/说明/截止时间/交付物）。 */
export const updateTeamTask = (
  teamId: string,
  taskId: string,
  body: UpdateTeamTaskBody,
  request?: ApiRequestOptions,
) =>
  api<TeamTask>(
    `/api/teams/${teamId}/tasks/${taskId}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
    request,
  );

/** 删任务。 */
export const deleteTeamTask = (teamId: string, taskId: string, request?: ApiRequestOptions) =>
  api<void>(`/api/teams/${teamId}/tasks/${taskId}`, { method: "DELETE" }, request);

/**
 * E2E 公钥分发与明文重加密（Task 2 契约，设计 §3.1/§7）：
 * - fetchE2eKeys：GET 全部用户设备公钥 {userId: [devices]}（X3DH 发起侧取对端 IK/SPK；
 *   会话层 E2eDeps.fetchPeerKeys 由接线层包一层按 userId 取值）。
 * - putE2eKeys：PUT 登记本人设备公钥（服务端 204 无响应体）。
 * - reencryptMessage：PUT 把本人 plain 消息原子重封为 e2e 信封。
 */
export const fetchE2eKeys = () => api<E2eKeysResponse>("/api/e2e/keys");
export const putE2eKeys = (body: PutE2eKeysBody) =>
  api("/api/e2e/keys", { method: "PUT", body: JSON.stringify(body) });
export const reencryptMessage = (messageId: string, body: ReencryptBody) =>
  api<Message>(`/api/messages/${encodeURIComponent(messageId)}/reencrypt`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

/** 右栏用量：当前用户已用字节 + 每用户配额字节（服务端读 HEMING_FILE_QUOTA_MB）。 */
export const fetchFileUsage = () => api<{ used: number; quota: number }>("/api/files/usage");

/** Uint8Array → base64（逐字节拼二进制串，与既有 uploadFile 同法）。 */
function btoaBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** POST /api/files 与 413 配额映射（uploadFile / uploadEncryptedFile 共用一条通道）。 */
async function postFileJson(payload: {
  name: string;
  mime: string;
  contentBase64: string;
}): Promise<SharedFileMeta> {
  try {
    return await api<SharedFileMeta>("/api/files", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // 服务端每用户配额超限（api() 把 body.error 作为 message 抛出）→ 换成用户可读文案；
    // 网关等非 JSON 体的 413（message 形如 "http 413"）保持原 ApiError 不动。
    if (e instanceof ApiError && e.status === 413 && e.message === "quota_exceeded") {
      throw new Error("超出存储配额");
    }
    throw e;
  }
}

/**
 * 上传共享库文件（右栏「上传」与右栏投递共用同一路径）：
 * 浏览器 File → ArrayBuffer → 手工逐字节拼二进制串 → btoa（TextEncoder 不必引入，
 * 文件名/类型走 JSON 字段，contentBase64 只承载原始字节）。上限由服务端 8MB json 上限兜底。
 * 明文语义（规格 §2.4）：显式共享=明文是既定产品语义——右栏上传/投递**保持明文**；
 * 消息附件的加密走 uploadEncryptedFile（同一 base64 通道，先加密再 POST）。
 */
export async function uploadFile(file: File): Promise<SharedFileMeta> {
  const buf = await file.arrayBuffer();
  return postFileJson({
    name: file.name,
    mime: file.type || "application/octet-stream",
    contentBase64: btoaBytes(new Uint8Array(buf)),
  });
}

// —— E2E Task 5：消息附件加密（规格 §2.4 文件边界——消息附件加密，右栏共享保持明文）——

/**
 * 附件密文 AAD（固定上下文串）：AES-GCM 的 additionalData 不随密文传输，上传与解密两侧
 * 必须同源同值——本常量即两侧唯一口径（api.test 与 ChatPage.test 各自独立拼一份做锁定，
 * 改动此处不同步改测试 → 解密即红）。IV 12B 随机、**前置于密文字节**：
 * contentBase64 = base64(iv(12) || ciphertext||tag(16))，解密时按同布局切分。
 */
const FILE_ENC_AAD = new TextEncoder().encode("heming.e2e.file.v1");
const FILE_IV_LEN = 12;
const FILE_KEY_LEN = 32;

/** 无 subtle 的附件拦截文案（与 ChatPage NO_E2E_NOTICE 同语义；api 层不 import 组件防环）。 */
/**
 * 无安全上下文（file:// 或 http 非回环）时统一的加密不可用文案。
 * 聊天页横幅与附件上传失败共用这一句，避免同一条件两种说法。
 */
export const NO_E2E_MESSAGE =
  "当前环境无法加密消息，请在桌面端打开，或使用以 https 开头的网址访问";

const NO_E2E_FILE_ERROR = `${NO_E2E_MESSAGE}（附件未处理）`;

/** 解密失败的可读文案（密钥不匹配/密文损坏/AAD 漂移统一口径，气泡占位直接展示）。 */
const FILE_DECRYPT_ERROR = "附件解密失败（密钥不匹配或数据已损坏）";

/**
 * 加密上传消息附件：随机 32B fileKey → AES-256-GCM 加密原字节 → POST /api/files。
 * 服务端只见密文：mime 置 application/octet-stream、name 加 `.enc` 前缀（共享库列表里
 * 也能一眼认出密文项，且不落明文类型供嗅探）；**fileKey 不上行**，由调用方随消息进密文
 * （payload.file.key，见 shared MessagePayload.file）。返回的 name/mime/size 是服务端
 * 密文形态；消息 payload 请用原文件的 name/mime/size + 本返回的 id/key（气泡按原 mime
 * 路由 image/audio、按原名展示与下载）。
 * 无 subtle 拦截：不发任何请求、不发明文（规格 §2.1 拒绝不降级）。
 */
export async function uploadEncryptedFile(file: File): Promise<{
  id: string;
  name: string;
  mime: string;
  size: number;
  key: string;
}> {
  if (!hasSubtle()) throw new Error(NO_E2E_FILE_ERROR);
  const plain = new Uint8Array(await file.arrayBuffer());
  const keyBytes = crypto.getRandomValues(new Uint8Array(FILE_KEY_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(FILE_IV_LEN));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: toArrayBuffer(FILE_ENC_AAD) },
      cryptoKey,
      toArrayBuffer(plain),
    ),
  );
  const sealed = new Uint8Array(iv.length + ct.length);
  sealed.set(iv, 0);
  sealed.set(ct, iv.length);
  // CreateFileBody.name 上限 255：前缀后超长截断（原名尾段丢失属极端边界，服务端契约优先）
  const meta = await postFileJson({
    name: (".enc" + file.name).slice(0, 255),
    mime: "application/octet-stream",
    contentBase64: btoaBytes(sealed),
  });
  return { id: meta.id, name: meta.name, mime: meta.mime, size: meta.size, key: toB64(keyBytes) };
}

/**
 * 解密下载附件（uploadEncryptedFile 的逆向）：与 fetchFileBlobUrl 同鉴权同错误口径
 * （Bearer 头、401 触发全局 onUnauthorized 并抛 ApiError），差异在拿到密文后用 fileKey
 * 做 AES-GCM 解密再打包 Blob。objectURL 由调用方按既有模式创建与 revoke（AttachmentPreview/
 * AudioBubble 的晚到即销 + cleanup 销仍成立）——本函数只负责取回明文 Blob。
 * mime 决定 Blob type（<img>/<audio> 对 blob: URL 的类型嗅探依据）；调用方通常传 payload.file.mime。
 * 解密失败抛 FILE_DECRYPT_ERROR（HTTP 错误保持原 ApiError 不吞）。
 */
export async function downloadEncryptedFile(
  id: string,
  key: string,
  mime = "application/octet-stream",
): Promise<Blob> {
  if (!hasSubtle()) throw new Error(NO_E2E_FILE_ERROR);
  const headers = new Headers();
  const t = token ?? localStorage.getItem("heming.token");
  if (t) headers.set("Authorization", `Bearer ${t}`);
  const res = await fetch(resolveUrl(`/api/files/${id}/content`), { headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, body.error ?? `http ${res.status}`);
  }
  const sealed = new Uint8Array(await (await res.blob()).arrayBuffer());
  if (sealed.length <= FILE_IV_LEN) throw new Error(FILE_DECRYPT_ERROR);
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(fromB64(key)),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(sealed.slice(0, FILE_IV_LEN)), additionalData: toArrayBuffer(FILE_ENC_AAD) },
      cryptoKey,
      toArrayBuffer(sealed.slice(FILE_IV_LEN)),
    );
    return new Blob([plain], { type: mime });
  } catch {
    // WebCrypto OperationError（密钥错/AAD 变）与 atob 坏 key 统一成可读文案，不吐栈
    throw new Error(FILE_DECRYPT_ERROR);
  }
}

/** Uint8Array → ArrayBuffer 背书（TS 5.9 BufferSource 收紧，同 e2eCrypto 的同名工具）。 */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * 附件内容取 objectURL（气泡缩略图 <img> / 文件卡 <a download> 共用）：
 * content 路由 authOnly 只认 Authorization 头，而浏览器裸 <img src>/<a href> 的标签页
 * 请求带不上鉴权（实测 401 断图）→ 带 token fetch 取 blob 后 URL.createObjectURL。
 * 401 与 api() 同口径触发全局 onUnauthorized 并抛 ApiError；不设 Content-Type（GET 取二进制）。
 * 调用方负责在组件卸载/换附件时 URL.revokeObjectURL（见 ChatPage 的 AttachmentPreview）。
 */
export async function fetchFileBlobUrl(id: string): Promise<string> {
  const headers = new Headers();
  const t = token ?? localStorage.getItem("heming.token");
  if (t) headers.set("Authorization", `Bearer ${t}`);
  const res = await fetch(resolveUrl(`/api/files/${id}/content`), { headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, body.error ?? `http ${res.status}`);
  }
  return URL.createObjectURL(await res.blob());
}

/**
 * 附件内容取纯文本（预览文本/Markdown 内嵌用）：与 fetchFileBlobUrl 同鉴权（content 路由
 * authOnly 只认 Authorization 头），差异只在返回 res.text() 而非 objectURL——先取 blob URL
 * 再二次 fetch 解码绕了一圈，文本路径独立函数更直白。401 同口径触发全局 onUnauthorized。
 */
export async function fetchFileBlobText(id: string): Promise<string> {
  const headers = new Headers();
  const t = token ?? localStorage.getItem("heming.token");
  if (t) headers.set("Authorization", `Bearer ${t}`);
  const res = await fetch(resolveUrl(`/api/files/${id}/content`), { headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, body.error ?? `http ${res.status}`);
  }
  return res.text();
}
