# 桌宠拖拽：残影/边缘闪烁修复与手感完善（d.67）

- 日期：2026-11-03
- 分支：`feat/d67-pet-nav`
- 版本：`d.67.2.25.0`
- 轮次定位：**体验修复 + 功能完善**（不新增能力边界，不改任何红线）
- 关联文档：`docs/PET.md`（使用与维护）、`docs/superpowers/specs/2026-11-01-d46-desktop-pet.md`（初版设计）

---

## 1. 用户报告与现象口径

用户报告「桌宠拖动会抽搐」。追问后确认的具体表现是：

> **移动桌宠窗口时有残影、边缘闪烁。**

这条口径很关键：它把问题从「窗口跟不上鼠标（跟随延迟/丢帧）」分到了「窗口在移动时，
系统合成出来的画面不干净」。两者根因与修法完全不同，先定口径再动手。

同时保留一条独立缺陷的单子（同一段拖拽代码里的状态机问题，见 §3.4），
它不属于「闪烁」，但用户拖动时一定会撞到。

---

## 2. 现状与证据（动手前）

| 位置 | 事实 |
|---|---|
| `packages/web/src/components/pet/PetWindow.tsx` `onMoveDrag` | 每一个原生 `mousemove` 都直接 `window.__heming_pet.dragMove()`，**没有任何节流/合并** |
| 同文件 `onMove` | 每次 `mousemove` 还额外跑一次 `focus(x, y)`（Live2D 追视）与命中判定 + `setInteractive` 上报 |
| `packages/desktop/pet-host.js` `dragTo` | 每收到一次 `pet:drag-move` 就 `win.setPosition(pos.x, pos.y)`，**位置没变也照调** |
| `packages/desktop/pet-window.js` `petWindowOptions` | `transparent: true`、`hasShadow: false`、`alwaysOnTop: true`（Windows 上是分层透明置顶窗） |
| `packages/web/src/components/pet/useLive2D.ts` | pixi ticker 常驻 60fps 重绘透明 WebGL 画布 |
| 设计稿 `2026-11-01-d46-desktop-pet.md` §151 | **原文就写了**「拖拽期间按 `requestAnimationFrame` 节流，抬起时补一次终值」——实现没有照做，属于实现与规格漂移 |

`mousemove` 在 Windows 上的投递频率可以远高于显示器刷新率（高回报率鼠标可达 500–1000Hz）。
当前实现把这些事件全部转成 IPC、再全部转成 `SetWindowPos`，同时画布还在每帧重绘，
三者叠加正好是 Windows 分层透明窗最容易露出残影/闪边的组合：

1. 窗口位置以高于刷新率的频率变化，DWM 来不及按每个位置合成一帧；
2. 每帧内容又在变（Live2D 追视 + 物理），分层表面无法复用上一帧；
3. 透明像素的边缘没有不透明底做「遮边」，位移中的半透明抗锯齿边缘最容易被合成器画脏。

## 3. 设计

### 3.1 拖拽移动：rAF 合并（渲染层）

- `mousemove` 只做两件事：记下「有位移」，必要时把状态机从「待判」推进到「拖拽中」；
  **不在事件回调里发 IPC**。
- 一个 `requestAnimationFrame` 循环在拖拽期间每帧最多发 1 次 `dragMove`；
  没有新位移的帧不发。
- `mouseup` 时若本帧还有未发送的位移，**同步补发一次终值**再 `dragEnd`——
  否则慢速拖拽的最后一小段会被吞掉，表现为「松手后窗口回跳一格」。
- 位移判定仍用主进程的屏幕坐标（`screen.getCursorScreenPoint()`），
  渲染层只负责「这一帧要不要让主进程重新取一次光标」——坐标真相仍然只有一份，
  不与 d.46 的既有决策冲突。

### 3.2 拖拽期间冻结画面（渲染层）

拖拽时窗口本身在动，渲染层拿到的 `clientX/clientY` 是「相对窗口」的、
每帧都被窗口位移污染的量。用它驱动 Live2D 追视只会让角色在拖动中乱瞟（用户眼里的「抖」），
驱动命中判定还会让穿透状态在拖拽中反复横跳。所以：

