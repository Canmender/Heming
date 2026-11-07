# 本体第五轮：第一次配模型少绕两圈（d.82.2.42.0）

- 日期：2026-11-07
- 分支：`feat/d77-heming-core`
- 来源：第一轮审计 P1-7（模型 Tab 首次配置负担重、缺「一步接上」）+ 同轮 P1-2 之后的自然延伸
  （「去设置」虽然已经直达「模型」页签，但「本机明明有连接、只是这个智能体没绑」仍要绕去设置找绑定）
- 范围：`UnboundModelNotice` 扩展快捷绑定；对话页接线；模型 Tab 预设聚焦与首跑说明

## 1. 问题拆成两段

| 场景 | 以前 | 现在 |
|---|---|---|
| 一个连接都没有 | 提示「去设置」（已直达模型页） | 不变 |
| **有连接、但这个智能体没绑** | 只能「去设置」→ 找智能体 → 编辑 → 绑定 | 提示条里「用本机连接」直接选，选中即绑 |
| 首次建连接 | 6 个字段里自己找必填；预设点开不聚焦 | 预设填好 4 项并聚焦 API Key；首跑说明写清三步 |

关键判断：第二种场景不该把用户送去设置页——连接已经在本机，缺的只是一次选择。
因此选择器放在**提示条原地**（`UnboundModelNotice` 的 `connections` / `onBind` 可选参数），
写入路径与智能体编辑弹窗相同（`useLlmStore.setBinding`，落 `heming.agentLlm`）。

## 2. 实现

- `UnboundModelNotice`：
  - 新增 `connections?: {id,label}[]` 与 `onBind?: (id)=>void`；
  - 两者都满足且有连接时渲染「用本机连接」选择器；选中回调后把 select 复位为空（避免显示已选项）；
  - 有快捷绑定时「去设置」改叫「管理连接」（仍能去增删连接），没有可用连接时保持「去设置」。
- `ChatPage`：把 `llmProfiles` 映射成 `connections`，`onBind` 调 `setAgentBinding(unboundAgent.agentId, profileId)`；
  绑定后 `unboundAgent` 由同一解析器重算，提示与发送禁用同时消失。
- `LlmSettingsCard`：
  - 预设点击后 `focusKeyAfterOpen` + `useEffect(open)` 把焦点交给 API Key；
  - 空态说明在表单打开时也保留（原来只在 `!open` 时显示，用户正在填时就看不到下一步了），
    文案写明「点预设 → 只需补 API Key → 保存后到智能体页绑定」。
- 任务区暂不改快捷绑定：启动面板没选定智能体、运行卡属于「历史任务」场景，
  两者继续用同源组件的默认形态（只有「去设置」）。

## 3. 验证

- 单测：`ux.test.tsx` +2、`ChatPage.test.tsx` +1、`LlmSettingsCard.test.tsx` +1（详见 CHANGELOG）。
- 真实浏览器端到端（1600×1000，0 error）：
  设置·模型 → 点 DeepSeek 预设（名称/模型已填、`document.activeElement` 是 API Key）→ 补假 Key 保存 →
  智能体页打开「和小鸣」→ 提示条出现选择器 → 选中后提示消失、`heming.agentLlm` 写入、发送按钮可用。
  截图 `.tmp/d82/quickbind-notice.png`、`.tmp/d82/quickbind-done.png`（不入库）。
- 门禁：见提交说明。

## 4. 未做 / 候选

- 任务区运行卡的快捷绑定（需要先定「绑定哪个智能体」的语义）；
- 多条连接时的默认绑定策略（当前仍要求显式选一次，不做隐式 fallback——模型连接决定费用与数据流向）；
- 会话消息滚动位置恢复、旧版本 RELEASE-NOTES 回填仍在候选清单。
