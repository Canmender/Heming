# d.131 · 内置模块插件完全独立化（宿主加载式首方模块包）— 设计

> 用户 2026-11-10 晚：「先完整做完插件完全独立化，然后打包部署云端」。
> 前置：d.127 已落地 `contributions.engine`（插件自带本机引擎）与耦合基线；本文件定义把
> **幕僚 / 信息中枢 / 自动化 / 工作流**四个内置模块的 UI、调度与业务逻辑迁出 `packages/web`
> 的最终架构与实施顺序。

## 1. 为什么不能直接复用「界面插件（bundle）」沙箱

四个模块的 UI 是 React 组件，直接读写本体 stores（任务、通知、模型路由、记忆、infohub 客户端）。
bundle 页面在独立 origin 的 `WebContentsView` 里，拿到的是受控桥，不是同一棵 React 树：

- 迁进沙箱 = 四个 UI 全部用原生 HTML/JS 重写 + 为每个模块补一套宿主数据桥 + 后台任务改独立进程；
- 画布（工作流）、长列表（信息中枢）与既有交互都要重做，工期与回归风险远大于本次目标。

因此采用**宿主加载式首方模块包**：模块代码是首方签名、安装时才落盘的 ESM 包；
运行时由主窗口动态 `import()`，与本体共享同一套 React/store/SDK。
代价是它是**受信任代码**（不是沙箱），所以只允许**首方签名**（与 bundle 引擎同一信任锚），
第三方插件仍然只能声明式或沙箱 bundle —— 这条红线不变。

## 2. 目标架构

```
模块包（module.tgz，首方签名）
├── module.json                 # id/name/version/files 摘要/签名 + web 贡献
└── files/web/
    ├── entry.js                # ESM：export { pages, background, homeCards, settings, tools }
    └── assets/**               # 可选（图片/字体；CSS 走宿主 Tailwind，不单独打包）

启动：主进程 module-store 安装/校验 → app://heming/modules/<id>/<version>/files/web/entry.js
     主窗口 loader 动态 import → 注册到「模块运行时注册表」
开发：vite 插件把 packages/modules/<id>/dist 挂到 /__modules__/<id>/entry.js，行为一致
```

### 2.1 模块导出契约（ESM）

```js
// packages/modules/staff/src/index.tsx（构建后 entry.js）
export const manifest = { id: "staff", version: "1.0.0" };
export const pages = { staff: StaffPage };             // page id → React 组件
export const background = { staff: useStaffLoop };     // 后台 hook（宿主在 AppShell 挂载）
export const homeCards = { staff: StaffHomeCard };
export const settings = [/* { id, title, Component } */];
export const toolProviders = [/* 可选：CapabilityProvider */];
```

宿主只认这些导出；页面/循环/卡片/设置全部由模块自己提供，本体不再 import 任何模块文件。

### 2.2 宿主 SDK（`@heming/module-sdk`）

模块不能 import 本体相对路径（运行时路径不成立）。构建时把模块里对宿主源码的 import
重写成虚拟模块，读取 `globalThis.__hemingHost`：

- `__hemingHost.react`：宿主 React（同一个实例，hooks 正常）；
- `__hemingHost.jsx`：`react/jsx-runtime`（jsx/jsxs/Fragment）；
- `__hemingHost.files["<web 源码相对路径>"]`：宿主共享模块的命名空间（stores、ui 组件、
  格式化、api、llmClient…），由构建脚本静态扫描模块依赖后生成 `lib/modules/host-sdk.generated.ts`；
- 模块私有逻辑（如 `lib/staff/*`）随模块包走，不经过 SDK。

构建工具 `scripts/build-web-module.mjs`：
1. 扫描 `packages/modules/<id>/src/**`，收集宿主 import（相对路径解析到 `packages/web/src`）；
2. 生成/更新 `host-sdk.generated.ts`（宿主侧 `import * as f...` 后挂到 `__hemingHost.files`）；
3. 用 Vite lib 模式 + 自定义 Rollup 插件把宿主 import 换成虚拟 shim（`const m = __hemingHost.files[...]`），
   React/jsx-runtime 换成 `__hemingHost.react`/`jsx`；
