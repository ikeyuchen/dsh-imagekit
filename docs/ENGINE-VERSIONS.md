# 引擎版本策略

`dsh-imagekit` 默认只使用清单中固定且已验证的 ComfyUI 版本；「同步上游最新」是显式、带警告的实验性逃生通道，不进入正常升级入口。本插件的目标是安装后可直接使用；不受控的引擎漂移会增加用户排查出图故障的成本。

## 两条升级路径

| | 清单固定版本（默认） | 同步上游最新（实验） |
|---|---|---|
| 命令 | `image_setup action=upgrade component=engine` | `comfy action=upgrade mode=upgrade confirm=true` |
| 做什么 | 按清单重新下载官方 portable 7z，整目录备份后解压替换 | 停止引擎，执行便携包中的 `update/update_comfyui.bat`（git pull 上游代码），然后重启 |
| 版本来源 | `models.manifest.json` 的 `components.engine.packs.default.version` | GitHub 最新 release |
| 是否校验 | `sizeBytes` + `sha256`；解压后还核对磁盘版本 | 不校验内容，只报告升级后的本地版本 |
| 风险 | 受控：引擎、python 依赖、节点接口都是配套的 | 版本漂移不受控：依赖不跟着更新、节点可能改名、出图可能静默走偏 |
| 回滚 | 失败自动回滚；旧版本备份按 `keepVersions` 保留 | git 更新无法自动回滚，只能重装清单版本兜底 |
| 用户环境 | 整目录替换，但会先保留并放回 `ComfyUI/custom_nodes` / `ComfyUI/extra_model_paths.yaml` / `ComfyUI/user` / `ComfyUI/input` / `ComfyUI/output` / `ComfyUI/models` | 就地 git 更新，配置文件本身不丢；但节点接口与依赖可能不兼容 |
| 适用场景 | 日常升级，设置页「升级」按钮走这条（弹二次确认，引擎先停后起） | 排障 / 明确要试上游新版本 |

> 两条路径方向相反：前者把引擎拉回清单版本，后者把引擎推到上游最新。不要交替执行，否则引擎会在两个版本之间反复切换。

## 固定版本策略

### 清单为唯一来源

`models.manifest.json` 的 `components.engine.packs.default` 是唯一事实来源：

```json
{
  "version": "<清单登记的固定版本>",
  "files": [{
    "path": "engine/ComfyUI_windows_portable.7z",
    "sources": { "official": "https://github.com/Comfy-Org/ComfyUI/releases/download/<固定 tag>/ComfyUI_windows_portable_nvidia.7z" },
    "sizeBytes": "<字节数>",
    "sha256": "<64 位十六进制>",
    "checkPath": "engine/ComfyUI_windows_portable/ComfyUI/main.py"
  }]
}
```

- `version`：升级目标；升级只和它比较，不查询 GitHub 最新版。
- `sizeBytes` + `sha256`：下载完成强制校验，对不上就不解压；没有校验的归档不允许进清单。
- `checkPath`：判断解压是否完成；升级后还会再读一次磁盘版本核对。
- `sources.official`：指向官方 GitHub Release 的固定 tag 资产直链，不跟随「latest」。

### 备份、回滚与重启

- 升级前先停引擎，再动手；升级完成后重启，失败回滚后也会把引擎重启回来。
- 旧引擎目录用同盘 `rename` 进 `<installRoot>/.imagekit/backups/engine/<版本>-<时间戳>/`：`payload/` 是旧目录本体，`meta.json` 记录版本、时间与文件数。
- 下载或解压失败：`restoreBackup` 把 `payload/` 移回原位，保留原版本记录，然后报错。
- 成功后按 `keepVersions`（默认 1，范围 0–2）清理更老的备份；旧备份可在设置页逐条删除。
- 备份的 `payload/` 只含引擎本体：用户数据在升级时被单独保管、失败回滚时放回，不重复进备份（否则每次备份都要多占一份节点/模型）。所以事后想手工回滚到旧版本时，要把 `payload/ComfyUI_windows_portable` 换回引擎目录后，再把当前安装里的 `ComfyUI/custom_nodes`、`ComfyUI/extra_model_paths.yaml`、`ComfyUI/user` 一并带过去。
- 必须先停的原因：Windows 上目录里有运行中的 `python.exe` 时 `rename` 会报 `EBUSY`，升级直接失败；就算侥幸换完文件，运行中的进程仍是旧版本。
- 手工启动的引擎也可识别：升级前通过 `comfyBaseUrl` 的 `/system_stats` 探活，命中后复用 `comfy` 的 `control` 停止，升级完成后按原 `profile`（`normal` / `lowvram`）重启。宿主未注册 `comfy` 工具时，明确拒绝升级并提示先手工停止引擎，不会报告虚假成功。

