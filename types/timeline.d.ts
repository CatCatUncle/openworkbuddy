/**
 * 时间轴成片（compose_video）的类型：timeline.json、排出来的计划、跑起来的任务。
 *
 * 真源是代码不是这里：输入的形状以 lib/timeline-compose.js 的 validateTimeline 为准（它收什么、怎么洗），
 * 计划和步骤以同一个文件的 timelinePlan / TimelineStep typedef 为准，任务以 lib/compose-jobs.js 的 startTimeline 为准。
 * 那边改了形状这里跟着改——这份文件只给 JSDoc 和 tsc 看，运行时没有人读它，不会自己跟着变。
 *
 * 用法（CommonJS 文件里）：
 *   /** @typedef {import("../../types/timeline").ComposeVideoInput} ComposeVideoInput *\/
 * 这里全是 type / interface，没有值：require 不到它，也不该 require 它。
 */

// ────────────────────────────────────────────────────────────────
// timeline.json（模型写、人也能手改的那份）。字段名照原样（下划线），路径都相对工作区
// ────────────────────────────────────────────────────────────────

/** 画幅：字符串（按标准尺寸出），或者带尺寸的对象（非标准尺寸、测试用小尺寸） */
export type TimelineAspect = string | { aspect: string; w?: number; h?: number };

/** 转场。cut 是硬切；duration 0.1–2 秒，默认 fade 0.3 */
export type TimelineTransition = "fade" | "slide" | "cut" | { type?: "fade" | "slide" | "cut"; duration?: number };

export interface TimelineVisual {
  /** 不写就按扩展名认 */
  kind?: "image" | "video" | "html";
  file: string;
  /** 按画幅换素材：{"16:9": "横版.png"} */
  by_aspect?: Record<string, string>;
  /** 只有视频认：[开始秒, 结束秒] */
  trim?: [number, number];
  /** 画幅对不上时：cover 裁满，blur 糊底，auto 差不到一成就裁、否则糊底 */
  fit?: "auto" | "cover" | "blur";
  /** 图片推镜；false 不推 */
  kenburns?: false | { from?: number; to?: number };
  /** HTML 段渲多久 */
  html_seconds?: number;
}

export interface TimelineVoice {
  file?: string;
  /** 整段的字幕文本（没按句切的时候） */
  text?: string;
  /** 按句配音（text_to_speech 的 segments 模式出来的那一串） */
  sentences?: Array<{ text?: string; file: string }>;
}

export interface TimelineSegment {
  id?: string;
  visual: TimelineVisual | string;
  voice?: TimelineVoice | string | false;
  /** 没配音时也上屏的字幕 */
  text?: string;
  min_seconds?: number;
  /** 封面优先从这一段截 */
  cover?: boolean;
  /** 进这一段时的转场，盖过全局那个 */
  transition?: TimelineTransition;
}

export interface TimelineBrandInline {
  logo?: string;
  font?: string;
  font_family?: string;
  /** #RRGGBB：底色、字色、强调色 */
  colors?: string[];
  cta?: string | { text?: string; sub?: string };
  banned?: string[];
}

export interface TimelineCard {
  seconds?: number;
  text?: string;
  sub?: string;
  /** 只有片尾认：用品牌包里的行动号召 */
  cta?: boolean;
}

export interface Timeline {
  version?: 1;
  title?: string;
  /** 相对工作区，不许 .. 也不许绝对路径；不写就是 成片/<片名> */
  out_dir?: string;
  fps?: 24 | 25 | 30 | 60;
  aspects?: TimelineAspect[];
  transition?: TimelineTransition;
  /** 品牌包的名字（brand_kit 建的），或者直接写 logo / 字体 / 颜色 */
  brand?: string | TimelineBrandInline;
  logo?: false | { corner?: "tl" | "tr" | "bl" | "br"; width_pct?: number; margin_pct?: number; opacity?: number };
  intro?: false | true | TimelineCard;
  outro?: false | true | TimelineCard;
  music?: string | false | { file: string; gain?: number; duck?: boolean };
  subtitles?: false | { burn?: "auto" | boolean; max_chars?: number; style?: { fontsize?: number } };
  segments: TimelineSegment[];
  /** 上游（配音、生图）记下的花费，只转交进清单；这一步本身不花钱 */
  cost?: Array<{ what: string; amount?: number | null; currency?: string }>;
}

// ────────────────────────────────────────────────────────────────
// 排出来的计划（timelinePlan 的返回）
// ────────────────────────────────────────────────────────────────

