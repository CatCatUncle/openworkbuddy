# 模型与 Key 管理：调研与改法（2026-09）

> 一句话：**「渠道 + 模型」两层分法是对的，不用推倒重来；真正的窟窿在 Key 的保管上。**
> 这轮查出四个，全部已经改完并配了测试：
> config.json 的文件权限、环境变量把 Key 发给别家、撞 401 两套说法、换 Key 不留痕。
>
> 下面每一条都是在本仓库里真跑出来的——文件权限是 `stat` 读的位，
> 「Key 发给了谁」是起一个本地监听器把 `Authorization` 头原样抓下来的。

---

## 一、今天是什么样

### 1.1 两层：渠道管凭证，模型管参数

一把 OpenRouter 的 Key 底下挂着几十个模型，一把火山方舟的 Key 底下挂着豆包全家。
老配置让每条模型自己抄一份地址和 Key，换 Key 时漏掉一条，那条就在下次对话时突然 401——
而界面上它跟别的条目长得一模一样，人根本不知道该改哪儿。

所以 `chat-models.js` 把「地址 + Key」抽到渠道那一层：

```jsonc
{
  "providers": [{ "id": "openrouter", "name": "OpenRouter", "kind": "openrouter",
                  "base_url": "https://openrouter.ai/api/v1", "api_key": "sk-or-..." }],
  "models":    [{ "name": "Sonnet", "channel": "openrouter", "model": "anthropic/claude-sonnet-5" }]
}
```

关键的一招是**压平**：每次规整都把渠道的地址和 Key 写回模型条目上。
所以下游那 **108 处**读 `m.base_url` / `m.api_key` 的代码一个字都不用改，老配置也照跑，
升级不需要用户做任何事。四路媒体模型（`media-models.js`）跟它共用同一张 `providers` 表。

三条红线写在 `chat-models.js` 开头：不删模型、协议归渠道管、同地址不同 Key 算两个渠道。

### 1.2 谁看得到 Key

| 身份 | 设置页上看到的 | 能改吗 |
|---|---|---|
| 个人桌面版（Electron + 只听回环） | **明文** | 能 |
| 平台管理员（默认组织的 admin） | `key_hint`：前三位…末四位 | 能 |
| 组织管理员 / 审计员 / 普通成员 | `********`，外加一个 `has_key` 布尔 | 不能（403「渠道归平台管理员配」） |

个人桌面版故意不脱敏，理由写在 `admin.js`：能连上回环地址的人本来就能直接打开 config.json。
留着脱敏在那儿只有一个效果——界面把 Key 显示成空，用户随手一存就把真 Key 抹了。

平台管理员那一档是 2026-09 改的：以前每打开一次设置页，九把明文 Key 就往浏览器里送一趟，
页面上任何一处 XSS 都能整包端走。现在只给前三位和末四位，「这把还能不能用」交给渠道卡上的「测一下」。

### 1.3 Key 一共能从哪儿来

1. `config.json` 的 `providers[].api_key`（设置页写的就是它）
2. `OPENWORKBUDDY_KEY_<渠道id>` 环境变量 —— **这轮新加的**
3. `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` —— 通用兜底，现在只发给这家自己的域名
4. 搜索那一路另有三个：`JINA_API_KEY` / `TAVILY_API_KEY` / `BRAVE_API_KEY`（`tools.js`）

---

## 二、查出来的四个窟窿

### 2.1 config.json 是 0644

```
$ ls -l config.json config.json.bak
-rw-r--r--  13k  config.json
-rw-r--r--  13k  config.json.bak
```

`store.writeJsonAtomic` 从来没给过 mode，落地就是 umask（022）给的 0644。
这是全机器上**唯一一份明文装着所有 API Key 的文件**，而同一台 VPS、同一台办公电脑上的
任何一个别的账号，一句 `cat` 就把九把 Key 全拿走了。

连坐的还有两处：`.bak` 跟正本一字不差；`data/backups/openworkbuddy-backup-*.tar.gz` 里装着
config.json + 账号表 + 积分账本 + 审计流水——下载接口是管理员专属的，可文件本身就躺在那儿，
等于绕开了上面所有的权限判断。