4. 产出 `packages/modules/<id>/dist/entry.js`（ESM、单文件、不压缩到不可读）并写 `packageSha256` 前的 staging；
5. 打包/签名沿用 `module-package` 链（`module.json` + `files/web/**`），扩展其清单校验允许 `web` 贡献。

### 2.3 宿主运行时

- 新增 `lib/modules/webModules.ts`：读取已装模块（桌面走 `window.__heming_modules` 桥；
  浏览器 dev 走 `/__modules__/`），动态 import 并缓存；模块不可用（未装/版本不符/验签失败）时
  **不渲染空壳**，导航入口与首页卡不出现，插件区显示「未安装/加载失败」原因。
- `lib/modules/runtime.tsx` 由静态 import 四个页面改为「内置回退 + 已装模块覆盖」：
  迁移期保留回退，迁完后回退与静态 import 全部删除，耦合基线归零。
- 桌面：`app-protocol.js` 增加 `modules/<id>/<version>/files/web/**` 路由（路径夹取、只读、
  只允许已装且验签的模块目录），CSP 继续 `script-src 'self'`（同源 app://）。
- 安全：模块只允许首方签名；安装/加载时重算 files 摘要；不允许模块热更新未签名文件。

### 2.4 数据与工具

- stores/localStorage 仍在同一 origin，模块直接用宿主 store——**不迁移用户数据**；
- 信息中枢的 Python 引擎仍走 d.127 的 `contributions.engine`（infohub-page 已示范），
  模块侧只保留 UI/客户端；本体的 `infohub-engine.js` 下载器在 P3 删除；
- 工具注入（`infohub_*`）由模块导出的 `toolProviders` 注册进能力注册表，本体只保留注入点；
- 首页卡/设置卡由模块导出组件，Host 渲染进既有槽位；不再写死在 HomePage/SettingsPage。

## 3. 迁移顺序与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | 构建/运行时基础设施：SDK 生成、Rollup shim、Vite dev 插件、loader、app-protocol、签名扩展、示例模块 | 一个示例模块在浏览器 dev 与打包版都能从 `entry.js` 加载；未安装时优雅降级 |
| M2 | 幕僚迁出：`components/StaffPage` + `lib/staff/*` + `StaffHomeCard` + `useStaffLoop` | 页面/简报/首页卡/后台巡检与迁移前一致；web src 删除对应文件，基线下降 |
| M3 | 自动化迁出：页面 + `lib/automation/*` + scheduler + 首页/设置 | 任务 CRUD/到点执行/运行记录一致；App 顶层调度器删除 |
| M4 | 信息中枢迁出：页面 + `lib/infohub/*`（客户端/store）+ homeCard + 工具 provider；本体只留引擎下载器（随后删） | 浏览/检索/日程/采集 UI 一致；`infohub_*` 工具仍可用；未安装不再 spawn Python |
| M5 | 工作流迁出：`components/workflow/*` + `lib/workflow/*` + 服务托管 | 画布/执行/凭据与迁移前一致；`workflow-kit` 服务由插件生命周期托管 |
| M6 | 收尾：删除 `lib/modules/registry.ts` 静态模块表、`coupling-baseline` 清空、安装包不含四模块源码的守卫测试、文档 | `coupling.test.ts` 基线 0；安装包 grep 不到模块源码；全量测试与真机通过 |

完成后：`pnpm -r build` → `build-desktop` 出 NSIS 安装包 → 按 `docs/deploy.md` 上传云端口径构建 → `release.mjs --desktop --deploy` + `publish-update.mjs`。

## 4. 风险与决策

- **信任模型**：宿主加载＝首方代码，签名/摘要失败时拒绝加载；第三方永远不能走这条路径。
- **React 单实例**：SDK 必须共享宿主 React，模块构建不得自带 React（构建脚本 external 检查）。
- **CSS**：宿主 Tailwind `content` 增加 `packages/modules/**`；模块不自带 tailwind 构建。
- **测试**：模块源码移出后，其单测随模块搬到 `packages/modules/<id>/src/**/*.test.ts`，由新的 vitest 配置
  或 web 包 include 覆盖；宿主侧补 loader/协议/签名测试。
- **回滚**：迁移期保留内置回退，模块加载失败仍可用旧实现；M6 才删除回退。
