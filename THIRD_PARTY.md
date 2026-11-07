# 来源说明

本项目以 MIT 许可发布（见 `LICENSE`）。

> 本项目为第三方开源插件，与阿里巴巴 / Qwen、ComfyUI 项目、DeepSeek 及其关联方**无隶属、赞助或背书关系**。
> 下列名称仅作兼容性的事实性指代，商标与著作权归各自所有者。

## 本包内聚的自研代码

以下模块由本插件作者编写，于 2026-11-06 内聚进本包：

- `lib/engine/` — 原 `dsh-plugin-comfyui` 引擎管理模块；
- `lib/perf/` — 原 `dsh-plugin-perfmon` 性能监测模块；
- `lib/env/` — 原 `dsh-plugin-guard` 的 `env_probe` / `preflight` 环境检测模块；
- `scripts/pixels.py` — 原 `dsh-plugin-image-pipeline` 的像素处理后端。

## 外部运行时依赖（均不随包分发）

| 组件 | 许可 | 与本包的关系 |
|---|---|---|
| **ComfyUI** | GPL-3.0 · https://github.com/comfyanonymous/ComfyUI | `image_setup` 从上游 GitHub Releases 下载**固定 tag**（见 `models.manifest.json`）的 Win64 便携包，校验大小与 sha256 后解压到本机，并 `spawn` 其中的 `python_embeded/python.exe` 运行；本包不修改其源码，GPL-3.0 义务随上游包提供 |
| **Qwen-Image 权重** | 以模型卡为准 · https://huggingface.co/Comfy-Org/Qwen-Image-2.1 | 由 `image_setup` 从 Hugging Face（或用户选择的镜像）下载到本机；本包不包含权重，许可与使用条款以上游模型卡为准 |
| **Real-CUGAN ncnn-vulkan** | MIT · https://github.com/nihui/realcugan-ncnn-vulkan | `image_setup` 从上游官方 release 下载 Windows 包（20220728，45,977,449 B，sha256 `c6e08d46…`）；本包不内置、不改源码 |
| **waifu2x ncnn-vulkan** | MIT · https://github.com/nihui/waifu2x-ncnn-vulkan | 同上（20250915，35,497,352 B，sha256 `7425be94…`）。权重来自 nagadomi/waifu2x（MIT） |
| **Real-ESRGAN ncnn-vulkan** | BSD-3-Clause · https://github.com/xinntao/Real-ESRGAN | 同上（v0.2.5.0 / 20220424，45,474,481 B，sha256 `abc02804…`）；权重随官方仓库以 BSD-3 发布 |
| **RealSR ncnn-vulkan** | MIT · https://github.com/nihui/realsr-ncnn-vulkan | 同上（20220728，64,005,701 B，sha256 `db77ca82…`）；真实照片保守修复 |
| **7-Zip**（可选） | LGPL-2.1+（含 unRAR 限制）· https://www.7-zip.org | 若本机已安装则优先调用；未安装也能工作——先试 Windows 自带的 `tar.exe`（bsdtar/libarchive，Win11 与部分 Win10 可解 7z），仍不行则从**官方 GitHub Releases** 下载 7-Zip 精简版 `7zr.exe`（26.06，600,064 B，sha256 固定校验）到 `<installRoot>/tools/`。7-Zip 本体与 7zr 都不随包分发；放大引擎的 zip 由本插件用 Node zlib 自行解压，不需要上述任何工具 |
| **Pillow / numpy** | MIT-CMU / BSD-3-Clause | 由用户 Python 环境安装，`scripts/pixels.py` 运行时导入 |

第三方下载源：`huggingface.co`（默认）、`hf-mirror.com`、`modelscope`、`SourceForge`、GitHub Releases。
其中 `hf-mirror.com` 与 `modelscope` 为**第三方非官方镜像**，仅在用户显式选择时使用。
放大引擎的四个包只从**上游官方 GitHub Releases** 下载（见上表），下载器对 GitHub release 页链接会优先解析官方 Releases API 资产直链，并按清单登记的 `sizeBytes` + `sha256` 校验。

> 若将来把上述引擎包**镜像到本项目自己的 GitHub Releases**（本仓库当前不分发二进制），由于 MIT/BSD-3 要求在再分发时随附版权声明与许可全文，镜像里必须一并提供
> `THIRD_PARTY_LICENSES/` 对应文本（MIT×3 + BSD-3），并在本文件登记来源、版本与校验和；BSD-3 另有一条：不得用原作者名为衍生分发背书。

第三方 LoRA（`viggle` turbo LoRA、`VNCCS` 姿态 LoRA）与工作流模板由外部生图网关提供，
本包不下载、不分发，许可与署名以上游作者为准。

**本包不包含任何模型权重、引擎二进制或第三方 GUI。**

## 图标来源

- `icon.svg` 的路径几何取自 **Tabler Icons**（MIT License，https://github.com/tabler/tabler-icons）的 `photo-up` 图形，
  在 24 网格上复用其坐标与描边；仅把原图形的“太阳圆点”替换为自绘四角火花，并整体改用本项目渐变。
- MIT 要求在所有副本或实质部分中保留版权声明与许可声明，全文见
  [`THIRD_PARTY_LICENSES/Tabler-MIT.txt`](THIRD_PARTY_LICENSES/Tabler-MIT.txt)。
- `docs/icon.png` 是该 SVG 的派生位图。
