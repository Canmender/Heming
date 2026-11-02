# d.46 实施计划 · 桌宠

> **编号说明（2026-11-02 补记）**：本文写作时基线为 d.45，故原编号为 d.46。合入前 main 已推进到 d.52.1.13.0，`d.46–d.48` 被信息中枢原生融入 / 自动化中心 / 常驻幕僚占用，两份设计稿亦预留了 d.53/d.54 —— 本文最终以 **d.53.1.13.0** 合入，两份设计稿顺延为 d.54/d.55。文件名保留写作日期的 d46 前缀，避免破坏既有链接。

- 规格：[`../specs/2026-11-01-d46-desktop-pet.md`](../specs/2026-11-01-d46-desktop-pet.md)
- 版本：`d.53.1.13.0`（写作时编号 d.46）

## 执行顺序与依赖

```
T1 资源与依赖 ──┬─→ T3 主进程窗口层 ──→ T4 渲染层 ──→ T5 对话与设置 ──→ T6 门禁与真机
                └─→ T2（纯函数测试，可与 T3 并行）
```

## T1 · 资源与依赖（已完成）

- [x] `packages/web/public/pet/live2dcubismcore.min.js`（官方 CDN，207,155 字节）
- [x] `packages/web/public/pet/Hiyori/`（moc3 443,648 / 贴图 1,814,312 + 2,504,416 / physics / pose / 10 动作）
- [x] `packages/web/public/pet/README.md`（授权与替换说明）
- [x] `packages/web` 增依赖 `pixi.js@6.5.10`、`pixi-live2d-display@0.4.0`

**验收**：`find packages/web/public/pet -type f` 文件大小与上游一致；`pixi-live2d-display/cubism4` 可被 Vite 解析。

## T2 · 窗口层纯函数（`packages/desktop/pet-window.js` + 测试）

- [x] `petWindowOptions(state)`：尺寸由 scale 推导、透明置顶、`backgroundThrottling:false`
- [x] `clampPetState(raw)`：坏 JSON / 越界 scale / 屏幕外坐标 → 回落默认（复用 workArea 校验思路）
- [x] `defaultPetPosition(workArea, size)`：右下角 24px 边距
- [x] `nextScale(current, dir)`：在 `[0.6,0.8,1.0,1.25,1.5]` 档位里移动，首尾夹住
- [x] 模型路径白名单：`sanitizeModelPath`（主进程）/ `isValidModelPath` + `petModelUrl`（渲染层），两侧同一套规则
- [x] `node --test pet-window.test.js` 覆盖以上全部

**验收**：`node --test packages/desktop/pet-window.test.js` 全绿；`node --check pet-window.js` 通过。

## T3 · 主进程接线

- [x] `main.js`：`setWindowOpenHandler` 放行 `hemingWindow=pet`（与 call 分支并列，**先判 pet**）
- [x] 创建/复用单例桌宠窗口；`showInactive()` 首次显示
- [x] 位置尺寸落 `userData/pet-state.json`，`move`/`resize` debounce 500ms
- [x] IPC：`pet:toggle`（显隐）、`pet:state`（读）、`pet:set-interactive`（穿透开关）、`pet:drag-start` / `pet:drag-move` / `pet:drag-end`、`pet:set-scale`、`pet:hide`
- [x] 拖拽在**主进程**用 `getCursorScreenPoint()` + 按下时窗口原点算位置
- [x] 托盘：`assets/pet-tray.png` + 菜单（显示/隐藏、穿透、退出）
- [x] `preload.js` 暴露 `__heming_pet`（只暴露上述动作，不暴露任意窗口操作）
- [x] `package.json` 的 `files` / `typecheck` / `test` 列表补入新文件
- [x] 主进程侧网络红线：`pet-window.js` 与托盘代码不得出现 `http`/`net`/`fetch`

**验收**：`node --check main.js`、`node --test packages/desktop/*.test.js` 全绿；真机启动出现透明窗口。

## T4 · 渲染层

