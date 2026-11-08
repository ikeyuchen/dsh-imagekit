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
```

## 硬约束

- 模型、引擎、7-Zip **不进仓库**；`doc-drift` 的 H 规则禁止在 `lib/paths.js` 之外写死盘符路径。
- 默认路径只在 `lib/paths.js` 派生；新增路径必须走 `IMAGEKIT_INSTALL_ROOT` 等环境变量。
- 所有下载必须带 `sizeBytes` + `sha256`，无校验的归档不得进入清单。
- 新增数据文件时同步 `package.json` 的 `files` 与 `THIRD_PARTY.md` 的来源表。
- 默认下载源保持官方（`huggingface` / GitHub Releases）；第三方镜像只作显式选项。
- 删除/升级只操作清单登记路径，必须二次确认；junction 根拒绝删除。
- 大文件下载只能由用户手动触发，不自动下载；版本号只在对外发布时递增。
- 平台：本插件是 Windows x64 向（ComfyUI 便携引擎与超分二进制都是 `.exe`）。
- 提示词文档分两层、不要互相复制：内置核心版是 `docs/PROMPTS-CORE.md`（随包分发，由 `image_prompt_guide`
  按需返回，不依赖 DSH 技能）；另一层是探索版 `docs/PROMPTS.md`。新增提示词文件放 `docs/`，命名 `PROMPTS*.md`。

## 改工具签名或描述时

- 跑 `npm run tokens`，同步 README 的 token 数字、`docs/USAGE.md`、`locale/*.json`，并在下次发布时记进 `CHANGELOG.md`。

## 提交与推送

- 本地随便提交，频率不限；**GitHub 不自动推送，用户明确说推才推**。
- 提交格式：`<type>(<scope>): <subject>`，type ∈ feat / fix / refactor / docs / chore / test / perf。
- **推送只发快照，不发本地历史**：本地提交只是工作记录，不是版本历史——把它同步到 GitHub 就是污染数据。
  GitHub 上永远只有一条提交（无父的根快照），内容 = 推送时的完整工作区；攒一批再推，不要每次改动都推。
  唯一分支是 `main`，不建开发分支、不带 tag 历史。

### 版本号与变更日志（只在推送时写）

推送 = 对外发布的那一刻，所以只有这时才动这两处；本地日常提交不改版本号、不写日志。

- 版本号：修 bug 动末位（`0.0.2` → `0.0.3`），成批新功能动次位（`0.0.x` → `0.1.0`）；1.0 之前不做兼容承诺，新功能也可落在末位。
- 未发布期间可以先攒一个 `## x.y.z（未发布）` 小节；推送时去掉「（未发布）」，并改成当天日期。
- **每条一行**：做了什么 + 用户能感知到什么。不写根因分析、类名、测试数字、实测耗时——那些留给提交说明和 `docs/`。
- 固定分区 `新增 / 变更 / 修复`（纯文档改动加一节 `文档`）。同版本只有一个同名分区，不要「（续）」。
- 只写用户可见的变化；重构、内部整理、测试补强不进日志。

推送前：`npm test`、`npm run test:docs` 必须通过，版本号与日志已改好。

```bash
git add -A
SNAP=$(git commit-tree "$(git write-tree)" -m "release: <版本与一句话说明>")
git push -f origin "$SNAP:main"
```

- 推完核对 `git log --oneline origin/main` 只有 1 条；本地 `main` 不受影响（未设 upstream，误敲 `git push` 会直接报错）。
