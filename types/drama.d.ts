/**
 * 短剧那条产线的类型：分镜表、画布状态、制片进度、合成计划。
 *
 * ⚠️ schema 是真源，改 schema 必须同步这里。
 *    schema 在 skills/short-drama/references/分镜表.schema.json。
 * 这份文件只给 JSDoc 和 tsc 看，运行时没有人读它——所以它**不会**自己跟着 schema 变。
 * schema 加了一个字段而这里没加，tsc 照样全绿，只是 JSDoc 里的提示少一项；
 * schema 删了一个必填而这里还写着必填，代码就会被逼着去填一个 schema 已经不收的字段。
 * 两边对不上的时候，以 schema 为准，改这里。
 *
 * 画布那几个类型的真源是 src/tools/canvas.js 的 canvasNormalizeState（后端落盘前统一过一遍）
 * 和 public/js/app-07-canvas-nodes.js（前端写 payload 的地方），同理，那边改了形状这里跟着改。
 *
 * 用法（CommonJS 文件里）：
 *   /** @typedef {import("./types/drama").Storyboard} Storyboard *\/
 * 这里全是 type / interface，没有值：require 不到它，也不该 require 它。
 */

// ────────────────────────────────────────────────────────────────
// 分镜表：一一对上 分镜表.schema.json。字段名照 schema 原样写（下划线、不改驼峰），
// 顺序也照 schema 的顺序，对着看的时候一眼能看出少了哪一项
// ────────────────────────────────────────────────────────────────

/** 画幅。schema 里的 enum，也是 drama-pipeline 的 STORYBOARD_ASPECTS */
export type Aspect = "9:16" | "16:9" | "1:1";

/** 出场角色（schema: characters[]）。跨镜头长得一样全靠 look + ref 这两项 */
export interface CastMember {
  /** 镜头里引用用的短 id，如 A / B */
  id: string;
  name: string;
  /** 外貌描述，写死一段，后面所有镜头照抄不改 */
  look: string;
  /** 定妆照的相对路径，如 角色_林夏.png。它是产物，草稿阶段不收 */
  ref?: string;
  /** 音色名，全程不换 */
  voice?: string;
}

/** 一个镜头（schema: scenes[].shots[]） */
export interface Shot {
  /** 镜头号，如 S1-01。所有产物文件名都带它 */
  id: string;
  /** 这一镜出场的角色 id（CastMember.id） */
  cast?: string[];
  /** 景别：远景 / 全景 / 中景 / 近景 / 特写 */
  shot_size: string;
  /** 首帧画面的提示词：景别 + 场景 + 姿态 + 光线。不写画风 */
  frame_prompt: string;
  /** 只写动作和运镜 */
  motion_prompt: string;
  /** 台词/旁白。空着就是无人声镜头 */
  line?: string;
  /** 说这句话的角色 id */
  speaker?: string;
  /** 首帧图的产物路径 */
  first_frame?: string;
  /** 尾帧图的产物路径。只有转场镜头才需要 */
  last_frame?: string;
  /** 视频产物路径 */
  video?: string;
  /** 配音产物路径 */
  audio?: string;
  /** 实测时长（秒），ffprobe 量完回写 */
  duration?: number;
  /** 给人看的备注 */
  note?: string;
}

/** 一场戏（schema: scenes[]） */
export interface Scene {
  /** 场次号，如 S1 */
  id: string;
  place?: string;
  /** 时间/光线，如 黄昏、夜、阴天正午 */
  time?: string;
  /** 至少一镜 */
  shots: Shot[];
}

/** 最终产物（schema: output）。做完回写 */
export interface StoryboardOutput {
  video?: string;
  cover?: string;
  subtitle?: string;
  duration?: number;
}

/** 分镜表本体（schema 根）。additionalProperties:false：这里没有的字段，schema 也不收 */
export interface Storyboard {
  title: string;
  logline?: string;
  aspect: Aspect;
  /** 整数 12–60，默认 24 */
  fps?: number;
  /** 全片统一的画风。由人定，归一时按请求写回，不信模型的 */
  style?: string;
  /** 至少一个 */
  characters: CastMember[];
  /** 至少一场 */
  scenes: Scene[];
  output?: StoryboardOutput;
}

// ────────────────────────────────────────────────────────────────
// 剧本 → 分镜表草稿（drama-pipeline 的四个纯函数）
// ────────────────────────────────────────────────────────────────

