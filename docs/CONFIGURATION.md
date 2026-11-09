# 配置参考

配置由 `lib/index.js` 的 `Config` 托管；volatile 字段在「插件 → 图像生成工坊」设置区直接改。
行为细节（下载、备份、删除怎么走）见 [IMPLEMENTATION.md](./IMPLEMENTATION.md)。

## 设置页字段

| 分组 | 字段 | 默认 | 说明 |
|---|---|---|---|
| 存储位置 | `installRoot` | `%LOCALAPPDATA%\dsh-imagekit` | 工具分类根目录。打开设置页或执行 `status` 时自动创建；旧版默认目录存在时沿用；可改为任意目录，`IMAGEKIT_INSTALL_ROOT` 可整体覆盖。其他平台按 XDG 数据目录解析，但引擎与超分仍仅支持 Windows x64 |
| | `modelsRoot` | `<installRoot>\models` | 生图模型 |
| | `engineRoot` | `<installRoot>\engine\ComfyUI_windows_portable` | ComfyUI 便携版。默认位置没引擎时自动探测本机已有的 ComfyUI 便携版并直接复用（不下载）；复用状态下 `image_setup` 拒绝往那个目录安装/升级。`IMAGEKIT_ENGINE_DIR` 可指定其他位置 |
| | `upscaleEnginesRoot` | `<installRoot>\upscale-engines\engines` | 放大引擎 |
| | `outputDir` | `<installRoot>\outputs` | 生成图片目录；放大落 `outputs/upscale` |
| 下载源 | `modelSource` | `huggingface` | `huggingface` / `hf-mirror`（第三方镜像）/ `modelscope`（第三方镜像）/ `custom` |
| | `modelPackBaseUrl` | 空 | `custom` 时的镜像根 |
| | `downloadConnections` | `4` | 大文件下载的分片连接数（`1`/`2`/`4`/`8`）；服务端不支持 Range 会自动回退单流 |
| | `githubProxy` | 空 | GitHub 下载代理（如 `https://ghfast.top/`）。仅在官方路径不可用时兜底，只代理 `github.com` 链接，仍按清单 sha256 校验；实测不提升速度，只提升可达性 |
| | `upscaleSource` | `official` | `official` / `sourceforge`（预留，当前清单未登记地址，会回落 `official`）/ `custom` |
| 性能与显存 | 只读 | 实时读取 | 只读面板，依赖 `perf` 工具；`minimal` 档不注册该工具，面板不可用 |
| 自动行为 | `toolsetProfile` | `standard` | `minimal` 6 件 / `standard` 14 件 / `all` 16 件 |
| | `autoDownload` | `off` | 保留字段，当前代码不会自动下载 |
| | `autoCheckUpdates` | `on` | `off` 时组件行不再显示「可升级/修复」提示（版本比对仍会做，只是不提示） |
| | `keepVersions` | `1` | 保留的旧版本备份份数（0–2） |

## 其他 Config（不在设置页）

| 键 | 默认 | 说明 |
|---|---|---|
| `gatewayUrl` | `http://127.0.0.1:8189` | 本地生图网关 |
| `generationBackend` | `auto` | 出图后端：`auto`（网关离线自动用内置直连）/ `direct` / `gateway` |
| `vramIdleFreeMinutes` | `10` | 空闲多少分钟后让引擎卸载模型释放显存（`0` = 不自动释放） |
| `generateTimeoutSeconds` / `processTimeoutSeconds` / `upscaleTimeoutSeconds` | 900 / 120 / 600 | 单次调用上限 |
| `selfHealWaitSeconds` | 420 | 引擎自愈等待 |
| `pythonCommand` / `nodePath` / `pythonPath` / `pnpmPath` | 空 | 空 = 按顺序探测：DSH 自带 Python 运行时（已含 Pillow/numpy）→ PATH 上的 `python` → `py` |
| `upscaleGpuDevice` | 0 | Vulkan 设备号 |
| `comfyBaseUrl` | `http://127.0.0.1:8188` | ComfyUI HTTP |
| `comfyRegistryYaml` | 空 | 模型注册表覆盖路径 |
| `perfDataDir` | `$DSH_HOME/imagekit/perf` | 性能采样数据 |
| `perfMode` | `inline` | `inline` / `worker` |
| `envDataDir` | `$DSH_HOME/imagekit/guard` | env_probe / preflight 数据 |
| `enginePorts` | `[8188, 8189, 16800]` | 视为本机引擎的端口 |
| `engines` | comfyui / 网关 / object-info | env_probe 探测的 HTTP 引擎 |
| `browserPaths` | `[]` | env_probe 检查的浏览器额外路径 |

