# 变更日志

版本号只在对外发布时递增；只记用户可见的改动，实现细节见 `docs/`。

## 0.0.2（2026-11-08）

汇总自 0.0.1 以来的主要变更，重点是出图不再依赖外部网关。

### 新增功能

- 内置直连后端：文生图与参考图编辑直接提交本机 ComfyUI，新增 `generationBackend` 配置，默认 `auto`，网关离线时自动走直连。
- 新增 `image_prompt_guide` 工具，按需返回随包提示词手册 `docs/PROMPTS-CORE.md`，不占常驻上下文。
- 新增 `denoise` 参数，配合单张参考图做部分重绘，保留原图结构只重画一部分。
- `draft` 档改用官方 turbo 8 步协议，只需 `fast` 包的 turbo 模型，画质接近 `standard`，没有 turbo 模型时回退 6 步 turbo LoRA。
- 生成后可释放显存：`unload_after` 立即释放，`vramIdleFreeMinutes` 空闲后自动释放。
- 下载支持多连接分片，默认 4 条，可在设置页改为 1/2/4/8。
- 下载过程显示百分比、实时速度与剩余时间。
- `image_setup` 支持按包删除模型，只清理该包独有文件。

### 体验优化

- 默认出图尺寸从 1056² 改为 1536²，`quality` 档保持 2048²/40 步。
- 网关改为可选组件，未安装时直接提示使用内置直连，不再等待超时。
- 解压只用两条路，`.zip` 用 Node 内置解压，`.7z` 用随插件的 `7zr`，用户不必安装 7-Zip。
- 升级与修复分开提示，版本不同才显示升级。
- 非 Windows 平台返回明确错误，不再表现为引擎无法启动。
- 四张示例图与超分对比图重做，均为 `quality` 档 2048² 直出。
- 工具集档位调整为 `minimal` 6 / `standard` 14 / `all` 16。

### 问题修复

- 只装 `core` 包时无法出图。
- 参考图编辑不传 `tier` 时报参数对象不可扩展。
- `cfg`、`negative_prompt`、`resolution`、`unload_after` 未出现在参数表，模型无法传入。
- 多文件下载时进度条回退到 0。
- 下载进行中仍显示升级按钮。
- `install` 与 `upgrade` 未指定 `pack` 时不再默认取清单第一个包，改为报错并列出各包。

### 其他变更

- 提示词文档分两层，随包核心版与仓库探索版。
- 新增 `docs/ENGINE-VERSIONS.md`，补 `docs/ARCHITECTURE.md` 的能力矩阵与 `docs/MODEL.md` 的像素预算、放大路由、能力边界。
- README 补安装方式与首次使用引导。
- CI 改为安装依赖并跑完整测试。

## 0.0.1（2026-11-08）

首个公开版本，把生图、像素处理、放大、引擎管理与性能监测收进同一个插件。

### 新增功能

- 生图工具 `image_generate`、`image_generate_raw`、`image_workflow_inspect`，提供 `draft`、`standard`、`quality` 三档，传参考图时自动切换编辑模板。
- 像素处理工具 `image_resize_lanczos`、`image_mark_region`、`image_flatten_alpha`、`anim_encode`、`pose_check`。
- 放大工具 `image_upscale`，内置 Real-CUGAN、Real-ESRGAN、waifu2x、RealSR 共 10 个预设，通过 Vulkan 直接使用 GPU。
- 引擎与安装工具 `comfy`、`image_service_status`、`image_setup`，支持 status、verify、install、upgrade、delete、clean，下载带断点续传与 sha256 校验，升级前备份、失败自动回滚。
- 性能与环境工具 `perf`、`env_probe`、`preflight`。
- 设置页支持存储位置、下载源、工具集档位、组件与旧版本管理。
- 工具集按档位注册，`minimal` 5 件、`standard` 13 件、`all` 15 件。

### 问题修复

- 引擎升级先停引擎并按磁盘版本校验，同时保留 `ComfyUI/custom_nodes` 等用户数据，不再因目录被占用失败。
- 升级时一并停掉占用引擎 python 的网关进程，避免目录 `rename` 报 `EPERM`。
- 下载优先走 Releases API 资产直链，并带超时、重试与断点续传。
- 可升级判断改为比较磁盘真实版本，不再被陈旧记录误报。

### 其他变更

- 模型、ComfyUI 引擎、放大引擎、7-Zip 均不随包分发，下载只在设置页手动触发。
- 本版本生图依赖外部网关服务，默认 `http://127.0.0.1:8189`，仓库不含该服务。
- 仅在 Windows 10/11 x64 验证。

