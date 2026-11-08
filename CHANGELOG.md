# 变更日志

版本号只在对外发布时递增；只记用户可见的改动，实现细节见 `docs/`。

## 0.0.2（2026-11-08）
### 新增

- **内置直连出图**：文生图与参考图编辑不再需要外部网关，插件直接驱动本机 ComfyUI；
  新增配置 `generationBackend`（`auto` 网关离线自动走直连 / `direct` / `gateway`）。
- **提示词手册随包分发**：新增工具 `image_prompt_guide`，返回 `docs/PROMPTS-CORE.md`，
  按需读取、不占常驻上下文；不再依赖 DSH 技能。
- **`draft` 档改用官方 turbo 8 步协议**：只需 `fast` 包的 turbo 模型（不再依赖未随包的 LoRA），
  画质接近 `standard`；没有 turbo 模型时回退 6 步 turbo LoRA。
- **部分重绘**：`image_generate` 新增 `denoise`（0–1，配单张 `ref_images`），直连走 VAEEncode，
  保留原图结构只重画一部分；0.7–0.9 有效，`denoise` 本身不减耗时。
- **模型自动卸载**：`unload_after` 生成后立即释放显存；`vramIdleFreeMinutes`（默认 10）空闲后自动释放。
- **多连接分片下载**：默认 4 条（可设 1/2/4/8），限速线路明显更快，不支持 Range 时自动回退单流。
- **下载进度**：百分比、实时速度、剩余时间、解压状态。
- **模型包可单独删除**：`image_setup(action="delete", component="models", pack="<name>", confirm="models")`，
  只清该包独有文件，共用文件保留并列出。
- **模型包必须显式指定**：`install` / `upgrade` 不带 `pack` 会报错并列出各包，避免低显存卡误下大包。

### 变更

- **默认出图尺寸 1056² → 1536²**（`standard` 档 25 步）；`quality` 保持 2048²/40 步（与官方示例一致）。
- **放大口径修正**：二次元放大提升明显，首选 `cugan_pro`；写实照片提升在边缘与材质干净度，原生 2K 仍更实。
- **提示词文档分两层**：随包核心版 `docs/PROMPTS-CORE.md` 与仓库探索版 `docs/PROMPTS.md`，互不复制。
- **网关降级为可选**：未安装时不再空等，直接提示改用内置直连；`image_service_status` 同时报告直连与引擎状态。
- **工具集档位**变为 `minimal` 6 / `standard` 14 / `all` 16。

### 修复

- 只装 `core` 包时无法出图，现已修复。
- 参考图编辑不传 `tier` 时会直接报错，现已修复。
- `cfg` / `negative_prompt` / `resolution` 现在可直接传（之前未声明，只能绕道 `image_generate_raw`）。
- 解压只保留两条路：`.zip` 用 Node 内置解压，`.7z` 用插件自带的 `7zr`，用户不必装 7-Zip。
- 「升级」与「修复」语义分开：版本不同才叫升级，只缺文件显示修复。
- 多文件下载时进度条回退到 0；下载进行中仍显示升级按钮。
- 非 Windows 平台改为明确报错，不再表现为「引擎起不来」。

### 文档

- **示例图重做**：四张示例改为 `quality` 档 2048² / 40 步直出，二次元换成猫娘女仆（提示词按手册的「主体 → 场景 → 风格 → 构图与光线」重写）。
- **新增二次元超分对比**：同一张 1024² 图放大 ×2，传统插值 / `cugan` / `cugan_pro` 三个 1:1 裁切并排。
- 写实两张对比图（原生 2048² vs 1056² 放大、插值 vs `waifu2x_photo`）用新示例图重做。
- 新增 `docs/ENGINE-VERSIONS.md`、`docs/PROMPTS-CORE.md`、`docs/ARCHITECTURE.md` 的能力矩阵。
- `docs/MODEL.md` 补像素预算、放大与后处理路由、能力边界；`docs/PROMPTS.md` 补分类配方与探索方法。
- README 补安装方式（DSH 添加插件 / `dsh plugin add` / 源码）与「装完还要下模型」的引导。

## 0.0.1（2026-11-08）

首个公开版本：把生图、像素处理、放大、引擎管理与性能监测收进同一个插件。

### 新增

- **生图**：`image_generate` / `image_generate_raw` / `image_workflow_inspect`，`draft` / `standard` / `quality` 三档，
  传参考图自动切编辑模板，`<image1>…<image10>` 指代多图。
- **像素处理**：`image_resize_lanczos`、`image_mark_region`、`image_flatten_alpha`、`anim_encode`、`pose_check`。
- **放大**：`image_upscale`，Real-CUGAN / Real-ESRGAN / waifu2x / RealSR 共 10 个预设，Vulkan 直通 GPU。
- **引擎与安装**：`comfy`、`image_service_status`、`image_setup`（status / verify / install / upgrade / delete / clean），
  断点续传、sha256 校验、升级备份与失败回滚。
- **性能与环境**：`perf`、`env_probe`、`preflight`。
- **设置页**：存储位置、下载源、工具集档位、组件与旧版本管理。
- **工具集档位**：`minimal` 5 件 / `standard` 13 件 / `all` 15 件。

### 修复

- 引擎升级先停引擎、保留 `ComfyUI/custom_nodes` 等用户数据、升级后按磁盘版本校验，不再因目录被占用而失败。
- 升级时一并停掉占用引擎 python 的网关进程，避免目录 `rename` 报 `EPERM`。
- 下载优先走 Releases API 资产直链，带超时、重试与断点续传。
- 「可升级」改为比较磁盘真实版本，不再被陈旧的记录（如 `"latest"`）误报。

### 说明

- 模型、ComfyUI 引擎、放大引擎、7-Zip 均不随包分发；下载只在设置页手动触发。
- 本版本生图依赖外部网关服务（默认 `http://127.0.0.1:8189`），仓库不含该服务。
- 仅在 Windows 10/11 x64 验证。
