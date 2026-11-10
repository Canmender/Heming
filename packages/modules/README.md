# packages/modules · 宿主加载式首方模块包（d.131）

> 目标：把幕僚 / 信息中枢 / 自动化 / 工作流四个内置模块从 `packages/web` 迁到这里，
> 以**首方签名、安装后才存在**的 ESM 包形式交付；本体只保留加载器与宿主 SDK。
> 设计全文：`docs/superpowers/specs/2026-11-10-d131-module-packages.md`。

## 目录

```
packages/modules/
├── sdk/                 # 构建期注入的 react / react-jsx 运行时 shim（读 globalThis.__hemingHost）
├── hello-page/          # 最小样例：验证 entry.js 构建 + 宿主加载（不发布）
│   ├── module.json
│   └── src/index.tsx
└── <id>/                # 真实模块（迁移中）：module.json + src/** + tests
```

## 契约

模块包构建成一个 ESM `entry.js`，导出：

```ts
export const manifest = { id, version };
export const pages = { <pageId>: ReactComponent };
export const background? = { <hookId>: (active: boolean) => void };
export const homeCards? = { <slot>: ReactComponent };
export const settings? = [{ id, title, Component }];
export const toolProviders? = [CapabilityProvider];
```

**不得**打包 React：构建时 `react` / `react/jsx-runtime` 被 alias 到 `sdk/` 下的 shim，
运行时从 `globalThis.__hemingHost` 取宿主那一份（同一 React 实例）。这条由构建门禁检查
（产物出现 `react-dom`/`react.production` 标记即失败）。

## 构建与验证

```bash
node scripts/build-web-module.mjs --id hello-page   # → packages/modules/hello-page/dist/entry.js
pnpm -C packages/web dev --port 5176                # 开发态 /__modules__/<id>/entry.js
node .tmp/test-loader-dev.mjs                       # CDP：loader.loadWebModule('hello-page')
```

- 开发：`packages/web/vite.config.ts` 的 `modulesDevServer` 把 `packages/modules/<id>/dist` 挂到
  `/__modules__/<id>/*`（路径夹取、no-store）；
- 安装版：`app://heming/modules/<id>/<version>/files/web/entry.js`（由 app-protocol 只读路由提供，
  仅服务已安装且验签过的模块目录——M1 之后实现）。

## 信任模型

这是**受信任代码路径**（不是沙箱）：只有首方签名的模块包会被加载，安装时验签 + `files/**` 摘要复核。
第三方插件永远不能走这条路径（仍只能声明式或 bundle 沙箱页面）。
