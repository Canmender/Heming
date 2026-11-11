# 画布插件 · 页面 ↔ 引擎契约（唯一真源）

本文件是「画布」（`heming.image-studio`）第一版实现的**跨文件契约**：页面（`files/app.js`
+ `files/index.html` + `files/style.css`）与 Python 引擎（`files/engine/bridge.py`）都按这里
的字段实现。任何一方想改字段，先改本文件，再同步实现与 selftest。

插件边界：v4 bundle（`schemaVersion: 4` / `distribution: "bundle"`），页面运行在
`widget://heming.image-studio/files/index.html`，只能通过 `window.__heming_widget` 的
`engineCall` 与本机引擎通信；引擎只连**本机回环**上的 ComfyUI，端口可配。

---

## 1. 引擎方法

协议是宿主 `plugin-engine.js` 的换行 JSON：请求 `{id,method,params}`，响应
`{id,ok:true,result}` / `{id,ok:false,error:{type,message}}`；引擎主动上报
`{event:"progress", ...}`。宿主握手固定先调用 `ping`。

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `ping` | `{}` | `{pong:true, version:"0.1.0"}` | 宿主启动握手，必须最轻量、不联网 |
| `status` | `{ baseUrl }` | 见 §1.1 | 探测 ComfyUI 是否可达，并返回检查点/LoRA/采样器目录 |
| `run` | `{ baseUrl, graph }` | 见 §1.2 | 编译图 → 提交 ComfyUI → 轮询 → 取图落盘 |
| `cancel` | `{ baseUrl }` | `{cancelled:true}` | 调 ComfyUI `POST /interrupt`；无生成任务也返回 true |
| `reveal_outputs` | `{}` | `{ok:true, dir}` | 打开插件数据目录下的 `outputs/`（Windows 资源管理器；失败返回 ok:false 的原因） |

`baseUrl` 缺省 `http://127.0.0.1:8188`；引擎**只接受本机回环**（`127.0.0.1` / `localhost` /
`[::1]`，必须带 `http://` 与端口），其余一律报错。引擎最后会把它归一成不带尾斜杠的形式。

### 1.1 `status` 返回

```json
{
  "reachable": true,
  "baseUrl": "http://127.0.0.1:8188",
  "version": "0.3.40",
  "checkpoints": ["sd_xl_base_1.0.safetensors"],
  "loras": ["style_v1.safetensors"],
  "samplers": ["euler", "euler_ancestral", "dpmpp_2m"],
  "schedulers": ["normal", "karras", "exponential"],
  "defaultCheckpoint": "sd_xl_base_1.0.safetensors",
  "error": ""
}
```

- 不可达时 `reachable:false`、`error` 是**可直接展示的中文原因**（含地址与排查提示），
  其余为 `[]` / `""`，**不抛异常**（页面要能显示设置卡而不是报错）。
- ComfyUI 探测：`GET /system_stats` 取版本；`GET /object_info/CheckpointLoaderSimple`、
  `/object_info/LoraLoader`、`/object_info/KSampler` 取目录（字段在
  `input.required.ckpt_name[0]` 等位置，取不到就给空数组+warning 文案放进 `error`）。

### 1.2 `run` 返回

```json
{
  "promptId": "2f7c…",
  "seed": 123456789,
  "durationMs": 5123,
  "images": [
    {
      "filename": "ComfyUI_00001_.png",
      "subfolder": "",
      "type": "output",
      "bytes": 1048576,
      "path": "<插件数据目录>/outputs/20261111-131500-ComfyUI_00001_.png",
      "dataUrl": "data:image/png;base64,…"
    }
  ]
}
```

- `graph.sampler.seed === -1` 时引擎随机取 `0..2^31-1`，并在返回的 `seed` 里回填实际值。
- 图片落盘到 `HEMING_PLUGIN_DATA_DIR/outputs/`（文件名前缀时间戳，避免覆盖）。
- 单张原始字节 > 3.2MB 时 `dataUrl` 为 `null`（宿主协议单行上限 4MB），页面据此提示
  「已保存到 path，预览过大」并给「打开文件夹」按钮。
- 超时预算：提交 30s；轮询总时长 10 分钟（页面 `engineCall` 传 `timeoutMs: 620000`）。
  轮询间隔 600ms。
