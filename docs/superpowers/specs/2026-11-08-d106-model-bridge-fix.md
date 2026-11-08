# d.106 修复「模型页用不了」：命令桥接线 + 浏览器降级收口

- 日期：2026-11-08
- 版本：`d.106.2.42.0`（特性 +1）
- 承接 d.100–d.104 的模型页。

## 1. 根因：命令桥只存在于工作区，没进提交

用户反馈「模型页用不了」。真机复现（Electron + 本机服务 + CDP 截图）发现：

```
window.__heming_magpie 只有 status/start/stop/gateway
→ getMagpieCliBridge() 返回 null
→ 页面显示「浏览器端可以查看…」，来源/账号/运行里的所有操作不可用
```

根因是 d.100 那一轮对 `packages/desktop/main.js` 与 `preload.js` 的命令桥改动
**没有落进提交**（并发的另一会话把工作区改动覆盖了），而页面测试用 mock 桥，
所以测试全绿、发布版里桥却不存在。

## 2. 修复

- 重新接上命令桥：
  - preload 暴露 `__heming_magpie` 的 `cli / cliStart / cliInput / cliKill / openTerminal / onCli`；
  - 主进程注册 `magpie:cli / cli:start / cli:input / cli:kill / terminal` 五个通道，
    全部登记 `TRUSTED_CHANNELS`，仍走白名单 + 无 shell；
- **回归守卫**：新增 `packages/desktop/magpie-wiring.test.js`，直接读源码断言
  「preload 六个方法都在」「主进程五个通道都注册且在 TRUSTED_CHANNELS」「参数走 validateCliArgs
  而不是拼 shell」——任何一端再丢，桌面门禁立刻红；
- 真机验证（Electron dev + 本机服务 + CDP）：桥的 keys 变成 10 个；
  `cli(["providers"])` 返回真实来源；模型页显示「已添加来源 1 / 可用模型 1」。

## 3. 浏览器端降级收口

之前浏览器里显示完整三个分区，但所有写操作都禁用，看起来像「坏了」。现在：

- 没有命令桥时只显示「模型」与「运行」两个分区，隐藏「来源」；
- 顶部明确说明：模型能力运行在你的电脑上，管理请用和鸣桌面端；
- 「模型」页只读列表与搜索，不再出现可点但无效的卡片。

## 4. 关于「复用 magpie 原版」

- 读了原版路由页的实现（`internal/gui/assets/plugins/routing/`）：布局是三列
  「客户端卡片 → hub 卡片 → 账号行卡片」+ 覆盖层曲线；动效是
  `rtflow .7s linear infinite`（虚线流动）、`rtlive 1.8s`（呼吸点）、
  `rtin .3~.4s ease-out`（入场）、hover 200ms/边框 300ms；
- d.104 的模型页与实时链路已按这套参数与结构重做（分段控件、行卡片、0.7s 流动、
  1.8s 呼吸点、300ms 入场、减少动效开关），而不是另起一套观感；
- 没有直接内嵌它的网页产物：那会把第三方品牌与服务进程重新带回界面，且需要额外
  起一个网页服务。若后续仍要 100% 原版组件，可评估「内嵌原版页面 + 注入品牌层」方案。

## 5. 验证

- 桌面门禁（含新守卫）：通过；
- web 全量用例与 typecheck：见发版记录；
- 真机：模型页三个分区正常、命令桥真实可用、截图确认布局。