export interface TimelineBlocker {
  what: string;
  why: string;
  fix: string;
}

export interface TimelineStep {
  key: string;
  label: string;
  argv: string[];
  out: string;
  stage: "clips" | "cards" | "audio" | "film" | "covers";
  kind: "ffmpeg" | "render";
  /** 跑这一步之前要落盘的文本（字幕文件、卡片 HTML） */
  writes?: Array<{ rel: string; text: string }>;
  /** 预估要跑几秒：进度按它加权，超时按它放宽 */
  expectSeconds: number;
  /** 这一步产出的媒体有几秒：读 ffmpeg 的 time= 算进度用 */
  mediaSeconds: number;
  aspect?: string;
  burned?: boolean;
  /** 第一条命令挂了换这条（烧字幕挂了就出不带字幕的） */
  fallback?: string[];
  fallbackWhy?: string;
  /** 挂了也不算整条失败（封面） */
  optional?: boolean;
  optionalWhy?: string;
  render?: { what: "motion" | "card"; file: string; width: number; height: number; fps?: number; duration?: number; out: string };
}

export interface TimelinePlanAspect {
  aspect: string;
  key: string;
  label: string;
  w: number;
  h: number;
  file: string;
  ass: string;
  burned: boolean;
  covers: string[];
}

export interface TimelinePlanOk {
  ok: true;
  blockers: TimelineBlocker[];
  warnings: string[];
  fps: number;
  T: number;
  frames: number;
  title: string;
  stem: string;
  outDir: string;
  workDir: string;
  aspects: TimelinePlanAspect[];
  segments: any[];
  cues: any[];
  srt: string;
  manifest: string;
  steps: TimelineStep[];
  etaMs: number;
  dirs: string[];
  cleanup: string[];
  manifestDraft: any;
}

export interface TimelinePlanFail {
  ok: false;
  blockers: TimelineBlocker[];
  warnings: string[];
  steps: TimelineStep[];
  etaMs: 0;
}

export type TimelinePlan = TimelinePlanOk | TimelinePlanFail;

// ────────────────────────────────────────────────────────────────
// 跑起来的任务（lib/compose-jobs.js startTimeline / timelineGet 交回来的那份）
// ────────────────────────────────────────────────────────────────

export interface ComposeFilm {
  aspect: string;
  label: string;
  file: string;
  /** 跑完之后 ffprobe 量出来的；量不到才是计划值 */
  w: number;
  h: number;
  duration: number;
  /** 字幕真的烧进画面了（缺 libass 换了不烧那条就是 false） */
  burned: boolean;
  bytes: number;
}

export interface ComposeJobView {
  /** 锁被别的任务占着时交回的那份是空串：前端见空 id 不轮询 */
  id: string;
  kind: "timeline" | "canvas";
  owner?: string;
  busy?: boolean;
  name?: string;
  at: number;
  total: number;
  startedAt?: number;
  done: boolean;
  running: boolean;
  canceled?: boolean;
  error: string;
  output: string;
  outputs?: string[];
  films?: ComposeFilm[];
  covers?: string[];
  manifest?: string;
  subtitleFile?: string;
  bytes?: number;
  log: string[];
  /** contracts A 的那组词：compose / encode / render / shot */
  stage: string;
  stages?: string[];
  pct?: number;
  steps: Array<{ key: string; label: string; out: string; state: "wait" | "run" | "done" | "fail" | "skip"; ms: number; note: string; size?: number }>;
  etaMs?: number;
  outDir?: string;
  warnings?: string[];
}

export interface ComposeTimelineHooks {
  /** 把 HTML 画成 PNG（片头片尾卡）或 mp4（HTML 段）。onFrac 报 0–1 */
  render?: (step: TimelineStep, signal: AbortSignal, onFrac: (frac: number) => void) => Promise<void>;
  onProgress?: (ev: { stage: string; done: number; total: number; pct: number; label: string }) => void;
  finish?: (job: any) => void | Promise<void>;
}

// ────────────────────────────────────────────────────────────────
// compose_video 工具的参数
// ────────────────────────────────────────────────────────────────

export interface ComposeVideoInput {
  /** 时间轴：工作区里 timeline.json 的路径，或者直接写 JSON */
  timeline?: string | Timeline;
  /** 只排片、不出片：看会出几条、多长、有什么警告 */
  dry_run?: boolean;
  /** 查一条已经开跑的合成 */
  job?: string;
  /** 配合 job：叫停它 */
  cancel?: boolean;
}