讽刺的是 `cli.js` 里那句注释：「权限收到 0600：跟 config.json 一个待遇」。
命令行历史确实是 0600，config.json 从来不是。

### 2.2 环境变量会把 Key 发给别家

老代码一句：

```js
const apiKey = cfg.api_key || process.env.OPENAI_API_KEY || "ollama";
```

`OPENAI_API_KEY` 是最常见的环境变量之一，几乎所有 AI 命令行工具都认它，很多人直接写死在
`~/.zshrc` 里。而初始 config.json 里预置着四条**空着 Key** 的渠道：通义、智谱、Kimi、Ollama。
两件事凑一起就是：

```
$ node keyleak.js          # 起本地监听器冒充 api.moonshot.cn
别家域名收到的 Authorization：Bearer sk-THIS-IS-MY-OPENAI-KEY
```

更绕的是这个组合还会骗人：渠道卡上的「测一下」走的是 `probeModel`，它自己拼头、**不读环境变量**，
所以验活会红；真跑一趟却因为环境变量而通了。用户看到的是「测着是坏的，用着是好的」，
没人会想到自己的 OpenAI Key 正在往别家发。

### 2.3 同一个 401，两套说法

| 撞 401 的地方 | 用户看到的 |
|---|---|
| 渠道卡「测一下」 | 这个 Key 上游不认（HTTP 401），检查有没有复制全、是不是这家服务商的 Key |
| 真跑一趟任务 | `LLM 接口错误 401: {"error":{"message":"Incorrect API key provided: sk-xxx. You can find your API key at https://platform.openai.com/...` |

`llm.js` 里 400（上下文超限）和 402（欠费）都翻成人话了，唯独最常见的 401 漏了，
直接掉进兜底那句 `LLM 接口错误 ${status}` 里。

### 2.4 换 Key 不进审计

`org.audit` 记着充值、修改成员、重置密码、删除成员、添加成员、自助注册——
唯独没有「谁换了那把全组织都在用的 Key」。

这恰恰是最值得留痕的一条：多管理员的组织里，任何一个管理员都能把渠道悄悄指到自己的账号、
或者指到一个会把对话原文全存下来的中转，事后翻遍后台一个字都查不到。
企业客户做合规的时候这是必问项。

---

## 三、改法（已落地）

### 3.1 装凭证的文件一律 0600

`store.js` 加了 `mode` 选项和一个 `tighten(file, mode)`：

```js
store.writeJsonAtomic(CONFIG_PATH, config, { pretty: true, mode: store.SECRET_MODE });
```

三个细节值得记一笔：

- **mode 要在 `writeFileSync` 里给，不能等写完再 chmod**——中间那一瞬文件是 0644，
  同机器上另一个用户 `cat` 得到的就是完整的一份。
- **写完还要再 chmod 一次**：`writeFileSync` 的 mode 还要过一道 umask，chmod 不受它管。
- **开机先收一次**（`server.js` 读 config 之前）：光改写入代码救不了**老机器**——
  装了半年的那台上 config.json 早就以 0644 躺在那儿了。收紧正本的同时收 `.bak`。

`makeBackup` 打完包也收一次。Windows 上 chmod 基本是空操作、容器挂载卷可能不让改，
所以 `tighten` 的失败一律吞掉——为一个装饰性的位把存盘整个失败掉，是拿丢配置换安全感。

**没有连坐**：流水账那类文件（会话、账本、定时任务）不传 mode，行为一个字节没变。
它们一天写几百次，收紧纯属添乱。

### 3.2 取 Key 分三级，越明确的越优先

`llm.js` 新增 `resolveKey(cfg, which)`：

| 优先级 | 来源 | 认哪些地址 |
|---|---|---|
| ① | 渠道自己填的 `api_key` | 全认 |
| ② | `OPENWORKBUDDY_KEY_<渠道id>` | 全认（用户点了名，不存在发错家） |
| ③ | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | **只发给这家自己的域名**，或地址留空（= 走官方） |

第 ② 级是顺手补上的一块：Docker / VPS 部署不用再把明文 Key 写进 config.json 了。
渠道 id 就是设置页那张卡上的 id，大写、非字母数字换成下划线：`openrouter-2` → `OPENWORKBUDDY_KEY_OPENROUTER_2`。

