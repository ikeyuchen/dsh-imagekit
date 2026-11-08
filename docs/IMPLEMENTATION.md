# 实现说明

## 包结构

```
lib/index.js        入口：注册七类工具（生成 / 处理 / 放大 / 安装 / 引擎 / 性能 / 环境）与资源管理
lib/generate/       生图工具与双后端（内置直连 / 外部网关）、档位表、提示词手册（docs/PROMPTS-CORE.md）
lib/client.js       设置页：存储位置、下载源、自动行为、组件状态与手动下载按钮
lib/setup.js        image_setup 工具 + host 路由 + 下载器
lib/engine/         ComfyUI 引擎管理（内聚自 dsh-plugin-comfyui）
lib/perf/           GPU/VRAM 性能监测（内聚自 dsh-plugin-perfmon）
lib/env/            环境检测（内聚自 dsh-plugin-guard）：env_probe + preflight
models.manifest.json
```

## Host 侧

- `lib/index.js#apply` 创建 `Config`，按 `toolsetProfile` 注册工具；
- `image_prompt_guide` 把随包手册 `docs/PROMPTS-CORE.md` 按需读回（进程内缓存，`section` 命中小节，未命中回全文）；
- `registerSetupTools` 注册 `image_setup`（status / defaults / verify / install / upgrade / delete / clean）；
- `status` 返回每个组件的 `targetVersion` / `installedVersion` / `versionSource` / `updateAvailable` / `backups` / `pack` / `packLabel` / `installedPack`；
  版本来源优先级：引擎以磁盘 `comfyui_version.py` 为准，其次 `state.json` 记录，最后清单探测；
  其它组件以 `state.json` 记录为准，缺失时用清单。
- 同一函数内通过 `ctx.inject(['connection'])` 注册两个路由：
  ```
  POST /api/dsh-imagekit/setup   body: { action, component?, pack?, confirm?, backup? }
  POST /api/dsh-imagekit/perf    body: { action: 'snapshot' }
  ```
  路由只是调用已注册的 `image_setup` / `perf` 工具，不另开写盘路径；
  鉴权与同源校验由宿主的 `connection` 服务负责，插件不自行放行跨站请求。
- 下载器：HTTP Range 续传 + `.partial` 临时文件，校验大小/sha256 后 rename；目标路径先 `assertWithin(installRoot)`；
  删除必须 `confirm=<component>`；归档用 `checkPath`/`checkPaths` 判断解压完成。解压只有两条路径：`.zip` 用 Node zlib 内置解压；
  `.7z` 用按需下载的官方 7zr（`<installRoot>/tools/7zr.exe`，缺失时下载并校验 sha256；`IMAGEKIT_EXTRACTOR=zip` 可强制 zip，
  `SEVEN_ZIP` 可指定本机 7z 替代 7zr）。解压后按 `extractRename` 改名、整合包用 `extractGlobs` 只取需要的目录再 `extractMove`；已存在目录不覆盖。
- `lib/generate/direct.js`：内置直连后端（拼 ComfyUI API 工作流 → `/prompt` → `/history` → `/view`）。
  文生图用 `UNETLoader/CLIPLoader/VAELoader/EmptyLatentImage/KSampler`；参考图编辑用 `LoadImage`（先 `/upload/image` 上传）
  + `TextEncodeQwenImage21`（输出 positive/negative/latent），turbo 模板自动挂 LoRA。
  生成后按 `vramIdleFreeMinutes` 安排空闲 `/free`；`unload_after=true` 则立即释放。
- `lib/upscale.js` 的 `image_upscale` 预设覆盖上游官方 Real-CUGAN / waifu2x / Real-ESRGAN / RealSR 模型；四个引擎包由 `image_setup` 从上游官方 release 下载并校验 sha256。
- 升级与备份（`lib/setup.js`）：
  - `upgrade` 比较清单 `version` 与已安装版本；相同且 `missing=0` 时跳过；
  - 先把旧内容 `rename` 进 `<installRoot>/.imagekit/backups/<component>/<version>-<时间戳>/payload`，
    再用 `downloadTo(..., {force:true})` 重新下载/解压；
  - engine 备份整个便携版目录；models 只备份将被替换的单个文件；upscale 备份已解压的引擎目录；
  - 成功后写 `state.json.installed[component] = {version, engineVersion, pack, at}`，并按 `keepVersions` 清理旧备份；
  - 失败时 `restoreBackup` 把 payload 移回原位，保留原版本记录后再报错。
- 旧版本删除复用 `delete` 动作：带 `backup=<id>` 时只删对应备份（校验 id 字符集、必须落在备份根内、junction 拒绝）。
- 多连接分片：`downloadTo` 在「已知 sizeBytes ≥ 8MB 且 connections>1」时先 `bytes=0-0` 探测 Range，
  支持则切成 N 段并发下载（每段独立 `.partial.N` 续传），拼完再统一算 sha256；服务端返回 200 或任一段失败则回退单流。
- 下载进度写进 `job.json`：`writtenBytes` / `totalBytes` / `fileLabel` / `fileIndex`（下载器回调，**800ms 节流**），
  `status` 再算出 `percent` 给设置页画进度条；设置页下载期间 1s 轮询一次。
- 多包组件（models）必须显式 `pack=<name>`，不再默认取清单第一个包（否则 8G 显卡会默默下 12G 的包）。
- 模型包按包删除：`delete component=models pack=<name> confirm=models` 只删该包**独有**文件；
  与其他「完整安装」的包共用的文件保留并在结果里列出，删完重算 `state.json` 记录的是哪个包。

