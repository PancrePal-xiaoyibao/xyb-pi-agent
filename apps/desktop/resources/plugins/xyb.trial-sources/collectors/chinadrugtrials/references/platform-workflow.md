# 平台工作流参考

## 平台与端点

- 站点：`https://www.chinadrugtrials.org.cn`
- 高级检索页：`/clinicaltrials.prosearch.dhtml`
- 列表检索：`POST /clinicaltrials.searchlist.dhtml`
- 详情页：`POST /clinicaltrials.searchlistdetail.dhtml`
- Word 导出：详情页下载 form 的 `POST action`，常见为 `/clinicaltrials.searchlistdetail.dhtml?_export=doc`

不要将以上路径当作长期稳定 API 承诺。每次维护或出现异常时，优先以当前页面源代码中的 form、字段和按钮为准。

## 搜索表单

基础字段通常包括：

```text
keywords, sort, sort2, rule, secondLevel, currentpage, id, ckm_index
```

高级字段包括：

```text
reg_no, indication, case_no, drugs_name, drugs_type,
appliers, communities, researchers, agencies, state
```

检测到任一高级条件时，设置 `secondLevel=0`；只有关键词检索时通常使用 `secondLevel=1`。列表默认每页约 20 条，但不要依赖该数字计算总页数，必须解析页面的实际分页信息。

## 列表与分页解析

- 结果表格：`table.searchTable`
- 登记号链接：通常位于第二列，`id` 作为详情 ID，`name` 作为 `ckm_index`
- 分页信息：`div.pageInfo`
- 常见文本：`当前第 X 页，共 Y 页，共 Z 条记录`

优先用文本正则解析分页；若页面文案变化，再从其中的 `<i>` 元素按顺序读取当前页、总页数和总条数。

## 详情页解析

详情请求需要当前检索表单字段，且设置：

```text
id=<列表链接 id>
ckm_index=<列表链接 name>
currentpage=<来源页码>
```

详情页中可能存在多个 `div.paddingSide15`。选择包含 `<table>` 的容器作为正文。章节标题常见为：

- `div.searchDetailPartTit`：大节标题；
- `div.sDPTit2`：小节标题。

抽取表格时处理两列“键-值”及偶数列“键-值-键-值”结构。保留 `full_text`，并将可用字段按章节生成 `rag_chunks`。

## 下载表单

下载按钮常见结构：

```html
<form action="/clinicaltrials.searchlistdetail.dhtml?_export=doc" method="post">
  <input type="hidden" name="id" value="..." />
  <button type="submit" class="download">下载</button>
</form>
```

定位 `button.download`，取得其父 form，并只提交该 form 中可成功提交的控件：启用的 hidden/text/select/textarea，以及选中的 checkbox/radio。不要把搜索表单中的 `keywords`、`currentpage`、排序字段混入下载请求。

## Word 响应

平台可能返回 Word 2003 XML：

- MIME 类型可能为 `application/xml`、`text/xml`、`application/octet-stream` 或 Word 类型；
- 内容中常见 `<w:wordDocument` 或 `<?mso-application progid="Word.Document"?>`；
- 浏览器文件名可能使用 `.doc`，但文件不是二进制 DOC。

保存响应前检查内容：二进制 DOC 的 OLE 头为 `D0 CF 11 E0`；OOXML DOCX 以 ZIP `PK` 开头；WordML 应具有上述 XML 标志。若内容为 HTML/登录页，不要当作 Word 成功保存。

## 输出契约

```text
output/<关键词>/
├── raw/<登记号>_detail.html
├── json/<登记号>.json
├── word/<登记号>.doc
├── word/<登记号>.docx            # macOS 文本转换可用时
├── word/source/<登记号>.source.doc
├── state.json
└── summary.json
```

RAG JSON 推荐最少包含：`schema_version`、`source`、`reg_no`、`list_info`、`details`、`sections`、`full_text`、`rag_chunks`、`content_hash`。

## 会话 Cookie

站点可能下发名为 `FSSBBIl1UgzbN7N80S`、`FSSBBIl1UgzbN7N80T` 的 Cookie，也可能需要浏览器会话中的其他字段（例如 `token`）。自动入口页刷新仅能获得服务端返回的字段；对于完整有效会话，优先使用浏览器已验证请求的“复制为 cURL”内容提取 Cookie。
