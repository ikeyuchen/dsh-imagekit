# dsh-imagekit

<img src="docs/icon.png" width="88" height="88" alt="dsh-imagekit">

**本地生图与放大的 DeepSeek Harness 插件**：Qwen-Image 文生图 / 参考图改图、Vulkan 超分，附像素处理、ComfyUI 引擎管理与显存监测。

[简体中文](README.md) · [English](README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-imagekit?color=4b6fff)](https://www.npmjs.com/package/dsh-imagekit)
[![license](https://img.shields.io/badge/license-MIT-4b6fff)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-lightgrey)](#要求)
[![dsh](https://img.shields.io/badge/dsh-0.2.x-6c5ce7)](package.json)

## 安装

**方式一：DSH 内安装（推荐）**

1. 打开 DSH →「插件」→「添加插件」
2. 输入包名 `dsh-imagekit`，安装源保持「npm 官方源」
3. 点「安装」；装好后在插件列表里打开它

**方式二：命令行（同样走 npm）**

```bash
dsh plugin add dsh-imagekit
```

> 国内镜像（npmmirror）同步有延迟，装到的可能是旧版本。装完用 `npm ls dsh-imagekit` 看一下版本；
> 比 README 旧就直接 `npm i dsh-imagekit@latest --registry=https://registry.npmjs.org`。

**方式三：源码**（开发或未发布版本）

```bash
git clone https://github.com/ikeyuchen/dsh-imagekit.git
dsh plugin --profile web add ./dsh-imagekit
```

## 首次使用：装完还要下模型

插件本体**不含**模型、ComfyUI 引擎与放大引擎（体积太大，不随包分发）。装完必须先去设置页下载，否则生图会报缺模型：

1. DSH →「插件」→「图像生成工坊」→「配置」
2. 「存储位置」确认安装根目录（默认 `%LOCALAPPDATA%\dsh-imagekit`，旧版装过的机器沿用原目录；可直接改到大容量磁盘）
3. 「组件与手动下载」→ **生图模型**：按显存选一个包下载

   | 显存 | 选这个包 | 说明 |
   | --- | --- | --- |
   | 12 GB | `core` 或 `fast` | `core` 细节最稳；`fast` turbo 速度约 1/3 |
   | 8 GB | `lowvram` / `lowvram-fast` | w4a8 文本编码器，省显存 |
   | 32 GB | `full` | 含 turbo + ControlNet + PE 双编码器 |

4. 同页下载 **ComfyUI 引擎**（约 2 GB，生图必需）与 **图片放大引擎**（约 190 MB，可选）
   本机已经有一份 ComfyUI 便携版时插件会自动复用它，这一步显示「已就绪」就不用再下；
   位置在别处就设环境变量 `IMAGEKIT_ENGINE_DIR` 指向那个目录
5. 都显示「已安装」后即可生图；具体用法见 [用法](docs/USAGE.md)

> 装错了包可以只删那一个：模型包行右侧的「删除该包」只清掉它独有的文件。

## 能力

| 工具 | 说明 |
| --- | --- |
| `image_generate` / `image_generate_raw` | 文生图、参考图改图、任意工作流；`draft` / `standard` / `quality` 三档 |
| `image_workflow_inspect` | 查看某个工作流模板实际提交的 ComfyUI 图 |
| `image_prompt_guide` | 内置提示词手册（选档 / 分类配方 / 文字渲染 / 参考图编辑 / 放大路由），按需返回，手册正文不占常驻；工具声明约 99 tokA |
| `image_upscale` | Real-CUGAN / Real-ESRGAN / waifu2x / RealSR 共 10 个预设（上游官方 MIT/BSD 构建），Vulkan 直通 GPU |
| 像素处理 5 件 | 降采样、红圈标记、透明扁平化、动图合成、姿势检查 |
| `comfy` / `image_service_status` | ComfyUI 引擎启停、自愈、升级 |
| `image_setup` | 模型与引擎的下载、校验、备份回滚、旧版本清理 |
| `perf` / `env_probe` / `preflight` | 显存采样、环境体检、重活前置闸门 |

工具集按档位注册：`minimal` 6 件 / `standard` 14 件 / `all` 16 件，默认 `standard`。

## 尺寸与放大

Qwen-Image 2.1 **原生约 2K**（官方示例 `2048×2048`、40 步；官方比例表从 `2048²` 到 `2752×1536`）。
本插件三档尺寸是按「速度 ↔ 画质」分的，不是模型限制：

| 档位 | 尺寸 / 步数 | 12G 显存实测 | 适合 |
|---|---|---|---|
| `draft` | 1056² / 8 步（官方 turbo） | 约 8–10 秒 | 构图与提示词迭代 |
| `standard`（默认） | **1536² / 25 步** | **约 50 秒** | 日常出图 |
| `quality` | 2048² / 40 步 | 约 170 秒 | 成片、要最实细节 |
| 自定义 | 官方比例 `2752×1536` 等 | 与 2048² 同档 | 横竖幅海报 |

- **放大确实能加细节，二次元尤其明显**：插画/动漫的线稿与色块提升非常直观，`cugan_pro`（models-pro）最锐；写实照片的毛发/材质也能更干净，但补不出模型没生成的写实细节。
- **省时间出 2K**：`draft` 1056² 出图 → `image_upscale` ×2，约 5 秒到 2112²，适合先看构图再定稿。
- **超过原生不建议**：2560² 实测 226 秒（25 步）且容易重复结构——要更大就 2048² 生成后放大。
- 8G 显存建议 ≤1536² 并选 `lowvram` 包；宽高需为 **32 的倍数**。

![二次元 1024² 放大 ×2：传统插值 / cugan / cugan_pro，同一块 1:1 细节](docs/anime-upscale.webp)

![同一块 1:1 细节：原生 2048² vs 1056² 放大 ×2](docs/native-vs-upscale.webp)

## 模型

| 包 | 步数 | 说明 |
| --- | --- | --- |
| `core`（标准） | 25 | 细节与中文文字最稳；热引擎约 30–60 秒 |
| `fast`（快速） | 6–8 | turbo 蒸馏，耗时约 1/3，质量接近标准；适合草稿迭代 |

两个包可同时安装、共用 VAE 与文本编码器；8G 显存选 `lowvram` 包。

## 示例

<p align="center">
  <img src="docs/demo-photo.webp" width="300" alt="写实：窗台上的橘白猫">
  &nbsp;&nbsp;
  <img src="docs/demo-anime.webp" width="300" alt="二次元：洋馆走廊里的猫娘女仆">
  <br>
  <img src="docs/demo-text.webp" width="300" alt="文字：中文新春海报">
  &nbsp;&nbsp;
  <img src="docs/demo-scene.webp" width="300" alt="场景：黄昏山谷湖泊">
</p>
<p align="center"><em>写实 · 二次元 · 文字 · 场景，均由本插件本地生成（quality 档 2048² / 40 步直出，提示词见 <a href="docs/USAGE.md">用法</a>）</em></p>

## 要求

- Windows 10/11 x64（引擎与超分二进制目前只有 Win64 版本）。
- **不需要自己装 Python**：像素工具（缩放、标记、扁平化、动图）默认用 DSH 自带的 Python 运行时（已含 Pillow/numpy）；
  没有时依次试 `python`、`py`，都不行用配置项 `pythonCommand` 指定一个装好 Pillow 的解释器。
- ComfyUI 与 Qwen-Image 权重不随包分发，缺什么用 `image_setup(action="status")` 查。
- **不需要装 7-Zip**：引擎包（`.7z`）用插件按需下载的官方 7-Zip 精简版 `7zr.exe`（首次解压时自动下载 600 KB，sha256 固定校验），
  放大引擎包（`.zip`）用 Node 内置 zlib 解压——两种格式都开箱可用，不依赖系统里有没有解压软件。
- **生图开箱即用，不需要任何外部服务**：文生图与参考图编辑都由插件直接向本机 ComfyUI 提交工作流（内置直连，无网关、无 Python 进程、无窗口）。
  只有 Prompt 增强 / ControlNet / VNCCS 等旧模板才需要外部兼容网关。

## 文档

[用法](docs/USAGE.md) · [提示词手册](docs/PROMPTS.md) · [模型与参数](docs/MODEL.md) · [配置](docs/CONFIGURATION.md) · [引擎版本](docs/ENGINE-VERSIONS.md) · [架构](docs/ARCHITECTURE.md) · [实现](docs/IMPLEMENTATION.md) · [图标](docs/ICON.md) · [发布](docs/RELEASING.md) · [变更](CHANGELOG.md) · [第三方](THIRD_PARTY.md)

## 许可

MIT 许可（全文见 [LICENSE](LICENSE)）。第三方组件与各自许可见 [来源说明](THIRD_PARTY.md)。

本项目是第三方开源插件，与阿里巴巴 / Qwen、ComfyUI 项目、DeepSeek 及其关联方无隶属、赞助或背书关系；文中产品名仅作兼容性的事实性指代。
