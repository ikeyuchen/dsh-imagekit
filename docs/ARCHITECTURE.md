# 架构

## 单包、多工具族

`dsh-imagekit` 是一个独立的 DSH 插件包，入口 `lib/index.js` 按**档位**注册工具：

```
apply(ctx, config)
├── registerImageGenTools   生图 2 件 + 提示词手册 1 件（+2 件任意工作流，standard 起）
├── registerUpscaleTools    放大 1 件
├── registerSetupTools      组件安装 image_setup 1 件
├── applyEngine             引擎 comfy 1 件
├── registerProcessTools    像素处理 5 件（standard 起）
├── applyPerf               性能 perf 1 件（standard 起）
└── applyEnv                环境 env_probe + preflight 2 件（仅 all）
```

| 档位 | 件数 | 组成 |
|---|---|---|
| `minimal` | 6 | 生图 2 + 手册 1 + 放大 1 + 安装 1 + 引擎 1 |
| `standard`（默认） | 14 | minimal + 任意工作流 2 + 处理 5 + perf 1 |
| `all` | 16 | standard + env_probe + preflight |

分档依据：插件只有**生图**与**放大**两个功能，其余工具只在这两件事之外才用得到；
常驻成本见 `npm run tokens`（1282 / 2662 / 2962 tokA）。

所有工具共享同一个 Cordis 插件生命周期和系统提示段；`image_generate` 的引擎兜底可以直接从
`ctx.tools.get("comfy")` 找到同包引擎工具，不再依赖外部插件是否存在。

## 为什么内聚而不是多包

- 用户只需要一次安装、一个版本号、一个 GitHub 仓库；
- 图像生成、引擎自愈、VRAM 监测本身就是同一条工作流；
- 避免 profile 中三个包版本漂移；
- 代价是引擎/性能模块不能单独复用；如果以后需要独立发布，可按 `lib/engine`/`lib/perf`
  边界再拆包，工具名保持不变。

## 放宽的边界

- `apply()` 不启动引擎、不加载 Python/Pillow/Vulkan、不联网；
- `comfy`/`perf` 的采样与引擎副作用都在工具调用或各自后台线程内；
- 外部模型、ComfyUI 引擎、Vulkan 引擎不随 npm 包分发。

## 数据目录

- 性能采样默认 `$DSH_HOME/imagekit/perf`（`perfDataDir` 可覆盖）；
- 环境检测（env_probe/preflight）默认 `$DSH_HOME/imagekit/guard`（`envDataDir` 可覆盖）；preflight 打点也在这里；
- ComfyUI 状态/日志默认在 `engineRoot` 的父目录；
- 资源版本/备份/下载进度在 `<installRoot>/.imagekit/`：
  - `state.json`：各组件已安装版本、安装/升级时间；
  - `job.json`：最近一次安装/升级任务状态；
  - `backups/<component>/<version>-<时间戳>/`：旧版本备份（`payload/` + `meta.json`），同盘 `rename`；
- 插件包目录内不写运行数据。

## 能力矩阵（与提示词手册对齐）

手册 `docs/PROMPTS-CORE.md`（`image_prompt_guide` 按需返回）里的每条能力，落点如下。
「直连」= 插件内置的 ComfyUI 直通后端，不需要外部网关；「网关」= 外部生图网关。

| 能力 | 落点（工具 / 参数） | 直连 | 网关 |
|---|---|---|---|
| 文生图 + 批量候选 | `image_generate`（`prompt` / `tier` / `width` / `height` / `steps` / `seed` / `batch_size`） | ✅ | ✅ |
| 参考图编辑 | `image_generate` + `ref_images`（`*_edit` / `*_edit3` / `*_edit6` / `*_i2i`） | ✅ 按张数拼节点（实测 1/3/6） | ✅ 上限 10 |
| 文字渲染调档 | 同 `image_generate`（`steps` / `cfg` / `negative_prompt`）+ `tier=quality` | ✅ | ✅ |
| 部分重绘（保结构） | `image_generate` + 单张 `ref_images` + `denoise` 0.7–0.9（直连走 VAEEncode + KSampler） | ✅ | ✅ i2i 模板 |
| 快速草稿档 | `tier=draft`（turbo LoRA）或 `template=turbo_official_t2i` | ✅ | ✅ |
| 放大 | `image_upscale`（`engine` / `scale` / `denoise`，10 个预设） | ✅ | — |
| 降采样 / 转格式 | `image_resize_lanczos`（`width` / `percent` / `format` / `quality`） | ✅ | — |
| 透明扁平化 | `image_flatten_alpha`（`background` / `format`） | ✅ | — |
| 局部标记 | `image_mark_region`（`cx` / `cy` / `radius` / `stroke_width` / `color`） | ✅ | — |
| 动图合成 | `anim_encode`（`frames` / `durations_ms` / `format` / `quality` / `loop` / `max_size`） | ✅ | — |
| 姿势几何校验 | `pose_check`（`character_image` / `skeleton_image` / `threshold`） | ✅ | — |
| 显存回收 | `unload_after` / `vramIdleFreeMinutes` / `comfy op=free` | ✅ | ✅ |
| 引擎与组件 | `comfy`（start/stop/restart/free/interrupt/upgrade）/ `image_setup`（engine/models/upscale） | ✅ | — |
| 提示词手册 | `image_prompt_guide`（`section`，常驻 99 tokA） | ✅ | — |

后端分工：`generationBackend=auto` 先探网关，离线自动走直连；`direct` 只用直连；`gateway` 只用网关。

## 已知能力缺口（架构层，不在本插件）

| 项 | 现状 | 绕法 |
|---|---|---|
| alpha 检测 / 合成 | `image_upscale` 只校验文件头，不做透明通道检测，RGBA 直放可能静默丢透明 | 先 `image_flatten_alpha`；要保留透明就 RGB 放大后自行合成 |
| 抠图质量校验 | 只有提示词侧话术，没有 alpha 后处理 | 用 `image_flatten_alpha` 反向看透明区干不干净 |
| OCR / 画质比对 | 无内置工具（无文字识别、无 SSIM）；`pose_check` 只算姿势几何 | 交给 agent 的视觉复核（多读一次 / 换 seed 对照） |
| 裁剪 / 拼接 / 图层合成 | 无工具；编辑是整图重绘不是图层 | 用 `image_generate_raw` 跑自定义工作流，或在仓库外处理 |
| 骨架生成 / ControlNet / LoRA / PE | 需要额外模型与专用工作流，插件只提供 `pose_check` 校验 | 配 `generationBackend=gateway` 走外部兼容网关 |
| 编辑模式 `batch_size` | 直连的编辑图固定一图一跑（`batch_size` 只影响 t2i） | 多次调用 |
| `draft` 档所需的 turbo LoRA | 直连的 turbo 路径 = turbo 模型 + turbo LoRA；**模型包不包含 LoRA**（`full` 也不含） | 自行放入 `models/loras/`；或改用 `standard`/`quality`（`core` 包即可） |
| 官方 turbo 的 8 步协议 | 官方 turbo 模型配的是 ManualSigmas + CFGGuider；直连没实现，`template=turbo_official_t2i` 在直连会显式报错 | 走网关后端；或直接 `tier=standard` |

结论：直连后端已经覆盖手册 §0–§8 的日常路径（生图 / 编辑 / 文字 / 放大 / 动图 / 显存），
留在外部的只有两类——「质量校验」与「需额外模型的控制」。这两类都不是默认路径的必经环节。
