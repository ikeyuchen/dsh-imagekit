# 引擎版本策略

`dsh-imagekit` 默认只使用清单里固定的、我们验证过的 ComfyUI 版本；「同步上游最新」是显式、带警告的实验性逃生通道，不进入正常升级入口。这个插件的卖点是「装完就能用」，不受控的引擎漂移会把出图故障的排查成本转嫁给用户。

## 两条升级路径

| | 清单固定版本（默认） | 同步上游最新（实验） |
|---|---|---|
| 命令 | `image_setup action=upgrade component=engine` | `comfy action=upgrade mode=upgrade confirm=true` |
| 做什么 | 按清单重新下载官方 portable 7z，整目录备份后解压替换 | 停引擎 → 跑便携包里的 `update/update_comfyui.bat`（git pull 上游代码）→ 重启 |
| 版本来源 | `models.manifest.json` 的 `components.engine.packs.default.version` | GitHub 最新 release |
| 是否校验 | `sizeBytes` + `sha256`；解压后还核对磁盘版本 | 不校验内容，只报告升级后的本地版本 |
| 风险 | 受控：引擎、python 依赖、节点接口都是配套的 | 版本漂移不受控：依赖不跟着更新、节点可能改名、出图可能静默走偏 |
| 回滚 | 失败自动回滚；旧版本备份按 `keepVersions` 保留 | git 更新无法自动回滚，只能重装清单版本兜底 |
| 用户环境 | 整目录替换，但会先保留并放回 `ComfyUI/custom_nodes` / `ComfyUI/extra_model_paths.yaml` / `ComfyUI/user` / `ComfyUI/input` / `ComfyUI/output` / `ComfyUI/models` | 就地 git 更新，配置文件本身不丢；但节点接口与依赖可能不兼容 |
| 适用场景 | **日常升级**，设置页「升级」按钮走这条（弹二次确认，引擎先停后起） | 排障 / 明确要试上游新版本 |

> 两条路径方向相反：前者把引擎拉回清单版本，后者把引擎推到上游最新。不要来回交替执行，否则引擎会在两个版本之间反复横跳。

## 固定版本策略

### 清单即事实来源

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
- 备份的 `payload/` 只含引擎本体：用户数据在升级时被单独保管、失败回滚时放回，不重复进备份（否则每次备份都要多占一份节点/模型）。所以**事后**想手工回滚到旧版本时，要把 `payload/ComfyUI_windows_portable` 换回引擎目录后，再把当前安装里的 `ComfyUI/custom_nodes`、`ComfyUI/extra_model_paths.yaml`、`ComfyUI/user` 一并带过去。
- 为什么必须先停：Windows 上目录里有运行中的 `python.exe` 时 `rename` 会报 `EBUSY`，升级直接失败；就算侥幸换完文件，运行中的进程仍是旧版本。
- 手工启动的引擎也能识别：升级前用 `comfyBaseUrl` 的 `/system_stats` 探活，命中就复用 `comfy` 的 `control` 停止，升级后按原 `profile`（`normal` / `lowvram`）重启。宿主没注册 `comfy` 工具时，明确拒绝升级并提示先手工停引擎，不会假装成功。

### 升级不破坏用户环境

固定版本升级是「整目录替换」，而 `<engineRoot>` 里除了引擎代码，还有用户自己的东西。升级前会把下面这些用同盘 `rename` 挪进 `<installRoot>/.staging/engine-upgrade-<pid>-<ts>/`，解压完再放回（回滚后同样放回）：

| 相对路径 | 内容 | 不保留会怎样 |
|---|---|---|
| `ComfyUI/extra_model_paths.yaml` | 模型注册表（绝对路径） | 引擎看不到任何模型，出图报模型不存在 |
| `ComfyUI/custom_nodes` | 自定义节点（pose / vnccs 等模板依赖） | 相关工作流节点缺失，模板直接报错 |
| `ComfyUI/user` | 工作流库 / 设置 / `comfyui.db` | 用户工作流与偏好丢失 |
| `ComfyUI/input`、`ComfyUI/output` | 用户上传的参考图、引擎自己的产物 | 参考图丢失 |
| `ComfyUI/models` | 用户直接放进便携版的模型 | 模型被新解压的空目录顶掉 |

- 只搬移、不改写内容；搬移失败时整个升级中止（「nothing changed」），不会出现「引擎升了、环境没了」。
- 临时区在 `<installRoot>/.staging/`，`image_setup action=clean` 会清扫残留（进程被杀在解压中途时用）。
- 注意：`extra_model_paths.yaml` 里若写的是旧便携版目录内的相对路径，整目录替换后仍会失效——模型源请用绝对路径（本仓库默认就是绝对路径）。

### 网关（生图服务）与 python_embeded

