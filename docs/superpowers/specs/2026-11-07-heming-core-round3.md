# 本体第三轮：宿主页 Tab 的刷新恢复（d.80.2.42.0）

- 日期：2026-11-07
- 分支：`feat/d77-heming-core`
- 来源：第二轮「页面 + 会话」刷新恢复之后，审计 P1-1 里剩下的一半——「团队页所选视图（看板/团队日程/用量）全部重置」，同类还有智能体「任务」Tab、插件区各 Tab、记忆区各 Tab
- 范围：`lib/sessionState.ts` 新增；四个宿主页 Tab 接入；模块 Tab 术语；测试基建 sessionStorage 隔离

## 1. 决策：Tab 与页面同一口径

| 项 | 存储 | 生存期 |
|---|---|---|
| 页面 + 已选会话 | `sessionStorage: heming.session.view.v1` | 本次渲染进程会话（刷新保留、关窗清空） |
| 宿主页 Tab | `sessionStorage: heming.tab.<page>.v1` | 同上 |

不做跨重启记忆：Tab 是「这一次使用」的上下文，不是偏好；关掉应用再开回到默认视图更符合预期。
不做 URL/路由：见 round2 规格 §1 的同一理由（Electron `app://` 内嵌产物，加路由要动渲染/导航/跳转/兼容）。

## 2. 实现

- `lib/sessionState.ts`：
  - `readSessionValue(key, fallback, allowed)`：只认白名单里的字符串，缺失/脏值/非 JSON 一律回落；
  - `writeSessionValue(key, value)`：写失败静默（隐私模式/配额满只在本次内存里切 Tab）；
  - `useSessionTab(key, fallback, allowed)`：`useState` 初值来自快照，setter 同步写盘。
- 接入四处：
  - `TeamPage`：`heming.tab.team.v1`（feed/board/agenda/usage）
  - `AssistantPage`：`heming.tab.assistant.v1`（chat/tasks）
  - `PluginsPage`：`heming.tab.plugins.v1`（plugins/modules/skills/tools/mcp）
  - `MemoryPage`：`heming.tab.memory.v1`（agents/database/wiki）
- 原有「一次性视图意图」（`pageView`）不变：命令面板/通知中心跳转仍然先落指定 Tab 再消费；
  会话记忆只负责「刷新后还在同一 Tab」。

## 3. 测试隔离

`sessionStorage` 成了组件状态的一部分，而同一测试文件的用例共用一个 jsdom——上一个用例切过的 Tab
会漏到下一个用例（表现为「默认 Tab 不对」）。因此在 `test-setup.ts` 里每个用例前清一次
`sessionStorage`；用例内部仍可正常断言写盘（清除发生在前）。这属于测试隔离，不是行为放宽。

## 4. 模块 Tab 术语（同轮顺手）

- 「N 个本机键」→「本机数据 N 项」；「当前生效」→「状态：已生效」；
  「停用只下线入口与后台挂载」→「停用只收起入口与后台任务」。

## 5. 验证

- 单测：`lib/sessionState.test.tsx` 3 例（白名单校验/写失败不抛/useSessionTab 往返恢复）；
  四页原有用例全绿（TeamPage/AssistantPage/PluginsPage/MemoryPage 共 77 例）。
- 真机（1600×1000）：团队切「用量」→ F5 仍在用量；记忆区切「数据库」→ F5 仍在数据库；
  插件区切「MCP 服务」→ F5 仍在 MCP 服务；控制台 0 error。
- 门禁：见提交说明。

## 6. 未做 / 候选

- 会话消息的滚动位置恢复（刷新回到上次读到的位置）——属于滚动记忆，单独做。
- 记忆区「数据库」默认智能体/选择器就近化、模型 Tab 首跑引导、更新日志用户版说明，仍在候选清单。
