# 变更日志

版本号只在对外发布时递增；用户可见变化记在这里。

## 0.0.2（未发布）

### 新增

- **模型包可单独删除**：设置页每个已安装的模型包新增「删除该包」，只清掉该包独有文件（与其他已安装包共用的保留并列出），
  装错高显存包时不必再整个 `models` 全删；命令行对应
  `image_setup(action="delete", component="models", pack="<name>", confirm="models")`。
- **尺寸与放大的使用说明**：README 与 `docs/USAGE.md` 新增「尺寸与放大」一节，按 Qwen-Image 2.1 官方口径说明
  **模型原生约 2K（官方示例 2048²/40 步，比例表 2048²–2752×1536）**，插件默认的 1056² 是速度预设（约原生 1/4 面积）；
  给出 1056²/1536²/2048²/2560² 的实测耗时，并附两张对比图：
  `docs/native-vs-upscale.webp`（原生 2048² vs 1056² 放大 ×2）、`docs/upscale-detail.webp`（传统插值 vs `waifu2x_photo` ×2）。
- **文档补齐上手路径**：安装方式分为「DSH 添加插件（包名 `dsh-imagekit`，npm 官方源）」「命令行 `dsh plugin add`」「源码」三种；
  新增「首次使用：装完还要下模型」一节，按显存给出选包对照表，并把设置页路径与组件下载顺序写清。

### 新增（续）

- **下载进度条**：设置页下载组件时显示百分比、已下载/总量与当前文件名，下载完自动转「解压中」；
  `job.json` 记录字节级进度（800ms 节流写盘），`image_setup(action="status")` 的 `job.percent` 同步暴露。
- **多连接分片下载**（默认 4 条，可在设置页「下载源 → 分片连接数」改成 1/2/4/8）：单文件切成 N 段并发 Range 下载后拼接；
  限速线路实测 1.4–3.8×，不限速约持平；服务端不支持 Range 或任一段失败会自动回退单流，校验仍在拼接后统一做。
  全程只用 Node 内置 `fetch`，不引入 aria2 等外部下载器。
- **下载速度与剩余时间**：进度条右侧显示实时速度（EMA 平滑）与预计剩余时间；设置页下载期间每秒轮询，
  属于实时刷新，不需要手动刷新页面。
- **模型包必须显式指定**：`image_setup(action="install"|"upgrade", component="models")` 不带 `pack` 会报错并列出
  各包（显存 / 体积），不再默默取清单第一个包（`core`，12G）——避免 8G 显卡误下 8.7GB 的错误编码器。

### 变更（尺寸与提示词）

- **默认出图尺寸 1056² → 1536²**：`standard` 档改为 25 步 × 1536²（12G 显存约 50 秒，约为模型原生 2K 的 6 成面积）；
  `draft` 保持 1056²/6 步用于草稿，`quality` 保持 2048²/40 步（与官方示例一致）。文档同步更新实测耗时。
- **放大口径修正**：此前写「放大补不出细节」过于绝对——二次元/插画放大提升非常明显（`cugan_pro`/models-pro 比
  `cugan`/models-se 更锐，见 `docs/anime-upscale.webp`）；写实照片提升在边缘与材质干净度，原生 2K 仍更实。
- **提示词文档分层**：`docs/PROMPTS.md` 改为「探索版手册」，开头说明两层分工与存放约定，
  并新增「能力探索方法」一节（固定 seed 阶梯实验、记录格式）。
- **内置提示词手册（新增工具）**：`image_prompt_guide` 返回随包分发的 `docs/PROMPTS-CORE.md`，
  覆盖选档、分类配方、文字渲染、参考图编辑、放大路由、能力边界、排查速查；按需读盘、进程内缓存，
  不占常驻上下文（每个档位只多 99 tokA）。手册是插件自身能力，**不再依赖 DSH 技能**。
  档位工具数变为 `minimal` 6 / `standard` 14 / `all` 16。

### 新增

- **内置直连出图后端（文生图不再需要外部网关）**：新增 `lib/generate/direct.js`，插件自己拼 ComfyUI API 工作流
  （UNETLoader / CLIPLoader / VAELoader / CLIPTextEncode / KSampler / VAEDecode / SaveImage，turbo 模板自动挂 LoRA），
  `/prompt` 提交 → `/history` 轮询 → `/view` 下载，全程静默无窗口。新增配置 `generationBackend`
  （`auto` / `direct` / `gateway`，默认 `auto`：网关离线时自动走内置直连）。
  实测无网关环境：draft 1056² 7.1 秒、standard 1536²/25 步 47.4 秒。
- **参考图编辑也内置**：`LoadImage`（先 `/upload/image` 上传本地参考图）+ `TextEncodeQwenImage21`（positive/negative/latent 三输出）
  构成编辑图，支持 1/3/6 张参考图；实测 1 图 25 步 19.5 秒、1 图 turbo 6 步 6.1 秒、3 图 6 步 8.6 秒，均无网关。
  至此只有 Prompt 增强（`*_pe`）/ ControlNet / VNCCS 等旧模板仍需外部兼容网关。