### 升级不破坏用户环境

固定版本升级是「整目录替换」，而 `<engineRoot>` 里除了引擎代码，还有用户自己的东西。升级前会将以下数据用同盘 `rename` 移至 `<installRoot>/.staging/engine-upgrade-<pid>-<ts>/`，解压完再放回（回滚后同样放回）：

| 相对路径 | 内容 | 不保留会怎样 |
|---|---|---|
| `ComfyUI/extra_model_paths.yaml` | 模型注册表（绝对路径） | 引擎看不到任何模型，出图报模型不存在 |
| `ComfyUI/custom_nodes` | 自定义节点（pose / vnccs 等模板依赖） | 相关工作流节点缺失，模板直接报错 |
| `ComfyUI/user` | 工作流库 / 设置 / `comfyui.db` | 用户工作流与偏好丢失 |
| `ComfyUI/input`、`ComfyUI/output` | 用户上传的参考图、引擎自己的产物 | 参考图丢失 |
| `ComfyUI/models` | 用户直接放进便携版的模型 | 模型被新解压的空目录顶掉 |

- 只搬移、不改写内容；搬移失败时整个升级中止，不会出现引擎已升级但用户环境丢失的情况。
- 临时区在 `<installRoot>/.staging/`，`image_setup action=clean` 会清扫残留（进程被杀在解压中途时用）。
- 注意：`extra_model_paths.yaml` 里若写的是旧便携版目录内的相对路径，整目录替换后仍会失效。模型源请使用绝对路径（本仓库默认使用绝对路径）。

### 网关（生图服务）与 python_embeded

生图网关（默认 `http://127.0.0.1:8189`）使用引擎目录中的 `python_embeded\python.exe app.py`，其 `fastapi`、`uvicorn`、`httpx`、`pydantic` 安装在引擎的 `site-packages` 中。因此整包替换引擎前必须处理两件事：

1. 先停网关：进程活着时 `python_embeded\python.exe` 被占用，引擎目录 `rename` 会报 `EPERM`，且不易察觉：即使引擎已停止，升级仍会失败。升级器仅在端口上的进程确实来自本引擎目录时停止该进程，不影响其他服务。
2. 换完补装依赖：新解压的 python_embeded 目录是干净的，不补装网关就起不来。升级器会用新 python 执行 `<网关目录>/requirements.txt`（`pip install -r`），失败按「升级失败」回滚，不让系统停在半可用状态。
3. 网关不主动拉起：它由生图调用按需自愈（下次 `image_generate` 会重新拉起），升级结果里会说明。

### 升级后版本校验

1. 磁盘版本：读取 `<engineRoot>/ComfyUI/comfyui_version.py` 中的 `__version__`，该值为引擎实际版本。
2. 状态记录：成功后写 `state.json` 的 `installed.engine = { version, engineVersion, pack, at }`。
3. 来源优先级：磁盘 `comfyui_version.py` → `state.json` 记录 → 清单探测；`status` 的 `versionSource` 用来说明当前值来自哪一级。
4. 不一致不静默：解压后磁盘版本与清单 `version` 不同（镜像给错包、归档内层目录变了）时输出 `WARN` 并保留本次备份（仍受 `keepVersions` 约束），不会静默记录为成功。
5. `updateAvailable` 比较的是磁盘真实版本与清单 `version`，`state.json` 陈旧不会造成永远「可升级」的空转。

## 允许同步上游的边界条件

「同步上游最新」只在同时满足下面这些条件时才允许使用：

- 实验性：只通过 `comfy` 手动触发，命令强制要求 `confirm=true`；不放进正常升级按钮。
- 明确警告：结果按「未经验证、可能破坏出图」对待，不得作为正常升级写入发布说明。
- 依赖同步：`update_comfyui.bat` 只更新代码，不更新 Python / torch 依赖；需要时手动执行 `update/update_comfyui_and_python_dependencies.bat`，否则新版引擎可能导入失败。
- 节点兼容：工作流模板按固定节点名与接口编写，跨版本节点改名或行为变化会让出图静默走偏（不报错，但结果不对）。
- 出图回归：至少 t2i、参考图改图、放大各冒烟一张，并与固定版本的结果对比。
- 失败可回滚：同步上游没有自动回滚；兜底是 `image_setup action=upgrade component=engine` 重装清单里的固定版本。
- 升级后必须重启并校验版本：`comfy` 的 upgrade 会自己停/起并报告版本，`image_setup` 也会重启；仍要人工确认版本与出图结果。

## 维护者流程：把清单版本从 X 提到 Y

