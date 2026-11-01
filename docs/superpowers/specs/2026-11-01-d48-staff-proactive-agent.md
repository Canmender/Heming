# d.48 · 常驻幕僚：主动式简报

- 日期：2026-11-01
- 状态：待实现
- 版本：`d.48.1.11.0`（暂定；d.47 自动化仍在工作区未提交，版本收口另行确认）
- 关联：d.37 会话连续性、d.39 全域消息感知、d.40 会话中心、d.45/d.46 信息中枢、d.47 本机自动化

---

## 1. 问题

和鸣目前是**被动**的：智能体只在用户 `@` 它、点发送时才动；任务区只在用户打开时展示；信息中枢的日程也需要用户主动去看。

用户真正需要的不是"再问一次"，而是**它替我盯着，出事再叫我**。学生干部的真实日常里，漏掉的往往不是"不会做"，而是"没看到"：日程临期、任务卡住、昨天失败的一次执行。

## 2. 目标与非目标

### 目标

1. **常驻**：登录后、应用打开期间，幕僚按时间与事件自行巡检，不依赖用户停在某个页面。
2. **只递简报**：产出结构化简报（摘要 + findings + 证据 + 跳转），**不代用户执行任何写操作**。
3. **可解释**：每条结论都能追到具体日程/任务；模型总结失败时退回确定性规则，不编造。
4. **可关、可预算、可追溯**：开关、晨报时间、静默时段、每日运行上限与 token 上限、历史简报都能查看与修改。
5. **零新增基础设施**：不引守护进程、不开端口、不上云、不改服务端协议；所有数据留在本机 localStorage。

### 非目标（本版明确不做）

- 不做自动执行（自动建任务、自动回复、自动改日程）——所有动作交给用户点击。
- 不做归档全文巡检（`infohub` 的检索留给 d.46 工具与 Ctrl+K）；本版日程只读 InfoHub 已生成的议程。
- 不做后台常驻进程/托盘；应用关闭即停止巡检。
- 不做插件化触发器编辑器；第一版是固定的三路内置触发。
- 不做服务端推送与跨设备同步。

## 3. 红线

| 红线 | 本版落实方式 |
|---|---|
| 个人数据不出设备 | 简报、设置、去重账本全部本机键；无上传路径。 |
| 智能体本机执行 | 模型调用复用 `streamChat(profile, …)`，目标只随用户自己的 `baseUrl`。 |
| 不自动执行写 | 只读采集 + 只读跳转；不调用 `infohub_agenda_rebuild`、不建任务、不发消息。 |
| 归档进程由用户拉起 | 幕僚只在 `useInfohubStore.running` 为真时读取议程；**绝不调用 `connect()` / `startInfohub()`**。 |
| 系统通知不泄露内容 | 桌面通知正文固定「有你可能需要处理的事」，不携带日程标题/任务名。 |
| 不静默降级 | LLM 失败 → 规则模式并在运行记录标 `mode:"fallback"`；采集失败 → 跳过本次并保留错误，不伪装成"今天没事"。 |

## 4. 触发口径

固定三路，均可在设置里单独关闭：

| 触发 | 时机 | 去重 | 说明 |
|---|---|---|---|
| `daily` 晨报 | 每天到达设置时间（默认 08:00，本地时区），每日一次 | `lastDailyDate` | 即使没有发现也生成一份"今天没有临期事项"的简报，证明它跑过。 |
| `agenda` 日程临期 | 每 15 分钟检查一次议程；出现**逾期**或 **24 小时内到期**且未提醒过的条目 | `seen.agenda["<id>:<bucket>"]` | bucket = `overdue` / `today` / `next24h`；同一日程升级（今天 → 逾期）可再提醒一次。 |
| `task` 任务异常 | 每 15 分钟检查一次任务；**卡住**（`running` 且超过 10 分钟无更新）或**最近 24 小时失败**且未提醒过 | `seen.tasks["<id>:<fingerprint>"]` | fingerprint 取 `updatedAt`/`endedAt`；任务状态再次变化才允许再提醒。 |

**节奏约束**：

- 巡检 tick：60 秒；日程/任务采集每 15 分钟一次（缓存），避免每次 tick 都打 IPC。
- 事件触发之间有 **10 分钟冷却**；`daily` 与 `manual` 不受冷却限制。
- 自动事件运行（`agenda`/`task`）每日上限默认 **8 次**；晨报每天至多一次、不受该上限约束；手动运行不计入上限。
- 静默时段（默认 22:00–07:30）：仍生成简报与站内通知，**不弹系统通知**；晨报在静默时段内就延后到静默结束后的第一个 tick。
- 首次开启：`lastDailyDate` 为空且当前已过晨报时间 → 立即生成第一份晨报，让用户当场看到价值。

