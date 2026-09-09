/**
 * demo 录屏的时长整形：打字和最后停在结果上的那几秒保持原速，只把「等模型干活」那段压进目标时长。
 * 纯函数放这里，record-demo.js 顶部 require("electron")，node 直接测不了。
 */
"use strict";

/**
 * @param {{at:number, until:number}[]} frames 每帧首次出现时刻 / 最后一次相同时刻
 * @param {{interval:number, speed?:number, targetSec?:number, sent?:number, done?:number}} o
 *   speed ≠ 1 时全片按倍速（人工指定优先）；否则超过 targetSec 才压，且只压 [sent, done) 这段
 * @returns {{durations:number[], factor:number, work:number, total:number}} 秒
 */
function fitDurations(frames, o) {
  const interval = o.interval;
  const real = frames.map((f, i) => {
    const next = frames[i + 1];
    return Math.max(interval, (next ? next.at : f.until + interval) - f.at) / 1000;
  });
  const total = real.reduce((s, d) => s + d, 0);
  const inWork = (f) => o.sent != null && o.done != null && f.at >= o.sent && f.at < o.done;
  const work = frames.reduce((s, f, i) => s + (inWork(f) ? real[i] : 0), 0);
  let factor = 1;
  if (o.speed && o.speed !== 1) {
    return { durations: real.map((d) => d / o.speed), factor: o.speed, work, total };
  }
  if (o.targetSec > 0 && total > o.targetSec && work > 0) {
    const other = total - work;
    const room = Math.max(5, o.targetSec - other); // 至少给干活那段留 5 秒，别压成一闪而过
    factor = Math.max(1, work / room);
  }
  const floor = interval / 1000;
  return { durations: frames.map((f, i) => (inWork(f) ? Math.max(floor, real[i] / factor) : real[i])), factor, work, total };
}

module.exports = { fitDurations };