/** buildStoryboardPrompt 的入参。画幅、画风、每镜时长是人定的 */
export interface StoryboardPromptInput {
  script?: string;
  style?: string;
  aspect?: string;
  /** 每镜秒数；不是正数就按 5 秒 */
  shotSeconds?: number | string;
  title?: string;
}

/** normalizeStoryboardDraft 的第二个参数：人定的那几项，压过模型写的 */
export interface StoryboardDraftOptions {
  aspect?: string;
  style?: string;
  shotSeconds?: number | string;
  title?: string;
}

export type StoryboardReply = { ok: true; data: object } | { ok: false; error: string };

/** 归一 / 合并的结果。改动全写进 warnings，不悄悄改 */
export interface StoryboardDraft {
  data: Record<string, any>;
  warnings: string[];
}

export interface StoryboardCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// ────────────────────────────────────────────────────────────────
// 画布状态：tools.js canvasNormalizeState 规整之后的形状
// ────────────────────────────────────────────────────────────────

/** 认得的节点类型。不认识的 kind 照原样留着（可能是别的版本建的），所以 CanvasNode.kind 是 string */
export type CanvasKind =
  | "note" | "script" | "agent" | "character" | "location" | "storyboard"
  | "scene" | "shot" | "image" | "video" | "audio" | "timeline";

/** 认得的连线用途。同理，不认识的也照留 */
export type CanvasRelation =
  | "input" | "split" | "generate" | "character" | "background" | "composition" | "motion"
  | "style" | "prop" | "continuity" | "first_frame" | "last_frame" | "audio" | "reference";

/** 一次生成喂进去的上游素材 */
export interface GenerationInput {
  nodeId: string;
  label?: string;
  relation?: string;
  path?: string;
}

/** 一次生成的记录（payload.generation / payload.generation_runs[]，一镜最多留 12 条） */
export interface GenerationRun {
  id?: string;
  kind: "image" | "video" | "audio" | string;
  /** Date.now() */
  at?: number;
  /** 真跑的耗时。沿用 / 缓存命中不记——「还要多久」按它取中位数，混进 0 会把预估压没 */
  ms?: number;
  model?: string;
  /** 产物路径 */
  output?: string;
  inputs?: GenerationInput[];
  /** 缓存复用 */
  reused?: boolean;
  /** 被这一次顶掉的上一版产物 */
  replaced?: string;
  /** 参数指纹，同参数下次沿用 */
  sig?: string;
  /** 这一次绕过了服务端缓存 */
  fresh?: boolean;
  /** 按备用顺序换了模型时，原来那个 */
  fallbackFrom?: string;
}

/**
 * 节点的 payload。各类节点字段不一样，而且前端随时会加新字段，所以留了索引签名。
 * 下面列的是后端（进度、合成）真去读的那些。
 */
export interface CanvasPayload {
  /** 镜头号 / 角色 id，也用来排顺序（S1-02 → 第 1 场第 2 镜） */
  id?: string;
  title?: string;
  /** 显式排过的顺序，压过镜头号 */
  order?: number | string;
  // 剧本 / 笔记
  text?: string;
  // 角色
  name?: string;
  role?: string;
  description?: string;
  /** 角色节点上是定妆照；镜头节点上是喂进去的参考图，不是产物 */
  reference?: string;
  voice?: string;
  // 镜头
  shot_size?: string;
  /** 画布上的时长是字符串（"4"），分镜表里的 duration 是数字 */
  duration?: string | number;
  prompt?: string;
  motion_prompt?: string;
  line?: string;
  speaker?: string;
  first_frame?: string;
  last_frame?: string;
  video?: string;
  audio?: string;
  voice_file?: string;
  // 素材节点（图 / 视频 / 声音）
  path?: string;
  url?: string;
  file?: string;
  image?: string;
  tags?: string;
  // 剪辑节点：配乐
  bgm?: string;
  music?: string;
  bgm_file?: string;
  bgm_title?: string;
  generation?: GenerationRun;
  generation_runs?: GenerationRun[];
  [key: string]: any;
}

export interface CanvasNode {
  id: string;
  /** 通常是 CanvasKind，但不认识的也照留，最长 40 字 */
  kind: CanvasKind | string;
  payload: CanvasPayload;
  position: { x: number; y: number };
  size?: { width?: number; height?: number };
}

