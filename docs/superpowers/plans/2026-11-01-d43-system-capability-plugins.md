# d.43 实施计划 · 系统能力包（技能 + 远程 MCP 服务）

- 日期：2026-11-01
- 规格：`docs/superpowers/specs/2026-11-01-d43-system-capability-plugins.md`
- 基线：d.42.1.11.0 → 目标：d.43.1.11.0
- 全程只改 `packages/web`；不改服务端、shared、桌面端

## 任务

1. **清单 v2**（`lib/plugins/manifest.ts`）
   - `schemaVersion` 接受 1/2；v2 增加 `mcpServers`（0–10）。
   - 校验 key/name/description/url；URL 只允许 https 或 localhost http，禁止 userinfo。
   - v2 允许纯 MCP；v1 仍要求至少 1 个技能；v1 出现 `mcpServers` 报错。
   - 导出 `PluginMcpServerSpec`；`PluginManifest` 自动带上数组默认值。

2. **MCP 来源与端口**
   - `ServerOrigin` 增加 `"plugin"`；`coerceServer` 白名单透传（否则重启后退回 manual）。
   - 定义 `PluginMcpPort { get/add/update/remove }`（`PluginStore` 的依赖面，默认 `mcpRegistry`）。

3. **插件存储生命周期**（`lib/plugins/store.ts`）
   - `InstalledPlugin` 增加 `serverIds`；读回缺省 `[]`。
   - 安装：先做 id 冲突检查 → 物化技能 → 添加/更新服务（`origin:"plugin"`、enabled 跟随插件、保留 headers）→ 删除消失服务。
   - 启停同步服务 `enabled`；卸载删服务（只删 `origin === "plugin"` 的所属 id）。
   - 更新保留 `installedAt` 与用户请求头/工具启用状态。

4. **插件页**（`components/PluginsPage.tsx`）
   - 安装预览列出服务与网络主机、写明连接/启用/确认口径。
   - 插件卡显示服务标签与「查看接口」入口；启停/卸载文案覆盖服务。
   - 页脚文案改为「技能与远程 MCP 服务；不执行代码、不带密钥」。

5. **接口区**（`components/InterfacesPage.tsx`）
   - `origin === "plugin"` 显示「插件」徽标与随包说明。

6. **测试**
   - manifest：v2 混合/纯 MCP/纯技能、v1 拒绝服务、URL 规则、key 重复、能力为空、上限。
   - store：服务注册与 id、冲突不落盘、更新增改删、保留 headers、启停、卸载、旧记录迁移。
   - 页面：预览显示主机与服务、安装后调用 store、查看接口跳转、卸载确认含服务。
   - MCP store：`origin:"plugin"` 往返。
   - 全量门禁。

7. **真实浏览器验证**
   - 本地 mock MCP HTTP 服务；安装 v2 插件 → 接口区可见「插件」徽标 → 连接 → 工具列表 → 启用；停用/卸载同步。

8. **收口**
   - `node scripts/bump-version.mjs auto feature`、CHANGELOG、`build-changelog.mjs`、HANDOFF/INDEX/README。
