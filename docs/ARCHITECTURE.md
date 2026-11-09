# 架构

## 单包与多工具族

`dsh-imagekit` 是独立的 DSH 插件包，入口为 `lib/index.js`，按档位注册工具：

```
apply(ctx, config)
├── registerImageGenTools   生图 2 件、提示词手册 1 件（另含 2 件任意工作流，standard 起）
├── registerUpscaleTools    放大 1 件
├── registerSetupTools      组件安装 image_setup 1 件
├── applyEngine             引擎 comfy 1 件
├── registerProcessTools    像素处理 5 件（standard 起）
├── applyPerf               性能 perf 1 件（standard 起）
└── applyEnv                环境 env_probe 与 preflight 共 2 件（仅 all）
```

| 档位 | 件数 | 组成 |
|---|---|---|
| `minimal` | 6 | 生图 2、手册 1、放大 1、安装 1、引擎 1 |
| `standard`（默认） | 14 | minimal + 任意工作流 2 + 处理 5 + perf 1 |
| `all` | 16 | standard + env_probe + preflight |

分档依据：插件的主要功能为生图与放大，其余工具仅在相关场景使用。常驻成本见 `npm run tokens`（1520 / 2960 / 3260 tokA）。

所有工具共享同一 Cordis 插件生命周期与系统提示段。`image_generate` 的引擎兜底可通过
`ctx.tools.get("comfy")` 找到同包引擎工具，不依赖外部插件是否存在。

## 内聚而非多包的原因

- 用户只需一次安装、一个版本号与一个 GitHub 仓库。
- 图像生成、引擎自愈与 VRAM 监测属于同一工作流。
- 避免 profile 中多个包版本不一致。
- 代价是引擎与性能模块不能单独复用。若后续需要独立发布，可按 `lib/engine` 与 `lib/perf`
  边界拆包，工具名保持不变。

## 运行时边界

- `apply()` 不启动引擎，不加载 Python、Pillow 或 Vulkan，不访问网络。
- `comfy` 与 `perf` 的采样及引擎副作用均发生在工具调用或各自后台线程内。
- 外部模型、ComfyUI 引擎与 Vulkan 引擎不随 npm 包分发。

## 数据目录

- 性能采样默认写入 `$DSH_HOME/imagekit/perf`，可通过 `perfDataDir` 覆盖。
- 环境检测（env_probe / preflight）默认写入 `$DSH_HOME/imagekit/guard`，可通过 `envDataDir` 覆盖；preflight 打点也写入该目录。
- ComfyUI 状态与日志默认位于 `engineRoot` 的父目录。
- 资源版本、备份与下载进度位于 `<installRoot>/.imagekit/`：
  - `state.json`：各组件已安装版本与安装、升级时间；
  - `job.json`：最近一次安装或升级任务状态；
  - `backups/<component>/<version>-<时间戳>/`：旧版本备份，包含 `payload/` 与 `meta.json`，使用同盘 `rename`。
- 插件包目录内不写入运行数据。

## 能力矩阵

手册 `docs/PROMPTS-CORE.md` 由 `image_prompt_guide` 按需返回，其中每项能力的落点如下。
「直连」指插件内置的 ComfyUI 直通后端，不需要外部网关；「网关」指外部生图网关。

