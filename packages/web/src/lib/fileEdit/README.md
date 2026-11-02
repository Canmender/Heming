# fileEdit · 文件编辑原语（d.55）

`file_patch` / `file_read` 的纯逻辑层。规格见
`docs/superpowers/specs/2026-11-02-d53-file-edit-primitive.md`（实施记录在 §15）。

## 分层（依赖单向，自下而上）

| 层 | 文件 | 说明 |
|---|---|---|
| 基础 | `types.ts` `limits.ts` `paths.ts` | 协议结构、上限、路径口径（web 侧单一来源） |
| 纯算法 | `parse.ts` `match.ts` | 补丁协议解析、三级锚点匹配与 hunk 应用 |
| 执行 | `resolve.ts` `apply.ts` | 目标解析（根 + 相对路径）、干跑产出 A/M/D 变更集（唯一读盘处，IO 注入） |
| 判定 | `safety.ts` `roots.ts` | 三态安全判定、可写根存储（localStorage） |
| 接线 | `bridge.ts` `tools.ts` | `window.__heming_files` 探测、工具定义与执行 |
| HITL | `ruleTargets.ts` `remember.ts` | 调用涉及哪些路径、按目录前缀记住授权 |
| UI 支撑 | `patchPreview.ts` | 确认卡行级 diff（复用 `hitl/preview.ts` 的 `diffLines`，脱敏 + 截断） |

## 三条不许破的线

1. **写盘只在用户显式添加的可写根内**：web 侧收敛 + 主进程 `packages/desktop/file-fs.js` 再夹一次（双层防线）。
2. **原子性**：任一 hunk 匹配失败，整份补丁不写盘；单文件写盘用 tmp+fsync+rename。
3. **授权只能按路径前缀**：`file_patch` 永不接受「整个工具放行」（`*`），确认卡按目标目录归纳前缀。

## 测试

```bash
pnpm --filter @heming/web test -- src/lib/fileEdit
pnpm --filter @heming/web test -- src/lib/hitl/policy-prefix.test.ts
cd packages/desktop && node --test file-fs.test.js path-guard.test.js
```