性能采样器细项保持原 perfmon 默认：`intervalSec=5`、`censusIntervalSec=30`、`retentionHours=48`、
`minGpuProcMB=16`、`maxGpuProcs=12`、`topRssCount=8`；不在设置页暴露，需要时改 profile patch。

## 本机私有配置（不进版本库）

网关为独立服务，位置因环境而异。按以下顺序解析（代码中不包含具体路径）：

1. 环境变量 `IMAGEKIT_GATEWAY_DIR`（日志目录可另行设置 `IMAGEKIT_GATEWAY_LOG_DIR`）
2. `$DSH_HOME/imagekit/local.json` 的 `gatewayDir` 字段
3. `<installRoot>/gateway`

```json
// $DSH_HOME/imagekit/local.json
{ "gatewayDir": "<网关目录>" }
```

同类可覆盖项：`IMAGEKIT_INSTALL_ROOT`（整体换安装根）、`IMAGEKIT_ENGINE_DIR`（指定已有 ComfyUI，免再次下载引擎）。

解压相关的环境变量（排障用）：`IMAGEKIT_EXTRACTOR=zip` 强制 Node 内置解压；`.7z` 固定走 7zr（`IMAGEKIT_EXTRACTOR=7zr` 对 `.zip` 不生效）；`SEVEN_ZIP` 可指定本机 7z 可执行文件替代 7zr（仅特殊环境需要）。默认：`.zip` → Node 内置解压，`.7z` → `<installRoot>/tools/7zr.exe`（缺失时按需下载并校验 sha256，600 KB）。

不再探测本机 7-Zip 或系统 tar；上述两条路径之外不提供其他回退方式。

## 目录布局

```text
<installRoot>/
├── engine/ComfyUI_windows_portable/
├── models/
├── upscale-engines/engines/
├── outputs/            # 生成结果（放大在 outputs/upscale）
├── archives/           # 下载的压缩包
└── .imagekit/          # state.json / backups/
```

旧版默认目录存在时直接沿用（见上表）。点「恢复默认」走 `image_setup action=defaults`，会创建安装根与子目录并把默认路径填回设置页（仍需点保存）。

## 模型清单

`models.manifest.json` 结构：`components.{engine|models|upscale}.packs.<name>.files[]`。

模型包（`models.packs`，支持叠加安装，可同时存在；权重合计单位为 GiB）：

| pack | 组成 | 合计 | 建议显存 |
|---|---|---|---|
| `core`（推荐） | 标准 int8 扩散 + qwen3vl int8 编码器 + VAE | 16.1 | 12 GB+ |
| `fast` | turbo int8 扩散 + 同上 | 16.1 | 12 GB+，步数少 |
| `lowvram` | 标准 int8 + w4a8 编码器 + VAE | 13.3 | 8 GB |
| `lowvram-fast` | turbo int8 + w4a8 编码器 + VAE | 13.3 | 8 GB |
| `full` | turbo + VAE + ControlNet + PE | 28.5 | 32 GB+ |

文件条目字段：`path`/`checkPath`/`checkPaths`、`sources`、`sizeBytes`、`sha256`、`optional`、
`extractTo`/`extractRename`/`extractGlobs`/`extractMove`；pack 级 `version` 用于升级判断。

## 生成图片存放

- 不传 `save_to`：整批拷进 `outputDir`，同名加 `-1`/`-2` 后缀；
- 传 `save_to`：只存第一张（目录尾斜杠保留原名）；
- 目录自动创建；保存失败降级为结果里的 `save_error`，不影响已生成。