| 能力 | 落点（工具与参数） | 直连 | 网关 |
|---|---|---|---|
| 文生图与批量候选 | `image_generate`（`prompt`、`tier`、`width`、`height`、`steps`、`seed`、`batch_size`） | 支持 | 支持 |
| 参考图编辑 | `image_generate` 与 `ref_images`。单图使用 `*_edit`，2–3 张使用 `*_edit3`，4 张以上使用 `*_edit6`，单图且 `denoise<1` 使用 `*_i2i` | 支持，按张数拼节点 | 支持，上限 10 张 |
| 文字渲染调档 | 同 `image_generate`（`steps`、`cfg`、`negative_prompt`）与 `tier=quality` | 支持 | 支持 |
| 部分重绘（保留结构） | `image_generate` + 单张 `ref_images` + `denoise` 0.7–0.9 | 支持，走 VAEEncode 与 KSampler | 支持，自动使用 i2i 模板 |
| 任意工作流 | `image_generate_raw`：整份 `workflow`（API 图） | 支持，提交至 `/prompt` | 支持 |
| 模板巡检 | `image_workflow_inspect`：解析网关模板 | 不适用 | 支持 |
| 结果可复现 | `image_generate` 的 render 回显 `seed`、`size`、`steps`、`cfg`、`template`、`backend` | 支持 | 支持 |
| 快速草稿档 | `tier=draft`。直连使用官方 turbo 8 步协议（`ManualSigmas` 与 `CFGGuider`，需要 `fast` 包）；缺少 turbo 模型且本地有 turbo LoRA 时回退至 6 步 LoRA；两者均缺失时返回错误 | 支持 | 支持 |
| 放大 | `image_upscale`（`engine`、`scale`、`denoise`，10 个预设） | 支持 | 不适用 |
| 降采样与转格式 | `image_resize_lanczos`（`width`、`percent`、`format`、`quality`） | 支持 | 不适用 |
| 透明扁平化 | `image_flatten_alpha`（`background`、`format`） | 支持 | 不适用 |
| 局部标记 | `image_mark_region`（`cx`、`cy`、`radius`、`stroke_width`、`color`） | 支持 | 不适用 |
| 动图合成 | `anim_encode`（`frames`、`durations_ms`、`format`、`quality`、`loop`、`max_size`） | 支持 | 不适用 |
| 姿势几何校验 | `pose_check`（`character_image`、`skeleton_image`、`threshold`） | 支持 | 不适用 |
| 显存回收 | `unload_after`、`vramIdleFreeMinutes`、`comfy op=free` | 支持 | 支持 |
| 引擎与组件 | `comfy`（start/stop/restart/free/interrupt/upgrade）与 `image_setup`（engine/models/upscale） | 支持 | 不适用 |
| 提示词手册 | `image_prompt_guide`（`section`，常驻 131 tokA） | 支持 | 不适用 |

后端选择：`generationBackend=auto` 先探测网关，离线时使用直连；`direct` 仅使用直连；`gateway` 仅使用网关。

## 已知能力缺口

| 项 | 现状 | 处理方式 |
|---|---|---|
| alpha 检测与合成 | `image_upscale` 只校验文件头，不检测透明通道；RGBA 图直接放大可能丢失透明通道 | 先使用 `image_flatten_alpha`；需要保留透明时，放大 RGB 图后自行合成 alpha |
| 抠图质量校验 | 仅提供提示词侧方法，没有 alpha 后处理 | 使用 `image_flatten_alpha` 检查透明区域 |
| OCR 与画质比对 | 无内置工具，`pose_check` 只计算姿势几何 | 由 agent 进行视觉复核，或更换 seed 对照 |
| 裁剪、拼接与图层合成 | 无专用工具；编辑为整图重绘，不是图层合成 | 使用 `image_generate_raw` 运行自定义工作流，或在仓库外处理 |
| 骨架生成、ControlNet、LoRA、PE | 需要额外模型与专用工作流，插件只提供 `pose_check` 校验 | 将 `generationBackend` 设为 `gateway`，使用外部兼容网关 |
| 编辑模式 `batch_size` | 直连的编辑图每次生成一张，`batch_size` 只影响 t2i | 多次调用 |
| turbo 档的编辑 | 官方 turbo 编辑为整图重绘（官方配置为 cfg 8），实测会改变主体，不能保留结构 | 需要保留结构时使用 `denoise` 0.7–0.9 的 i2i 路径 |

直连后端覆盖手册 §0–§10 的日常路径，包括生图、编辑、文字、放大、动图与显存。
留在外部的只有质量校验与需要额外模型的控制，两者都不是默认路径的必需环节。
