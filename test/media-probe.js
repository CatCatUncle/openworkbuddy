"use strict";
/**
 * 音频量时长 + 句子拼接 —— lib/media-probe.js
 *
 * 按句配音的字幕要跟声音对齐到 150ms 以内。读 mp3 容器里写的时长，每段差 25–50ms，
 * 累加到第 4–6 句就超线了；所以时长一律按 PCM 采样数算，整条音轨也按采样拼。
 * 这里钉住的是：
 *   ① WAV 头按块走，不假设 data 在第 44 字节（ffmpeg 写的 WAV 中间夹着 LIST 块）；
 *   ② 句间留白按采样落位，最后一句后面不留；
 *   ③ 拼接时每个采样落在哪一格都算得出来，静音就是静音，声音一个采样都不少；
 *   ④ 格式不对就当场拒绝，不偷偷转；失败或被叫停不留半截文件、不盖掉旧文件；
 *   ⑤ ffmpeg / ffprobe 的报错带上它自己最后说的话，跑不起来和读不懂分开处理；
 *   ⑥ 视频朝向：转 90° 的竖拍按转过之后的宽高报。
 * 纯计算的部分用手搓的 WAV 测，CI 上也跑；真 ffmpeg 那段看 resolveMediaBins 找没找到，
 * 没有就明说跳过——OWB_REQUIRE_FFMPEG=1 时没有算红。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { spawnSync } = require("child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-media-probe-"));
process.env.OPENWORKBUDDY_HOME = path.join(TMP, "home");
const MP = require("../lib/media-probe");

let pass = 0, fail = 0;
const ok = (v, m, extra) => { if (v) pass++; else { fail++; console.error("  ❌", m, extra === undefined ? "" : "\n     " + extra); } };
const eq = (a, b, m) => { try { assert.deepStrictEqual(a, b, m); pass++; } catch { fail++; console.error("  ❌", m, "\n     实际:", JSON.stringify(a), "期望:", JSON.stringify(b)); } };
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

/** 16 位样本：全是非零值，拼出来哪里是静音一眼就能认出来 */
function pcm16(n, seed = 1) {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(1000 + ((i * 7 + seed * 13) % 500), i * 2);
  return b;
}
/** 一个 RIFF 块：奇数长度后面补一个字节 */
function chunk(id, body, size) {
  const h = Buffer.alloc(8); h.write(id, 0, "ascii"); h.writeUInt32LE(size === undefined ? body.length : size, 4);
  return Buffer.concat([h, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
/** 手搓 WAV：可以塞 LIST 块、写成 EXTENSIBLE、把 data 长度写成流式的 0xFFFFFFFF */
function makeWav({ rate = 24000, channels = 1, bits = 16, data, list = false, extensible = false, subTag = 1, dataSize } = {}) {
  const ba = channels * bits / 8;
  const fmtBody = Buffer.alloc(extensible ? 40 : 16);
  fmtBody.writeUInt16LE(extensible ? 0xfffe : 1, 0); fmtBody.writeUInt16LE(channels, 2); fmtBody.writeUInt32LE(rate, 4);
  fmtBody.writeUInt32LE(rate * ba, 8); fmtBody.writeUInt16LE(ba, 12); fmtBody.writeUInt16LE(bits, 14);
  if (extensible) { fmtBody.writeUInt16LE(22, 16); fmtBody.writeUInt16LE(bits, 18); fmtBody.writeUInt16LE(subTag, 24); }
  const parts = [chunk("fmt ", fmtBody)];
  if (list) parts.push(chunk("LIST", Buffer.from("INFOISFT\x05\x00\x00\x00Lavf\x00", "binary")));
  parts.push(chunk("data", data, dataSize));
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), ...parts]);
  const riff = Buffer.alloc(8); riff.write("RIFF", 0, "ascii"); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
const put = (name, buf) => { const p = path.join(TMP, name); fs.writeFileSync(p, buf); return p; };

(async () => {
  console.log("【1】WAV 头：按块走，不假设 data 在第 44 字节");
  {
    const w = MP.parseWav(makeWav({ data: pcm16(1000) }));
    ok(w && w.pcm && w.sampleRate === 24000 && w.channels === 1 && w.bitsPerSample === 16, "最朴素的 PCM WAV 要认得", JSON.stringify(w));
    eq(w && [w.dataOffset, w.samples, w.ms], [44, 1000, 42], "采样数按 data 块字节 / 块对齐算，毫秒由采样数换算");
    const l = MP.parseWav(makeWav({ data: pcm16(1000), list: true }));
    ok(l && l.dataOffset > 44 && l.samples === 1000, "中间夹 LIST 块（ffmpeg 写的就是这样）：data 位置往后挪，采样数不变", JSON.stringify(l));
    const lb = makeWav({ data: pcm16(1000), list: true });
    ok(l && lb.readInt16LE(l.dataOffset) === pcm16(1000).readInt16LE(0), "dataOffset 指的正是第一个采样（奇数长度的 LIST 块后面有一个补齐字节）");
    const x = MP.parseWav(makeWav({ data: pcm16(300), extensible: true }));
    ok(x && x.pcm && x.formatTag === 1 && x.samples === 300, "WAVE_FORMAT_EXTENSIBLE 里包的 PCM 也要认成 PCM", JSON.stringify(x));
    const f = MP.parseWav(makeWav({ data: Buffer.alloc(400), bits: 32, extensible: true, subTag: 3 }));
    ok(f && !f.pcm && f.formatTag === 3, "EXTENSIBLE 里包的是浮点就不是 PCM（反向对照）", JSON.stringify(f));
    const s = makeWav({ data: pcm16(800), dataSize: 0xffffffff });
    eq(MP.parseWav(s, s.length)?.samples, 800, "流式写出的 WAV 头里 data 长度是 0xFFFFFFFF：以文件实际大小为准");
    const cut = makeWav({ data: pcm16(800), dataSize: 1600 * 10 });
    eq(MP.parseWav(cut, cut.length)?.samples, 800, "头里写的比文件实际还长（写到一半断了）：只算真有的那些");
    const st = MP.parseWav(makeWav({ channels: 2, data: Buffer.concat([pcm16(200), Buffer.alloc(3)]) }));
    eq(st && [st.blockAlign, st.samples], [4, 100], "立体声按 4 字节一格数，多出来的零头不算半个采样");
    eq(MP.parseWav(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00 mp3 data here", "binary")), null, "mp3 不是 WAV，返回 null，不猜");
    eq(MP.parseWav(Buffer.from("RIFF\x10\x00\x00\x00AVI LIST", "binary")), null, "RIFF 但不是 WAVE（AVI）也返回 null");
    eq(MP.parseWav(Buffer.from("RIFF")), null, "短得连头都不全，返回 null");
    const noFmt = Buffer.concat([Buffer.from("RIFF\x00\x00\x00\x00WAVE", "binary"), chunk("data", pcm16(10))]);
    eq(MP.parseWav(noFmt), null, "data 在 fmt 前面、不知道采样率，就不给时长");
    const rt = MP.parseWav(Buffer.concat([MP.wavHeader({ rate: 24000, dataBytes: 48000 }), Buffer.alloc(48000)]));
    eq(rt && [rt.pcm, rt.sampleRate, rt.samples, rt.ms, rt.dataOffset], [true, 24000, 24000, 1000, 44], "wavHeader 写出来的头自己要能读回来");
    const onDisk = put("disk.wav", makeWav({ data: pcm16(480), list: true }));
    eq(MP.readWavInfo(onDisk)?.samples, 480, "readWavInfo 从盘上读");
    eq(MP.readWavInfo(path.join(TMP, "没有这个文件.wav")), null, "文件不存在返回 null，不抛");
  }

  console.log("【2】句间留白按采样落位");
  {
    eq(MP.gapLayout([100, 50, 30], 10), { starts: [0, 110, 170], ends: [100, 160, 200], total: 200 }, "最后一句后面不留白：总长 = 各句之和 + (句数 − 1) × 留白");
    eq(MP.gapLayout([5], 100), { starts: [0], ends: [5], total: 5 }, "只有一句就没有留白");
    eq(MP.gapLayout([], 100), { starts: [], ends: [], total: 0 }, "没有句子总长就是 0");
    eq([MP.msToSamples(1234, 24000), MP.samplesToMs(29616, 24000), MP.msToSamples(300, 44100), MP.samplesToMs(1, 24000)], [29616, 1234, 13230, 0], "毫秒和采样互换");
    // 六句各 1.23456 秒：各自取整到毫秒再累加，会和按采样算出的起点差出好几毫秒；这里要的是后者
    const lens = Array(6).fill(29629);
    const lay = MP.gapLayout(lens, MP.msToSamples(300, 24000));
    eq(MP.samplesToMs(lay.starts[5], 24000), Math.round((5 * 29629 + 5 * 7200) * 1000 / 24000), "第 6 句的起点由采样数一次换算，不是把每句的毫秒数累加");
  }

  console.log("【3】命令行是一个个参数，不是拼出来的一串");
  {
    const weird = path.join(TMP, "带 空格 和 '引号'.mp3");
    const p = MP.probeArgs(weird);
    ok(p[p.length - 1] === weird && p.includes("a:0") && p.includes("json"), "ffprobe：只看第一条音轨、JSON 输出、文件名原样是最后一个参数", p.join(" | "));
    ok(/duration_ts/.test(p.join(" ")) && /time_base/.test(p.join(" ")), "duration_ts 和 time_base 要一起要：不知道单位就换算不成采样数", p.join(" "));
    const c = MP.pcmArgs("in.mp3", "out.wav.part", 24000);
    const at = (flag) => c[c.indexOf(flag) + 1];
    eq([at("-i"), at("-ac"), at("-ar"), at("-c:a"), at("-f"), c[c.length - 1]], ["in.mp3", "1", "24000", "pcm_s16le", "wav", "out.wav.part"], "解码：单声道、指定采样率、16 位 PCM；写 .part 时要显式 -f wav");
    ok(c.includes("-nostdin") && c.includes("-vn") && c.includes("-y"), "不读标准输入（否则在后台会卡住）、丢掉封面图、覆盖 .part");
    const m = MP.mp3Args("full.wav", "out.mp3.part");
    eq([m[m.indexOf("-c:a") + 1], m[m.indexOf("-q:a") + 1], m[m.indexOf("-f") + 1], m[m.length - 1]], ["libmp3lame", "2", "mp3", "out.mp3.part"], "编 mp3：libmp3lame、-q:a 2");
    // 末尾一个半角叹号：300 字节往回数正好落在一个汉字的中间（全是三字节汉字的话 300 能被 3 整除，切口碰巧对齐，测不出来）
    const t = MP.tailBytes("开头".repeat(200) + "最后这句要留下!", 300);
    ok(Buffer.byteLength(t) <= 300 && !t.includes("�") && t.endsWith("最后这句要留下!"), "报错只留最后 300 字节，切在字符边界上不出乱码", t.slice(0, 20));
  }

  console.log("【4】拼接：静音就是静音，声音一个采样都不少");
  {
    const a = put("a.wav", makeWav({ data: pcm16(1000, 1) }));
    const b = put("b.wav", makeWav({ data: pcm16(500, 2), list: true }));
    const c = put("c.wav", makeWav({ data: pcm16(250, 3), extensible: true }));
    const out = path.join(TMP, "full.wav");
    const r = await MP.concatWithGaps("", [a, b, c], { gapSamples: 240, rate: 24000, outAbs: out });
    eq([r.samples, r.starts, r.ends, r.ms], [2230, [0, 1240, 1980], [1000, 1740, 2230], 93], "返回的总长和每句起止都按采样算（写 .wav 不需要 ffmpeg）");
    const w = MP.readWavInfo(out);
    eq(w && [w.pcm, w.sampleRate, w.channels, w.samples], [true, 24000, 1, 2230], "写出来的文件头和返回值对得上");
    const data = fs.readFileSync(out).subarray(w.dataOffset);
    const seg = (s, e) => data.subarray(s * 2, e * 2);
    ok(seg(0, 1000).equals(pcm16(1000, 1)) && seg(1240, 1740).equals(pcm16(500, 2)) && seg(1980, 2230).equals(pcm16(250, 3)), "三段声音原样落在算好的位置上（带 LIST 块、EXTENSIBLE 的也一样）");
    ok(seg(1000, 1240).every((x) => x === 0) && seg(1740, 1980).every((x) => x === 0), "两段留白全是 0");
    ok(!fs.existsSync(out + ".part"), "写完 .part 改名，不留临时文件");

    const zero = await MP.concatWithGaps("", [a, b], { gapSamples: 0, rate: 24000, outAbs: path.join(TMP, "nogap.wav") });
    eq(zero.samples, 1500, "留白 0 就是首尾直接相接");

    // 失败路径：旧文件不能被盖掉、不能留半截
    const keep = path.join(TMP, "keep.wav");
    fs.writeFileSync(keep, "旧的那份");
    const d16 = put("d16k.wav", makeWav({ rate: 16000, data: pcm16(100) }));
    const e1 = await errOf(MP.concatWithGaps("", [a, d16], { gapSamples: 240, rate: 24000, outAbs: keep }));
    ok(e1 && /d16k\.wav/.test(e1.message) && /16000Hz/.test(e1.message) && /toPcmWav/.test(e1.message), "采样率不一样直接拒绝，点名是哪个文件、说清先 toPcmWav", e1 && e1.message);
    eq(fs.readFileSync(keep, "utf8"), "旧的那份", "拒绝时旧文件原封不动");
    const st = put("stereo.wav", makeWav({ channels: 2, data: pcm16(200) }));
    ok(/2 声道/.test((await errOf(MP.concatWithGaps("", [st], { gapSamples: 0, rate: 24000, outAbs: keep })))?.message || ""), "立体声也拒绝，不偷偷混成单声道");
    const txt = put("note.txt", "不是音频");
    ok(/不是能读的 WAV/.test((await errOf(MP.concatWithGaps("", [a, txt], { gapSamples: 0, rate: 24000, outAbs: keep })))?.message || ""), "混进来一个不是 WAV 的也要说清楚");
    ok(/\.wav 或 \.mp3/.test((await errOf(MP.concatWithGaps("", [a], { gapSamples: 0, rate: 24000, outAbs: path.join(TMP, "x.ogg") })))?.message || ""), "只写 .wav 和 .mp3");
    for (const g of [-1, 1.5, "abc"]) ok(/留白不对/.test((await errOf(MP.concatWithGaps("", [a], { gapSamples: g, rate: 24000, outAbs: keep })))?.message || ""), `留白要是非负整数个采样：${g}`);
    ok(/采样率不对/.test((await errOf(MP.concatWithGaps("", [a], { gapSamples: 0, rate: 0, outAbs: keep })))?.message || ""), "采样率 0 当场拒绝");
    ok(/没有要拼的/.test((await errOf(MP.concatWithGaps("", [], { gapSamples: 0, rate: 24000, outAbs: keep })))?.message || ""), "空列表当场拒绝");
    const ac = new AbortController(); ac.abort();
    const stopped = path.join(TMP, "stopped.wav");
    const e2 = await errOf(MP.concatWithGaps("", [a, b], { gapSamples: 240, rate: 24000, outAbs: stopped, signal: ac.signal }));
    ok(e2 && e2.name === "AbortError", "用户点了停止：抛 AbortError，上层据此不当成出错", e2 && e2.name);
    ok(!fs.existsSync(stopped) && !fs.existsSync(stopped + ".part"), "停下来不留半截文件");
    // 停止在拼到一半时才到（第一句写完、第二句之前）：要停在那里，而且旧的整条音轨不能被这半截顶掉
    let reads = 0;
    const midway = /** @type {AbortSignal} */ (/** @type {any} */ ({ get aborted() { return ++reads === 2; } }));
    const e3 = await errOf(MP.concatWithGaps("", [a, b, c], { gapSamples: 240, rate: 24000, outAbs: keep, signal: midway }));
    ok(e3 && e3.name === "AbortError", "拼到两句之间收到停止：就停在那儿，不拼完", e3 ? e3.name : "没停，拼完了");
    ok(!fs.existsSync(keep + ".part"), "停下来的半截 .part 要删掉");
    eq(fs.readFileSync(keep, "utf8"), "旧的那份", "上面这一串失败、停止之后，旧文件还是原样（新的先写 .part，成功才改名）");
  }

  console.log("【5】跑二进制：跑不起来、出错、超时、被叫停，四种要分开");
  {
    const e1 = await errOf(MP.runBin(path.join(TMP, "没有这个程序"), ["-version"], { timeout: 2000, what: "ffmpeg" }));
    ok(e1 && e1.code === "ENOENT" && /跑不起来/.test(e1.message), "程序不存在：带 ENOENT，话说清楚", e1 && e1.message);
    const e0 = await errOf(MP.runBin("", ["-version"], { timeout: 2000, what: "ffprobe" }));
    ok(e0 && e0.code === "ENOENT" && /ffprobe/.test(e0.message), "路径是空的（没找到）也按「跑不起来」处理", e0 && e0.message);
    const noisy = `process.stderr.write("x".repeat(2000) + "\\nInvalid data found when processing input：最后一句"); process.exit(3)`;
    const e2 = await errOf(MP.runBin(process.execPath, ["-e", noisy], { timeout: 5000, what: "ffmpeg" }));
    ok(e2 && /退出码 3/.test(e2.message) && /最后一句$/.test(e2.message) && e2.message.length < 360, "出错：带退出码和 stderr 的最后 300 字节，不是整屏倒出来", e2 && e2.message.slice(-80));
    const t0 = Date.now();
    const e3 = await errOf(MP.runBin(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeout: 300, what: "ffmpeg" }));
    ok(e3 && e3.timedOut === true && /已经停掉/.test(e3.message) && Date.now() - t0 < 5000, "超时：到点杀掉并说清楚", e3 && e3.message);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const t1 = Date.now();
    const e4 = await errOf(MP.runBin(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeout: 20000, signal: ac.signal, what: "ffmpeg" }));
    ok(e4 && e4.name === "AbortError" && Date.now() - t1 < 5000, "点了停止：子进程马上被杀，抛 AbortError", e4 && `${e4.name} ${e4.message}`);
  }

  console.log("【6】probeAudio 怎么读 ffprobe 的话（用一个假 ffprobe）");
  if (process.platform === "win32") {
    console.log("    （Windows 上脚本当不了可执行文件，跳过）");
  } else {
    // 假 ffprobe：把环境变量里给的 JSON 原样吐出来，或者按给的退出码退出
    const fake = put("fake-ffprobe", "#!/usr/bin/env node\nif(process.env.FAKE_PROBE_EXIT){process.stderr.write('Invalid data found when processing input');process.exit(Number(process.env.FAKE_PROBE_EXIT));}\nprocess.stdout.write(process.env.FAKE_PROBE_OUT||'{}');\n");
    fs.chmodSync(fake, 0o755);
    const say = (obj) => { delete process.env.FAKE_PROBE_EXIT; process.env.FAKE_PROBE_OUT = JSON.stringify(obj); };
    say({ streams: [{ codec_name: "mp3", sample_rate: "24000", channels: 1, time_base: "1/14112000", duration_ts: 17418240, duration: "1.234286" }], format: { duration: "1.234286" } });
    const mp3 = await MP.probeAudio(fake, path.join(TMP, "x.mp3"));
    eq(mp3, { samples: 29623, sampleRate: 24000, ms: 1234, codec: "mp3", channels: 1, exact: false }, "mp3：duration_ts 按 time_base 换成采样；有补齐的格式 exact 一律是 false");
    const wavFile = put("probe.wav", makeWav({ data: pcm16(1000), list: true }));
    say({ streams: [{ codec_name: "pcm_s16le", sample_rate: "24000", channels: 1, time_base: "1/24000", duration_ts: 999 }] });
    eq((await MP.probeAudio(fake, wavFile))?.samples, 1000, "PCM 的 WAV 以文件头为准（ffprobe 说 999 也不听）");
    eq((await MP.probeAudio(fake, wavFile))?.exact, true, "PCM 从文件头数出来的是精确值");
    say({ streams: [{ codec_name: "aac", sample_rate: "44100", channels: 2 }], format: { duration: "2.000000" } });
    eq((await MP.probeAudio(fake, path.join(TMP, "x.m4a"))), { samples: 88200, sampleRate: 44100, ms: 2000, codec: "aac", channels: 2, exact: false }, "只有 duration 的时候按它换算，并标明不精确");
    say({ streams: [], format: { duration: "3.0" } });
    eq(await MP.probeAudio(fake, path.join(TMP, "x.mp4")), null, "没有音轨返回 null，不拿整个文件的时长顶替");
    say({ streams: [{ codec_name: "mp3", channels: 1 }] });
    eq(await MP.probeAudio(fake, path.join(TMP, "x.mp3")), null, "不知道采样率就不给时长");
    process.env.FAKE_PROBE_OUT = "这不是 JSON";
    eq(await MP.probeAudio(fake, path.join(TMP, "x.mp3")), null, "ffprobe 吐的不是 JSON 也返回 null");
    process.env.FAKE_PROBE_EXIT = "1";
    eq(await MP.probeAudio(fake, path.join(TMP, "坏的.mp3")), null, "ffprobe 跑了但读不懂这个文件：返回 null，不编一个时长");
    delete process.env.FAKE_PROBE_EXIT; delete process.env.FAKE_PROBE_OUT;
    const gone = await errOf(MP.probeAudio(path.join(TMP, "没有这个 ffprobe"), wavFile));
    ok(gone && gone.code === "ENOENT", "ffprobe 本身跑不起来要抛出来，不能当成「这个文件读不懂」混过去", gone && gone.message);
    const ac = new AbortController(); ac.abort();
    ok((await errOf(MP.probeAudio(fake, wavFile, { signal: ac.signal })))?.name === "AbortError", "被叫停也要抛出来");
  }

  console.log("【7】找 ffmpeg / ffprobe");
  const onPath = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 && spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
  const p1 = MP.resolveMediaBins(), p2 = MP.resolveMediaBins();
  ok(p1 === p2, "并发来的两次共用同一趟查找");
  const bins = await p1;
  // 真跑那段看 resolveMediaBins 找没找到（跟别的套件、跟 app 一个口径）：
  // 从桌面启动、CI 没配 brew shellenv 时 PATH 上没有，但 /opt/homebrew/bin 里有，照样要跑
  const hasFf = !!(bins.ffmpeg.bin && bins.ffprobe.bin);
  ok(["ffmpeg", "ffprobe"].every((k) => bins[k] && typeof bins[k].bin === "string" && typeof bins[k].how === "string" && typeof bins[k].why === "string"), "两样都给 {bin, how, why}", JSON.stringify(bins));
  ok(/ffmpeg/.test(bins.install), "带一句本系统的装法（缺 ffprobe 给的也是 ffmpeg 的装法）", bins.install);
  if (bins.ffmpeg.bin && bins.ffprobe.bin) ok(MP.resolveMediaBins() === p1, "找全了就记住，后面直接用");
  else {
    ok(!!(bins.ffmpeg.why || bins.ffprobe.why), "没找到要说为什么", JSON.stringify(bins));
    ok(MP.resolveMediaBins() !== p1, "没找全的不记：装好之后点「重新检测」就能找到，不必重启");
  }
  if (onPath) ok(!!bins.ffmpeg.bin && !!bins.ffprobe.bin, "PATH 上有 ffmpeg 的机器上必须找得到", JSON.stringify(bins));
  MP.reset();
  ok(MP.resolveMediaBins() !== p1, "reset() 之后重新找");
  await MP.resolveMediaBins();

  console.log("【8】真 ffmpeg");
  if (!hasFf) {
    if (process.env.OWB_REQUIRE_FFMPEG === "1") ok(false, "OWB_REQUIRE_FFMPEG=1 却找不到 ffmpeg / ffprobe", JSON.stringify(bins));
    else console.log("    跳过：本机没有 ffmpeg");
  } else {
    let ran = 0;
    const ff = bins.ffmpeg.bin, fp = bins.ffprobe.bin;
    const gen = (name, args) => {
      const out = path.join(TMP, name);
      const r = spawnSync(ff, ["-nostdin", "-v", "error", "-y", ...args, out], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`造测试素材失败：${name}\n${r.stderr}`);
      return out;
    };
    const hasLame = /libmp3lame/.test(spawnSync(ff, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout || "");
    const srcA = gen("src-a.wav", ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000:duration=1.234", "-c:a", "pcm_s16le"]);
    const srcC = gen("src-c.wav", ["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=2", "-ac", "2", "-c:a", "pcm_s16le"]);
    const srcB = hasLame
      ? gen("src-b.mp3", ["-f", "lavfi", "-i", "sine=frequency=550:sample_rate=44100:duration=0.8", "-c:a", "libmp3lame", "-q:a", "2"])
      : gen("src-b.wav", ["-f", "lavfi", "-i", "sine=frequency=550:sample_rate=44100:duration=0.8", "-c:a", "pcm_s16le"]);
    if (!hasLame) console.log("    （这台 ffmpeg 没带 libmp3lame，mp3 那几条跳过）");

    const a = await MP.toPcmWav(ff, srcA, path.join(TMP, "n-a.wav"), { rate: 24000 });
    const b = await MP.toPcmWav(ff, srcB, path.join(TMP, "n-b.wav"), { rate: 24000 });
    const c = await MP.toPcmWav(ff, srcC, path.join(TMP, "n-c.wav"), { rate: 24000 });
    eq([a.samples, a.ms, a.sampleRate, a.channels, a.bitsPerSample], [29616, 1234, 24000, 1, 16], "1.234 秒 → 24000Hz 下恰好 29616 个采样，一个不多一个不少"); ran++;
    eq([c.samples, c.channels], [48000, 1], "48kHz 立体声 2 秒 → 24kHz 单声道 48000 个采样"); ran++;
    ok(Math.abs(b.ms - 800) <= 60, `mp3 解出来的长度和原来差不多（${b.ms}ms，mp3 本身有几十毫秒的出入）`); ran++;
    ok(!fs.existsSync(path.join(TMP, "n-a.wav.part")), "转完不留 .part"); ran++;
    for (const [f, w] of [["n-a.wav", a], ["n-b.wav", b], ["n-c.wav", c]]) {
      const p = await MP.probeAudio(fp, path.join(TMP, f));
      ok(p && p.samples === w.samples && p.exact === true && p.codec === "pcm_s16le", `probeAudio 量 ${f}：和文件头一致、标为精确`, JSON.stringify(p)); ran++;
    }
    if (hasLame) {
      const pm = await MP.probeAudio(fp, srcB);
      ok(pm && pm.exact === false && pm.codec === "mp3" && Math.abs(pm.ms - 800) <= 80, "原始 mp3：给个大概，但标明不精确", JSON.stringify(pm)); ran++;
    }

    const gap = MP.msToSamples(300, 24000);
    const full = path.join(TMP, "full-real.wav");
    const parts = [path.join(TMP, "n-a.wav"), path.join(TMP, "n-b.wav"), path.join(TMP, "n-c.wav")];
    const r = await MP.concatWithGaps(ff, parts, { gapSamples: gap, rate: 24000, outAbs: full });
    eq(r.samples, a.samples + b.samples + c.samples + 2 * gap, "整条 = 三句 + 两段留白，最后一句后面不留"); ran++;
    const pf = await MP.probeAudio(fp, full);
    ok(pf && pf.samples === r.samples && pf.exact, "ffprobe 量整条音轨，和算出来的采样数一模一样", JSON.stringify(pf)); ran++;
    const sd = spawnSync(ff, ["-nostdin", "-hide_banner", "-i", full, "-af", "silencedetect=noise=-50dB:d=0.2", "-f", "null", "-"], { encoding: "utf8" }).stderr || "";
    const starts = [...sd.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]) * 1000);
    const ends = [...sd.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]) * 1000);
    const want = r.starts.slice(1).map((s, i) => [MP.samplesToMs(r.ends[i], 24000), MP.samplesToMs(s, 24000)]);
    ok(starts.length === 2 && ends.length === 2 && want.every(([ws, we], i) => Math.abs(starts[i] - ws) <= 20 && Math.abs(ends[i] - we) <= 20),
      "用 ffmpeg 自己的 silencedetect 听：两段静音就在算好的位置（±20ms）", JSON.stringify({ starts, ends, want })); ran++;
    ok(!fs.existsSync(full + ".part"), "拼完不留 .part"); ran++;
    if (hasLame) {
      const fm = path.join(TMP, "full-real.mp3");
      await MP.concatWithGaps(ff, parts, { gapSamples: gap, rate: 24000, outAbs: fm });
      const pm = await MP.probeAudio(fp, fm);
      ok(pm && pm.codec === "mp3" && Math.abs(pm.ms - r.ms) <= 80, `要 .mp3 就用同一份 PCM 编一次，长度只差编码补齐那点（${pm && pm.ms} vs ${r.ms}）`); ran++;
      ok(!fs.existsSync(fm + ".part"), "编完不留 .part"); ran++;
    }
    const txt = put("not-audio.txt", "这不是音频，只是一段字");
    eq(await MP.probeAudio(fp, txt), null, "ffprobe 读不懂的文件返回 null"); ran++;
    const bad = path.join(TMP, "bad.wav");
    const eb = await errOf(MP.toPcmWav(ff, txt, bad, { rate: 24000 }));
    ok(eb && /ffmpeg 出错了/.test(eb.message) && eb.message.length < 400, "转不了：报错带 ffmpeg 自己最后说的话", eb && eb.message); ran++;
    ok(!fs.existsSync(bad) && !fs.existsSync(bad + ".part"), "转失败不留文件"); ran++;
    const ac = new AbortController(); ac.abort();
    ok((await errOf(MP.toPcmWav(ff, srcA, path.join(TMP, "stop.wav"), { rate: 24000, signal: ac.signal })))?.name === "AbortError" && !fs.existsSync(path.join(TMP, "stop.wav")), "已经叫停就不开跑"); ran++;
    ok(/采样率不对/.test((await errOf(MP.toPcmWav(ff, srcA, path.join(TMP, "r.wav"), { rate: 1000 })))?.message || ""), "采样率不合理当场拒绝，不交给 ffmpeg 去猜"); ran++;
    ok(ran === (hasLame ? 19 : 16), `真 ffmpeg 这段该跑的都跑了（${ran} 条）`);
  }

  console.log("【9】视频朝向：手机竖拍存成横的 + 转 90°，按转过之后的宽高算");
  {
    const v = (extra) => ({ codec_type: "video", width: 1920, height: 1080, ...extra });
    eq(MP.displaySize(v({ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] })), { w: 1080, h: 1920, rot: 270 }, "显示矩阵 -90° → 宽高对调，rot 记成 270");
    eq(MP.displaySize(v({ tags: { rotate: "90" } })), { w: 1080, h: 1920, rot: 90 }, "老版 tags.rotate=90 也认");
    eq(MP.displaySize(v({ side_data_list: [{ rotation: 180 }] })), { w: 1920, h: 1080, rot: 180 }, "转 180° 横竖不变");
    eq(MP.displaySize(v({})), { w: 1920, h: 1080, rot: 0 }, "没朝向信息：原样");
    eq(MP.streamRotation(v({ side_data_list: [{ rotation: 45 }] })), 0, "不是 90 的倍数的角度不认（ffmpeg 也不会按它转）");
    eq(MP.streamRotation(v({ side_data_list: [{ side_data_type: "Stereo 3D" }, { rotation: "-270" }] })), 90, "side_data 里夹着别的项、角度是字符串也认");
    eq([MP.turned(1920, 1080, 90), MP.turned(1920, 1080, -270), MP.turned(1920, 1080, 0), MP.turned(1920, 1080, undefined)],
      [{ w: 1080, h: 1920 }, { w: 1080, h: 1920 }, { w: 1920, h: 1080 }, { w: 1920, h: 1080 }], "turned：±90/270 对调，0 和没给都不动");
    ok(MP.ROTATION_ENTRIES === "stream_side_data=rotation:stream_tags=rotate", "ffprobe 要问的两样：显示矩阵的角度 + 老版的 rotate 标签", MP.ROTATION_ENTRIES);
    if (hasFf) {
      const ff = bins.ffmpeg.bin, fp = bins.ffprobe.bin;
      const flat = path.join(TMP, "flat.mp4"), rot = path.join(TMP, "rot.mp4");
      const r0 = spawnSync(ff, ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", flat], { encoding: "utf8" });
      ok(r0.status === 0, "造横的测试片", r0.stderr);
      // -display_rotation 是输入端选项（ffmpeg 7+），老版本没有就退到 rotate 标签
      let r1 = spawnSync(ff, ["-nostdin", "-v", "error", "-y", "-display_rotation", "90", "-i", flat, "-c", "copy", rot], { encoding: "utf8" });
      if (r1.status !== 0) r1 = spawnSync(ff, ["-nostdin", "-v", "error", "-y", "-i", flat, "-c", "copy", "-metadata:s:v:0", "rotate=90", rot], { encoding: "utf8" });
      ok(r1.status === 0, "造转 90° 的测试片", r1.stderr);
      const probe = (f) => {
        const r = spawnSync(fp, ["-v", "error", "-select_streams", "v:0", "-show_entries", `stream=width,height:${MP.ROTATION_ENTRIES}`, "-of", "json", f], { encoding: "utf8" });
        try { return MP.displaySize(JSON.parse(r.stdout).streams[0]); } catch { return { err: r.stderr }; }
      };
      const dr = probe(rot), df = probe(flat);
      ok(dr.w === 360 && dr.h === 640 && (dr.rot === 90 || dr.rot === 270), "真 ffprobe：转 90° 的片子报 360×640", JSON.stringify(dr));
      eq(df, { w: 640, h: 360, rot: 0 }, "真 ffprobe：没转的片子原样 640×360");
      const sz = spawnSync(ff, ["-nostdin", "-hide_banner", "-i", rot, "-frames:v", "1", "-vf", "showinfo", "-f", "null", "-"], { encoding: "utf8" }).stderr || "";
      ok(/s:360x640\b/.test(sz), "真 ffmpeg：解码时确实先转正成 360×640（上面按转过之后的算才对得上）", sz.split("\n").filter((l) => /showinfo|s:\d/.test(l)).slice(0, 2).join(" | "));
    }
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail === 0 ? "√" : "×"} media-probe：${pass} 条通过，${fail} 条失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("套件自己挂了：", e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