- **模型自动卸载**：`unload_after=true` 生成后立即 `POST /free` 释放（实测占用的 10.22 GB 降到 1.22 GB）；
  新增 `vramIdleFreeMinutes`（默认 10）在空闲后自动卸载，下次生成重置计时。
- **网关自愈修正**：网关现在是可选组件——未安装时不再 spawn 不存在的 `app.py`、也不白等 120 秒，而是 0 秒内明确
  提示「文生图/编辑用内置直连，旧模板才需要网关」；`image_service_status` 在网关 DOWN 时同时报告内置直连是否可用、引擎是否在线。

### 文档

- **提示词手册与模型手册大幅扩充**（内容来自长期内部实测，已按公开仓库标准脱敏）：
  `docs/PROMPTS.md` 增加按内容类型的配方（写实 / 二次元 / 3D 产品 / 海报文字 / 图标贴纸）、
  文字渲染档位、参考图编辑的「属性枚举 + 反向排除 + 多图职责」写法与易翻车场景；
  `docs/MODEL.md` 新增三节：像素预算与清晰度（4MP 内容峰值 / 8MP 可用上限 / 硬上限）、
  放大与后处理路由（引擎选择、降噪档、错配代价、不该放大的情况）、能力边界（三视图漂移、
  拼接不可行、多 seed 无共同真值、骨架格式、多帧累积、显存墙）。
  所有数字标注「本机单 seed 小样本、属经验值」，不写成普适规律；不含任何第三方 IP、客户信息、本机路径或内部设计。



- **PE（Prompt 增强）模型显存实测**：9.75 GB 加载峰值、释放后 1.23 GB；12 GB 卡必须「PE → 释放 → 出图」两段式，
  8 GB 卡跑不了。写入 `docs/MODEL.md`，便于用户决定是否装 `full` 包。

### 修复

- **`unload_after` 参数此前隐式失效**：代码一直在读它，但 `image_generate` 的参数表里没有声明，
  模型根本传不进来。现已声明为布尔参数，生成后立即 `POST /free` 释放显存（10.22 GB → 1.22 GB）。
- **参考图编辑不传 `tier` 会直接报错**：宿主会冻结工具参数，自动切编辑模板时写 `template` 触发
  “Cannot add property template, object is not extensible”。现在先拷贝再改（修复后实测 1 图编辑 20.8 s 通过）。
- **只装 `core` 包时完全不能出图**：直连的模型探测把 turbo 模型当必需项，干净安装（只有 `core`）会报
  “no turbo diffusion model” 而直接失败。现改为两个 UNET 都可缺，按请求模式显式校验：要 `draft` 必须有
  turbo 模型 + turbo LoRA，要标准档必须有 base 模型，缺什么就报缺什么并给出安装命令。
- **`cfg` / `negative_prompt` / `resolution` 同一类问题**：请求体一直在用，工具参数表同样没声明。
  现已补上——排版档的 `cfg 2`、负向词、编辑画布预算都能直接传，不必绕道 `image_generate_raw`。
- **解压只保留两个方案，不再依赖用户装 7-Zip**：`.zip` 用 Node 内置 zlib 解压；`.7z` 用插件自带的官方 7-Zip 精简版
  `7zr.exe`（首次按需下载 600 KB，sha256 固定校验，落在 `<installRoot>/tools/`）。`image_setup(action="status")` 的
  `extractor:` 行显示当前解压器。已实测真实 1.9GB 引擎 7z 与 46MB 上游 zip。
- **升级/修复语义拆开**：以前「缺文件」也会被当成「可升级」，界面上会出现「可升级 → 和已装版本一模一样」；
  现在版本不同才显示「升级」，只缺文件显示「修复」，并去掉文案里的箭头。
- **进度条在多个文件时会回退**：`writeProgress` 里 `...extra` 覆盖了累计字节数，换文件时把进度强制写成 0，
  表现为「4 个文件时进度只走到 1/4 又从头开始」；现在累计值在 spread 之后写入，进度单调递增。
- **下载中不再显示升级按钮**：该行有任务在跑（含其它会话发起的）时，升级/修复/校验/删除按钮全部隐藏或锁定；
  已安装的组件不再显示无动作的「已安装」下载按钮。
- **CI**：`ci.yml` 此前从不安装依赖，`doc-drift` 与 `image_setup` 自测在 `ERR_MODULE_NOT_FOUND` 上失败；
  现把宿主侧 peer 依赖钉进 `devDependencies`、补装 7-Zip，并让 CI 跑完整 `npm test`。
- **文档**：许可相关标题改为中文（`License`→`许可`、`Third-party`→`来源说明`、`Changelog`→`变更日志`）；
  修正「生图网关需自备并在设置里指向它」的错误描述（插件会自动拉起网关，网关目录与地址都不在设置页表单里）。

## 0.0.1（2026-11-08）