生图网关（默认 `http://127.0.0.1:8189`）跑的是**引擎目录里的** `python_embeded\python.exe app.py`，它的 `fastapi` / `uvicorn` / `httpx` / `pydantic` 就装在引擎的 `site-packages` 里。所以整包替换引擎前必须处理两件事：

1. **先停网关**：进程活着时 `python_embeded\python.exe` 被占用，引擎目录 `rename` 会报 `EPERM`（比 `EBUSY` 更隐蔽——引擎停了也照样失败）。升级器只在「端口上的进程确实来自本引擎目录」时才杀它，不误伤别人的服务。
2. **换完补装依赖**：新解压的 python_embeded 目录是干净的，不补装网关就起不来。升级器会用新 python 执行 `<网关目录>/requirements.txt`（`pip install -r`），失败按「升级失败」回滚，不让系统停在半可用状态。
3. 网关不主动拉起：它由生图调用按需自愈（下次 `image_generate` 会重新拉起），升级结果里会说明。

### 升级后版本校验

1. **磁盘为准**：读 `<engineRoot>/ComfyUI/comfyui_version.py` 里的 `__version__`，这就是引擎实际版本。
2. **状态记录**：成功后写 `state.json` 的 `installed.engine = { version, engineVersion, pack, at }`。
3. **来源优先级**：磁盘 `comfyui_version.py` → `state.json` 记录 → 清单探测；`status` 的 `versionSource` 用来说明当前值来自哪一级。
4. **不一致不静默**：解压后磁盘版本与清单 `version` 不同（镜像给错包、归档内层目录变了）时输出 `WARN` 并保留本次备份（仍受 `keepVersions` 约束），不会悄悄记成成功。
5. `updateAvailable` 比较的是磁盘真实版本与清单 `version`，`state.json` 陈旧不会造成永远「可升级」的空转。

## 允许同步上游的边界条件

「同步上游最新」只在同时满足下面这些条件时才允许使用：

- **实验性**：只通过 `comfy` 手动触发，命令强制要求 `confirm=true`；不放进正常升级按钮。
- **明确警告**：结果按「未经验证、可能破坏出图」对待，不能当正常升级写进发布说明。
- **依赖同步**：`update_comfyui.bat` 只更新代码，不更新 python / torch 依赖；需要时手动跑 `update/update_comfyui_and_python_dependencies.bat`，否则新版引擎可能 import 失败。
- **节点兼容**：工作流模板按固定节点名与接口编写，跨版本节点改名或行为变化会让出图静默走偏（不报错，但结果不对）。
- **出图回归**：至少 t2i、参考图改图、放大各冒烟一张，并与固定版本的结果对比。
- **失败可回滚**：同步上游没有自动回滚；兜底是 `image_setup action=upgrade component=engine` 重装清单里的固定版本。
- **升级后必须重启并校验版本**：`comfy` 的 upgrade 会自己停/起并报告版本，`image_setup` 也会重启；仍要人工确认版本与出图结果。

## 维护者流程：把清单版本从 X 提到 Y

1. 取官方 Release 的 portable 7z 资产，记录 `sizeBytes` 与 `sha256`（无校验的归档不进清单）。
2. 更新 `models.manifest.json`：`components.engine.packs.default` 的 `version`、`sources.official`（固定 tag）与 `sizeBytes` / `sha256`；`pack` 名保持 `default`。
3. 干净环境验证升级：`image_setup(action="upgrade", component="engine")` 能下载、校验、解压、停/起引擎，并在 `status` 里显示目标版本。
4. 冒烟出图：t2i 一张、参考图改图一张、`image_upscale` 一张；记录耗时与显存，和旧版本基线对比。
5. 节点兼容核对：出图不报错不等于没走偏，至少核对模板用到的节点与关键参数仍然存在。
6. 更新 `CHANGELOG.md` 的用户可见说明，并同步本文档里过时的版本描述。
7. `npm run check` 与 `npm run test:docs` 必须通过；合并前跑一遍 `npm test`。

## 分发方式：官方源 vs 自建镜像

清单条目的 `sources` 可以有多个键，下载器按 `preferred(用户选的源) → mirror → sourceforge → huggingface → hf-mirror → modelscope → official` 的顺序取第一个存在的 URL。因此「要不要由我们自己托管二进制」不是二选一，而是给同一个条目加一个 `sources.mirror`：

```json
"sources": {
  "official": "https://github.com/<上游>/<repo>/releases/download/<tag>/<asset>",
  "mirror": "https://github.com/<我们>/<镜像仓库>/releases/download/<tag>/<asset>"
}
```

**为什么不把二进制放进本仓库的 git 树**：Git 单文件 100 MB 硬限制、仓库体积永久膨胀（每次 clone 都拉），而 Releases 资产单文件上限 2 GB、不计入仓库体积。

**自托管的收益与代价**：

