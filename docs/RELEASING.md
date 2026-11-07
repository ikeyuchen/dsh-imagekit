# 发布流程

## 版本策略

- 当前版本：`0.0.1`
- 日常开发提交**不改** `version`；
- 只有对外发布时才更新 `package.json`、`CHANGELOG.md` 和 git tag；
- npm 上每个版本不可覆盖，发布前必须确认 `npm pack --dry-run` 内容。

## 发布前检查

```bash
npm test          # 8 套离线自测（check / download / backup / setup / upscale / output / prompt / docs）
npm pack --dry-run
npm publish --dry-run --access public
```

确认包内不含：

- `data/`、`node_modules/`
- 模型权重、ComfyUI 引擎、Vulkan 引擎
- 本地 profile 配置、密钥

## 推送到 GitHub

- **不要频繁推送**；攒到一批有意义的变更再推。
- 本地可以随时提交（commit）；**推送到 GitHub 时把本地多个提交合并成一个**，并**不要自动推送**，由人工确认后执行。
- 推送前写清提交说明：一句话说"做了什么 + 为什么"，涉及用户可见变化的写进 `CHANGELOG.md`。

```bash
# 1) 把本地未推送的提交压成一个
git reset --soft origin/main      # 首次推送用 git reset --soft <父提交>
git commit -m "feat: <一句话说明>"

# 2) 人工确认后推送
git push origin main
```

## 发布到 npm

```bash
npm login
npm publish --access public
git tag v0.0.1
git push origin v0.0.1
```

GitHub Release 使用同一 tag，说明本次变更。

## 版本号变更（仅发布时）

```bash
npm version patch --no-git-tag-version
# 或 minor / major，按兼容性决定
```

然后更新 `CHANGELOG.md`，重新跑检查并发布。
