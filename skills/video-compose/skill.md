---
name: video-compose
description: 图文成片——脚本→分镜卡片图→TTS配音→ffmpeg 拼装成带字幕的竖版/横版视频（口播、知识分享、带货讲解）
---

# 图文成片技能（脚本 → 视频）

## 适用场景
「把这篇文章做成视频」「做一条口播/知识分享视频」。产出 = 一条 mp4（分镜卡片轮播 + 配音 + 字幕）+ 发布文案。走的是「图文成片」路线（信息密度高、成本为零、可控性强），不是 AI 生成实拍画面——需要实拍感画面时才用 generate_video 生成个别镜头素材。

## 前置检查（先做，缺了就早说）
1. `run_shell` 执行 `ffmpeg -version`：没装就直接告诉用户 `brew install ffmpeg`（mac）/ `winget install ffmpeg`（win），并先把分镜图做完，配音和拼装留到装好后再跑（按句配音要靠 ffmpeg 量每句时长，没装它会直接报错、不花钱）。
2. 语音合成（text_to_speech）没配渠道时：照常出片但改为「无声+大字幕」样式，并明说配音跳过的原因。
3. **分镜超过 6 段就先让用户把额度调上去**：一段要走出图、拼片两步（配音一次调用整批出），6 段也有十几步，而单独用本技能时默认上限是 25 步 / 30 分钟（走 promo-video 配方时，开头表单一交上限就按配方放宽了，跳过这一条）。撞上限断在最后一步 concat 之前是最亏的一种断法——图和配音的钱都花了，片子一秒都没有。开工前先说一句：去「设置 → 智能体 → 执行上限」，把「最大执行步数」调到 60、「任务最大运行时间」调到 60 分钟；不想守着的话把「自动续跑轮数」设成 1~2，撞上限会自己接着做完（每一轮都真计费）。

## 流程
1. **脚本**：把内容改写成口播稿，切成 6~12 个分镜段落，每段 1~3 句话（一段 = 一个画面）。开头 3 秒必须是钩子。
2. **分镜卡**：每段一张卡片图，方法同 xhs-cards 技能（HTML → html_to_image）。竖版 1080x1920（`body{width:1080px;height:1920px}`），横版 1920x1080。每张卡放该段的核心句（大字）+ 关键词/数据，不要整段照抄。
   - **动画路线**（要动效、工具里有 render_motion 时）：每段写成一个 HTML，元素用 `data-start`/`data-duration` 控制出场；先做完第 3、4 步拿到每段秒数，再一次 `render_motion` 传 `html_files`（按分镜顺序）+ `durations`，直接出一条无声 mp4，不花钱。交付前用 look_at_image 看它落的封面 PNG。有 compose_video 时可以省掉这一步：每段 HTML 直接写进时间轴 `{"visual":{"file":"s1.html","kind":"html"}}`，它按配音长度逐段渲。手工拼时第 5 步的 shots.txt 换成这条 mp4 当画面轨：`ffmpeg -y -i 动画.mp4 -i 旁白.wav -c:v copy -c:a aac -shortest final.mp4`。
3. **配音**：一次 `text_to_speech`，传 `segments`（每个分镜一项，按顺序）和 `filename: "旁白.wav"`。逐句合成、按解码后的采样量好每句时长，一次出整轨 `旁白.wav`、句级字幕 `旁白.srt`、时长清单 `旁白.json`。改了哪句就原样再调一次，只有那一句重新花钱。
4. **定时长**：读 `旁白.json`：第 N 个分镜时长 = `segments[N-1].slot_ms`/1000 秒（这一句 + 句后停顿）。不要再逐段跑 ffprobe——mp3 容器时长每段差几十毫秒，累加下来字幕对不上嘴。
5. **拼装**（工具里有 compose_video 时走它，本机 ffmpeg，不花钱）：写 `timeline.json` 放在分镜旁边，先传 `dry_run: true` 看会出几条、多长、有什么警告，没问题再正式跑。最小写法：
   `{"title":"片名","aspects":["9:16","16:9"],"segments":[{"visual":"shot_01.png","voice":{"sentences":[{"text":"这一句","file":"旁白.json 里对应那项的 file"}]}}]}`
   - 第 N 个分镜的 `voice.sentences` 照抄 `旁白.json` 里 `segments[N-1]` 的 text / file。每段画面时长跟着配音走，不用自己填秒数；没配音的段写 `"text"` 和 `"min_seconds"`。
   - 可选：`brand` 填 brand_kit 建的品牌包名（logo、字体、颜色、片尾号召）；`intro` / `outro` 加片头片尾卡；`music` 垫配乐，说话时自动压低；某段写 `"cover": true` 指定从那段截封面。
   - 等得到就直接交成片；等不到会先给任务号，过一会儿传 `{"job":"任务号"}` 再查，要停传 `{"job":"任务号","cancel":true}`，不会留半截文件。
   - 工具列表里没有 compose_video 时，退回 run_shell 手工拼：
     - 写画面清单 `shots.txt`，每个分镜两行，秒数照上一步：`file 'shot_01.png'` 换行 `duration 2.61`，依次往下写；**最后一张再单独补一行 `file 'shot_NN.png'`**——concat 不认最后一条的 duration，不补的话最后一镜只闪一帧，`-shortest` 还会把结尾那句旁白一起剪掉。
     - 成片：`ffmpeg -y -f concat -safe 0 -i shots.txt -i 旁白.wav -vf "fps=30,format=yuv420p" -c:v libx264 -tune stillimage -c:a aac -shortest final.mp4`。画面按累计时间切、整轨一次配上，十几镜拼完声画也不漂。别每镜各配一截音频再 concat：每截 AAC 开头都有几十毫秒补齐，越往后声音越晚。
     - 无配音模式：duration 写你定的每段秒数，去掉 `-i 旁白.wav` 和 `-c:a aac -shortest`。
6. **字幕**（可选加分项）：compose_video 自带，按句切好；本机 ffmpeg 带 libass 就烧进画面，没有就只附 .srt，结果里会照实说。不要字幕写 `"subtitles": false`（分镜卡本身已带大字时可省）。手工路线直接用第 3 步出的 `旁白.srt`，时间轴就是整轨的：要烧进画面就在成片那条的 `-vf` 里接上 `,subtitles=旁白.srt:force_style='FontSize=18,Alignment=2,MarginV=40'`；先 `ffmpeg -hide_banner -filters` 看有没有 subtitles 这个滤镜，没有（没带 libass）就别烧，把 `旁白.srt` 跟成片一起交付。
7. **交付**：成片（compose_video 每个画幅一条，手工路线是 final.mp4）+ 封面图（compose_video 会截好；手工路线用第一张分镜卡）+ 发布文案（标题/简介/标签）。

## 硬约束
- 所有中间产物（HTML/PNG/旁白整轨和分句/timeline.json/shots.txt）留在工作空间，别删——用户可能要改某一段重拼。
- ffmpeg 命令一次只做一件事，失败要把 stderr 关键行读出来说人话，不要吞。
- 时长控制：总片长 ≤ 60 秒最稳（短视频平台完播率）；口播稿超了就砍分镜，不要加语速。
