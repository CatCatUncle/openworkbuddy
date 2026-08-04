---
name: feishu-doc
description: 创建/写入飞书云文档的完整 API 姿势（含插图）。要"发到飞书/建飞书文档"优先用 feishu_doc_create 工具；需要手写 API（插图片/表格/自定义凭证）或排查权限、块结构报错时加载本技能。
---

# 飞书云文档（docx）API 速查

## 首选：feishu_doc_create 工具

纯文字/标题/列表/代码/引用的 Markdown 文档，直接调 `feishu_doc_create` 工具即可，**不要自己找凭证写脚本**。凭证在设置 → IM 远程指挥（机器人凭证或独立的「云文档凭证」）里配置。以下内容用于工具覆盖不了的场景（插图、表格、高级块）。

## 凭证与 token

```
POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
{"app_id":"...","app_secret":"..."}   → data.tenant_access_token
```
应用必须开通 **docx:document**（建议再加 **drive:drive**）权限并**发布版本**，否则创建接口报权限错（99991672/99991679/1770032/230002）。

## 创建文档 + 写入内容

```
POST /docx/v1/documents  {"title":"..."}        → data.document.document_id
POST /docx/v1/documents/{doc_id}/blocks/{doc_id}/children  {"children":[...块...]}
```
- 根块 ID = document_id，直接往根块下加子块。
- **每批最多 50 块**，多了分批。
- 追加到末尾**不要传 index**（传 index:-1 会报 99992402 field validation failed）。

## 块结构（最容易踩的坑）

每块必须带 `block_type` + **同名小写字段**：

| 块 | block_type | 字段名 |
|---|---|---|
| 正文 | 2 | `text`（**不是 paragraph！**） |
| 标题1/2/3 | 3/4/5 | `heading1/2/3` |
| 无序列表 | 12 | `bullet` |
| 有序列表 | 13 | `ordered` |
| 代码块 | 14 | `code` |
| 引用 | 15 | `quote` |
| 待办 | 17 | `todo` |
| 图片 | 27 | `image` |

内容结构统一是 `{"elements":[{"text_run":{"content":"文字"}}]}`（code 块可加 `"style":{}`）。

常见错误码：
- **99992402** field validation failed → 块缺 block_type / 字段名写错（paragraph→text）/ index 非法
- **1770001** invalid param → block_type 数值与内容字段名不匹配

## 插入图片（三步走，顺序不能反）

1. **先创建空 image 块**：`POST .../blocks/{doc_id}/children` `{"children":[{"block_type":27,"image":{}}]}` → 返回该 image 块的 `block_id`
2. **再上传素材**（multipart/form-data）：
   ```
   POST /drive/v1/medias/upload_all
   file_name=xxx.png, parent_type=docx_image, parent_node=<第1步的 block_id>, size=<字节数>, file=<二进制>
   ```
   → data.file_token。直接上传不带 parent_node 会报 **parent node not exist**；`/im/v1/images` 的 image_key 不能用于 docx。
3. **回填 token**：`PATCH /docx/v1/documents/{doc_id}/blocks/{block_id}` `{"replace_image":{"token":"<file_token>"}}`

**格式**：飞书不认 SVG，只收 PNG/JPG。本机把 SVG/HTML 转 PNG **别手写 PNG 编码器**，直接用 Chrome 无头截图：
```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --screenshot=out.png --window-size=1200,800 --hide-scrollbars file:///绝对路径/chart.html
```
（图表先写成一页自包含 HTML/SVG，再截图；中文字体由浏览器渲染，无乱码问题。）

## 读回 / 清理 / 分享

- 列文档内容：`GET /docx/v1/documents/{doc_id}/blocks/{block_id}/children`（**必须用 children 接口**，`GET /blocks` 列不出来）
- 批量删块：`DELETE /docx/v1/documents/{doc_id}/blocks/{parent_block_id}/children/batch_delete` `{"start_index":0,"end_index":2}`（按子块序号左闭右开）
- 开链接分享：`PATCH /drive/v1/permissions/{doc_id}/public?type=docx` `{"link_share_entity":"tenant_readable"}`（需 drive:drive 权限）
- 文档链接：`https://feishu.cn/docx/{doc_id}`