- [x] `packages/web/src/lib/petWindow.ts`：`PET_WINDOW_FLAG` / `parsePetWindowParams` / `buildPetWindowUrl` + 测试
- [x] ~~`main.tsx` 增 pet 分支~~ → 改为**独立入口** `pet.html` + `src/pet.tsx` + Vite 多入口（`main.tsx` 静态 import 了 App，走 query 分支仍会下载整套 bundle）
- [x] `components/pet/PetWindow.tsx`：舞台容器、输入框、气泡、右键菜单、错误态
- [x] `components/pet/useLive2D.ts`：注入 Cubism Core → 建 pixi app → 加载模型 → 视线/点击/口型
- [x] `components/pet/petInteraction.ts`：可交互区判定（纯函数）+ 节流上报 + 拖拽状态机 + 测试
- [x] `lib/petPrefs.ts`：`heming.pet.v1` 读写（坏 JSON 回落、只认白名单字段）+ 测试

**验收**：`pnpm --filter @heming/web build` 通过；主窗口 bundle 不新增 pixi（对比分包产物）。

## T5 · 对话与设置

- [x] `components/pet/usePetChat.ts`：读 `heming.llmConfigs` / `heming.agentLlm` → `streamChat` → 逐字回调
- [x] 无配置 → 气泡提示 + 跳设置（`pet:open-settings` → 主窗口显示并切设置页）
- [x] 口型由流式文字驱动（`ParamMouthOpenY` 振荡），结束归零
- [x] 设置区新增「桌宠」卡：开关、缩放、绑定智能体、穿透模式、模型路径
- [ ] 「打开桌宠」入口（设置区 + 命令面板可选）

**验收**：配好连接后能对话且口型同步；断开配置时提示如实。

## T6 · 收口

- [x] `node scripts/bump-version.mjs auto feature` → `d.46.1.11.0`
- [x] CHANGELOG 追加；`node scripts/build-changelog.mjs`
- [x] HANDOFF.md「当前状态 / 里程碑 / 下一步」补 d.46 条目
- [x] `docs/INDEX.md` 增规格与计划索引
- [x] 全量门禁 `pnpm -r build && pnpm -r --workspace-concurrency=1 test`
- [x] 真机验收清单（规格 §4 八条）逐条走一遍，结论写回本文

## 明确不做（与规格 §3 一致）

语音 / 消息感知 WS / 模型市场 / 养成系统 / 独占全屏兼容 / macOS 验证。

## 真机验收结论（2026-11-01）

`pnpm -r build` 通过；分包测试 **shared 79 / server 9 文件 / web 2221 / desktop 365** 全绿（`shared` 与 `desktop` 各自单跑确认，`web` 用 `--no-file-parallelism`）。

真实 Electron（`app://` 协议 + 构建产物 + 真实 `pet-host.js`）逐条：

| 规格 §4 | 结果 |
|---|---|
| 1 门禁全绿 | 通过 |
| 2 右下角出现、呼吸眨眼、视线跟随 | 通过（位置按记忆落位；呼吸/眨眼由模型内置，视线跟随在 mousemove 驱动） |
| 3 双击 TapBody / 单击出输入框 | 代码路径与单测覆盖；**未做人工点击验证**（截图工具无法注入鼠标事件） |
| 4 配好 LLM 后对话 + 口型 | **未验**：本机未配置模型连接，仅验证到「无连接时气泡提示 + 去设置」分支 |
| 5 穿透（点得中桌面、拖得动角色） | **未验**：需要人工在真实桌面点按；窗口层与判定逻辑有单测（`pet-host` 20 例、`petInteraction` 16 例） |
| 6 关闭主窗口后桌宠仍在 | 按实现成立（桌宠窗口独立于主窗口，`window-all-closed` 不触发）；**未人工复验** |
| 7 托盘菜单 | 托盘创建成功（`start()` 内建，无异常）；**菜单项未人工点击** |
| 8 重启后位置与缩放保持 | 通过（删状态前后对比：`visible:false` → 写入 `visible:true` 并指定 (120,160) → 重启后角色出现在该位置） |

**结论**：渲染与窗口层已真机证实；交互（点击/拖拽/穿透/菜单）与对话需要人在键盘前操作一遍。这三项都属「按一下就知道了」的验证，不是实现缺口。
