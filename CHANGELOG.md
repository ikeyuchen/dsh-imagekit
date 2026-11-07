# Changelog

版本号只在对外发布时递增；日常提交记录在 git 历史里。

## 0.0.1（未发布）

首个公开版本：把生图、像素处理、放大、引擎管理与性能监测收进同一个 DSH 插件。

### 新增

- **生图**：`image_generate` / `image_generate_raw` / `image_workflow_inspect`，支持 `draft` / `standard` / `quality` 三档、
  参考图自动切换编辑模板、`<image1>…<image10>` 指代多图。
- **像素处理**：`image_resize_lanczos`、`image_mark_region`、`image_flatten_alpha`、`anim_encode`、`pose_check`。
- **放大**：`image_upscale`，内置 Real-CUGAN / Real-ESRGAN / waifu2x / Omni 等 12 个引擎预设，Vulkan 直通 GPU。
- **引擎管理**：`comfy`（status / control / upgrade）+ `image_service_status`，引擎与生图网关的隐藏拉起、健康探测与自愈。
- **资源管理器**：`image_setup`（status / verify / install / upgrade / delete / clean），模型包可叠加安装，
  下载支持断点续传与 sha256 校验，升级先备份、失败自动回滚。
- **性能与环境**：`perf`（GPU/显存采样与趋势卡）、`env_probe`（本机能力体检）、`preflight`（显存/端口/引擎前置闸门）。
- **工作流模板**：`t2i` / `t2i_turbo` / `turbo_official_t2i` / `turbo_official_edit` / `edit3` / `edit6` / `i2i` / `cn` / `vnccs` / `*_pe`。
- **设置页**：存储位置、下载源、工具集档位、组件与旧版本管理。
- **工具集档位**：`minimal` 5 件 / `standard` 13 件 / `all` 15 件，按需注册以降低常驻 token。

### 说明

- 模型、ComfyUI 引擎、超分引擎、7-Zip 均不随包分发，由用户在设置页触发下载或自行安装。
- 生图依赖外部网关服务（默认 `http://127.0.0.1:8189`），本仓库不含该服务。
- 已在 Windows 10/11 x64 验证；其它平台未验证。