export interface CanvasEdge {
  source: { id: string };
  target: { id: string };
  relation?: CanvasRelation | string;
}

export interface CanvasState {
  /** 2 = 这份文件把连线记全了；1 = 老文件，没有连线不代表真没有 */
  version: 1 | 2 | number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  updatedAt: number;
}

/**
 * 进度和合成这两个纯函数只读 nodes，调用方经常只凑一个 { nodes } 传进来（测试、dry run），
 * 所以入参按最宽的收
 */
export interface CanvasStateLike {
  nodes?: Array<Partial<CanvasNode>>;
  edges?: CanvasEdge[];
  [key: string]: any;
}

// ────────────────────────────────────────────────────────────────
// 素材定位（drama-pipeline 的 assetLocator）
// ────────────────────────────────────────────────────────────────

/** 定位结果。rel 为空 = 没认出来；同名好几份时 rel 为空、ambiguous 列出全部候选，不替人挑 */
export interface AssetHit {
  rel: string;
  ambiguous?: string[];
}

/** 字段里写的路径 → 盘上的那一份。near：先按这个目录解一遍（分镜表里的路径相对它自己写） */
export type Locate = (ref: string, near?: string) => AssetHit;

export interface AssetLocatorOptions {
  /** 清单是截断过的：按相对路径没认出来时再问一次盘。不给就只看清单 */
  exists?: (rel: string) => boolean;
}

// ────────────────────────────────────────────────────────────────
// 制片进度（drama-pipeline 的 dramaProgress）
// ────────────────────────────────────────────────────────────────

export type ProductKind = "image" | "video" | "audio" | "cast";

/** outputOf 的结果：路径 + 盘上在不在 */
export interface OutputHit {
  path: string;
  base: string;
  ok: boolean;
  /** 认到的路径跟字段里写的不一样时才有 */
  rel?: string;
  ambiguous?: string[];
}

/** 给界面的那一格 */
export interface ProgressCell {
  path: string;
  ok: boolean;
  rel?: string;
  ambiguous?: string[];
}

export interface DramaProgressOptions {
  /** basename 集合；不给就不查盘，只看字段 */
  onDisk?: Set<string>;
  /** 给了就按「相对路径 → 文件名全区搜」认，onDisk 不再看 */
  locate?: Locate;
}

export type BlockerLevel = "stop" | "warn";

/** 卡点。ids 是卡住的节点，界面上能直接跳过去 */
export interface Blocker {
  level: BlockerLevel;
  text: string;
  ids: string[];
  /** 界面上那个按钮做什么 */
  action?: string;
}

export interface ProgressStage {
  /** script / cast / shots / frame / video / voice / cut（也当 next.action 用，所以不收窄成字面量） */
  key: string;
  label: string;
  done: number;
  total: number;
  state: "none" | "todo" | "doing" | "done";
}

export interface ProgressCastRow {
  nodeId: string;
  name: string;
  role: string;
  image: ProgressCell | null;
  ambiguous?: string[];
}

export interface ProgressShotRow {
  id: string;
  nodeId: string;
  title: string;
  shot_size: string;
  duration: string;
  line: string;
  needsVoice: boolean;
  /** 空串 = 没卡 */
  blocked: string;
  frame: ProgressCell | null;
  video: ProgressCell | null;
  audio: ProgressCell | null;
  ambiguous?: string[];
}

export interface DramaProgress {
  percent: number;
  stages: ProgressStage[];
  shots: ProgressShotRow[];
  cast: ProgressCastRow[];
  blockers: Blocker[];
  next: { text: string; ids: string[]; action: string };
  pending: { cast: number; image: number; video: number; audio: number };
  /** 没跑过就是 null：不编一个数出来 */
  eta: { ms: number; basis: string; partial: boolean } | null;
  counts: { script: number; character: number; shot: number; scene: number; storyboard: number; timeline: number };
}

// ────────────────────────────────────────────────────────────────
// 合成计划（drama-compose 的 composePlan）
// ────────────────────────────────────────────────────────────────

/** ffprobe 探到的规格。没探到就没这一项，不是全 0 */
export interface MediaProbe {
  dur?: number;
  w?: number;
  h?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  pix?: string;
}

