---
name: video-compose
description: 图文成片——脚本→分镜卡片图→TTS配音→ffmpeg 拼装成带字幕的竖版/横版视频（口播、知识分享、带货讲解）
---

# 图文成片技能（脚本 → 视频）

## 适用场景
「把这篇文章做成视频」「做一条口播/知识分享视频」。产出 = 一条 mp4（分镜卡片轮播 + 配音 + 字幕）+ 发布文案。走的是「图文成片」路线（信息密度高、成本为零、可控性强），不是 AI 生成实拍画面——需要实拍感画面时才用 generate_video 生成个别镜头素材。

## 前置检查（先做，缺了就早说）
1. `run_shell` 执行 `ffmpeg -version`：没装就直接告诉用户 `brew install ffmpeg`（mac）/ `winget install ffmpeg`（win），并先把分镜图和配音做完，视频拼装留到装好后再跑。
2. 语音合成（text_to_speech）没配渠道时：照常出片但改为「无声+大字幕」样式，并明说配音跳过的原因。

## 流程
1. **脚本**：把内容改写成口播稿，切成 6~12 个分镜段落，每段 1~3 句话（一段 = 一个画面）。开头 3 秒必须是钩子。
2. **分镜卡**：每段一张卡片图，方法同 xhs-cards 技能（HTML → html_to_image）。竖版 1080x1920（`body{width:1080px;height:1920px}`），横版 1920x1080。每张卡放该段的核心句（大字）+ 关键词/数据，不要整段照抄。
3. **配音**：每段一次 `text_to_speech`（filename=voice_01.mp3…）。分段合成而不是整篇一次——这样每个分镜的时长能对上自己的音频。
4. **量时长**：`ffprobe -v error -show_entries format=duration -of csv=p=0 voice_01.mp3` 逐段取时长。
5. **拼装**（run_shell，一段一个中间片，最后 concat）：
   - 单段：`ffmpeg -y -loop 1 -i shot_01.png -i voice_01.mp3 -c:v libx264 -tune stillimage -c:a aac -pix_fmt yuv420p -shortest seg_01.mp4`
   - 合并：写 `list.txt`（`file 'seg_01.mp4'` 每行一个）后 `ffmpeg -y -f concat -safe 0 -i list.txt -c copy final.mp4`
   - 无配音模式：`-t <每段秒数>` 替代 `-shortest`，去掉音频输入。
6. **字幕**（可选加分项）：生成 `subs.srt`（用第 4 步的时长累加算时间轴），合并时加 `-vf "subtitles=subs.srt:force_style='FontSize=18,Alignment=2,MarginV=40'"`（此时合并不能用 `-c copy`，改为重编码）。分镜卡本身已带大字时字幕可省。
7. **交付**：final.mp4 + 封面图（第一张分镜卡）+ 发布文案（标题/简介/标签）。

## 硬约束
- 所有中间产物（HTML/PNG/mp3/seg mp4）留在工作空间，别删——用户可能要改某一段重拼。
- ffmpeg 命令一次只做一件事，失败要把 stderr 关键行读出来说人话，不要吞。
- 时长控制：总片长 ≤ 60 秒最稳（短视频平台完播率）；口播稿超了就砍分镜，不要加语速。
