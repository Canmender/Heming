# 画布插件 · 页面实现规格（`files/index.html` / `files/style.css` / `files/app.js`）

本文件是页面侧的实现规格；**协议与图结构以 `docs/CONTRACT.md` 为准**（两者冲突时以契约文件为准，
并回来改本文件）。页面是纯 HTML/CSS/JS，不引入任何框架、构建步骤或外部资源。

## 1. 硬约束（CSP 与宿主边界）

- 运行环境：Electron `widget://heming.image-studio/files/index.html`，`script-src 'self'`。
  **禁止内联 `<script>`、`onclick=` 之类的内联事件、`eval`、`new Function`、远程 CDN/字体/图片**。
  脚本全部放在 `files/app.js`，样式全部放在 `files/style.css`。
- 宿能力只来自 `window.__heming_widget`（见 `packages/shared/src/plugin/widget.ts`）：
  `info()` / `onEvent()` / `engineCall()` / `onEngineEvent()` / `engineStatus()` /
  `settings()`（本插件不声明 settings 字段，可不调）/ `dataGet()` / `dataSet()` / `log()`。
- **页面不发任何网络请求**（不 `fetch`、不 `XMLHttpRequest`、不 `EventSource`、不 `WebSocket`）；
  所有网络都由引擎完成。图片只显示引擎返回的 `dataUrl`。
- 用户输入（提示词、检查点名）一律 `textContent` / `value` 渲染，**禁止 `innerHTML` 拼接用户文本**。
- 主题：`info().theme` 初始化，`onEvent((e) => e.kind === "theme")` 切换；根元素 `data-theme="light|dark"`。
  宿主没有桥（浏览器直接打开）时也要能渲染出静态界面，但显示「请在和鸣桌面端打开」提示层。

## 2. 布局

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 顶栏：画布 / AI 绘图工作台     [● ComfyUI 已连接 · 8188]   [运行 Ctrl+Enter] [取消] [清空] │
├───────────────────────────────────────────────┬──────────────────────────────┤
│ 画布工具条：＋ 添加节点 ▾   ｜ 适配视图  自动整理  重置示例 ｜ 状态提示        │ 结果面板（宽 340）│
│ ┌───────────────────────────────────────────┐ │  最新图片（等比缩放，最大高度 60%）│
│ │  点阵网格 + 可平移/缩放画布               │ │  本次参数（seed/尺寸/耗时）        │
│ │  ┌─────────┐      ┌──────────┐           │ │  [打开文件夹] [复制参数]           │
│ │  │checkpoint│─────▶│ positive │──┐        │ │  本次会话历史条（缩略图 ≤12，横向） │
│ │  └─────────┘      └──────────┘  │        │ │  空态：引导文案 + 检查点数量        │
│ │        └─────────▶ sampler ◀────┘        │ │                                  │
│ │                        │                  │ │                                  │
│ │                   ┌────▼────┐             │ │                                  │
│ │                   │ output  │             │ │                                  │
│ │                   └─────────┘             │ │                                  │
│ └───────────────────────────────────────────┘ │                                  │
├───────────────────────────────────────────────┴──────────────────────────────┤
│ 状态栏：引擎状态 · 进度（排队/生成/取图） · 上次耗时与图片大小 · 缩放比例        │
└──────────────────────────────────────────────────────────────────────────────┘
```

- 顶栏左侧：标题「画布」+ 小字「AI 绘图工作台」。
- 顶栏中部：ComfyUI 状态胶囊（● 绿=已连接 / ● 琥珀=未连接 / ● 灰=检测中），点它展开/收起
  「连接设置」浮层（地址输入、连接按钮、检查点数量、错误原因、「如何启动 ComfyUI」一句话）。
- 顶栏右侧：主按钮「运行」、次按钮「取消」（仅运行中启用）、「清空画布」（二次确认，仅删节点不删设置）。
- 右侧面板固定 340px；窄窗口（<980px）折叠到画布下方（CSS grid 自适应即可，不要求移动端）。
- 画布占满剩余空间，最小高度 420px。

## 3. 视觉

- 风格：专业工作台，冷静的深色优先；不用渐变大字、不用 emoji、不用花哨动效。动效只保留
  150ms 的 hover/选中过渡。
- 颜色用 CSS 变量，深/浅两套：`--bg` `--panel` `--panel-2` `--line` `--text` `--muted` `--accent`
  `--ok` `--warn` `--error`；深色底 `#14161a` 左右，面板 `#1b1e24`，线 `#2a2f38`，
  文字 `#e6e8ec` / 次要 `#9aa3b2`；强调色用冷青 `#4ea3ff`（不与宿主品牌冲突即可）。
