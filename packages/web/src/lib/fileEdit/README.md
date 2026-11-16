# fileEdit · 本机文件工具（d.55，d.153 扩到六个）

`file_read` / `file_write` / `file_edit` / `file_glob` / `file_grep` / `file_patch` 的纯逻辑层。
规格见 `docs/superpowers/specs/2026-11-02-d53-file-edit-primitive.md`（实施记录在 §15）；
d.153 的六个工具与「工作区即写根」改动见 `docs/HANDOFF.md` 对应版本条目。

## 分层（依赖单向，自下而上）

| 层 | 文件 | 说明 |
|---|---|---|
| 基础 | `types.ts` `limits.ts` `paths.ts` | 协议结构、上限、路径口径（web 侧单一来源） |
| 纯算法 | `parse.ts` `match.ts` | 补丁协议解析、三级锚点匹配与 hunk 应用 |
| 执行 | `resolve.ts` `apply.ts` | 目标解析（根 + 相对路径）、干跑产出 A/M/D 变更集（唯一读盘处，IO 注入） |
| 判定 | `safety.ts` `roots.ts` | 三态安全判定、可写根存储（localStorage）+ 会话工作区派生写根 |
| 接线 | `bridge.ts` `toolOps.ts` `tools.ts` | `window.__heming_files` 探测、六个工具的执行体、工具定义与可见性 |
| HITL | `ruleTargets.ts` `remember.ts` | 调用涉及哪些路径、按目录前缀记住授权 |
| UI 支撑 | `patchPreview.ts` | 确认卡行级 diff（复用 `hitl/preview.ts` 的 `diffLines`，脱敏 + 截断） |

## 六个工具

| 工具 | 风险 | 用途 | 桌面通道 |
|---|---|---|---|
| `file_read` | read | 读文本（offset/limit 分页） | `file:read` |
| `file_glob` | read | 按通配符找文件 | `file:glob` |
| `file_grep` | read | 按正则搜内容 | `file:grep` |
| `file_write` | write | 新建/整份覆盖（空内容=建空文件，自动建父目录） | `file:write`（`createParents`） |
| `file_edit` | write | 精确串替换（`replace_all`） | `file:read` + `file:write` |
| `file_patch` | write | 多点锚点补丁（一次改多处/多文件） | `file:read` + `file:write` |

可见性：**任意一条根** → 读三件；**存在可写根** → 写三件；桥不支持 `glob`/`grep`（旧安装包）
时搜索两件按工具隐藏，而不是注入一个调用即崩的工具。

## 根从哪来（d.153 起）

1. **会话工作区自动成为写根**：`mergeWorkspaceRoot(roots, conversation.workspace)` 现场派生
   `{name:"工作区", mode:"write"}` 并排第一位，**不写 localStorage**——换会话即换根，
   不会把上一个项目的目录悄悄留在设置里。
2. 用户在「设置 → 文件编辑」手动加的根照旧生效；同路径时手动配置优先（不会把只读根
   悄悄升级成可写）。
3. **未分组会话用默认工作区兜底**：没有工作区、也没有任何手动根时，桌面端 preload 下发的
   `defaultRootPath`（`文档\和鸣`）成为唯一写根，名字「默认工作区」。为什么还要这一层：
   大部分既有会话是未分组，只靠工作区的话「帮我建个文件」仍然会得到「没有可写根」——
   那等于投诉没修好。只要用户配过根（哪怕只有只读根）就不兜底：尊重「我只让它读」。
4. `currentFileRoots()` 是四处（工具可见性 / HITL 闸门 / 确认卡预览 / 记住授权）唯一的根口径；
   `fileRootsFor(workspace)` 是显式参数版（capability provider 用 `ctx.workspace`，不依赖时序）。
   **不要**在别处直接读 `fileRootsStore.roots()`：那会漏掉工作区与默认工作区，
   出现「工具能写、闸门以为越界」的分裂。

## 三条不许破的线

1. **写盘只在可写根内**（配置根 ∪ 会话工作区 ∪ 未分组会话的默认工作区）：web 侧收敛 +
   主进程 `packages/desktop/file-fs.js` 再夹一次（双层防线）。
2. **原子性**：补丁任一 hunk 匹配失败则整份不写盘；单文件写盘用 tmp+fsync+rename。
3. **授权只能按路径前缀**：写工具永不接受「整个工具放行」（`*`），确认卡按目标目录归纳前缀。

## 测试

```bash
pnpm --filter @heming/web test -- src/lib/fileEdit
pnpm --filter @heming/web test -- src/lib/hitl/policy-prefix.test.ts
cd packages/desktop && node --test file-fs.test.js path-guard.test.js
```