③ 被跳过时在控制台说一次为什么、该怎么办——不说的话，用户只会看到一句 401，然后以为是软件坏了：

```
[模型] 渠道「Kimi」没填 Key，环境变量 OPENAI_API_KEY 也没用上——它是 OpenAI 的 Key，
这条渠道打的是 api.moonshot.cn，发过去等于把 Key 交给了别家。
要给这条渠道配 Key：设置 → 模型 里填，或者设环境变量 OPENWORKBUDDY_KEY_KIMI。
```

本机地址（localhost / 127.0.0.1）不唠叨：绝大多数是 Ollama，它压根不要 Key。

### 3.3 401 跟「测一下」统一口径

`llm.js` 补了 401/403 分支，点名是哪条渠道、指明去哪儿改，原始报错留在后面方便贴给客服。

### 3.4 换 Key 进审计，只留掩码

`server.js` 的 `auditKeyChanges(req, before, after)`：存渠道时对比前后，
只记「哪条渠道、从哪把换成哪把」，两头都是 `keyHint`：

```
更换模型 Key    渠道    DeepSeek：abc…7788 → xyz…1234；Kimi：首次填入 sk-…9900
```

审计表管理员和审计员都看得到，写明文等于给 Key 开第二个出口。
审计写不进去也不能把「存设置」整个失败掉，所以整段包在 try 里。

---

## 四、怎么验

`test/e2e.js` 的 `testKeyGuard()`，四段全是**行为实测**，不看源码：

| 段 | 判什么 | 负向对照 |
|---|---|---|
| ① | 存完是 0600、`.bak` 同待遇、老机器开机就修好 | 不传 mode 的流水账文件**不该**被收紧（证明 mode 真在起作用） |
| ② | `OPENAI_API_KEY` 不发给别家域名 | 地址就是 OpenAI 官方时**必须**照认（不能因噎废食）；`OPENWORKBUDDY_KEY_<渠道>` 点名生效；渠道自己填的压得住环境变量；本机不唠叨 |
| ③ | 撞 401 说人话且点名渠道、给出下一步 | —— |
| ④ | 换 Key 进审计流水 | 流水里**不许**出现 Key 明文，且要能认出是哪一把 |

② 和 ③ 起的是真的 `http.createServer`，把 `Authorization` 头原样抓回来；
④ 起的是真的 `server.js`，注册管理员、存渠道、读 `/api/admin/audit`。

---

## 五、想过但没做的

**静态加密 config.json。** 听着对，其实是纸糊的：解密密钥必须跟密文放在同一台机器上，
不然服务起不来。真想防「磁盘被人拿走」，该用的是系统盘加密（FileVault / LUKS / BitLocker），
不是在应用层套一层自欺欺人。真要做，得接系统钥匙串（macOS Keychain / Windows DPAPI /
libsecret），那是另一个题目，而且 Docker 里没有钥匙串可接。

**把压平那一步去掉。** 108 处读扁平字段，为一个「更干净的数据模型」全改一遍，
收益是零、风险是每一处都可能漏。压平这招的全部意义就是让它们不用动。

**每个成员自带 Key。** 当前设计是**一台服务器一套 Key**，用量靠 `quota.js`（按次计费的外部 API）
和 `account.js`（模型 token 折算的积分）两本账分别记，闸门默认全关。
「成员自带 Key」是另一套模型，会同时动账本、闸门、归属三处，且跟「平台管理员统一管控」
这个前提冲突。真有需求的时候单开一轮，不顺手塞进这次。

---

## 六、给部署的人

VPS / Docker 上装，推荐这么配 Key：

```bash
# 不把明文 Key 写进 config.json——渠道 id 在 设置 → 模型 的卡片上能看到
export OPENWORKBUDDY_KEY_DEEPSEEK=sk-xxx
export OPENWORKBUDDY_KEY_OPENROUTER=sk-or-xxx
```

已经写进 config.json 的不用动，它优先级最高。检查一下权限：

```bash
ls -l ~/.openworkbuddy/config.json      # 应该是 -rw-------
```

不是的话，启动一次服务它会自己收紧；实在不行 `chmod 600` 一下。

---

[← 回 README](../README.md) · [配置模型](配置模型.md) · [开源与商业版边界](开源与商业版边界.md)