## 5. 采集与简报

### 5.1 事实源

- **议程**：`useInfohubStore.agenda`（`InfohubAgendaResult`）。条目字段用 `id/title/detail/dueTs/dueText/convName/senderName/conversationId`。
  - 逾期：`dueTs > 0 && dueTs < now`
  - 今天：`dueTs` 落在本地当天
  - 24 小时内：`now < dueTs <= now + 24h`
- **任务**：`useTaskStore.getState().tasks`（`TaskRecord`）。
  - 卡住：`task.status === "running" && now - task.updatedAt > 10min`
  - 失败：`task.status === "failed" && endedAt/updatedAt` 在 24 小时内
  - 进行中数量作为晨报摘要的一部分（不作为单独 finding）。
- **不读取**消息正文、记忆正文、归档原文。

### 5.2 规则模式（默认）

确定性生成 findings，最多 8 条，按 `urgent > warn > info`、再按到期时间排序：

| 来源 | 级别 | 标题 | 详情 |
|---|---|---|---|
| 逾期日程 | urgent | `已逾期：<title>` | `<convName> · 原定 <dueText> · <senderName>` + 本地 `detail` 截断 |
| 今天日程 | warn | `今天：<title>` | 同上 |
| 24 小时内 | warn | `24 小时内：<title>` | 同上 |
| 卡住任务 | warn | `任务可能卡住：<title>` | `已 N 分钟无更新` |
| 失败任务 | warn | `任务失败：<title>` | 错误原因截断 |

晨报摘要（规则）：`今天有 X 条日程临期、Y 个任务需要留意。`；全空时：`今天没有临期事项，也没有异常任务。`

### 5.3 模型模式（可选）

用户在幕僚设置里绑定一个已有的 LLM 连接（`LlmProfile`）后，每次运行额外做**一次**一次性调用：

- 输入：**脱敏事实**——日程只发 `title/dueText/convName/senderName/bucket`，任务只发 `title/status/error`；**不发 `detail`、不发消息正文**。
- 输出：严格 JSON
  ```json
  { "summary": "一句话", "findings": [
    { "severity": "urgent|warn|info", "title": "…", "detail": "…", "refs": ["agenda:12", "task:abc"] }
  ] }
  ```
- 校验：`summary` ≤ 200 字；findings ≤ 7；标题 ≤ 40 字、详情 ≤ 160 字；`refs` 必须命中本次提供的事实 id；非法条目丢弃。
- **安全合并**：规则模式算出的 `urgent` 与 `warn` 条目若未被模型 `refs` 覆盖，**强制补回**，防止模型把逾期日程吞掉。
- 失败（超时 25s、HTTP 错、JSON 非法、全部条目被丢弃）→ 回退规则模式，运行记录 `mode:"fallback"` 并保留错误摘要。
- 用量：`streamChat` 的 `onUsage` 累加后记入 `heming.tokenUsage`；拿不到 usage 记 `recordUnreported`。运行记录保存 `tokens: number | null`。

## 6. 数据模型与存储

### 6.1 设置 `heming.staff.v1`

```ts
interface StaffSettings {
  enabled: boolean;
  dailyAt: string;             // "08:00"
  quietFrom: string;           // "22:00"
  quietTo: string;             // "07:30"
  sources: { daily: boolean; agenda: boolean; task: boolean };
  profileId: string | null;    // null = 规则模式
  dailyRunCap: number;         // 1–24，默认 8
  dailyTokenCap: number;       // 0 = 不限；默认 30000
  lastDailyDate: string | null;// "YYYY-MM-DD"（本地）
}
```

### 6.2 历史 `heming.staff.runs.v1`

```ts
interface StaffRun {
  id: string;
  trigger: "manual" | "daily" | "agenda" | "task";
  mode: "rules" | "llm" | "fallback";
  startedAt: number;
  finishedAt: number;
  summary: string;
  findings: StaffFinding[];
  tokens: number | null;
  error?: string;
}
interface StaffFinding {
  id: string;
  severity: "urgent" | "warn" | "info";
  title: string;
  detail: string;
  evidence: { label: string; kind: "agenda" | "task"; refId: string; conversationId?: string; taskId?: string }[];
  action?: { kind: "open-infohub" | "open-task" | "open-conversation"; targetId?: string; conversationId?: string };
}
```

- 最多 **30** 份、**192KB**；超出按时间淘汰最旧。
- 每条 finding 的文案在落盘前截断（标题 60、详情 240），UI 再按版面截断。

### 6.3 去重账本 `heming.staff.seen.v1`