1. 取官方 Release 的 portable 7z 资产，记录 `sizeBytes` 与 `sha256`（无校验的归档不进清单）。
2. 更新 `models.manifest.json`：`components.engine.packs.default` 的 `version`、`sources.official`（固定 tag）与 `sizeBytes` / `sha256`；`pack` 名保持 `default`。
3. 干净环境验证升级：`image_setup(action="upgrade", component="engine")` 能下载、校验、解压、停/起引擎，并在 `status` 里显示目标版本。
4. 冒烟出图：t2i 一张、参考图改图一张、`image_upscale` 一张；记录耗时与显存，和旧版本基线对比。
5. 节点兼容核对：出图未报错不代表节点兼容，至少应核对模板使用的节点与关键参数仍然存在。
6. 更新 `CHANGELOG.md` 的用户可见说明，并同步本文档里过时的版本描述。
7. `npm run check` 与 `npm run test:docs` 必须通过；推送前执行 `npm test`。

## 分发方式：官方源 vs 自建镜像

清单条目的 `sources` 可以有多个键，下载器按 `preferred(用户选的源) → mirror → sourceforge → huggingface → hf-mirror → modelscope → official` 的顺序取第一个存在的 URL。是否自托管二进制并非二选一，可为同一条目增加 `sources.mirror`：

```json
"sources": {
  "official": "https://github.com/<上游>/<repo>/releases/download/<tag>/<asset>",
  "mirror": "https://github.com/<本仓库>/<镜像仓库>/releases/download/<tag>/<asset>"
}
```

为什么不把二进制放进本仓库的 git 树：Git 单文件 100 MB 硬限制、仓库体积永久膨胀（每次 clone 都拉），而 Releases 资产单文件上限 2 GB、不计入仓库体积。

自托管的收益与代价：

| | 说明 |
|---|---|
| 收益 | 上游删除 release 或重打 tag 时仍可安装；分发的文件为已验证版本，sha256 一致；插件与引擎同源分发，信任根集中 |
| 许可 | MIT / BSD-3 允许再分发，但要求随附版权声明与许可全文（见 `THIRD_PARTY_LICENSES/`），BSD-3 另有「不得用原作者名义背书」一条 |
| 网络 | 和官方源同一个 GitHub 域，不会绕开「github.com 直连不通」的网络问题。提升可达性主要依靠多源（`mirror`、上游官方与用户自建 `modelPackBaseUrl`）；下载器对 GitHub release 链接优先解析官方 API 资产直链 |
| 维护 | 镜像要跟着清单版本更新，过期的镜像等于安全债；旧版本资产要么保留（可回滚），要么写清保留策略 |

当前仓库不在 git 里分发任何二进制；引擎与放大条目只登记 `sources.official`（上游官方 release），模型条目登记 `sources.huggingface` / `hf-mirror`。`sources.mirror` 是预留的可选槽位，需要时加即可，不改代码。

## 下载路径实测（2026-11-08，本机 5070 Ti / 家用宽带）

同一个 45,977,449 B 的官方资产，三条路径各测多轮（完整文件或 4–8 MB Range）：

| 路径 | 结果 | 吞吐 | 完整性 |
|---|---|---|---|
| `api.github.com` Releases 资产直链（下载器首选） | 4/4 成功 | 4.0 MB/s | sha256 一致 |
| `https://ghfast.top/` 代理 `github.com` 链接 | 完整文件成功 | 3.55 MB/s（Range 探测 0.8–1.3 MB/s，首包要等回源） | sha256 一致 |
| 直连 `github.com/.../releases/download/...` | 8/8 连接超时（21s），完整文件 0/2 | 0 | 不适用 |
| `gh-proxy.com` / `ghproxy.net` / `ghproxy.cn` / `gh.llkk.cc` / `hub.gitmirror.com` | 全部失败或 ≤0.25 MB/s | 不适用 | 不适用 |

结论：
- 代理不加速，本机反而比 API 资产直链慢约 12%；它的价值是「直连 0/8 时还能下下来」，属于可达性兜底。
- 所以 `githubProxy` 默认关闭，只在官方两条路径都不通时手动填；`ghfast.top` 不代理 `api.github.com`（实测 403），因此只改写 `github.com` 链接。
- 完整文件经代理下载后 sha256 与清单一致（代理不修改字节）；校验机制仍是主要的内容保证。

## 多连接下载与镜像加速的实测边界（2026-11-08）

第三方「GitHub 加速」类方案（如 Motrix Smart Link）实质为链接解析与改写：将发布页解析为真实资产地址，为直链添加镜像前缀（`ghfast.top`），下载后校验 sha256，再将 URL 交给下载器。这类方案本身不提供带宽，速度提升来自底层下载器的多连接分片（Motrix 使用 aria2）。

