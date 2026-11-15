# 变更日志

版本号只在准备发布时递增；只记用户可见的改动，实现细节见 `docs/`。

## 0.0.5-beta.1（2026-11-15）

0.0.5-beta.1 开发版，针对真实调用的失败记录收紧参数边界，并降低默认档常驻 token。

### 体验优化

- 默认档 `lean` 常驻 token 由 2443 降到 2178：`perf` 移出默认档，需要性能面板时切到 `standard`。
- 插件自己拉起的引擎空闲 10 分钟后自动重启，`/free` 在 AIMDO 下释放不了地址空间；用户自己启动的引擎只发 `/free`，不被接管。
- 引擎报 `VBAR allocation failed` 时，错误信息里直接给出「重启引擎再试」的建议，不再只贴一段引擎 JSON。
- `image_generate` 的描述点明：需要精确图内文字或特定风格时先调 `image_prompt_guide`。

### 问题修复

- `image_upscale` 的 `input_path` / `save_to` 传对象或空串时给出明确报错，不再抛底层的 `path` 类型错误。
- 显式指定编辑类模板却没传参考图时，本地直接报错并提示改用文生图，不再等网关返回 400 占位符错误。
- `ref_images` 里的空串不再被静默丢弃。
- `image_generate` 的 `prompt` 为空白时直接拒绝，并说明该写什么。

### 其他变更

- 档位工具数为 `minimal` 6 / `lean` 9 / `standard` 14 / `all` 16，设置页、README 与文档同步。
- 工具校验自测扩充到 31 项，覆盖路径参数、参考图闸门与引擎错误翻译。

## 0.0.4-beta.2（2026-11-12）

0.0.4-beta.2 开发版，新增 lean 档并压缩工具声明与提示词手册。

### 新增功能

- 新增 `lean` 工具集档位并设为默认：10 件工具，保留 standard 的全部能力，像素处理合并为 `image_process`（用 `action` 选 resize / mark_region / flatten_alpha / anim_encode / pose_check）。
- `npm run tokens` 覆盖 lean 档，设置页档位选择同步新增 lean。

### 体验优化

- 工具描述去掉重复说明与实现细节，`standard` 档常驻 token 由 2960 降至 2699，`lean` 档为 2419。
- 内置提示词手册压缩 17%（14210 → 11736 字符），保留全部实测数字与边界，去掉重复条目与机制解释。
- `image_prompt_guide` 的工具声明由 131 tokA 缩短到 83 tokA。
- 设置页与文档的档位说明改写为一句一档，不再逐项解释。

### 问题修复

- `image_upscale` 的倍率范围只写在 `scale` 参数上，`engine` 说明不再重复，避免两处口径不一致。
- 合并档下 `image_process` 对缺参、未知 action 的报错改为在参数层直接拒绝，并指出合法取值。

## 0.0.4-beta.1（2026-11-09）

0.0.4-beta.1 开发版，汇总自 0.0.3 以来的提示词与生成链路修复。

### 新增功能

- 生成结果回显实际 seed、尺寸、步数、模板与后端，便于同参数复现。
- `image_generate_raw` 支持整份 API 图在无网关时直接提交本机 ComfyUI。
- 生成结果附带交付前自检提示，提醒检查图内文字与属性。
- 内置提示词手册新增“什么时候不该用”一节。

### 体验优化

- 省略 `tier` 时默认 `standard` 1536²，与文档保持一致。
- 提示词手册支持英文与近义小节关键字，未命中时不再返回整本手册。
- `minimal` 档会标注当前未注册的工具。
- 参考图编辑按图片张数与 `denoise` 自动选择 i2i / edit3 / edit6。
- 相对 `save_to` 按会话工作目录解析。
- 宽高不是 32 的倍数时直接给出可读错误。

### 问题修复

- 网关链路下生图结果缺少 prompt_id 字段，真实宿主会报输出校验失败。
- 网关离线时 `image_generate_raw` 的整份工作流仍尝试连接网关。
- 内置提示词手册与探索版在文字步数、标签化写法、否定句上的口径冲突。
- 网关离线时状态页不显示本地档位，提示词手册缓存不随文档更新。

### 其他变更

- 新增 `npm run test:gateway`，覆盖网关链路的请求体与错误路径。
- 开发版改用 npm 的 `beta` dist-tag 发布，稳定版继续使用 `latest`。

## 0.0.3（2026-11-08）
修复安装与下载环节的用户反馈问题，默认安装位置改为当前用户目录，本机已有 ComfyUI 或 Python 的机器不再重复下载。

### 新增功能

- 本机已有 ComfyUI 便携版时自动复用它，不必再下载引擎；位置特殊时用环境变量 `IMAGEKIT_ENGINE_DIR` 指定。
- 像素工具自动使用 DSH 自带的 Python 运行时，不再要求用户另装 Python 与 Pillow。

### 体验优化

- 默认安装位置从 `D:/AI/Tools/ImageKit` 改为 `%LOCALAPPDATA%\dsh-imagekit`，不再出现作者机器的盘符与目录名。
- 安装根与子目录在打开设置页或执行 `status` 时自动创建，不再等到第一次下载才出现。
- 旧版默认目录已存在的机器继续沿用原目录，已下载的模型和引擎不受影响。
- 引擎未安装时状态直接说明并给出安装或复用做法，不再报成进程启动失败。
- `image_service_status` 先说明哪些能力不依赖网关，再报网关状态，不再直接显示 Gateway DOWN。
- 放大工具说明里列出每个引擎支持的倍率，可选引擎写成固定选项。
- `perf` 首次调用说明采样器刚启动，不再只显示一串问号。
- 引擎日志为空时说明日志只由插件启动的引擎写入，并回退到 ComfyUI 自己的日志。

### 问题修复

- 超分引擎安装失败时只显示 `FAIL upscale: [object Object]`，现在能看到真实原因。
- 多连接下载某一段失败后，其余分段仍在后台写盘，表现为进度卡住不动；现在会先取消同组分段再回退单流。
- 多连接回退到单流时残留 `.partial.N` 分段文件，占用数 GB 空间且下次安装会重复同样路径；现在回退前清理。
- 多连接失败会增加一次重试，仍失败才回退单流。
- 装了外部网关也总被当成没装，网关不在时错误提示指向错误的处理办法。

### 其他变更

- Node 版本要求对齐官方口径 `^22.19.0 || >=24.0.0`。
- README 补充国内镜像同步延迟的检查与重装命令。

## 0.0.2（2026-11-08）

汇总自 0.0.1 以来的主要变更，主要变化是出图不再依赖外部网关。

### 新增功能

- 内置直连后端：文生图与参考图编辑直接提交本机 ComfyUI，新增 `generationBackend` 配置，默认 `auto`，网关离线时自动走直连。
- 新增 `image_prompt_guide` 工具，按需返回随包提示词手册 `docs/PROMPTS-CORE.md`，不占常驻上下文。
- 新增 `denoise` 参数，配合单张参考图做部分重绘，保留原图结构只重画一部分。
- `draft` 档改用官方 turbo 8 步协议，只需 `fast` 包的 turbo 模型，画质接近 `standard`；没有 turbo 模型、但本地已有 turbo LoRA 时回退 6 步 LoRA。
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

- 提示词文档分两层，随包内置版与仓库探索版。
- 新增 `docs/ENGINE-VERSIONS.md`，补 `docs/ARCHITECTURE.md` 的能力矩阵与 `docs/MODEL.md` 的像素预算、放大路由、能力边界。
- README 补安装方式与首次使用引导。
- CI 改为安装依赖并执行完整测试。

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