```ts
interface StaffSeen {
  agenda: Record<string, number>;  // key → 最后提醒时间
  tasks: Record<string, number>;
}
```

- 每类最多 **200** 条，按最后提醒时间淘汰最旧。
- 键不可读/损坏 → 空账本（宁可多提醒一次，不漏）。

### 6.4 存储水位

`STORAGE_MODULE_RULES` 增加 `heming.staff.` → 「幕僚」，避免落入「其它」。

## 7. 调度挂载

- `useStaffLoop(active)` 挂在 `AppShell` 登录后的同一层（与 `useBackgroundMessages`、`useAutomationScheduler` 并列），**不挂在任何页面里**（切页会卸载）。
- 依赖：`useStaffStore`（设置/历史/账本）、`useTaskStore`、`useInfohubStore`、`useLlmStore`。
- 在途锁 + `cancelled` 标志；任何异常 `catch` 后只记录、不抛出。
- `visibilitychange` 回到前台时补一次 tick（后台定时器可能被节流）。
- 浏览器端可运行（任务路可用）；议程路只在 `isInfohubAvailable() && running` 时启用。
- 应用关闭即停止，不引入后台进程。

## 8. 界面

### 8.1 导航

- 新增页 `staff`，标签「幕僚」，**不占数字快捷键**（1–9/0 已排满）。
- `DEFAULT_NAV_ORDER` 追加在 `conversations` 之后；旧用户存储的顺序由 `normalizeNavOrder` 自动补在末尾。
- `SettingsPage` 的 `NAV_LABELS` 补 `staff: "幕僚"`。

### 8.2 幕僚页 `StaffPage`

- 顶部：标题 + 一句话定位；状态行（开关 / 模式 / 下次检查 / 今日自动次数与 token）。
- 操作：「现在跑一次」（busy 禁用）、「设置」展开。
- 设置区：晨报开关与时间、日程临期开关、任务异常开关、静默时段、模型选择（含隐私说明）、每日运行上限、每日 token 上限、清空历史（二次确认）。
- 简报列表（最新在前）：时间、触发源、模式徽标、摘要、findings。
  - finding 行：级别标记、标题、详情、证据 chips、动作按钮。
  - 动作：日程 → `openInfohub({ tab: "agenda" })`；任务 → `focusTask(id, conversationId)`；证据里的会话 → `openConversation(id)`。
- 空态：`还没有简报。开启后，幕僚会在每天 08:00 前后给你一份。`
- 首次开启：立即触发一次手动运行，按钮显示「正在生成第一份简报…」。

### 8.3 首页卡 `StaffHomeCard`

- 未开启：一句定位 + 「开启幕僚」→ 幕僚页。
- 已开启无简报：显示下次检查时间。
- 有简报：最近一份的摘要 + 前 3 条 finding + 「查看全部」。
- 浏览器端照常渲染（任务路可用）。

### 8.4 通知

- 站内通知：`kind:"staff"`，`key:"staff:<runId>"`，标题「幕僚简报」，正文 = 摘要（本机）。
- 仅在 `findings.length > 0` 时推送；「今天没事」的晨报只进历史，不打扰。
- 系统通知：复用 `notifyDesktop`，标题「幕僚简报」、正文固定「有你可能需要处理的事」；静默时段与窗口在前台时不弹。
- 通知中心跳转：`kind:"staff"` → `setPage("staff")`。

## 9. 测试与验收

### 单测

- 模型：设置归一（坏 JSON/非法时间/上限夹紧）、简报淘汰、议程/任务分类、静默时段跨零点、晨报每日一次、finding 排序。
- 存储：设置写入、运行记录、去重账本淘汰、清空历史。
- 生成：规则模式全覆盖；事件触发无事时不生成；LLM JSON 解析/校验/回退；紧急项不被模型吞掉；token 入账。
- 调度：关闭不跑、晨报每日一次、冷却、每日上限、在途锁、不调用 `connect`。
- 页面：空态、开关、手动运行、finding 跳转；首页卡三态。
- 通知：`staff` 类型读盘后不被丢弃。

### 浏览器实测

1. 打开幕僚页 → 开启 → 出现第一份简报（规则模式）。
2. 手动运行 → 历史 +1，通知中心出现「幕僚简报」。
3. 点 finding 动作 → 跳到任务区/信息中枢日程。
4. 关闭开关 → 不再新增；历史上限与空态正常。
5. 控制台无报错；全程不自动拉起 InfoHub 进程。

## 10. 明确不做

- 自动执行、自动建任务、自动回复。
- 归档全文巡检、跨源语义检索。
- 服务端聚合、跨设备同步、团队视图。
- 托盘常驻、应用关闭后的巡检。
- 通用触发器编辑器、插件自定义触发器。