本机实测（同一资产，Windows / 家用宽带，单位 MiB/s）：

| 方式 | 吞吐 | 相对单连接 |
|---|---|---|
| 单连接 32 MB（两次） | 1.62 / 1.83 | 基准 |
| 4 连接 × 8 MB 并行 | 2.48 | ≈1.4× |
| 8 连接 × 4 MB 并行 | 1.85 | 无增益（连接数超过收益拐点） |
| `ghfast.top` 镜像（完整文件） | 3.55（另一次测） | 只影响可达性，与官方 API 直链相比并不更快 |
| `github.com` 直链 4 连接 | 1.07 | 该路径本身不可靠 |

结论：

- 单连接被限速（约 1 个连接的 0.6 MiB/s）时，4 连接能拿到约 1.4 倍；继续加连接不再变快。
- 镜像前缀解决的是「连不上」，不解决「慢」；实测镜像甚至慢于官方 API 资产直链。
- 已实现客户端多连接分片（`downloadConnections`，默认 4）：把单文件切成 N 段并发 Range 下载再拼接，不引入 aria2 等外部下载器；
  服务端不支持 Range 或任一段重试失败时自动回退单流，校验仍在拼接后统一做一次。

实现后的实测（同一台机器，两个不同网络时段）：

| 场景 | 单流 | 4 连接 | 加速比 |
|---|---|---|---|
| 本地服务器按连接限速（每连接约 1.25 MB/s） | 1.24 MiB/s | 4.74 MiB/s | 3.83× |
| 真实 GitHub 资产、线路未限速 | 10.71 MiB/s | 11.79 MiB/s | 1.10× |
| 真实 GitHub 资产、单流被限到 ~0.6 MiB/s | 1.62 MiB/s | 2.48 MiB/s | 1.4× |

结论：分片解决的是「单连接被限速」，不是「总带宽不足」；不限速时接近持平，限速时收益最大。

## 常见故障排查
| 现象 | 原因 | 处理 |
|---|---|---|
| 升级报 `EBUSY` / 备份 `rename` 失败 | 引擎仍在运行：手工启动的进程，或 `comfyBaseUrl` 与真实端口不一致，未探测到 | 先执行 `comfy(action="control", op="stop")` 再重试；确认没有 `python.exe` 占用引擎目录 |
| 升级报 `EPERM` / 备份 `rename` 失败，但引擎已停止 | 生图网关使用引擎目录中的 `python_embeded\python.exe`，进程运行时锁定目录 | 使用 `netstat -ano` 找到占用 8189 端口的 PID 并结束该进程；新版升级器会自动停止网关并补装依赖 |
| 升级后网关无法启动 / `ModuleNotFoundError: fastapi` | 整包替换更换了 python_embeded 目录，网关依赖未补装 | 使用新引擎的 Python 执行 `python_embeded\python.exe -m pip install -r <网关目录>/requirements.txt`，然后重新生图触发自愈 |
| GitHub Release 直链 404 / 超时 | 网络受限、仓库迁移或 release 资产被限流；直链连接可能在 TLS/连接阶段就超时 | 下载器对 GitHub Release URL 先解析官方 Releases API 资产直链（tag → asset id → `/releases/assets/<id>`），失败再退回原链接；有 `GITHUB_TOKEN` / `GH_TOKEN` 时带 Bearer；仍失败按网络/代理排查 |
| 下载中断 | 大文件断网，或链路长时间不吐数据 | 无数据超过 60s 会被主动中断并按 `.partial` 续传重试（默认 3 次）；临时文件保留，重新执行同一条命令时通过 HTTP Range 续传；完成后校验大小与 `sha256` 再 `rename` |
| `sha256` 校验失败 | 归档不完整或镜像内容不正确 | 删除 `.partial` 与归档后重新下载；不要绕过校验 |
| 升级后版本未变化 | 运行中的仍是旧进程 | 执行 `comfy(action="control", op="restart")`，再通过 `image_setup action=status` 查看 `versionSource` 为 `engine` 时的版本 |
| 回滚失败 | 目标目录被占用或权限不足 | 备份仍在 `<installRoot>/.imagekit/backups/engine/<版本>-<时间戳>/`（`payload/` 是旧目录本体，`meta.json` 记录版本与时间）；手工把 `payload/` 移回原位，或重装清单版本 |
| 同步上游后 import 失败 | 只更新了代码，Python 依赖未同步 | 手动执行 `update/update_comfyui_and_python_dependencies.bat`，或重装清单中的固定版本 |
