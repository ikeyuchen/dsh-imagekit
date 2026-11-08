# 发布流程

## 版本策略

- 当前版本：`0.0.2`
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

- **不自动推送**：用户说了才推。
- **只推快照，不推本地历史**：GitHub 上始终只有一条无父的根提交，内容等于推送时的完整工作区；
  本地高频提交只留在本机（同步过去就是污染数据）。
- 攒一批再推；推送前跑 `npm test` 与 `npm run test:docs`。

```bash
git add -A
SNAP=$(git commit-tree "$(git write-tree)" -m "release: <版本与一句话说明>")
git push -f origin "$SNAP:main"
```

推完核对 `git log --oneline origin/main` 只有 1 条。

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
npm version patch --no-git-tag-version   # 或 minor / major，按兼容性决定
```

然后更新 `CHANGELOG.md`，重跑检查并发布。
