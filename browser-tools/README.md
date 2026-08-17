# Trail Browser Tools

Browser Tool 是一份受限 YAML 工作流。它复用用户当前 Chrome 页面和登录状态，通过声明式动作填写、点击、等待并提取 DOM 数据。

## 内置工具清单

插件内置工具由 [`catalog.yml`](./catalog.yml) 统一管理。新增工具时，把 YAML 放在 `browser-tools/` 的任意子目录，再在清单中登记相对路径：

```yml
schema_version: 1
version: 1
tools:
  - path: cnki/tool.yml
  - path: examples/literature-search.example.yml
    enabled: false
```

`enabled` 默认为 `true`。构建会自动收集目录内的 YAML，因此不需要再修改 TypeScript 导入列表。插件首次安装或升级时会一次性同步启用的工具；设置页也提供“内置工具库 → 同步”按钮。

同步只自动更新仍标记为“内置”的工具。用户通过编辑器手动导入的同 ID 工具会转为“自定义”来源，后续升级不会覆盖；清单中的停用项也不会删除用户现有数据。清单内容发生变化时应递增 `version`。

## 支持的动作

- `wait_for`: 等待元素出现。
- `fill`: 填写普通输入框、文本域或 `contenteditable`；密码框始终禁止。
- `select`: 选择原生 `<select>` 的值。
- `click`: 点击元素，可同时等待另一块内容变化。
- `wait`: 短暂等待。
- `scroll`: 按固定距离滚动页面或指定容器，也可回到顶部/底部，适用于虚拟滚动结果列表。
- `wait_for_change`: 等待先前观察过的元素内容变化。
- `extract`: 从一组 DOM 元素提取结构化字段。
- `repeat`: 有上限地重复一组动作。
- `pause_for_user`: 在登录、验证码等节点停止并把原因返回给调用方。
- `pause_if_present`: 在限定时间内检测到登录或验证码选择器时暂停，否则继续工作流。

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

对于 Web of Science 这类结果 URL 使用临时会话标识的单页应用，可以让每个批次回到固定检索页，并把当前输入注入一个已声明的隐藏参数：

```yml
parameters:
  keyword:
    type: string
    required: true
    presentation: { placement: hidden }
batch:
  navigation:
    type: fixed_url
    url: https://example.com/basic-search
    input_parameter: keyword
```

`fixed_url` 仍会经过工具域名和 URL 匹配校验；工作流负责填写 `{{ parameters.keyword }}`、提交检索并提取结果。

`repeat` 可以声明可选的实时进度元数据。运行时会把当前循环、总循环数和已发现记录数发送到侧边栏：

```yml
- action: repeat
  max: "{{ parameters.max_pages }}"
  progress:
    scope: page
    label: 正在处理页面
    item_label: 页
  steps: []
```

同一工作流可使用不同 `scope`（例如 `page`、`load`）同时展示分页与虚拟滚动进度。

虚拟滚动可以用 `stop_after_unchanged` 自适应提前结束。连续指定次数没有新增记录时停止当前 `repeat`，避免已经滚到底部后继续空等：

```yml
- action: repeat
  max: 12
  stop_after_unchanged: 2
  steps: []
  between:
    - action: scroll
      delta_y: 2500
    - action: wait
      duration_ms: 550
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
    composer:
      enabled: true
      label: 组合搜索
      group_label: 条件组
      placeholder: 每行输入一个词
      operators: [AND, OR]
      default_operator: AND
      max_groups: 4
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

`batch_input.composer` 启用侧边栏的组合输入模式。每个条件组可以放置多行词项，运行时按组生成笛卡尔组合，例如两组分别有 2、3 个词项时会得到 6 条检索式。界面会在运行前预览生成结果，并继续遵守工具 `batch.max_keywords` 的批量上限。`operators` 只负责连接各组词项，具体支持哪些检索运算符应由目标平台的工具 YAML 声明。

## 全文下载

工具可以声明从某个结果集合进入详情页并下载资源。核心只负责队列、域名校验、详情页解析、点击和 Chrome 下载状态；平台专有的字段和选择器仍保留在 YAML：

```yml
downloads:
  - id: fulltext
    label: 全文下载
    collection: literature
    detail_url_field: url
    title_field: title
    formats:
      pdf:
        label: PDF
        selector: ".btn-dlpdf a"
        extension: pdf
      caj:
        label: CAJ
        selector: ".btn-dlcaj a:not(.chapterDown)"
        extension: caj
    blockers:
      - selector: "#captcha"
        status: verification
        message: 页面需要完成安全验证，下载队列已暂停。
    allowed_domains: [bar.example.com]
    max_items: 20
    delay_ms: 1200
```

下载必须由用户主动启动，按单工作标签页串行执行。资源 URL 在详情页即时提取，不写入运行历史；遇到可见的验证码、登录或权限阻断器时会激活工作标签页并暂停。当前版本完成安全验证后需要在结果页重新选择未完成项启动，尚未实现原队列原地恢复。

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
