# d.44 · 插件更新预览与能力详情

- 日期：2026-11-01
- 相关版本：d.43.1.11.0（基线）、本 spec = d.44.1.11.0（特性位 +1）
- 涉及包：`packages/web`（纯前端，不改服务端、不改共享协议）
- 上游判断：d.43 把插件做成**系统能力包**（技能 + 远程 MCP 服务），装得进、停得下、卸得净。但「同 id 再装 = 覆盖更新」目前是一句黑箱承诺：用户看不到这一版到底动了什么，也看不到一个插件此刻实际握着哪些能力。

## 0. 问题

- **更新是黑箱**：安装面板只显示「将覆盖更新」，不说明会新增/改动/删除哪些技能与服务。插件包会被转发、存档，版本一变就可能是别人改过的包，用户没法定夺要不要接受。
- **规则藏在代码里**：技能按名称匹配、服务按 `key` 匹配、清单移除即删除、用户请求头与工具启用保留——这些语义只在 CHANGELOG 与注释里，界面上一句都没有。
- **冲突与上限迟到**：服务 id 被手填服务占用、插件数满 50 时，只有在点「确认安装」后才以「安装失败」出现；用户已经为这次更新付出一次失败尝试。
- **能力不可纵览**：插件卡只铺清单里的名字，不是实际物化结果。技能可能被用户在技能区单独删掉，服务也可能被改名或转正；卡片与会话真实可用状态并不一致，也没有一个地方能一次看清「这个包给了我什么、现在开着没有」。

## 1. 决策

### A. `PluginStore.preview(input)`：纯差异快照

只做「解析 + 比对」，**不写插件记录、不碰技能池、不碰 MCP 注册表**，与 `install` 共用同一套语义（`pluginServerId`、按名/按 key 匹配、清理范围）。

```ts
export interface PluginServerDiff { key: string; name: string }

export interface PluginPreview {
  manifest: PluginManifest;
  existing: InstalledPlugin | null;      // null = 新插件
  skills:  { added: string[]; changed: string[]; unchanged: string[]; removed: string[] };
  servers: { added: PluginServerDiff[]; changed: PluginServerDiff[];
             unchanged: PluginServerDiff[]; removed: PluginServerDiff[] };
  conflicts: { id: string; name: string }[];  // 非插件来源占用 incoming id
  hosts: string[];                            // URL.host，含端口，去重保序
  limitReached: boolean;
}
```

**技能**：以 `skillPool` 中 `pluginId === manifest.id` 的**实际技能**为准，不读旧清单。

| 条件 | 归类 |
|---|---|
| 来名在池中无同名技能 | `added` |
| 同名且 `description / instructions / triggers / tags` 全等（数组按元素逐项比） | `unchanged` |
| 同名但任一字段不同 | `changed` |
| 池中有、来名里没有 | `removed` |

用户在技能区手删过的技能会重新落到 `added`——与 `install` 会重建它一致。

**MCP 服务**：id = `pluginServerId(manifest.id, key)`，以 MCP 注册表**实际配置**为准。

| 条件 | 归类 |
|---|---|
| 已存在且 `origin !== "plugin"` | `conflicts`（**不**进 added/changed/unchanged，安装必失败） |
| 不存在 | `added` |
| 存在且 `name` 或 `url` 任一不同 | `changed` |
| 存在且 `name` 与 `url` 相同 | `unchanged` |
| 旧 `serverIds` 中已不被清单引用、且注册表里仍 `origin === "plugin"` | `removed` |

`removed` 的 `key` 由 id 去掉 `plugin:<插件 id>:` 前缀得到（前缀不匹配时用 id 兜底），`name` 取注册表实际名。

**其余**：`hosts` 取清单内每个服务 URL 的 `URL.host`（含端口）；`limitReached` 仅当 `existing === null` 且已装数 `>= MAX_PLUGINS`。清单非法时抛 `PluginManifestError`（与 `install` 同一错误），页面据此就地报错。

### B. `skillsOf` / `serversOf`：详情视图的窄信息口

```ts
skillsOf(pluginId: string): { id: string; name: string; description: string; enabled: boolean }[]
serversOf(pluginId: string): { id: string; name: string; url: string; enabled: boolean }[]
```

