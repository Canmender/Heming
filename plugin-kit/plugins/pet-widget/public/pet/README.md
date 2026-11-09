# 桌宠运行时与模型资源

本目录随插件包一起分发（`files/pet/`，构建时由 Vite `public/` 原样复制），由桌宠窗口通过
`widget://heming.pet/files/pet/...` 加载，**不联网**。

## 目录内容

| 文件 | 用途 | 来源 |
|---|---|---|
| `live2dcubismcore.min.js` | Cubism Core 运行时（Live2D 专有） | Live2D 官方 CDN `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js` |
| `Hiyori/` | 官方示例模型 Hiyori 全套资源（moc3 / 贴图 / 物理 / 动作 / 表情） | `Live2D/CubismWebSamples` 仓库 `Samples/Resources/Hiyori`（`develop` 分支） |

## 许可证与再分发

两份资源的授权**都不属于本仓库**，各自遵循 Live2D 的许可条款：

1. **Cubism Core**（`live2dcubismcore.min.js`）
   遵循 [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)。
   该 SDK 自带的 `Core/RedistributableFiles.txt` 明确把 `live2dcubismcore.d.ts` / `live2dcubismcore.js` / `live2dcubismcore.min.js`
   列为 **Redistributable Code**（允许随应用再分发）。文件头部版权与许可声明**不得移除**。

2. **示例模型 Hiyori**
   遵循 [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)。
   仅限用于 Live2D 相关的创作与演示，不得单独转售或再分发素材本身。

## 替换模型

`Hiyori/` 只是默认形象。桌宠按**标准 Cubism 3/4 目录约定**加载模型：一个 `*.model3.json` 加它引用的
moc3、贴图、物理、动作文件。换形象只需放入另一个同构目录，并把设置里的模型路径指过去，渲染代码无需改动。

访问 `Live2D Free Material License` 之外的第三方模型时，请自行确认其授权允许在你的分发形态中使用。