- 拖拽期间**跳过** `focus()`（保持拖动开始时的朝向）与命中判定/`setInteractive` 上报；
- 拖拽期间暂停 Live2D 的自动重绘（ticker 暂停），只保留窗口这一层静止画面移动；
- `dragEnd` 之后恢复渲染并**显式渲染一帧**，避免暂停期间积压的状态变化不生效；
- 恢复追视时以当前指针位置重新 `focus` 一次，不做补间（补间会看到眼睛「扫」回来）。

### 3.3 主进程：只处理真实位移 + 收尾吸附/钳制

- `dragTo` 先比对目标与当前 bounds，**相同就跳过** `setPosition`（高频 IPC 里重复位置很常见）。
- `endDrag` 先用当前光标对齐一次终值，再做两件收尾：
  - **边缘吸附**：与所在工作区左/右/上/下边缘距离 ≤ 12px 时贴齐（只在收尾做，拖拽中不做 ——
    拖拽中吸附会「粘住」手感，用户想停在边缘附近就得跟系统抢）；
  - **可见性钳制**：复用 `pet-window.js` 的 `MIN_VISIBLE_WIDTH/HEIGHT` 思路，
    保证窗口至少有一块够大的面积留在某个工作区里；拖到屏幕外也能被拖回来。
- 吸附与钳制都是 `pet-window.js` 里的**纯函数**，用 node:test 直接断言，
  不引入任何第三方依赖、不新增 IPC 通道。

### 3.4 状态机缺陷：tap 之后的「幽灵拖拽」

`onUp` 的 tap 分支把 `dragRef.current` 重新赋值为一个 `dragging: false` 的对象。
于是**鼠标键已经松开**之后，任何一次超过阈值（4px）的 `mousemove` 都会把状态推进到
「拖拽中」并发 `dragStart()` —— 桌宠会跟着鼠标跑，直到下一次 `mouseup`。

修法：拖拽状态只承认「按键仍按下」的移动（`e.buttons` 位掩码包含左键），
并在 `mouseup`/`mouseleave`/`blur` 上都把状态机复位；tap 分支不再留下可被推进的状态。

### 3.5 交互反馈

拖拽期间给 `body` 加 `cursor: grabbing`，结束时移除（与右栏拖宽度的既有做法一致）。

## 4. 非目标

- 不改桌宠的透明/置顶窗口模型（`transparent` / `hasShadow` / `alwaysOnTop` 不动）：
  这是产品形态本身，换掉要重做一整套「怎么不挡桌面」的穿透设计。
- 不做拖拽惯性/回弹（常驻桌宠上属于噪音）。
- 不做拖拽中的实时吸附（见 §3.3 理由）。
- 不改 `pet:event` 事件通道、不改托盘菜单、不改模型加载。

## 5. 验收

| 项 | 判据 |
|---|---|
| 移动 jQuery 合并 | 一次拖拽期间 `pet:drag-move` 次数 ≤ 拖拽持续帧数 + 1（抬起补发），不是 mousemove 次数 |
| 终值不丢 | `mouseup` 后窗口位置等于最后一次光标位移对应的目标 |
| 无重复写入 | 主进程对同一目标位置只调一次 `setPosition` |
| 幽灵拖拽 | tap 之后（未按住）移动鼠标，窗口位置不变 |
| 吸附/钳制 | 纯函数单测覆盖四边吸附、阈值内外、多显示器、越界回拉 |
| 冻结恢复 | 拖拽结束后追视/渲染恢复，角色不会停在暂停帧 |

自动化测试：`packages/desktop/pet-window.test.js`、`pet-host.test.js`、
`packages/web/src/components/pet/*.test.ts(x)`。
真机（Windows 10/11 + 高 DPI）拖拽实测记录写进 PET.md §6 排查表与提交说明；
**视觉残影是否完全消失以用户真机确认为准**，不自称「肉眼已验证」除非确实看过。
