# 发布流程

## 版本策略

- 当前版本：`0.0.2`
- 版本号 `主.次.补丁`，本仓库管得宽松：补丁位就是「又一次发布」，不按十进制进位、没有上限，
  修个 bug 也能发一个；次位只在想做大阶段划分时才动（规则原文见 `AGENTS.md`）。
- 日常开发提交**不改** `version`；
- 只有对外发布时才更新 `package.json` 与 `CHANGELOG.md`；日志怎么写（一条一行、固定分区）见 `AGENTS.md` 的「版本号与变更日志」；
- npm 上每个版本不可覆盖：发布前必须确认 `npm pack --dry-run` 内容，发布后只能改内容发新版本。

## 发布前检查

```bash
npm test
npm pack --dry-run
npm publish --dry-run --access public
```

确认包内不含：`data/`、`node_modules/`、模型权重、ComfyUI 引擎、Vulkan 引擎、本地 profile 配置与密钥。

## 推送到 GitHub

- **不自动推送**：用户说了才推；推送 = 发布，版本号与日志也在这一步确认。
- **攒一批再推**：一两处小改动不推，避免刷出一长串提交记录。
- **正常快进推送**：`git push origin main`，远端历史完整保留；不用 `push -f`、不重建根提交。
- 推送前跑 `npm test` 与 `npm run test:docs`（脚本会自动跑）。

```bash
npm run release            # 预演：显示标题改动与推送说明
npm run release -- --push  # 去「未发布」→ 写日期 → npm test → 提交并推送
```

脚本不可用时的等价手搓步骤：

```bash
git add -A && git commit -m "<type>(<scope>): <subject>"
git fetch origin && git rebase origin/main   # 远端有新提交时
git push origin main
```

## 发行说明（GitHub Release）

- 标题只用版本号：`vX.Y.Z`，不写副标题。
- 正文直接复用 `CHANGELOG.md` 对应小节，末尾加一段安装命令。
- 分区与写法跟 CHANGELOG 一致：`新增功能 / 体验优化 / 问题修复 / 其他变更`，每条一行。
- 不逐条加粗、不用破折号、不写括号式补充说明；面向使用者写，不写实现细节。

```bash
gh release create v0.0.2 --target main --title v0.0.2 --notes-file <说明文件>
```

## 发布到 npm

```bash
npm login                     # 凭证过期时重新授权
npm publish --access public   # prepublishOnly 会自动跑 npm run check
npm view dsh-imagekit version # 核对已上架
```

- 开了 2FA 时加 `--otp=<6 位码>`。
- 发布后如需修正，只能发下一个版本号。

## 版本号变更（仅发布时）

```bash
npm version patch --no-git-tag-version   # 补丁位 +1，不封顶；要做大阶段划分再用 minor / major
```

然后更新 `CHANGELOG.md`，重跑检查并发布。