- 任何失败都返回 `ok:false`，`error.message` 用中文说清「哪一步 + 原因 + 建议」
  （如「提交工作流失败：ComfyUI 返回 400，节点 KSampler 的 ckpt_name 不存在」）。

### 1.3 进度事件

引擎通过 stdout 上报（页面用 `onEngineEvent` 收）：

```json
{ "event": "progress", "phase": "queued",  "promptId": "…" }
{ "event": "progress", "phase": "running", "promptId": "…" }
{ "event": "progress", "phase": "fetching","promptId": "…", "index": 0, "total": 2 }
```

`phase` 只有这三种；页面按它更新状态栏文案。事件不是应答，丢了不影响结果。

---

## 2. 图（graph）数据结构

页面维护、引擎消费。JSON 可 `JSON.stringify`，不含函数/循环引用。

```json
{
  "nodes": [
    { "id": "n1", "type": "checkpoint", "x": 40,  "y": 80,  "params": { "ckpt_name": "sd_xl_base_1.0.safetensors" } },
    { "id": "n2", "type": "positive",   "x": 360, "y": 40,  "params": { "text": "a quiet lake at dawn, cinematic" } },
    { "id": "n3", "type": "negative",   "x": 360, "y": 300, "params": { "text": "low quality, watermark" } },
    { "id": "n4", "type": "latent",     "x": 360, "y": 520, "params": { "width": 768, "height": 1024, "batch_size": 1 } },
    { "id": "n5", "type": "sampler",    "x": 700, "y": 240, "params": { "steps": 25, "cfg": 7, "sampler_name": "euler", "scheduler": "normal", "seed": -1, "denoise": 1 } },
    { "id": "n6", "type": "output",     "x": 1000,"y": 240, "params": {} }
  ],
  "edges": [
    { "from": { "node": "n1", "port": "model" }, "to": { "node": "n5", "port": "model" } },
    { "from": { "node": "n1", "port": "clip" },  "to": { "node": "n2", "port": "clip" } },
    { "from": { "node": "n1", "port": "clip" },  "to": { "node": "n3", "port": "clip" } },
    { "from": { "node": "n1", "port": "vae" },   "to": { "node": "n6", "port": "vae" } },
    { "from": { "node": "n2", "port": "conditioning" }, "to": { "node": "n5", "port": "positive" } },
    { "from": { "node": "n3", "port": "conditioning" }, "to": { "node": "n5", "port": "negative" } },
    { "from": { "node": "n4", "port": "latent" }, "to": { "node": "n5", "port": "latent" } },
    { "from": { "node": "n5", "port": "latent" }, "to": { "node": "n6", "port": "latent" } }
  ]
}
```

`x/y` 是画布坐标（只影响 UI，引擎忽略）。节点类型、端口与参数如下（`*` = 必填）：

| type | 输入端口 | 输出端口 | 参数 |
|---|---|---|---|
| `checkpoint` | — | `model` MODEL / `clip` CLIP / `vae` VAE | `ckpt_name`* 文本（≤260） |
| `lora`（可选，最多 1 个） | `model` MODEL / `clip` CLIP | `model` MODEL / `clip` CLIP | `lora_name`*（≤260）、`strength_model` 0–2（默认 1）、`strength_clip` 0–2（默认 1） |
| `positive` / `negative` | `clip` CLIP | `conditioning` CONDITIONING | `text`* 文本（≤4000，可为空串？不允许全空：见校验） |
| `latent` | — | `latent` LATENT | `width` 64–2048 且 8 的倍数、`height` 同上、`batch_size` 1–4 |
| `sampler` | `model` MODEL / `positive` CONDITIONING / `negative` CONDITIONING / `latent` LATENT | `latent` LATENT | `steps` 1–150、`cfg` 1–30、`sampler_name`、`scheduler`、`seed` -1 或 0..2^31-1、`denoise` 0–1 |
| `output` | `latent` LATENT / `vae` VAE | — | 无 |

### 2.1 图校验（引擎权威，页面先做一遍轻量检查）

必须满足，否则 `run` 返回中文错误（页面直接把 message 展示出来）：

1. 节点数 4–40；`id` 唯一（`^[A-Za-z0-9_-]{1,32}$`）；`type` 在词表内；未知字段忽略。
2. 每种类型**恰好 1 个**：`checkpoint` / `positive` / `negative` / `latent` / `sampler` / `output`；
   `lora` 0 或 1 个。
