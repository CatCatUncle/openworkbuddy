---
name: lark-cli
description: 用命令行操作飞书/Lark——发消息、建群、读写云文档与多维表格、日历日程、任务、审批、邮件、妙搭应用、白板、知识库。凡是"发到飞书/在飞书里建/查我的飞书"的任务都用它
---

# 飞书命令行（lark-cli）

飞书官方 CLI（[larksuite/cli](https://github.com/larksuite/cli)，MIT）。整个飞书开放平台都能从命令行调，
**不要自己写 HTTP 脚本去拼 token**——那样既容易错又拿不到用户身份。

一切都通过 `run_shell` 执行。

---

## 第 0 步：先确认能用（每次任务开头做一次，别跳）

```bash
lark-cli --version && lark-cli whoami
```

- `command not found` → 告诉用户装：`npx @larksuite/cli@latest install`，然后停下。**不要自己去装**（要写 PATH，得用户自己来）。
- `whoami` 里 `identity` 是 `bot` 还是 `user` 决定了你能干什么：
  - **bot**：只能做机器人能做的事（发消息到它在的群、读它收到的消息）。
  - **user**：以用户本人身份操作，能读他的日历、云文档、邮件、任务。
- 没登录 / token 过期 → 走下面「授权」那节，**不要静默失败**。

---

## 第 1 步：先读官方技能，再动手

lark-cli 自带每个领域的详细技能文档，**比你记忆里的命令可靠**。动手前先读：

```bash
lark-cli skills list                 # 看有哪些领域技能（JSON）
lark-cli skills read lark-doc        # 读某一个的正文
```

领域和技能名一一对应：`lark-im`(消息/群) `lark-doc`(云文档) `lark-base`(多维表格)
`lark-sheets`(电子表格) `lark-calendar`(日历) `lark-task`(任务) `lark-approval`(审批)
`lark-mail`(邮件) `lark-drive`(云盘) `lark-wiki`(知识库) `lark-whiteboard`(白板)
`lark-slides`(幻灯片) `lark-minutes`(妙记) `lark-okr` `lark-contact`(通讯录)
`lark-vc`(视频会议) `lark-apps`(妙搭应用/建站) `lark-markdown`(云盘原生 Markdown)

**做任何飞书任务的固定顺序：`skills list` 挑领域 → `skills read <名字>` 读正文 → 按里面写的干。**

---

## 第 2 步：命令怎么找

优先级从高到低：

```bash
lark-cli <domain> --help                      # 1. 看这个领域有什么，优先用带 + 的快捷命令
lark-cli calendar +agenda                     # 2. +shortcut：一条命令干完一件事，首选
lark-cli im chats list --page-size 20         # 3. 具体 API 方法
lark-cli schema im.chats.list                 # 4. 不确定参数就查 schema（参数/类型/所需权限/示例）
lark-cli api GET /open-apis/im/v1/chats       # 5. 兜底：没有对应命令时直接打 HTTP 路径
```

通用开关：

- `--jq '<表达式>'` 过滤输出。**返回可能很长，一律加 `--jq` 只取你要的字段**，别把整坨 JSON 灌进上下文。
- `--dry-run` 只打印将要发的请求，不执行。改动量大或没把握时先跑这个。
- `--as bot` / `--as user` 显式指定身份。
- 每条命令的 `--help` 会标 `read` / `write` / `high-risk-write` 三档风险。

---

## 授权：扫码登录

token 失效或没登录时：

```bash
lark-cli auth login --no-wait --json --domain im,docs,drive,calendar,task
```

返回 `verification_url` + `device_code`（10 分钟有效）。然后：

```bash
lark-cli auth qrcode "<verification_url>" --ascii
```

把二维码和链接**一起贴给用户**，让他用飞书 App 扫码，扫完回来告诉你。之后再：

```bash
lark-cli auth login --device-code "<device_code>" --json
```

`--domain` 按任务实际需要给，别一上来就 `all`——要的权限越多，用户越可能不敢点同意。

> 用户也可以在 **设置 → 助理设置 → 飞书** 里点「扫码授权」走同一套流程，不用你在对话里操作。

---

## 红线

1. **`high-risk-write` 必须先问用户**。这类命令要加 `--yes` 才执行——发消息给别人、删除、批量改动、发起审批都属于这一档。
   问清楚"发给谁、发什么内容"，得到明确同意再加 `--yes`。绝不主动替用户对外发消息。
2. **不编造 ID**。chat_id、doc_token、user_id 一律先用 list/search 命令查出来，不许猜、不许拿示例里的 ID 直接用。
3. 命令失败先看报错里的 scope 提示——多半是权限没开，让用户去开放平台补权限或重新扫码授权时多给一个 `--domain`。

## 踩过的坑

- **`--as bot` 列消息只认 `--chat-id`（`oc_` 开头），传 `--user-id`（`ou_` 开头）会被拒。** 机器人视角没有"某个人的会话"这个概念，只有它所在的会话。
- **白板更新内容要用 `lark-cli whiteboard update --input_format raw --source -`**（内容走标准输入），直接把 JSON 塞进参数会被截断。
- 输出里带 `Config file path:` 这类尾巴时，JSON 解析前先截掉。
- 表格/文档写入的内容含中文引号、换行时，用文件或标准输入传，别硬拼进命令行。