- `skillsOf`：按 `pluginId` 从技能池实际过滤（技能自持归属），已手删的自然消失。
- `serversOf`：以插件记录的 `serverIds` 为索引逐个 `mcp.get`，注册表里已不存在的跳过；读的是实际 `name/url/enabled`，不是清单。
- 两者都不发起连接、不读工具清单、不写任何东西。

### C. 安装面板改用预览

- **新插件**：显示「技能 N · 服务 M」计数，保留现有网络访问 host 行与「连接/启用/人工确认」口径。
- **更新**：两行摘要（`技能 +a ~c =u -r`、`服务 +a ~c =u -r`）+ 前缀 chip（`+ 新增` / `~ 变更` / `- 移除`，`unchanged` 只计数不铺 chip）+ 一行保留声明：「更新不会改动接口区补的请求头、已启用的工具、插件启停状态与初次安装时间」。
- **冲突**：`role="alert"` 阻断块列出冲突 id 与服务名，提示「先在接口区删除或改名」，确认按钮 `disabled`。
- **上限**：`limitReached` 时同样阻断并提示「插件数量已达上限（50 个）」，确认按钮 `disabled`。
- 安装动作本身不变：仍调 `plugins.install(text)`，成功/失败消息沿用 d.43 文案。

### D. 插件卡「详情」弹窗

- 卡片操作区新增「详情」，打开 `role="dialog" aria-modal="true"` 弹窗（`useModalA11y(ref, close, { active })`，Esc / 点遮罩 / 关闭按钮可退，焦点归还触发按钮）。
- 内容：名称、版本、启停、id、作者、描述、安装与更新时间；**技能列表**（名称 + 描述 + 启用徽标）；**MCP 服务列表**（名称 + host + 启用徽标）。数据取自 `skillsOf` / `serversOf`，打开时按当前池与注册表计算。
- 空态各给一行：纯技能包写「本包未声明 MCP 服务」，纯服务包写「本包未声明技能」。
- 页脚：`查看技能` / `查看接口` / `卸载`。卸载**先关详情**再弹 d.43 的卸载确认框，避免双层模态。
- 只展示登记态：**不做连接探测、不显示工具列表、不提供工具开关**；连接与逐工具授权仍在接口区。

### E. 边界

- 不新增存储键，不改 `heming.plugins.v1` 结构，不做网络请求，不引入第二套能力系统。
- 预览是**咨询性**的：结论必须与 `install` 实际行为一致；不一致时以 `install` 为准并视为缺陷。
- `install` 的写入顺序、冲突检查时机、保留规则一概不动。

## 2. 明确不做

- 市场安装 / URL 直装 / 版本回滚 / 差异存档。
- 签名校验与来源可信度评估。
- OAuth 发现、动态注册、stdio 或命令类服务。
- 自动连接、自动启用工具、自动更新。
- 按插件限定智能体分配。
- 详情里的逐工具开关（工具授权只属接口区）。
- 导出清单、下载 plugin.json 或生成更新包。

## 3. 验收

1. `preview` 为纯函数：调用前后 `heming.plugins.v1`、技能池、MCP 注册表快照逐字不变。
2. 新插件 / 更新 / 完全一致（全 `unchanged`）/ 服务 id 冲突 / 插件数上限五种场景分类正确，且与随后真正 `install()` 的结果一致。
3. 技能 diff 以实际技能池为准：手删技能后预览报 `added`；只改 `triggers` 也报 `changed`。
4. 服务 diff 以注册表为准：改 `url` 报 `changed`，转正（改来源）的服务不出现 `removed`。
5. 冲突或超限时确认按钮不可点，并给出中文阻断原因；解除后恢复可点。
6. 详情弹窗显示实际物化的技能与服务（含启用状态与 host），技能/服务为空时有空态说明；Esc 可关且焦点回到「详情」。
7. 详情里卸载先关弹窗再确认；`查看技能` / `查看接口` 切页行为与 d.43 卡片按钮一致。
8. d.42 / d.43 既有行为（安装、更新、启停、卸载、接口区标记）不变；全量门禁 `pnpm -r build && pnpm -r --workspace-concurrency=1 test` 全绿。