| | 说明 |
|---|---|
| 收益 | 上游删 release / 重打 tag 时我们仍能装；分发的就是**我们验过的那几个字节**（sha256 永远对得上）；插件与引擎同源分发，信任根收敛到一处 |
| 许可 | MIT / BSD-3 允许再分发，但要求随附版权声明与许可全文（见 `THIRD_PARTY_LICENSES/`），BSD-3 另有「不得用原作者名义背书」一条 |
| 网络 | 和官方源同一个 GitHub 域，**不会**绕开「github.com 直连不通」的网络问题；真正提高可达性的是多源（`mirror` + 上游官方 + 用户自建 `modelPackBaseUrl`），下载器已对 GitHub release 链接优先解析官方 API 资产直链 |
| 维护 | 镜像要跟着清单版本更新，过期的镜像等于安全债；旧版本资产要么保留（可回滚），要么写清保留策略 |

当前仓库**不在 git 里分发任何二进制**，清单里只登记 `sources.official`（上游官方 release）；`sources.mirror` 是预留的可选槽位，需要时加即可，不改代码。

## 下载路径实测（2026-11-08，本机 5070 Ti / 家用宽带）

同一个 45,977,449 B 的官方资产，三条路径各测多轮（完整文件或 4–8 MB Range）：

| 路径 | 结果 | 吞吐 | 完整性 |
|---|---|---|---|
| `api.github.com` Releases 资产直链（**下载器首选**） | 4/4 成功 | **4.0 MB/s** | sha256 一致 |
| `https://ghfast.top/` 代理 `github.com` 链接 | 完整文件成功 | 3.55 MB/s（Range 探测 0.8–1.3 MB/s，首包要等回源） | sha256 一致 |
| 直连 `github.com/.../releases/download/...` | **8/8 连接超时**（21s），完整文件 0/2 | 0 | —— |
| `gh-proxy.com` / `ghproxy.net` / `ghproxy.cn` / `gh.llkk.cc` / `hub.gitmirror.com` | 全部失败或 ≤0.25 MB/s | —— | —— |

结论：
- **代理不加速**，本机反而比 API 资产直链慢约 12%；它的价值是「直连 0/8 时还能下下来」，属于可达性兜底。
- 所以 `githubProxy` 默认**关闭**，只在官方两条路径都不通时手动填；`ghfast.top` 不代理 `api.github.com`（实测 403），因此只改写 `github.com` 链接。
- 完整文件经代理下载后 sha256 与清单一致（透传不改字节），校验机制仍是我们唯一的内容保证。

## 常见故障排查
| 现象 | 原因 | 处理 |
|---|---|---|
| 升级报 `EBUSY` / 备份 `rename` 失败 | 引擎还在运行：手工启动的进程，或 `comfyBaseUrl` 与真实端口不一致没探活到 | 先 `comfy(action="control", op="stop")` 再重试；确认没有 `python.exe` 占着引擎目录 |
| 升级报 `EPERM` / 备份 `rename` 失败，但引擎已停 | 生图网关用的是引擎目录里的 `python_embeded\python.exe`，进程活着就锁住目录 | 查 `netstat -ano | findstr :8189` 找到 PID 后结束它；新版升级器会自动停网关并补装依赖 |
| 升级后网关起不来 / `ModuleNotFoundError: fastapi` | 整包替换换掉了 python_embeded 目录，网关依赖没补装 | 用新引擎的 python 跑 `python_embeded\python.exe -m pip install -r <网关目录>/requirements.txt`，然后重新生图触发自愈 |
| GitHub Release 直链 404 / 超时 | 网络受限、仓库迁移或 release 资产被限流；直链连接可能在 TLS/连接阶段就超时 | 下载器对 GitHub Release URL **先**解析官方 Releases API 资产直链（tag → asset id → `/releases/assets/<id>`），失败再退回原链接；有 `GITHUB_TOKEN` / `GH_TOKEN` 时带 Bearer；仍失败按网络/代理排查 |
| 下载中断 | 大文件断网，或链路长时间不吐数据 | 无数据超过 60s 会被主动中断并按 `.partial` 续传重试（默认 3 次）；临时文件保留，重跑同一条命令走 HTTP Range 续传；完成后校验大小与 `sha256` 再 `rename` |
| `sha256` 校验失败 | 归档不完整或镜像内容不对 | 删掉 `.partial` 与归档后重下；不要绕过校验 |
| 升级后版本没变 | 运行中的仍是旧进程 | `comfy(action="control", op="restart")`，再 `image_setup action=status` 看 `versionSource` 为 `engine` 时的版本 |
| 回滚失败 | 目标目录被占用或权限不足 | 备份仍在 `<installRoot>/.imagekit/backups/engine/<版本>-<时间戳>/`（`payload/` 是旧目录本体，`meta.json` 记录版本与时间）；手工把 `payload/` 移回原位，或重装清单版本 |
| 同步上游后 import 失败 | 只更新了代码，python 依赖没同步 | 手动跑 `update/update_comfyui_and_python_dependencies.bat`，或重装清单里的固定版本 |
