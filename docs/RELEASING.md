# 发布流程

## 版本策略

- 当前版本：`0.0.5-beta.1`（开发版，未发布）
- 版本号格式为 `主.次.补丁`。补丁位用于每次发布，不按十进制进位，无上限；次位仅用于阶段性版本（规则见 `AGENTS.md`）。
- 开发版为 `x.y.z-beta.N`，仅发布到 npm 的 `beta` tag；稳定版为 `x.y.z`，仅发布到 `latest`。
- 日常开发提交不修改 `version`。准备发布 beta 时，升到下一个 `x.y.z-beta.N`，并在 `CHANGELOG.md` 顶部写入同版本、带日期的小节（如 `## 0.0.4-beta.2（2026-11-12）`）。
- 稳定版准备期间写 `## x.y.z（未发布）`，由 `npm run release -- --push` 去标记并写日期。
- npm 上每个版本不可覆盖：发布前必须确认 `npm pack --dry-run` 内容，发布后只能改内容发新版本。

## 发布前检查

```bash
npm test            # check、10 套用例（含网关与工具校验）、文档漂移
npm pack --dry-run
```

`npm publish` 会自动先跑 `npm test`（`package.json` 的 `prepublishOnly`），所以任何发布入口都绕不过自测。
CI（`.github/workflows/ci.yml`）在 `windows-latest` 上跑 Node 22 与 24，作为参考；私有仓库免费版没有分支保护，
CI 不能强制拦截，真正的门禁是 `prepublishOnly`。

确认包内不含：`data/`、`node_modules/`、模型权重、ComfyUI 引擎、Vulkan 引擎、本地 profile 配置与密钥。

## 开发版发布（beta）

```bash
npm run release:beta                 # 预演：检查版本/日志
npm run release:beta -- --publish    # 真发布：npm publish --tag beta（prepublishOnly 先跑 npm test）
```

- 只更新 `beta` tag，不改 `latest`；
- 用户安装开发版：`dsh plugin add dsh-imagekit@beta` 或 `npm install dsh-imagekit@beta`；
- beta 小节直接写发布日期，不写「未发布」。

## 稳定版发布（latest）

```bash
npm run release            # 预演：显示标题改动与推送说明
npm run release -- --push  # 去「未发布」→ 写日期 → npm test → 合并提交 → 推送 main → 推 v<version> tag
```

推送 tag 后由 `.github/workflows/release.yml` 发布：先核对 tag 与 `package.json` 版本一致，再跑
`npm test`（`prepublishOnly`），最后按版本号选 dist-tag 发布。本地不要再执行 `npm publish`，
否则同一版本会被发布两次。

workflow 不可用时的手动兜底：`npm publish --access public`（`prepublishOnly` 同样会先跑 `npm test`）。

`release.mjs` 遇到版本号带 `-` 会拒绝走稳定流程；beta 只能用 `release:beta`。

## 推送到 GitHub

- 不自动推送：仅在用户明确要求时推送。推送即发布，版本号与日志在这一步确认。
- 集中推送：少量改动不单独推送，避免产生过多提交记录。
- 每次推送一个提交：推送前将本地提交合并为一个（squash），远端只追加一条；正常快进，不使用 `push -f`。
- 推送前执行 `npm test` 与 `npm run test:docs`（脚本会自动执行）。
- 推 `v<version>` tag 等于发布，除发布外不要推 tag。

```bash
npm run release            # 预演：显示标题改动与推送说明
npm run release -- --push  # 去「未发布」→ 写日期 → npm test → 合并提交 → 推送 main → 推 v<version> tag
```

脚本不可用时的等价手动步骤：

```bash
git add -A && git commit -m "<type>(<scope>): <subject>"
git fetch origin && git rebase origin/main                                   # 远端有新提交时
git reset --soft origin/main && git commit -m "release: x.y.z <说明>"  # 合并提交
git push origin main
```

## 发行说明（GitHub Release）

- 标题只用版本号：`vX.Y.Z`，不写副标题。
- 正文直接复用 `CHANGELOG.md` 对应小节，末尾加一段安装命令。
- 分区与写法跟 CHANGELOG 一致：`新增功能 / 体验优化 / 问题修复 / 其他变更`，每条一行。
- 不逐条加粗、不用破折号、不写括号式补充说明；面向使用者写，不写实现细节。

```bash
gh release create vX.Y.Z --target main --title vX.Y.Z --notes-file <说明文件>
```

## 发布到 npm

```bash
npm login                                  # 凭证过期时重新授权
npm run release:beta -- --publish          # beta：publish --tag beta（prepublishOnly 跑 npm test）
npm view dsh-imagekit@beta version         # 核对 beta

npm run release -- --push                  # stable：打 tag → release.yml 发布 latest
npm view dsh-imagekit version              # 核对 latest
```

- 稳定版不要手工 `npm publish`：tag 触发的 workflow 会发布；两条路都走会撞「版本已存在」。
- 发布失败先看 `gh run list --workflow=Release --limit 3`，再决定是否重跑 workflow（同版本重跑不会重复发布，npm 会拒绝已存在的版本）。

- 启用 2FA 时，beta 脚本会进入 npm 交互流程；也可手动执行 `npm publish --tag beta --otp=<6 位码>`。
- 发布后如需修正，只能发下一个版本号；beta 修正发 `x.y.z-beta.N+1`，稳定版修正发下一个补丁。

## 版本号变更（仅发布时）

```bash
npm version 0.0.5-beta.1 --no-git-tag-version   # 下一个开发版
npm version patch --no-git-tag-version          # 稳定版补丁位 +1
```

然后更新 `CHANGELOG.md`，重新执行检查并发布。
