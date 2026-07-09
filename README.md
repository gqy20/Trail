# Trail

把 Chrome 标签页分组记录成一次可保存的研究轨迹。

## MVP 范围

- 从当前激活标签页检测 Chrome Tab Group。
- 支持对当前分组开始和停止半自动记录。
- 当前标签页不在分组内时，回退到记录当前窗口。
- 使用 `chrome.storage.local` 保存已完成的 Sessions。
- 暂不接入 AI，先生成 mock Research Markdown。
- 支持复制或下载生成的 Markdown。

## 本地开发

```bash
npm install
npm run build
```

构建完成后，在 Chrome 扩展管理页打开「开发者模式」，选择「加载已解压的扩展程序」，加载生成的 `dist/` 目录。

## 提交规范

使用 Conventional Commits：

```text
feat(scope): message
fix(scope): message
chore(scope): message
```
