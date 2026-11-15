# 后端可移植性：ComfyUI 与 stable-diffusion.cpp

> **状态：评估稿（未实现）。** 本文记录「是否换掉生图引擎」的选型依据，不代表已交付能力；
> 当前实际能力以[架构](ARCHITECTURE.md)的能力矩阵为准。

## 结论先行

- `llama.cpp` 不在候选里：它不做扩散，所有架构都是因果注意力加逐 token 采样。ggml 家族里
  真正做生图的是 stable-diffusion.cpp（下称 sd.cpp），与它共享后端、同为 MIT。
- 产品主干（文生图、参考图编辑、部分重绘、放大、批量）在 sd.cpp 上都有等价能力，
  参数几乎一一对应，连 turbo 档的 8 步 sigma 表都逐位相同。
- 迁移动因是三条硬约束：ComfyUI 为 GPL-3.0（闭源分发受限）、便携引擎绑 Windows 与
  Python 运行时、单进程单队列。
- 迁移代价是三条：失去任意工作流（ControlNet 只剩 SD 1.5）、切模型变整模型重载、上游接口频繁变动。

## 工具 × 后端

「不受影响」表示该工具不经过生图引擎，换后端无需改动。

| 工具 | 用途 | ComfyUI（现状） | sd.cpp（若迁移） | 说明 |
|---|---|---|---|---|
| `image_generate` | 文生图、参考图编辑、批量、`denoise` 部分重绘 | 支持 | 支持 | 参数近 1:1 映射（`ref_images`、`init_image` 加 `strength`、`custom_sigmas`）；`tier` 切换从图内换模型变成整模型重载；编辑需要额外挂视觉投影（mmproj） |
| `image_generate_raw` | 提交任意 API 图 | 支持 | 不支持 | sd.cpp 没有「图」这一层，只有固定请求体 |
| `image_workflow_inspect` | 解析网关模板 | 仅网关 | 不适用 | 与引擎无关，属于网关侧功能 |
| `image_service_status` | 引擎状态与队列 | 支持 | 部分支持 | 有模型状态、能力清单与配方列表，没有队列列表，也没有显存读数 |
| `comfy` | 启停、回收显存、中断、升级 | 支持 | 需重写 | 启停保留；回收显存变成卸载模型；升级变成替换二进制 |
| `image_setup` | 引擎与模型包安装 | 支持 | 需重做清单 | 从「可原地升级的便携包」变成「二进制压缩包加组件文件」：扩散模型、文本编码器、VAE 三门 |
| `env_probe` 与 `preflight` | 环境探测与预检 | 支持 | 需改判据 | 现在判 Python 与引擎目录，改为判二进制与组件完整性 |
| `image_upscale` | 超分放大 | 支持 | 不受影响 | 走独立的 ncnn 二进制，与生图引擎解耦 |
| `image_process` | 像素处理（含 `image_resize_lanczos`、`image_mark_region`、`image_flatten_alpha`） | 支持 | 不受影响 | 本地运算 |
| `anim_encode` | 动图合成 | 支持 | 不受影响 | 本地编码 |
| `pose_check` | 姿势几何校验 | 支持 | 不受影响 | 本地比对 |
| `image_prompt_guide` | 提示词手册 | 支持 | 不受影响 | 随包文档 |
| `perf` | 性能与显存采样 | 支持 | 基本不受影响 | 显存本就走 nvidia-smi，不读引擎状态 |

## 生成算法自由度

ComfyUI 给的是「图」：节点怎么接、参考图怎么注入、采样器用哪个、最后接不接放大，都是可编辑的
JSON。sd.cpp 给的是「参数表」：文本编码、采样、解码、可选的高清修复与放大，中间插不进东西。

| 档位 | 能力 | ComfyUI | sd.cpp |
|---|---|---|---|
| 不受影响 | 文生图、多张参考图编辑、turbo 8 步、部分重绘、遮蔽重绘（`mask_image`）、文字改图、RGBA 透明输出、ESRGAN 放大、LoRA 叠加、批量、种子复现 | 支持 | 支持 |
| 退化但可绕 | 一次多组参数对比（应用层循环发任务）、多段处理（放大后重绘要分两次请求并落盘）、换模型（整模型重载） | 图内一次完成 | 靠上层拼，慢且有磁盘往返 |
| 部分支持 | ControlNet 只在 SD 1.5 上有；IP-Adapter 限 SD 1.5 与 SDXL（含 Plus）；参照图编码的可调项换成 `ref_image_args` 的一套预设 | 不设限 | 有边界 |
| 做不了 | latent 直接传给后续节点、多模型串成一张图、任意 API 图、自定义节点 | 支持 | 无等价物 |

