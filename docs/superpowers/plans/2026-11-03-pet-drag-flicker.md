# 实施计划：桌宠拖拽残影修复（d.67）

- 规格：`docs/superpowers/specs/2026-11-03-pet-drag-flicker.md`
- 执行：teammate `pet-drag`（实现 + 单测），Lead（评审、全量门禁、真机确认协调）
- 写作用域：`packages/desktop/pet-host.js`、`pet-window.js`、两者测试、`packages/web/src/components/pet/**`、`docs/PET.md`

## 任务

- [ ] T1 渲染层 rAF 合并：`mousemove` 只记状态，rAF 每帧最多一次 `dragMove`；`mouseup` 补发终值
- [ ] T2 拖拽期间冻结：跳过 `focus()`/命中判定/`setInteractive`；暂停 Live2D ticker；结束恢复并渲染一帧
- [ ] T3 状态机修复：`e.buttons` 位掩码 + `mouseup/mouseleave/blur` 复位，tap 后不再产生幽灵拖拽
- [ ] T4 主进程去重：`dragTo` 目标位置与当前 bounds 相同则跳过 `setPosition`
- [ ] T5 纯函数：`snapToWorkArea` / `clampToVisible`（12px 吸附 + 最小可见面积）落 `pet-window.js` 并单测
- [ ] T6 `endDrag`：先用当前光标对齐终值 → 吸附 → 钳制 → 落盘
- [ ] T7 交互反馈：拖拽期间 `cursor: grabbing`
- [ ] T8 测试：desktop `pet-window.test.js`/`pet-host.test.js`；web `petInteraction`/`PetWindow` 用例
- [ ] T9 文档：`docs/PET.md` 用法/实现/排查表/已知限制

## 验收命令

```bash
cd packages/desktop && node --test pet-window.test.js pet-host.test.js
pnpm --filter @heming/web exec vitest run src/components/pet --no-file-parallelism
```

## 真机验证（需 Lead 放行后）

1. `--user-data-dir=D:\Heming\.tmp\pet-dev` 起独立开发实例（不得影响用户正在运行的和鸣）；
2. 记录一次拖拽期间 `pet:drag-move` 次数、主进程 `setPosition` 次数、rAF 帧间隔；
3. 用系统级拖拽实测残影是否消失，如实记录「肉眼确认 / 未确认」。