首个公开版本：把生图、像素处理、放大、引擎管理与性能监测收进同一个 DSH 插件。

### 新增

- **生图**：`image_generate` / `image_generate_raw` / `image_workflow_inspect`，支持 `draft` / `standard` / `quality` 三档、
  参考图自动切换编辑模板、`<image1>…<image10>` 指代多图。
- **像素处理**：`image_resize_lanczos`、`image_mark_region`、`image_flatten_alpha`、`anim_encode`、`pose_check`。
- **放大**：`image_upscale`，内置 Real-CUGAN / Real-ESRGAN / waifu2x / RealSR 共 10 个预设（上游官方 MIT/BSD 构建），Vulkan 直通 GPU。
- **引擎管理**：`comfy`（status / control / upgrade）+ `image_service_status`，引擎与生图网关的隐藏拉起、健康探测与自愈。
- **资源管理器**：`image_setup`（status / verify / install / upgrade / delete / clean），模型包可叠加安装，
  下载支持断点续传与 sha256 校验，升级先备份、失败自动回滚。
- **性能与环境**：`perf`（GPU/显存采样与趋势卡）、`env_probe`（本机能力体检）、`preflight`（显存/端口/引擎前置闸门）。
- **工作流模板**：`t2i` / `t2i_turbo` / `turbo_official_t2i` / `turbo_official_edit` / `edit3` / `edit6` / `i2i` / `cn` / `vnccs` / `*_pe`。
- **设置页**：存储位置、下载源、工具集档位、组件与旧版本管理。
- **工具集档位**：`minimal` 5 件 / `standard` 13 件 / `all` 15 件，按需注册以降低常驻 token。

### 变更

- **放大引擎改为上游官方构建**：`image_upscale` 的四个引擎统一从各自上游官方 GitHub Releases 下载并逐包校验 sha256 ——
  Real-CUGAN、waifu2x（MIT）、Real-ESRGAN（BSD-3）、RealSR（MIT），合计约 190 MB。
  预设共 10 个：`cugan` / `cugan_pro` / `cugan_cons` / `waifu2x` / `waifu2x_photo` /
  `esrgan_anime` / `esrgan_hq` / `photo_hq` / `realsr` / `realsr_jpeg`。
- 新增 `githubProxy` 配置（默认空）：GitHub 直连不通时可用 `https://ghfast.top/` 之类代理兜底。
  实测本机直连 `github.com` 8/8 连接超时、`api.github.com` 资产直链 4.0 MB/s、`ghfast.top` 3.55 MB/s 且 sha256 一致——
  代理只提升**可达性**、不加速；下载器仍优先走官方 API 资产直链，代理排在第三位（仅代理 `github.com` 链接，`api.github.com` 不被代理）。

- **模型包可单独删除**：设置页每个已安装的模型包新增「删除该包」，只清掉该包独有文件（与其他已安装包共用的保留并列出），
  装错高显存包时不必再整个 `models` 全删；命令行对应 `image_setup(action="delete", component="models", pack="<name>", confirm="models")`。
- **CI 修复**：`ci.yml` 此前从不安装依赖，`doc-drift` / `image_setup` 自测在 `ERR_MODULE_NOT_FOUND` 上失败；现钉住宿主侧
  peer 依赖为 devDependencies、补装 7-Zip，并让 CI 跑完整 `npm test`。

### 修复

- 引擎升级前先停止引擎、升级后重启并按磁盘 `comfyui_version.py` 校验版本，避免运行中的进程占用目录导致备份 `rename` 失败；
  整目录替换前会保留并放回 `ComfyUI/custom_nodes` / `ComfyUI/extra_model_paths.yaml` / `ComfyUI/user` / `ComfyUI/input` / `ComfyUI/output` / `ComfyUI/models`，
  升级不再把用户的节点与模型注册一并冲掉。
- 升级引擎时一并处理生图网关：先停掉占用引擎 python_embeded 的网关进程（否则目录 `rename` 报 `EPERM`），
  换包后用新 python 补装 `<网关目录>/requirements.txt`，失败自动回滚；网关由下次生图自愈拉起。
- 引擎下载改为优先走官方 Releases API 资产直链（发布页直链在受限网络下会在连接阶段超时），
  增加「无数据超时 + 自动重试 + 断点续传」，避免设置页升级按钮长时间无响应；`sha256` 不符直接失败不重下。
- 组件「可升级」改为比较磁盘真实版本，不再被陈旧的 `state.json` 记录（如 `"latest"`）永久误报。

### 说明

- 模型、ComfyUI 引擎、超分引擎、7-Zip 均不随包分发，由用户在设置页触发下载或自行安装。
- 新增[引擎版本策略](docs/ENGINE-VERSIONS.md)：默认只用清单固定的验证版本，同步上游最新仅作实验性逃生通道。
- 生图依赖外部网关服务（默认 `http://127.0.0.1:8189`），本仓库不含该服务。
- 已在 Windows 10/11 x64 验证；其它平台未验证。
