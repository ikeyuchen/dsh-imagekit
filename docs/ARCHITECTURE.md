# 架构

## 单包、多工具族

`dsh-imagekit` 是一个独立的 DSH 插件包，入口 `lib/index.js` 按**档位**注册工具：

```
apply(ctx, config)
├── registerImageGenTools   生图 2 件（+2 件任意工作流，standard 起）
├── registerUpscaleTools    放大 1 件
├── registerSetupTools      组件安装 image_setup 1 件
├── applyEngine             引擎 comfy 1 件
├── registerProcessTools    像素处理 5 件（standard 起）
├── applyPerf               性能 perf 1 件（standard 起）
└── applyEnv                环境 env_probe + preflight 2 件（仅 all）
```

| 档位 | 件数 | 组成 |
|---|---|---|
| `minimal` | 5 | 生图 2 + 放大 1 + 安装 1 + 引擎 1 |
| `standard`（默认） | 13 | minimal + 任意工作流 2 + 处理 5 + perf 1 |
| `all` | 15 | standard + env_probe + preflight |

分档依据：插件只有**生图**与**放大**两个功能，其余工具只在这两件事之外才用得到；
常驻成本见 `npm run tokens`（970 / 2350 / 2650 tokA）。

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
