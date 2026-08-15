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

## 批量检索词

需要批量切换检索词的工具可以声明 URL 查询参数导航：

```yml
batch:
  navigation:
    type: query_parameter
    parameter: kw
  max_keywords: 50
  delay_between_keywords_ms: 1200
```

侧边栏随后会显示批量输入区。运行时依次导航目标标签页、复用原工作流提取，并给每条记录增加 `_query` 来源列；默认在完成后自动下载汇总 CSV。遇到登录、验证码或提取失败会停止后续检索并保留已完成结果。

## 展示契约

工具可以用可选的 `presentation` 段声明工作区标题、来源名称、输入文案、动作名称和结果字段。核心侧边栏只读取这些通用声明，不识别具体平台、集合或字段语义：

```yml
presentation:
  title: 数据采集
  source_label: Example Search
  batch_input:
    label: 搜索词
    placeholder: 每行输入一个搜索词
    item_label: 搜索词
    count_unit: 个
    import_formats: [txt, csv]
    csv_headers: [搜索词, keyword, query]
  actions:
    run: 开始搜索
    run_empty: 输入搜索词后开始
    running: 正在搜索…
    single_run: 只读取当前结果页
  results:
    title: 本次结果
    item_label: 条目
    count_unit: 个
  collections:
    results:
      label: 搜索结果
      item_label: 条目
      count_unit: 个
      fields:
        name: { label: 名称, order: 10, emphasis: primary }
        url: { label: 链接, order: 20, display: link }
```

参数可使用自己的展示声明决定放置位置和渲染方式：

```yml
parameters:
  page_limit:
    type: number
    label: 读取页数
    default: 3
    presentation:
      placement: primary
      style: sentence
      prefix: 每个搜索词读取
      suffix: 页
```

未声明 `presentation` 时，运行时使用“数据采集”“批量输入”“记录”等中性默认文案。平台专有名称、字段中文名、字段顺序和链接展示方式应留在各自的工具 YAML 中。

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

popup 中的扳手入口会在当前网页旁打开 Browser Tools Side Panel；旧版浏览器会回退到独立管理页。它支持导入或覆盖 YAML、根据目标 URL 显示匹配状态、按工具展示契约动态渲染输入与参数、运行工具、表格化查看最近结果，以及导出带 UTF-8 BOM 的 CSV 或 JSON。

当前版本的 `pause_for_user` 会结束本次运行并返回 `paused`，尚不能从中断步骤原地恢复。保存历史会限制运行数量、集合记录数量和长文本长度；本次运行返回的完整结果仍可直接导出。