采样器本身不是短板：sd.cpp 也支持 euler、heun、dpm++ 系列、lcm 与自定义 sigma 曲线，
turbo 档用的 `qwen-image-2.1-turbo` 预设与插件现有 sigma 表逐位相同，出图可对齐。
随机数另有一项便利：sd.cpp 支持 `--rng cpu`，与 ComfyUI 的 RNG 一致，同 seed 可比对。

## 三件常被问到的事

**参考图**：支持。多张参考图按顺序重复传参即可，等价于现在的 1 / 3 / 6 张模板。
Qwen-Image-2.1 的编辑必须额外加载视觉投影文件（`--llm_vision`），这是它与纯文生图唯一的组件差别。

**局部修改**：两条路。指令式（在提示词里说明改哪块）是 Qwen-Image-2.1 的原生用法；
原生 API 另有 `mask_image` 字段（单通道，与 `init_image` 和 `strength` 配合），
用于支持遮蔽重绘的模型。当前工具面没有暴露遮蔽参数，所以这一项对现有产品是「不减反增」。

**文字修改**：支持。官方编辑示例本身就是改图中的文字（把画面里的 `qwen2.1.cpp` 改成 `sd.cpp`），
换字、保留原字体这类需求由模型负责，引擎只做透传。

## 迁移面

`lib` 约 11718 行，其中引擎相关约 3000 行，真正贴着 ComfyUI 协议的约 1700 行：

- `lib/generate/direct.js`（图构造、提交与轮询、上传下载）
- `lib/generate/gateway.js`（自愈拉起与 HTTP 客户端）
- `lib/engine/index.js`（启停、状态、升级）

其余部分与引擎无关，可直接复用：`lib/setup.js` 的带校验下载与解压、`lib/upscale.js` 的三个
Vulkan 二进制、`lib/process.js`、`lib/perf/sampler.js` 的 nvidia-smi 采样。

## 约束与代价

| 项 | ComfyUI | sd.cpp |
|---|---|---|
| 许可证 | GPL-3.0，随包分发闭源产品受限 | MIT |
| 平台 | 便携包为 Windows 专属 | CPU、CUDA、Vulkan、Metal、OpenCL、SYCL |
| 运行时 | 需 Python 运行时（便携包约 1.9 GB） | 单个二进制 |
| 模型切换 | 图内换模型，热态可用 | 一次只持有一个模型上下文，忙时加载返回 409，切换等于重载 |
| 模型体积 | 现有 int8 包 13.27–16.10 GB | GGUF 路线约 13 GB 加 5 GB 文本编码器加 0.7 GB VAE，并不更小 |
| 上游稳定性 | 生态大、day-0 支持多 | 单维护者，自述接口与命令行选项可能频繁变动 |
| 控制能力 | 节点图、ControlNet、IPAdapter、任意后处理 | 有遮蔽重绘、IP-Adapter、PhotoMaker、ADetailer；ControlNet 仅到 SD 1.5，没有节点图 |

## 何时该换

三条判据，任一为「是」就该认真考虑把 sd.cpp 提为主线，而不是可选后端：

1. 产品要**闭源商用并分发装机包**——GPL-3.0 是硬阻塞，MIT 不是。
2. 产品要上 **macOS 或 Linux**——现有便携引擎走不通。
3. 产品定位是**简单出图**，不需要节点级自定义，也不需要 SD 1.5 之外的 ControlNet。

反过来，只要产品卖点是「可控生成」或「任意工作流」，就应保留 ComfyUI 作为主力后端，
把 sd.cpp 做成轻量可选后端（低显存机器、拒绝装 Python 的机器）。

## 与 llama.cpp 的关系

llama.cpp 与 sd.cpp 是兄弟项目，共享 ggml 后端，互不替代。它在这个产品里的位置是**文本侧**：
本地跑小模型做提示词改写与扩写、参考图理解与打标。这部分与生图后端的选择完全独立，
两条路都能加。

## 换后端前必须先测

同一提示词、同一 8 步 sigma 表、同分辨率，对比墙钟耗时、显存峰值与像素差。
`sd.cpp` 在低显存卡上更省是常见说法，但「更省」与「更快」经常不同向，没有实测就不换。