## Client 侧

- `lib/client.js` 通过 `window.__ModuleLoader__.load` 注册 lazy factory；
- 在 `plugins.bundle.config` 注册设置卡（key = 包名 `dsh-imagekit`）；
- 配置命名空间做候选解析：`dsh-imagekit` / `tool-image` / `include:tool-image`，取已 ready 的；
- `perf` 工具卡（原 `dsh-plugin-perfmon` 的趋势卡）注册到 `tool.call.toolview`（key = `perf`），
  只读 `output.presentationMeta`，渲染 GPU 显存折线 + 共享显存峰值；无 meta 时降级为文本摘要；
- 设置页「性能与显存」面板通过 `fetch('/api/dsh-imagekit/perf', {action:'snapshot'})` 读取 GPU/共享显存/进程/采样状态；
- 组件状态通过 `fetch('/api/dsh-imagekit/setup', {action:'status'})` 读取；
- 生图模型行下按 pack 列出 core / fast / lowvram / lowvram-fast / full；每个 pack 有独立「下载该模型/校验」按钮，
  下载时把 `pack` 传给 `image_setup`（pack 之间叠加，不互斥）；
- 组件行显示当前版本与体积；`versionMismatch`（版本不同）显示「升级」，`needsRepair`（缺文件）显示「修复」，
  两者互斥；有任务在跑时整行动作锁住（含别的会话发起的任务）；已装齐则禁用下载、`updateAvailable` 时给「升级」，`backups` 时列出旧版本并可删；
- 按钮分别发 `{action:'install'|'upgrade'|'delete', component, pack?, backup?}`，大文件期间每 1s 刷新状态；
- 设置值来自 `SettingsFormModel`，字段值是 `{text, overridden, invalid}`：`SettingsValueField` 必须展开该对象
  （直接当 `value` 会触发 React error #31），下拉只取 `.text`。

## 输出目录

- `Config.outputDir`（默认 `<installRoot>/outputs`，volatile，设置页「生成图片目录」）；
- `saveImages(sources, saveTo, outputDir)`：无 `save_to` 时整批落 `outputDir` 并做同名去重；有 `save_to` 时只存第一张（旧语义）；两者都空则保持原行为；
- `image_upscale` 的默认输出目录是 `<outputDir>/upscale`，写盘前 `mkdirSync(recursive)`；

## GitHub 下载兜底

`downloadTo` 对 GitHub Release URL 先解析官方 Releases API 资产直链（tag → asset id → `/releases/assets/<id>` + `application/octet-stream`），
其次用 `githubProxy` 代理（仅当用户显式配置），最后才用原始 `releases/download/<tag>/<asset>` 直链；
有 `GITHUB_TOKEN`/`GH_TOKEN` 时带 Bearer。API 不可用时继续走后面的候选。

## 为什么没有自动下载

模型和引擎是 GB 级，自动下载会：

- 阻塞首次使用；
- 在未知磁盘上写几十 GB；
- 无法让用户选择镜像与目标盘。

因此设置页只保存路径/源，所有下载由用户点击按钮触发；`autoDownload` 默认 `off`，且当前代码不会在生图前下载。

## 默认路径与删除按钮

- `image_setup action=defaults`：按 `lib/paths.js` 的规则返回默认路径（环境变量 → 旧版目录沿用 →
  当前用户数据目录），并创建安装根与子目录；
  设置页「恢复默认」调用它，再通过 `props.edit` 填入字段（仍需用户点保存）。
- 组件行在已安装时显示「删除」：`window.confirm` 后调用
  `image_setup action=delete component=<name> confirm=<name>`；
  删除前校验组件根，junction 根拒绝删除。

## 版本与发布

- 版本只在对外发布时递增（见 `package.json`）；
- `npm run check` 校验包结构、patch、必要文件；CI 同款；
- `npm run smoke` 无宿主加载并按档位验证工具注册（minimal 6 / standard 14 / all 16）；
- `npm run test:download` 验证下载器 5 项行为；
- `npm run test:backup` 验证引擎/模型备份与回滚、旧版本删除、`keepVersions` 清理、版本视图；
- `npm run test:setup` 用临时目录直接调用 `image_setup.execute`，验证 status 版本字段、旧版本列表、
  `delete backup=<id>`、同版本跳过与升级失败回滚（不联网）；
- `env_probe` / `preflight` 从 `dsh-plugin-guard` 迁入，工具名与输出保持兼容；`repo_check` / `plugin_health` / `agent_capacity` 不随包；
- `npm run test:upscale` / `test:output` / `test:prompt` 分别覆盖 7z 选择性解压、输出目录落盘、参考图×模板路由；
- `npm run test:route` 用假 `connection` 服务 + 真实 `Request` 覆盖设置页两条 host 路由（200/400/503/500、`no-store`）；
- `npm run test:e2e`（默认跳过）设 `IMAGEKIT_E2E=1` 才跑：真实下载一个组件（默认 `upscale` 约 190 MB）的
  安装 → sha256 → 解压 → status → verify；加 `IMAGEKIT_E2E_UPGRADE=1` 再走一遍备份与升级；
  `IMAGEKIT_E2E_LOCAL_ARCHIVES=<dir>` 用本机已有的真实归档起本地 HTTP 服务（含 Range），断网也能跑完整回归；
- `npm run tokens` 按宿主口径量三个档位的常驻 token；
- `npm test` 依次跑 check + download + backup + setup + upscale + output + paths + prompt + route + docs；
- 发布流程见 `docs/RELEASING.md`。
