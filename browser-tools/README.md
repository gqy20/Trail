# Trail Browser Tools

Browser Tool 是一份受限 YAML 工作流。它复用用户当前 Chrome 页面和登录状态，通过声明式动作填写、点击、等待并提取 DOM 数据。

## 支持的动作

- `wait_for`: 等待元素出现。
- `fill`: 填写普通输入框、文本域或 `contenteditable`；密码框始终禁止。
- `select`: 选择原生 `<select>` 的值。
- `click`: 点击元素，可同时等待另一块内容变化。
- `wait`: 短暂等待。
- `wait_for_change`: 等待先前观察过的元素内容变化。
- `extract`: 从一组 DOM 元素提取结构化字段。
- `repeat`: 有上限地重复一组动作。
- `pause_for_user`: 在登录、验证码等节点停止并把原因返回给调用方。

字段只允许读取文本、链接、`content` 和 `datetime`。转换只允许使用 `trim`、`normalize_whitespace`、`parse_year`、`parse_number` 和 `split_authors`。YAML 不能执行 JavaScript。

`extract` 字段可以用 `multiple: true` 返回多个匹配元素。`repeat.max` 可以引用数字参数；`repeat.between` 只在相邻迭代之间运行，适合把“提取当前页”和“翻到下一页”分开。

## 调用链路

扩展页面先发送 `VALIDATE_BROWSER_TOOL_YAML` 校验配置，再由明确的用户操作发送：

```ts
const result = await sendMessage({
  type: "RUN_BROWSER_TOOL",
  yaml,
  parameters: { keyword: "browser automation" },
  userInitiated: true
});
```

后台会再次解析和校验 YAML、检查目标域名，然后才把已验证的定义发送给目标标签页执行。

popup 中的扳手入口会在当前网页旁打开 Browser Tools Side Panel；旧版浏览器会回退到独立管理页。它支持导入或覆盖 YAML、根据目标 URL 显示匹配状态、动态填写参数、运行工具、表格化查看最近结果，以及导出带 UTF-8 BOM 的 CSV 或 JSON。

当前版本的 `pause_for_user` 会结束本次运行并返回 `paused`，尚不能从中断步骤原地恢复。保存历史会限制运行数量、集合记录数量和长文本长度，完整数据导出将在文献数据集层实现。
