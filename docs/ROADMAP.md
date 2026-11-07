# 路线图

## 已完成（0.0.x）

- [x] 单包内聚生成 / 处理 / 放大 / 引擎 / 性能
- [x] 独立 GitHub 仓库与本地 git
- [x] npm 包结构、LICENSE、CHANGELOG、CI
- [x] 版本只在发布时递增（首个公开版起）
- [x] 设置页（client）：存储位置 / 下载源 / 自动行为 / 工具集档位
- [x] 资源管理器 `image_setup`：status / verify / install / upgrade / delete / clean
- [x] 下载器断点续传 + sha256（`npm run test:download` 5 项自测）
- [x] 设置页手动下载按钮；已安装且 `missing=0` 时禁用下载，保留「校验」自检
- [x] 默认资产目录统一到工具分类 `<installRoot>`（Windows D 盘优先，可用 `IMAGEKIT_INSTALL_ROOT` 覆盖）；旧路径兼容 junction
- [x] host 路由 `/api/dsh-imagekit/setup` 打通设置页与 `image_setup`
- [x] 设置页「恢复默认」：有 D 盘用 D，无 D 盘用 C；`image_setup action=defaults`
- [x] 已安装组件的删除按钮（二次确认 + junction 防护）
- [x] Qwen 模型下载源与 LFS sha256（Comfy-Org/Qwen-Image-2.1）
- [x] 引擎/放大压缩包解压（系统 7z + extractRename）
- [x] **真正的 upgrade**：清单版本比较 → 同盘备份 → 重新下载/解压 → 失败自动回滚；`keepVersions` 生效
- [x] **设置页升级入口**：显示当前版本 / 清单版本 / 「可升级」，升级按钮接 `image_setup upgrade`
- [x] **旧版本管理**：`status` 列出旧版本备份（版本/体积/文件数/时间）；设置页逐个「删除旧版本」；
  `image_setup delete backup=<id>`；引擎整目录 / 模型单文件 / 放大引擎目录三种备份粒度
- [x] **版本显示**：`state.json` 记录 + 引擎 `comfyui_version.py` + 清单探测三级来源
- [x] **离线测试**：`test:backup`（备份/回滚/删除/清理/版本视图）、`test:setup`（直调 `image_setup.execute`）

## 未完成（发布前必须处理）

- [ ] **更新提示开关**：版本比对已实现（`status` 回 `targetVersion/installedVersion/updateAvailable`，组件行显示「可升级 → vX」）；
  尚缺的只是 `autoCheckUpdates` 这个开关的接线（当前开关不生效，提示总会显示）
- [ ] **进度反馈**：路由是同步请求，当前只有 3 秒状态刷新，没有百分比/速率/暂停
- [x] **模型包选择**：设置页按模型包列出 core / fast / lowvram / lowvram-fast / full，每个可独立下载/校验；
  标准与快速是不同扩散模型，可同时安装；`lowvram` / `lowvram-fast` 用 w4a8 文本编码器适配 8G 显存
- [x] **设置页显存面板**：专用/共享 VRAM、sysmem fallback、GPU 进程、采样状态，带「刷新显存」
- [x] **perf 工具卡**：原 perfmon 的 GPU 显存趋势折线卡迁移到 `tool.call.toolview`
- [x] **环境检测内聚**：`dsh-plugin-guard` 的 `env_probe`（本机能力体检）+ `preflight`（显存/共享显存/端口/引擎/CPU 闸门）迁入 `lib/env/`，独立的环境检测插件不再是依赖
- [x] **去本机化（路径层）**：默认路径收敛到 `lib/paths.js` 单点派生，`IMAGEKIT_INSTALL_ROOT` /
  `IMAGEKIT_GATEWAY_DIR` / `IMAGEKIT_GATEWAY_LOG_DIR` 可覆盖；`doc-drift` 的 H 规则禁止其他文件写死盘符路径
- [ ] **去本机化（剩余）**：网关仍是独立服务（插件会自动拉起，但网关代码需自备）；7-Zip 探测路径固定；
  非 Windows 平台的引擎/超分二进制尚未验证
- [x] **生成图片统一目录**：`Config.outputDir`（默认 `<installRoot>/outputs`），不传 `save_to` 时整批落盘、同名不覆盖；放大落 `outputs/upscale`
- [x] **GitHub 下载兜底**：直链失败回退 Releases API（可选 `GITHUB_TOKEN`）
- [x] **引擎下载可校验**：清单固定 ComfyUI 版本并登记 `sizeBytes` + `sha256`，下载后强制校验
- [x] **放大引擎可下载**：清单改为 4 个上游官方 ncnn 包（Real-CUGAN / waifu2x / Real-ESRGAN / RealSR，合计约 190MB，MIT + BSD-3），逐包校验 sha256 后解压；不依赖本机已有目录
- [ ] **更多测试**：设置页路由（HTTP 层）尚未自动化；缺源/断网已覆盖升级回滚，但引擎/放大升级尚未跑真实大文件回归

## 原则

- 模型和引擎不进 npm 包；
- 删除/升级只操作清单登记路径，必须二次确认；
- 版本号只在对外发布时更新；
- 大文件下载必须用户手动触发，不自动下载。
