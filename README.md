# Trail

把 Chrome 标签页分组记录成一次可保存的研究轨迹。

## MVP 范围

- 从当前激活标签页检测 Chrome Tab Group。
- 支持对当前分组开始和停止半自动记录。
- 当前标签页不在分组内时，回退到记录当前窗口。
- 录制期间捕获网页内复制和稳定选中的文本片段。
- 支持复制片段的来源上下文、类型识别、重复合并和可选脱敏。
- 使用 `chrome.storage.local` 保存已完成的 Sessions。
- 暂不接入 AI，先生成 mock Research Markdown。
- 支持复制或下载生成的 Markdown。

## 交互捕获

Trail 只在录制期间捕获普通网页中的交互信号，不读取系统剪贴板，也不会记录输入框、文本域或可编辑区域中的内容。

当前支持：

- 复制捕获：用户在网页内选中文本并复制后，保存为“已复制”片段。
- 稳定选中：用户选中文本并停留片刻后，保存为“仅选中”关注片段。
- 复制升级：如果用户先选中、随后复制同一段文本，Trail 会把原片段升级为“已复制”，避免重复记录。
- 上下文记录：可记录页面标题、URL、domain、章节标题、附近文本和大致页面位置。
- 片段治理：支持类型识别、重复复制合并、域名排除和可选自动脱敏。

相关开关在 popup 的“复制捕获”面板中：

- 记录网页复制
- 记录稳定选中
- 保留来源上下文
- 复制后轻提示
- 合并重复片段
- 自动脱敏
- 不记录当前域名

自动脱敏默认关闭；开启后会在写入 `chrome.storage.local` 前隐藏常见邮箱、token、密钥和 API key 形态。

## 本地开发

```bash
npm install
npm run build
```

构建完成后，在 Chrome 扩展管理页打开「开发者模式」，选择「加载已解压的扩展程序」，加载生成的 `dist/` 目录。

测试交互捕获时，需要刷新扩展和目标网页：

1. 运行 `npm run build`。
2. 在 `chrome://extensions` 中重新加载 Trail。
3. 刷新需要测试的网页，让 `content.js` 重新注入。
4. 点击 Trail popup 中的“开始记录”。
5. 在当前录制范围内选中或复制网页文本。
6. 停止记录后，在研究文档页查看“关注片段”。

## 发布

发布使用 GitHub Actions，推送 `v*` 标签会自动构建 Chrome 扩展并创建 GitHub Release：

```bash
git tag v0.1.0
git push origin v0.1.0
```

发布前需要同步以下版本号：

- `package.json`
- `public/manifest.json`
- `CHANGELOG.md` 中的 `## [x.y.z]`

Release 产物：

- `trail_v0.1.0_chrome.zip`
- `checksums.txt`

zip 内部直接包含 `manifest.json`、`entries/`、JS、assets 和 icons，可用于 Chrome Web Store 上传或手动分发。

## 提交规范

使用 Conventional Commits：

```text
feat(scope): message
fix(scope): message
chore(scope): message
```

安装本地 Git hooks 后，会在提交前运行项目检查，并在提交时校验 commit message：

```bash
npm run install-hooks
```