- 字体：`system-ui, "Segoe UI", "Microsoft YaHei", sans-serif`；参数数值用 `ui-monospace` 等宽。
- 画布网格：CSS `radial-gradient` 点阵（深/浅两套），随缩放自然平铺（用 background-size 随 zoom 调整）。
- 节点卡：宽 240px，圆角 10px，1px 边框；头部 34px 高，左侧 8px 色点 + 中文标题 + 右侧删除「×」；
  主体 padding 10–12px。选中：2px `--accent` 外描边。拖动中提升 z-index 并加轻微阴影。
- 节点类型色点：checkpoint 青、lora 紫、positive 绿、negative 红、latent 蓝、sampler 琥珀、output 灰白。
- 端口：节点左右边缘的 10px 圆点，`title`/`aria-label` 写端口名；输入在左、输出在右，端口名以小字
  贴在节点内侧（MODEL/CLIP/VAE/CONDITIONING/LATENT）。已连接端口实心，未连接空心。
- 连线：SVG 三次贝塞尔（水平出入），线宽 2px；按端口类型上色（MODEL 青、CLIP 紫、CONDITIONING 绿、
LATENT 蓝、VAE 灰）；hover 加粗，选中的连线加 3px 光晕；正在拖拽的连线用虚线。
- 右侧结果图：最大宽度 100%，`object-fit: contain`，圆角 8px，点击可放大（灯箱：遮罩 + 原图，
  Esc/点击关闭）。
- 所有可点元素 `cursor: pointer`，禁用态 `cursor: not-allowed`；focus-visible 有 2px 描边。

## 4. 交互

### 4.1 画布
- 平移：在空白处按住左键拖动（或中键拖动）；缩放：滚轮以指针为锚点，`0.4–1.6`；
  工具条「适配视图」把所有节点缩放到可见；「自动整理」按当前图做一次按层的从左到右布局。
- 节点拖动：按住卡片头部/主体拖动（输入框、下拉、按钮、端口除外），用 `requestAnimationFrame`
  合并更新 `x/y`；拖动结束写回并持久化。
- 选中：点击卡片选中（单选）；点击空白取消；选中时 Delete/Backspace 删除节点（连带其边）。
- 连线：从输出端口按下拖到输入端口松开；端口类型不匹配时目标端口显示错误色且不建立连接；
  松开在空白处取消。创建时若目标输入已有边则**替换**旧边（不报错）。
- 连线选中后 Delete 删除。Esc 取消正在拖拽的连线。
- 新增节点：工具条「添加节点」下拉，七项（检查点 / LoRA / 正面提示词 / 负面提示词 / 空潜空间 /
  采样器 / 输出）。选择后放在画布可视区域中央（带少量随机偏移避免重叠）；新节点即选中。
- 节点内表单：输入即改 `params`，500ms 防抖持久化；数字输入失焦/回车时夹到契约范围，
  非法输入回落到默认值并在字段下给一行小字说明（不要用 alert）。

### 4.2 图 → 运行
- 运行前客户端轻校验（缺节点/缺边时在状态栏给出中文原因并高亮缺失端口，不调用引擎）：
  必需节点齐全、采样器四个输入、输出两个输入、提示词 clip、vae 连接；
  文案直接指向「哪个节点的哪个输入没连」。
- 运行中：按钮转 loading 文案「生成中…」，禁用「运行」「清空」；「取消」可用。
  提交后显示阶段：「排队中」→「生成中」→「取图中」，来自 `onEngineEvent` 的 `phase`。
- 成功：右侧显示第一张图；多图时下方出现缩略图行；显示实际 seed（若原 seed 为 -1，回填到采样器节点
  的 seed 字段，方便微调复现）、尺寸、耗时、图片大小；把结果加入会话历史（最多 12 条，
  每条含 dataUrl、seed、尺寸、时间）。`dataUrl` 为 null 时显示「图片过大，已保存到 path」+
  「打开文件夹」按钮（调用 `reveal_outputs`）。
- 失败：结果面板顶部红色错误条，展示引擎返回的中文 `message`（可换行），保留上一次成功图；
  给「重试」按钮。取消导致的失败显示为中性提示「已取消本次生成」。
