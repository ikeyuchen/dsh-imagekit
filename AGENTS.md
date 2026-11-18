# AGENTS.md — dsh-imagekit 开发指引

面向在本仓库工作的 AI 代理与维护者的操作约束。仅记录易错事项，不重复 README。

## 环境

- Node 版本不低于 22.19（见 `engines`）。ComfyUI 未运行时先执行 `comfy status`，不要按代码缺陷处理。
- 临时产物只写入 `.verify-cache/` 或 `_tmp/`（已在 `.gitignore` 中），不写到仓库外。

## 命令

```bash
npm run check      # 包结构 / 语法（lib 与 scripts）/ 发布边界
npm run test:docs  # 文档漂移（链接、路径、工具名、配置键、数量）
npm test           # 全套离线自测（check + 10 套用例 + 文档漂移，含网关与工具校验），修改后必须执行
npm run test:e2e   # 真实大文件回归（默认跳过；IMAGEKIT_E2E=1 时运行，约 190 MB）
npm run release    # 发布预演（只显示会改什么，不动文件、不推送、不打 tag）
```

CI 在 `windows-latest` 上跑 Node 22 与 24（本插件不支持 Linux，不要用 ubuntu runner）。
CI 不是强制门禁（私有仓库免费版没有分支保护），真正的门禁是 `prepublishOnly` 里的 `npm test`。

## 硬约束

- 模型、引擎、7-Zip 不进仓库；`doc-drift` 的 H 规则禁止在 `lib/paths.js` 之外写死盘符路径。
- 默认路径只在 `lib/paths.js` 派生；新增路径必须走 `IMAGEKIT_INSTALL_ROOT` 等环境变量。
- 所有下载必须带 `sizeBytes` + `sha256`，无校验的归档不得进入清单。
- 新增数据文件时同步 `package.json` 的 `files` 与 `THIRD_PARTY.md` 的来源表。
- 默认下载源保持官方（`huggingface` / GitHub Releases）；第三方镜像只作显式选项。
- 删除/升级只操作清单登记路径，必须二次确认；junction 根拒绝删除。
- 大文件下载只能由用户手动触发，不自动下载；版本号只在准备发布时递增。
- 平台：本插件是 Windows x64 向（ComfyUI 便携引擎与超分二进制都是 `.exe`）。
- 提示词文档分两层，不互相复制：内置版是 `docs/PROMPTS-CORE.md`（随包分发，由 `image_prompt_guide`
  按需返回，不依赖 DSH 技能）；另一层是探索版 `docs/PROMPTS.md`。新增提示词文件放在 `docs/`，命名为 `PROMPTS*.md`。

## 外部进程（LibreOffice / soffice）

- 用 LibreOffice 转换 docx/pdf 必须设超时；超时后用 `taskkill /PID <pid> /T /F` 结束**进程树**。DSH 的
  `job_kill` 只结束 pwsh/job 外壳，不会杀 `soffice` 子进程，孤儿进程会继续写盘。
- headless 调用带独立 profile，避免与常驻实例抢锁：`-env:UserInstallation=file:///C:/.../lo-profile`。
- 转换输出与临时文件只放 `.verify-cache/`；失败后检查并清理 `lu*.tmp` 与 `.~lock.*#`，不要留着等下次。
- 教训：2026-11-18 一次 `--convert-to txt:Text` 挂起，临时文件 `lu1404814emx.tmp` 涨到 971 GB，写满 D 盘。

## 改工具签名或描述时

- 执行 `npm run tokens`，同步 `docs/ARCHITECTURE.md` 与 `docs/USAGE.md` 的 token 数字、`locale/*.json` 的文案，并在下次发布时记进 `CHANGELOG.md`。

## 提交与推送

- 本地提交可使用 `<type>(<scope>): <subject>` 格式（type 为 feat / fix / refactor / docs / chore / test / perf）。
- 不自动推送：仅在用户明确要求时推送。
- 推送前将本地提交合并为一个提交，GitHub 每次推送只新增一条记录。
- 只追加、不改写：`git push origin main` 正常快进，不使用 `push -f`；远端有新提交时先执行
  `git fetch origin && git rebase origin/main`，再合并提交。唯一分支为 `main`。
- 推 `v<version>` tag 就是发布：会触发 `release.yml` 发布到 npm。除发布外不要推 tag。

### 版本号与变更日志（发布时）

日常提交不修改 `version`，不写变更日志。开发版发布到 npm 的 `beta`，稳定版发布到 `latest`。

- 版本号格式为 `x.y.z`；开发版为 `x.y.z-beta.N`。补丁位用于每次发布，不按十进制进位。
- 仅开发版使用 `npm run release:beta -- --publish`；稳定版使用 `npm run release -- --push`——脚本会合并提交、推送 main、打 `v<version>` tag，由 `release.yml` 发布，不要再手工执行 `npm publish`。稳定版发布前应完成 beta 验证。
- `CHANGELOG.md` 最新小节必须与 `package.json` 版本一致。开发版写发布日期；稳定版发布前写「未发布」，由脚本更新。
- 分区固定为 `新增功能 / 体验优化 / 问题修复 / 其他变更`。首句总结，每条一行，只写用户可见变化，不写根因、类名、测试数字或实测耗时。
- 发布由脚本执行。`prepublishOnly` 在 `npm publish` 前跑完整 `npm test`（含 `doc-drift` 的 K 规则），本地手动发布也绕不过；`release.mjs` 拒绝 prerelease 走稳定流程。

完整流程与命令参数见 `docs/RELEASING.md`。
