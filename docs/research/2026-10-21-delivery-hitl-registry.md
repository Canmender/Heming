# d.19.1.5.0 交付说明：HITL 确认闸门 + MCP Registry（remote）

> 本文件是**开发者视角**的本轮交付与交接记录。面向用户的更新日志见 `CHANGELOG.md` 顶部条目；
> 两份架构设计（更详细）见 `2026-10-21-hitl-architecture.md` 与 `2026-10-22-registry-architecture.md`。

## 一、本轮交付了什么

### 1. HITL：工具执行前的人工确认（完整落地）

模型每次要调用工具，`bridge.execute` **之前**先弹窗问用户。已接线的完整链路：

```
agentStream.ts:483   confirmToolCalls(deps, calls, ctx)      ← 唯一接线点
  └─ ChatPage.tsx:1096  hitlGate.review(toHitlBatch(...))     ← 模块级单例，不在渲染体里 new
       ├─ gate.ts        批内分流 + 同指纹去重 + 兜底按 deny
       ├─ policy.ts      三档 + 会话授权（内存 Map，绝不落盘）
       ├─ classify.ts    风险三级 + 参数摘要（敏感值抹掉）
       └─ store/hitl.ts  pending 队列（单槽 + 排队）
            └─ ToolApprovalModal.tsx  →  ConfirmDialog.tsx   ← 骨架复用
```

- `ConfirmDialog` 是从确认弹窗里拆出的**通用骨架**（遮罩 / Esc / 焦点循环），
  以后任何「要用户拍板」的交互都复用它
- 档位设置卡 `HitlPolicyCard` 挂在设置的 **security 分组**（不是 model 分组）
- 工具轨迹带 `denied: true`，被拒的调用在流式渲染里标「已拒绝」

### 2. MCP Registry（remote 分支，纯逻辑层完成）

`lib/registry/` 6 个文件：拉列表（游标分页 + 去重 + `version` 参数）、
映射（包名白名单 + headers 提示）、安装评级、对外出口。
**108 个测试全绿。**

- 装法只支持 remote：`buildRemoteOptions` 只做 URL 合法性检查
- npm/pypi 类返回 `unsupported`（`LOCAL_PACKAGES_SUPPORTED = false`）——
  下轮放开只需改这一个常量
- `remotes[]` 里带 `headers` 的（实测 13%）会转成 `headerHints`，
  用户填的值经第四个参数进 `McpServerConfig.headers`

### 3. 顺手修掉的既有缺陷

| 缺陷 | 影响 |
|---|---|
| `guards.ts` bearer 正则缺 `i` | `Bearer <token>`（HTTP 标准写法）漏掩码。HITL 参数摘要是新展示面，漏了等于把 token 摆到弹窗上 |
| `MarkdownMessage` 的 `.then()` 无 `.catch` | 高亮失败 → unhandled rejection（Electron 里是未捕获错误）。已改为降级纯文本 |
| `presets.ts` 的 `filesystem` 预置 | Windows 上从未跑通过（npx 是 shell 脚本）+ `args` 硬编码本机路径。已删 |
| `coerceTool` 白名单丢 `annotations` | 重启后 annotations 失效。已补透传 |
| `mcp-stdio.js:13` 注释 | 原文说「.cmd 由调用方写成 npx.cmd」，实测会 EINVAL。已更正 |

## 二、几个值得记住的决策（含实测依据）

| 决策 | 依据 |
|---|---|
| **没有「全部放行」档** | 与 `self_mcp_add_server → self_mcp_enable → 该 MCP 所有工具` 组合后是致命的 |
| **`annotations` 不参与判定** | MCP 规范明言 untrusted hint；实测真实服务器 20/20 带 annotations，改个 `readOnlyHint` 就能让 `delete_file` 静默执行 |
| **闸门异常一律按 deny** | 兜底方向决定错误可见性：deny 的错用户立刻发现，allow 的错静默不可见 |
| **域名不一致只提示不评级** | 实测 100 条里有仓库地址的 36 条全在 GitHub；100% 误报的高危标记等于没有标记 |
| **丢弃 `packageArguments` / `environmentVariables`** | 后者能注入任意环境变量（含 `PATH`/`NODE_OPTIONS`），风险面比 args 更大 |
| **不按 `transport.type` 预过滤** | 声明的 type 不可信（有服务声明 sse 实际是 streamable-http）；我们 `Accept` 两种都试，连一下才知道 |
| **`meta` 用「桥级函数」而非挂在 tools 对象上** | `tools[]` 直接发给 LLM 供应商（`agentStream.ts:384`），挂字段就是协议污染 |
| **下架态用白名单而非「非 active 即下架」** | Registry 可能新增状态值；把不认识的当「下架」会误伤（如 `inactive` 也许是临时故障） |

## 三、门禁状态

```
web       86 个测试文件 / 1354 例全绿（--no-file-parallelism 串行）
server     9 个文件 / 210 例
desktop   17 个文件 / 0 失败
tsc       0 错误
```

**测试护栏两条**（要改回去的人必须先删它们，那时至少会有人停下来想）：

1. `classify.test.ts`：`readOnlyHint: true` 的 `srv__delete_file` 必须判 `danger`
2. `policy.test.ts`：`expect(modes).not.toContain("auto")`

## 四、还没做的（下一轮）

1. **T08 Registry 的发现页 UI**：安装确认卡、浏览/搜索界面、header 填写表单。
   *T07 只做了纯逻辑层。* 交互范式复用 `ConfirmDialog`
2. **云端部署**：`docs/deploy.md`。改动影响前端展示，需要重新部署
3. **打包**：`node scripts/build-desktop.mjs --win nsis`（需要给用户装包时）
4. **npm/pypi 类本地安装**：需要先把 `node`/`uv` 打进安装包（+30MB 量级），
   或按 `npx-cli.js` 方案从 node 目录反推（实测可行，但会打破零依赖承诺）
5. **`ChatPage.test.tsx` 的 HITL 端到端用例**：目前闸门层测试很全，
   但 `ChatPage` 接线层（`confirmToolCalls` 异常按拒绝）还没有直接断言

## 五、踩过的坑（写给下一个接手的人）

- **「测试全绿」在安全功能上可能是危险信号**：第一版测试把
  `resolveRisk("srv__delete_file", { readOnlyHint: true })` 断言成 `read`——
  绿着，漏洞也在。安全断言要看**方向**，不只是看绿
- **用 raw URL 拉目录必然返回空**：不能据此说「目录是空的」
  （查目录用 GitHub API 的 `contents/`）
- **404 = 要排除「路径写错」与「东西不存在」两种可能**：
  本轮两次把「仓库找错了」当成「文件不存在」
- **串行跑 web 测试**：`vitest run` 默认并发会少跑约 2 个文件
- **`HitlMode` 的 `auto` 改名成了 `pass`**：`Decision` / `PolicyOutcome` 里的
  `"auto"` 与已删除的档位同名两义，已统一为 `pass`
