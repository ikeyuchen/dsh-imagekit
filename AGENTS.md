# AGENTS.md — dsh-imagekit 开发指引

给在本仓库工作的 AI 代理（以及人）的操作约束。只写容易踩错的，不重复 README。

## 环境

- Node ≥ 22.19（见 `engines`）。ComfyUI 不在位时先 `comfy status`，别当代码 bug 修。
- 临时产物只往 `.verify-cache/` 或 `_tmp/` 写（已在 `.gitignore`），不写到仓库外。

## 命令

```bash
npm run check      # 包结构 / 语法 / 发布边界
npm run test:docs  # 文档漂移（链接、路径、工具名、配置键、数量）
npm test           # 全套离线自测（check + 7 套 + 路由 + 文档漂移），改完必跑
npm run test:e2e   # 真实大文件回归（默认跳过；IMAGEKIT_E2E=1 才跑，拉 ~190MB）
npm run release    # 发布预演（只显示会改什么，不动文件、不推送）
```

## 硬约束

- 模型、引擎、7-Zip **不进仓库**；`doc-drift` 的 H 规则禁止在 `lib/paths.js` 之外写死盘符路径。
- 默认路径只在 `lib/paths.js` 派生；新增路径必须走 `IMAGEKIT_INSTALL_ROOT` 等环境变量。
- 所有下载必须带 `sizeBytes` + `sha256`，无校验的归档不得进入清单。
- 新增数据文件时同步 `package.json` 的 `files` 与 `THIRD_PARTY.md` 的来源表。
- 默认下载源保持官方（`huggingface` / GitHub Releases）；第三方镜像只作显式选项。
- 删除/升级只操作清单登记路径，必须二次确认；junction 根拒绝删除。
- 大文件下载只能由用户手动触发，不自动下载；版本号只在准备发布时递增。
- 平台：本插件是 Windows x64 向（ComfyUI 便携引擎与超分二进制都是 `.exe`）。
- 提示词文档分两层、不要互相复制：内置核心版是 `docs/PROMPTS-CORE.md`（随包分发，由 `image_prompt_guide`
  按需返回，不依赖 DSH 技能）；另一层是探索版 `docs/PROMPTS.md`。新增提示词文件放 `docs/`，命名 `PROMPTS*.md`。

## 改工具签名或描述时

- 跑 `npm run tokens`，同步 `docs/ARCHITECTURE.md` 与 `docs/USAGE.md` 的 token 数字、`locale/*.json` 的文案，并在下次发布时记进 `CHANGELOG.md`。

## 提交与推送

- 本地随便提交，格式 `<type>(<scope>): <subject>`（type ∈ feat / fix / refactor / docs / chore / test / perf）。
- **不自动推送**：用户明确说推才推。
- **推送前合成一笔**：把攒下的本地提交合并成一个提交（squash），GitHub 每推一次只多一条记录。
- **只追加、不改写**：`git push origin main` 正常快进，不用 `push -f`；远端有新提交先
  `git fetch origin && git rebase origin/main` 再合成。唯一分支 `main`。

### 版本号与变更日志（准备发布时才写）

日常提交不改版本号、不写日志。准备发布时先升版本、在 `CHANGELOG.md` 顶部攒一个「（未发布）」小节；推送时由 `npm run release -- --push` 去标记、写日期并合成一笔推送。

- 版本号 `主.次.补丁`，本仓库管得宽松：**补丁位就是「又一次发布」，不按十进制进位**（`0.0.9` 之后是
  `0.0.10`，不是 `0.1.0`），没有上限，修个 bug 也能发一个；次位只在确实想做大阶段划分时才动。
- 未发布期间先攒一个 `## x.y.z（未发布）` 小节；**去掉「未发布」不用记，`npm run release -- --push` 会做**。
- 分区固定为 `新增功能 / 体验优化 / 问题修复 / 其他变更`；同版本不出现同名分区与「（续）」。
- 小节第一句写总结：`x.y.z 版本，汇总了自 x.y.w 以来的主要变更，重点是…`。
- **每条一行、陈述句**：做了什么 + 用户能感知到什么。不写根因、类名、测试数字、实测耗时。
- 去 AI 腔：不逐条加粗、不用破折号（——）、不写括号式补充说明、不用「重点/核心/全新/正式/一站式」这类词。
- 只写用户可见的变化；重构、内部整理、测试补强不进日志。

发布就一条命令（预演不加 `--push`）：

```bash
npm run release            # 预演：标题会变成什么、推送说明是什么
npm run release -- --push  # 真发布：去「未发布」→ 写日期 → npm test → 合成一笔并推送
```

脚本一次做完，不要手搓；`npm test` 不过会停在推送前。最后一步把本地提交压成一条
`release: x.y.z` 再正常快进推送，远端历史只追加、不改写。
两道闸不靠记性：`doc-drift` 的 K 规则校验「CHANGELOG 最新小节 == package.json 版本」，
`npm publish` 前 `prepublishOnly` 跑 `release.mjs --check`，发现还写着「未发布」直接失败。