3. 每条边两端节点存在、端口在词表内、端口类型匹配（MODEL→MODEL、CLIP→CLIP、
   CONDITIONING→CONDITIONING、LATENT→LATENT、VAE→VAE）；同一输入端口最多 1 条入边；
   同一输出端口可多条出边；不允许自环；`from` 必须是输出端口、`to` 必须是输入端口。
4. 必需连接（缺失时点名「哪个节点的哪个输入没连」）：
   - `positive.clip`、`negative.clip` 必须来自 `checkpoint.clip` 或 `lora.clip`；
   - `sampler.model` 来自 `checkpoint.model` 或 `lora.model`；
   - `sampler.positive` ← `positive.conditioning`，`sampler.negative` ← `negative.conditioning`；
   - `sampler.latent` ← `latent.latent`；
   - `output.latent` ← `sampler.latent`；`output.vae` ← `checkpoint.vae`；
   - 有 `lora` 时：`lora.model`/`lora.clip` 必须来自 `checkpoint` 对应端口（不接受级联 lora）。
5. 节点上的**额外边**（例如把 `latent` 直接接到 `output`）合法，编译按端口取值；但所有
   输入端口都必须满足上述来源要求，否则报错。

### 2.2 编译到 ComfyUI API 格式（引擎负责）

按节点在 `nodes` 数组中的顺序分配 API 节点 id（`"1"`, `"2"`, …；`output` 占两个 id：
`VAEDecode` 与 `SaveImage`）。类映射：

| 图节点 | ComfyUI class_type | inputs |
|---|---|---|
| `checkpoint` | `CheckpointLoaderSimple` | `ckpt_name` |
| `lora` | `LoraLoader` | `lora_name`、`strength_model`、`strength_clip`、`model`、`clip`（来自 checkpoint） |
| `positive`/`negative` | `CLIPTextEncode` | `text`、`clip`（来自 checkpoint.clip 或 lora.clip） |
| `latent` | `EmptyLatentImage` | `width`、`height`、`batch_size` |
| `sampler` | `KSampler` | `seed`、`steps`、`cfg`、`sampler_name`、`scheduler`、`denoise`、`model`、`positive`、`negative`、`latent_image`（连线取 `[id, portIndex]`） |
| `output` | `VAEDecode` + `SaveImage` | `samples`←sampler.latent、`vae`←checkpoint.vae；`images`←VAEDecode、`filename_prefix: "heming-canvas"` |

端口序号：`CheckpointLoaderSimple` 输出 `MODEL=0, CLIP=1, VAE=2`；`LoraLoader` 输出
`MODEL=0, CLIP=1`；`CLIPTextEncode` 输出 `CONDITIONING=0`；`EmptyLatentImage` 输出
`LATENT=0`；`KSampler` 输出 `LATENT=0`；`VAEDecode` 输出 `IMAGE=0`。

提交：`POST {baseUrl}/prompt`，body `{"prompt": <api工作流>, "client_id": "heming-image-studio"}`。
响应的 `prompt_id` 用于轮询 `GET {baseUrl}/history/{prompt_id}`（返回对象里取该 id 的条目）。
条目 `status.status_str === "error"` 或存在 `status.messages` 里的 `execution_error` 时，
把节点 id 与异常文本转成中文错误。取图：
`GET {baseUrl}/view?filename=<urlencoded>&subfolder=<urlencoded>&type=output`。

---

## 3. 页面职责（详见 `docs/UI-SPEC.md`）

- 只通过 `window.__heming_widget` 访问宿主；**不**直接 `fetch` 任何地址（CSP 只放行声明主机，
  引擎负责全部网络）。
- 图与 `baseUrl` 存在 `dataGet/dataSet("workspace")`；不把图片写进宿主 data（体积）。
- 页面不得调用 `permissions` 之外的能力；不需要 `chat` / `kb` / `tools`。
- 所有网络行为集中在引擎；页面只做渲染、编辑和调用 `engineCall`。

## 4. 版本

- 插件 `version`：0.1.0；协议版本字段只在 `ping` 的 `version` 里出现，形如 `0.1.0`。
- 改任何请求/响应字段 = 破坏性变更：同时升 `version` 与更新本文件，并同步页面与引擎。
