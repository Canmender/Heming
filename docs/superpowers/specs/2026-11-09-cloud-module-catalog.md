# 模块目录上云：原生应用不再写死「内置模块」

- 日期：2026-11-09
- 版本：`d.117.3.46.0`（特性 +1）
- 分支：`claude/serene-torvalds-fc4f1e`
- 起因：用户截图显示插件页仍有三张「内置模块」卡片（幕僚 / 信息中枢 / 自动化），
  指出这是残留硬编码，要求原生应用不携带插件、用户自己决定是否从云端安装。

## 1. 根因

`PluginsPage` 把 `BUILTIN_MODULES` 注册表直接传给统一能力投影并渲染卡片，
与「是否安装」「云端有没有这个模块」无关。安装包确实已经不带模块引擎（d.116），
但客户端仍把三张卡片画出来，看起来就像自带插件。

## 2. 设计

### 2.1 云端目录（shared + server）

- `packages/shared/src/moduleCatalog.ts`：
  - `ModuleCatalogEntrySchema { id, name, version, description, author, engine, publishedAt? }`；
  - `engine` 为 `null` 表示纯宿主页面模块（安装不联网），否则是需下载的引擎 id；
  - 目录项**不含代码、密钥、权限**，只是「有什么可装」。
- `packages/server/src/moduleCatalog.ts` + `GET /api/modules`（公开、只读）：
  - 读取 `HEMING_MODULE_DIR`（缺省 `<cwd>/module-catalog`）的 `<id>/<version>/module.json`；
  - 同 id 只给最新版本；坏条目跳过；
  - 目录缺失/为空时回落到随服务端发布的三条目录项（保证新部署也能看到可选模块）。

### 2.2 客户端

- `lib/modules/catalogClient.ts`：`fetchModuleCatalog()` 走 `GET /api/modules`，
  zod 校验失败/网络失败都抛中文错误，不把坏数据当空目录。
- 插件页：
  - 统一能力投影只传**已安装**的模块（`BUILTIN_MODULES.filter(installed)`），
    未安装模块不渲染、不占「模块」筛选；
  - 新增「从云端安装模块」按钮 → `CloudModulesDialog`：只在打开时联网取目录，
    列出服务端真实条目；安装只调用 `useModuleStore.install(id)`；
  - 安装后的卡片仍复用 `ModulePluginCard`（启停/删除/打开页面），来源标「模块」。
- `useUnitStatuses()` 的默认投影同样只含已安装模块（命令面板/其它读投影的地方一致）。

### 2.3 旧状态迁移

- d.115 及以前模块默认「已安装」；升级后旧 localStorage 会让卡片继续出现。
- 新增 `heming.modules.schema.v2` 标记：首次读到无标记的旧状态时，
  一次性把 `installed/enabled` 归零并写标记；**不删任何业务数据**
  （简报、归档配置、自动化任务与运行记录原样保留）。
- 归零后用户从云端安装的状态正常保留。

## 3. 明确不做 / 边界

- 模块的**宿主页面代码**仍随应用发布（懒加载 chunk）；未安装时完全不生效
  （不占导航、不跑后台、不注入工具）。若要求「页面代码也不随应用」，
  需要另立「模块 UI 云端分发/沙箱」规格（现有 desktopWidget 运行时不能承载主窗页面）。
- 服务端不执行模块代码；目录只用于展示与安装入口。
- 安装包里仍不携带任何模块 / 引擎 / 插件包（d.116 的打包边界不变）。

## 4. 验证

- web 全量 302 文件 / 4299 例；server 16 文件 / 264 例；shared 6 文件 / 82 例；
  web/server/shared typecheck 通过。
- 真实浏览器（本地 API + Vite）：
  - 插件页默认只有系统能力卡；来源筛选只有「系统」；无任何模块卡；
  - 点「从云端安装模块」→ 弹窗列出服务端三条目录项（自动化 / 信息中枢 / 幕僚）；
  - 安装幕僚 → 卡片才出现（来源「模块」），删除后回到无模块；
  - 旧 `installed=true` 的本地状态被 v2 标记迁移归零。
- 未部署：云端 `/api/modules` 需随服务端一起发布后，已安装用户才能看到可选模块。