export interface ComposeOptions {
  /** basename → 工作区相对路径。真在盘上的文件（不给 = 盘上什么都没有） */
  files?: Map<string, string>;
  /** 给了就不看 files（drama-pipeline 的 assetLocator） */
  locate?: Locate;
  /** 用来给成片挑一个不撞名的名字 */
  onDisk?: Set<string>;
  /** 先按相对路径查、再按文件名查：两集同名的镜头，时长不能串 */
  probes?: Record<string, MediaProbe>;
  /** ffmpeg 可执行路径，空 = 本机没有 */
  ffmpeg?: string;
  ffprobe?: string;
  /** 没装时的装法 */
  install?: string;
  /** 要不要烧字幕；null / 不给 = 有台词就烧 */
  subtitles?: boolean | null;
  /** 本机 ffmpeg 有没有 libass。false = 字幕文件照出，只是不进画面 */
  burn?: boolean;
  /** 要不要配乐；null / 不给 = 画布上找得到就配 */
  music?: boolean | null;
  /** 直接指定配乐文件，压过画布上猜出来的那段 */
  musicFile?: string;
  /** 本机 ffmpeg 有没有 sidechaincompress */
  duck?: boolean;
  /** 有没有 alimiter */
  limiter?: boolean;
  /** 中间产物放哪个子目录，默认「成片素材」 */
  dir?: string;
  [key: string]: any;
}

/** pickFile 的结果：字段里写的 → 盘上的那一份 */
export interface PickedFile {
  ref: string;
  base: string;
  /** 空 = 盘上没有，或者同名好几份 */
  rel: string;
  /** 字段里指的不是这一类文件（video 指着一张 png） */
  wrongKind: boolean;
  ambiguous?: string[];
}

/** 配乐候选。有毛病的也在里头，上层据此说清「为什么这次没配乐」 */
export interface MusicCandidate extends PickedFile {
  title: string;
  from: "指定的" | "剪辑节点" | "声音节点" | string;
  /** 声音节点标成了配乐，但还没有文件 */
  empty?: boolean;
}

/** 合成计划里的一镜 */
export interface ComposeRow {
  id: string;
  nodeId: string;
  title: string;
  /** 占位文字原样没改算没台词，是空串 */
  line: string;
  /** 盘上的相对路径；空 = 拼不进去 */
  video: string;
  videoRef: string;
  audio: string;
  audioRef: string;
  /** 这一镜在成片里占几秒（配音比画面长就按配音算） */
  seconds: number;
  vdur: number;
  adur: number;
  /** 最后一帧要接住多少秒 */
  pad: number;
  /** 拼不进去的原因，空串 = 没毛病 */
  why: string;
  ambiguous?: string[];
  w?: number;
  h?: number;
  fps?: number;
  vcodec?: string;
  pix?: string;
  /** 这一镜的中间片段 */
  clip?: string;
}

/** 一条 ffmpeg 命令 */
export interface ComposeStep {
  key: string;
  label: string;
  argv: string[];
  out: string;
  /** 这条失败时换这条再跑一次 */
  fallback?: string[];
  fallbackWhy?: string;
  /** 失败了也不算整趟失败（烧字幕） */
  optional?: boolean;
  optionalWhy?: string;
}

export interface ComposeOutputs {
  dir: string;
  list: string;
  clips: string[];
  /** 成片。有配乐时这个名字留给配好乐的那一版 */
  film: string;
  /** concat 出来的那一条：没配乐时就是 film */
  merged: string;
  music: string;
  /** 空 = 这次不出字幕 */
  srt: string;
  /** 空 = 这次不烧字幕 */
  subtitled: string;
}

export interface ComposeMusic {
  base: string;
  rel: string;
  title: string;
  dur: number;
  from: string;
  duck: boolean;
}

export interface ComposePlan {
  /** 没有 stop 级卡点、而且有命令可跑 */
  ready: boolean;
  /** copy = 直拼；规格不一致或要补帧就是 reencode */
  mode: "copy" | "reencode";
  target: { w: number; h: number };
  fps: number;
  blockers: Blocker[];
  shots: ComposeRow[];
  /** 有 stop 就一条都不给 */
  steps: ComposeStep[];
  outputs: ComposeOutputs;
  srt: string;
  /** 找到了这段音乐（界面上的勾靠它） */
  music: ComposeMusic | null;
  /** 这次真的要用配乐 */
  musicOn: boolean;
  /** concat 的清单文件内容 */
  listText: string;
  /** 探不全时长就是 0 */
  totalSeconds: number;
  timelineIds: string[];
  /** 估不出来就是 0 */
  etaMs: number;
}
