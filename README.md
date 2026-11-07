# dsh-imagekit — 图像生成工坊

<img src="docs/icon.png" width="96" height="96" alt="图像生成工坊">

本地生图（Qwen-Image-2.1）+ 图片放大（Vulkan 超分），另附像素处理、引擎管理与显存监测。

## 快速开始

1. **装插件**（从源码，npm 尚未发布）

   ```bash
   git clone https://github.com/ikeyuchen/dsh-imagekit.git
   dsh plugin --profile web add ./dsh-imagekit
   ```

2. **装模型**：设置页「组件与手动下载」点「下载 / 安装」。模型包可叠加，8G 显存选 `lowvram`。

3. **起服务**：`comfy(action="control", op="start")` 拉起 ComfyUI（:8188）。
   生图网关（:8189）是独立服务，需自备并在设置里指向它。

4. **出图**：先 `image_generate(tier="draft", …)` 迭代，满意后换 `standard`，再 `image_upscale` 放大。

模型、引擎、7-Zip 都不随包分发；缺什么用 `image_setup(action="status")` 查。

要求：Windows 10/11 x64（引擎与超分二进制目前只有 Win64 版本，其它平台未验证）。

## 设置

可改存储位置、下载源、工具集档位（`minimal` 5 件 / `standard` 13 件 / `all` 15 件）、旧版本保留份数。
「性能与显存」面板依赖 `perf` 工具，`minimal` 档不含。

默认资产目录 `<installRoot>`：Windows 为 `<盘符>/AI/Tools/ImageKit`（有 D 盘用 D，否则 C），非 Windows 为
`~/AI/Tools/ImageKit`；可用 `IMAGEKIT_INSTALL_ROOT` 覆盖。旧目录做个 junction 指过去即可，不必搬几十 GB。

文档：[用法](docs/USAGE.md) · [提示词](docs/PROMPTS.md) · [模型与参数](docs/MODEL.md) · [配置](docs/CONFIGURATION.md) · [实现](docs/IMPLEMENTATION.md) · [架构](docs/ARCHITECTURE.md) · [图标](docs/ICON.md) · [发布](docs/RELEASING.md) · [路线图](docs/ROADMAP.md) · [变更](CHANGELOG.md) · [第三方](THIRD_PARTY.md)

## License

MIT。

本项目是第三方开源插件，与阿里巴巴 / Qwen、ComfyUI 项目、DeepSeek 及其关联方无隶属、赞助或背书关系；
文中出现的产品名仅作兼容性的事实性指代，商标归各自所有者。