- 修改图后不清空上一次结果（只有「清空画布」清空节点与结果历史）。

### 4.3 连接与设置
- 启动顺序：`info()` → 主题；`engineStatus()` → 若 `declared:false` 显示引擎缺失卡；
  然后 `dataGet("workspace")` 恢复图/地址（没有就用默认空潜空间 + 示例图），再
  `engineCall("status", { baseUrl })` 探测（超时 20s，失败不弹窗，只把状态胶囊置为未连接）。
- 默认图（7 个节点，坐标合理、连线完整）：checkpoint、positive（示例词「清晨薄雾中的湖边小屋，
  木栈道通向水面，柔和逆光，电影感」）、negative（「低质量，模糊，水印，文字」）、latent 768×1024、
  sampler（steps 25, cfg 7, euler, normal, seed -1, denoise 1）、output，外加 0 个 LoRA。
  checkpoint 的 `ckpt_name` 取 `status.defaultCheckpoint`（没有就空串，节点上提示「先连接 ComfyUI 选择模型」）。
- 连接设置浮层：地址输入（默认 `http://127.0.0.1:8188`）、「连接」按钮、状态结果（ComfyUI 版本 /
  检查点数量 / 错误原因）。连接成功后刷新 checkpoint、lora、sampler、scheduler 下拉。
- 检查点/采样器目录为空时：节点内下拉退化为文本输入并给提示「未获取到目录，可直接填名称」。
- `dataSet("workspace", { baseUrl, graph })` 持久化；加载时对坏数据做防御（节点/边字段缺失就丢弃
  该节点/边，不白屏）。

### 4.4 空态与降级
- 无宿主桥（`window.__heming_widget` 不存在 / `engineCall` 不存在）：整页可用但顶部覆盖一条
  不可关闭的提示条「画布需要在和鸣桌面端（安装版）中打开」，运行按钮禁用。
- 引擎启动失败：结果面板显示原因（`engineStatus().error` 或 `engineCall` reject 的 message）+
  「重试」按钮；不得白屏。
- 没有 ComfyUI：结果面板显示引导卡（启动 ComfyUI、确认 8188 端口、连接设置入口），
  画布仍可编辑。

## 5. 代码结构（`app.js`，单文件，约 900–1400 行以内）

建议分区（顺序即可）：

1. `CONST`：节点类型表 `NODE_TYPES`（标题/颜色/输入输出端口/默认参数/字段渲染描述）、端口类型、
   画布缩放范围、默认地址。
2. `bridge`：安全获取 `window.__heming_widget`；`call(method, params, timeout)` 包装（缺桥时 reject）。
3. `state`：`{ graph, baseUrl, status, selected, camera, drag, connect, running, result, history, error }`。
4. 纯函数：`newNode(type, x, y)`、`defaultGraph(checkpoint)`、`validateGraph(graph)` → `{ok, message, missingPorts}`、
   `autoLayout(graph)`、`fitView(nodes, viewport)`、`portColor(type)`、`edgePath(a, b)`、
   `clampParams(type, params)`、`sanitizeWorkspace(raw)`。
5. 渲染：`renderAll()`（可由局部 `renderNodes/renderEdges/renderPanel/renderStatus` 组成）；
   拖拽期间只更新 transform/位置，不整树重建。
6. 事件绑定：指针事件统一用 `pointerdown/move/up` + `setPointerCapture`；滚轮缩放 `passive:false`。
7. 启动：`init()`。

性能要求：节点 ≤40 个时拖动保持流畅；不要在 `pointermove` 里做 DOM 查询（缓存元素引用）；
不要每个事件都 `dataSet`（防抖 500ms）。

## 6. 自检（提交前逐条）

- [ ] `node --check files/app.js` 通过。
- [ ] 页面里搜不到 `fetch(`、`XMLHttpRequest`、`eval(`、`new Function`、`innerHTML`、内联 `on*=` 属性。
- [ ] 深/浅两种 `data-theme` 下文字与边框都有足够对比度（深色背景不要出现黑字）。
- [ ] 无桥打开 `index.html`：能看到界面骨架与顶部提示条，不报未捕获异常。
- [ ] 默认图连线完整；点运行（引擎/ComfyUI 不可用）时给出的是中文可读原因。
- [ ] Delete/Esc/Ctrl+Enter 生效；输入框内按 Delete 不会删节点。
- [ ] 拖动、缩放、连线、加节点、删节点、适配视图都正常；刷新后图与地址恢复。
