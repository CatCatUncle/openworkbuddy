"use strict";
/**
 * 自动化 / 定时任务 — 到点自动让 Agent 执行任务（如每天早上生成日报、每周五汇总周报）。
 * 任务持久化在 schedules.json；cron 5 字段：分 时 日 月 周（支持 * , - 和 星号/步长）。
 */

const path = require("path");
const { dataPath } = require("./paths");
const jsonStore = require("./store");
const { judgeRun, explainRunError, verdictMessage } = require("./task-verdict");

const STORE = dataPath("schedules.json");

/** 错过的任务最多往回补一天；关机一个月不该开机就把一个月的晨报全补一遍 */
const MAX_CATCHUP_MS = 24 * 3600 * 1000;
/** 两次 tick 差这么久，就认为中间那段没人看着（睡眠 / 应用关了） */
const GAP_MS = 90 * 1000;
/** 运行记录留多少条。留太多每次存盘都要重写一大坨，留太少查不了昨天 */
const MAX_RUNS = 300;
/**
 * 定时任务跑起来时挂在 runTask 上的任务标签。
 * agent 那边靠它认出「我现在就是被定时任务叫起来的」，从而不许再动排期表——
 * 一条定时任务改出另一条定时任务，是个没人看着的时候会自己越滚越多的闭环。
 * 两个文件各写一遍字面量迟早对不上，所以从这儿出。
 */
const SCHEDULE_LABEL = "定时任务";

const WEEK_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * 把 cron 说成人话；说不清就返回 ""，由调用方退回原样显示。
 *
 * 这不是装饰。排期是要弹给用户点头的：他看见「0 9 * * 1-5」判断不了要不要批，
 * 看见「工作日 09:00」才判断得了。所以只认最常见的那几种写法，花活一律不猜——
 * 猜错比不说更坏，用户会照着一句错的说明点「同意」。
 */
function describeCron(expr) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length !== 5) return "";
  const [mi, hr, dom, mon, dow] = f;
  if (mon !== "*") return ""; // 按月挑月份的极少见，不猜
  const num = (s) => (/^\d+$/.test(s) ? parseInt(s, 10) : null);
  const m = num(mi), h = num(hr);
  let step;
  if (dom === "*" && dow === "*") {
    if (hr === "*" && (step = mi.match(/^\*\/(\d+)$/))) return `每 ${step[1]} 分钟`;
    if (hr === "*" && m !== null) return m === 0 ? "每小时整点" : `每小时第 ${m} 分`;
    if (m !== null && (step = hr.match(/^\*\/(\d+)$/))) return `每 ${step[1]} 小时（第 ${m} 分）`;
  }
  if (m === null || h === null) return "";
  const at = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (dom === "*" && dow === "*") return `每天 ${at}`;
  if (dom === "*" && dow === "1-5") return `工作日 ${at}`;
  if (dom === "*" && /^[0-7](,[0-7])*$/.test(dow)) {
    const days = [...new Set(dow.split(",").map((d) => (d === "7" ? 0 : +d)))].sort((a, b) => a - b);
    return `每${days.map((d) => WEEK_CN[d]).join("、")} ${at}`;
  }
  if (dow === "*" && /^\d+$/.test(dom)) return `每月 ${+dom} 号 ${at}`;
  return "";
}

/**
 * 「活的」排期表的插座。
 *
 * 调度器只有 server 起得起来（它要 runtime，要推送通道），可 agent 那边也得让模型自己排期，
 * 又不能反过来 require server —— 那是一个环。所以这儿留一个槽：server 建好之后插上，
 * agent 每次列工具时现取。CLI 和测试里没人插，取到 null，排期工具就压根不出现；
 * 不是先摆出来再报「用不了」——那样模型会把它当成偶发失败，一遍遍重试。
 */
let activeInstance = null;
function setActiveScheduler(s) {
  activeInstance = s || null;
  return s;
}
function activeScheduler() {
  return activeInstance;
}

function loadStore(file) {
  // 坏文件先拿 .bak 顶，再不行改名隔离——原来是静默当空表，紧接着一次保存就把
  // 用户攒的所有定时任务永久抹掉了，全程一句提示都没有
  const j = jsonStore.readJson(file, {}) || {};
  return {
    tasks: Array.isArray(j.tasks) ? j.tasks : [],
    // 运行记录。只有 last_result 的话，昨天跑挂了今天跑好了就查无此事——
    // 自动化最需要回答的问题恰恰是「它这几天到底跑成什么样」，那得留流水。
    runs: Array.isArray(j.runs) ? j.runs : [],
    last_tick_at: j.last_tick_at || "",
  };
}
function saveStore(store, file) {
  // 先写临时文件再改名：直接覆写的话，写到一半断电就只剩半个 JSON，整张任务表就没了
  jsonStore.writeJsonAtomic(file, store, { pretty: true });
}

// ---------- 迷你 cron 解析 ----------

/**
 * 解析一个 cron 字段。支持 *、5、1-5、*\/15、1-30/5、5/10，逗号分隔。
 * 越界和写反的一律报错——静默收下的后果是任务永远不触发，而界面上看它一切正常。
 */
function parseField(field, min, max, label) {
  const values = new Set();
  const bad = (why) => new Error(`${label}字段「${field}」${why}`);
  for (const part of String(field).split(",")) {
    const bits = part.split("/");
    if (bits.length > 2) throw bad(`里的「${part}」不认识`);
    let step = 1;
    if (bits.length === 2) {
      if (!/^\d+$/.test(bits[1])) throw bad(`的步长「${bits[1]}」不是数字`);
      step = parseInt(bits[1], 10);
      // 步长 0 会让下面的 for 永远走不动，整个进程就卡死在这一行（server 跑在 Electron 主进程里，界面会一起冻住）
      if (step < 1) throw bad("的步长必须 ≥ 1");
    }
    const range = bits[0];
    let lo, hi, m;
    if (range === "*") {
      lo = min; hi = max;
    } else if ((m = range.match(/^(\d+)-(\d+)$/))) {
      lo = parseInt(m[1], 10); hi = parseInt(m[2], 10);
      if (lo > hi) throw bad(`里的范围「${range}」写反了`);
    } else if (/^\d+$/.test(range)) {
      lo = parseInt(range, 10);
      hi = bits.length === 2 ? max : lo; // 标准 cron：5/10 是「从 5 开始每 10」
    } else {
      throw bad(`里的「${part}」不认识`);
    }
    if (lo < min || hi > max) throw bad(`超出范围，只能是 ${min}-${max}`);
    for (let i = lo; i <= hi; i += step) values.add(i);
  }
  if (!values.size) throw bad("没圈出任何值");
  return values;
}

/**
 * 「只跑一次」的时刻。
 *
 * 说一句「五分钟后叫我去准备面试」，排出来的是一条**每天 14:00** 的 cron，任务正文还成了
 * 半句上下文「飞书上叫我去准备面试了」——离谱到没法用。
 * 根因不在模型：cron 五个字段里压根没有「一次」这个概念，模型手上只有这一个工具，
 * 只能拿「每天这个点」去近似「这个点」——于是一条提醒变成了一条每天都要响的闹钟。
 *
 * 认三种写法，都是为了让模型写得出来：
 *   +5m / +2h / +1d  从现在起往后推。**这条是主力**——系统提示词里的当前时间只精确到「几点左右」，
 *                    模型算不出「五分钟后」的绝对时刻，硬让它算只会算歪，还不如让它照抄用户说的那个量。
 *   14:05            今天的这个钟点；已经过了就顺延到明天（人说「6 点叫我」时想的就是这个）。
 *   2026-09-19 14:05 / ISO  说全了就按说的来。
 *
 * 认不出来一律抛错，绝不猜一个时刻回去：排期是要弹给用户点头的，猜错的那一下他点的是「同意」。
 */
function parseAt(expr, now = Date.now()) {
  const raw = String(expr == null ? "" : expr).trim();
  if (!raw) throw new Error("没写执行时刻");
  let m = raw.match(/^\+\s*(\d+)\s*(分钟|分|小时|时|天|m|min|h|hour|d|day)$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const mins = /^(小时|时|h|hour)$/.test(unit) ? n * 60 : /^(天|d|day)$/.test(unit) ? n * 1440 : n;
    if (!(mins > 0)) throw new Error(`「${raw}」推不出一个未来的时刻`);
    // 一年以上就别当定时任务了：那是个日程，而且这么长的等待期里应用早重启过无数次
    if (mins > 366 * 1440) throw new Error("最多只能往后排一年");
    return new Date(now + mins * 60000).toISOString();
  }
  if ((m = raw.match(/^(\d{1,2})\s*[:：]\s*(\d{2})$/))) {
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) throw new Error(`「${raw}」不是一个钟点`);
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setHours(h, mi);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1); // 今天这个点过了就是明天的这个点
    return d.toISOString();
  }
  // 「2026-09-19 14:05」这种当本地时间读。直接丢给 Date 的话，不带时区的写法在不同运行时里
  // 一会儿被当 UTC 一会儿被当本地，差出八个小时——提醒就响在半夜
  if ((m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/))) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), 0);
    if (isNaN(d.getTime())) throw new Error(`「${raw}」不是一个有效时刻`);
    return d.toISOString();
  }
  const t = Date.parse(raw); // 带时区的完整 ISO 走这条
  if (!isNaN(t)) return new Date(t).toISOString();
  throw new Error(`看不懂「${raw}」。只跑一次的写法：+5m（五分钟后）、14:05（今天或明天那个钟点）、2026-09-19 14:05`);
}

/** 这条排期什么时候跑，说成人话。一次性的说日子和钟点，周期的交给 describeCron */
function describeWhen(item) {
  if (item && item.at) {
    const d = new Date(item.at);
    if (isNaN(d.getTime())) return "";
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const at = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return (sameDay ? "今天 " : `${d.getMonth() + 1} 月 ${d.getDate()} 日 `) + at + "（只跑一次）";
  }
  return describeCron(item && item.cron);
}

function parseCron(expr) {
  const fields = String(expr || "").trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron 需要 5 个字段：分 时 日 月 周");
  const dow = parseField(fields[4], 0, 7, "周");
  if (dow.has(7)) { dow.delete(7); dow.add(0); } // 标准 cron 里 0 和 7 都是周日
  return {
    minute: parseField(fields[0], 0, 59, "分"),
    hour: parseField(fields[1], 0, 23, "时"),
    dom: parseField(fields[2], 1, 31, "日"),
    month: parseField(fields[3], 1, 12, "月"),
    dow,
    // 标准 cron 的怪脾气：日和周都限定了就是「或」，得留着原样才判得出来
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

function cronMatches(cron, date) {
  if (!cron.minute.has(date.getMinutes())) return false;
  if (!cron.hour.has(date.getHours())) return false;
  if (!cron.month.has(date.getMonth() + 1)) return false;
  const dom = cron.dom.has(date.getDate());
  const dow = cron.dow.has(date.getDay());
  // 「每月 1 号 或 每周一」——两个都写了具体值时标准 cron 是取或，不是取且
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  return dom && dow;
}

// ---------- 调度器 ----------

/**
 * @param recorder 可选：把一次定时执行录成一段真会话。server 建调度器时插进来。
 *   调度器自己不认识会话存储（那是 server.js 的 SESS_DIR 那一摊），所以只留这么个插座：
 *   recorder({ item, trigger, run }) → { sessionId, opts, done(ok, text) }
 *   - opts 会原样摊进 runTask（emit / sessionId / taskLabel / user / baseDir …）
 *   - done 在这一趟收尾时调一次，成败都调，负责把会话落盘
 *   没插 recorder（CLI、测试）就跟以前一模一样：不录、不留 session_id、不影响执行本身。
 */
function createScheduler({ runtime, onResult, storePath, recorder }) {
  // 测试要能指到别处去，不然一跑测试就把用户真的任务表洗了
  const file = storePath || STORE;
  const store = loadStore(file);
  let lastMinuteKey = "";
  /** 正在跑的任务 id → 开始时间戳。同一个任务不许叠着跑，上一次没跑完就跳过这次 */
  const running = new Map();
  // 上次看表是什么时候。开机第一眼不补跑，否则第一次装起来就会把历史全部重放一遍
  let lastTickMs = store.last_tick_at ? Date.parse(store.last_tick_at) || 0 : 0;

  /**
   * 运行记录没了，跟着它那段「执行过程」会话也该没。
   *
   * 不清的话就是个只进不出的坑：后台 cron 每跑一次多一个会话文件，运行记录到 300 条封顶、
   * 任务删了记录也跟着删，可盘上那些会话永远没人碰——用得越久越多，而且全是没有入口的孤儿。
   */
  const forgetRuns = (rows) => {
    const ids = (rows || []).map((r) => r && r.session_id).filter(Boolean);
    if (ids.length && recorder && recorder.forget) {
      try { recorder.forget(ids); } catch (e) { console.warn(`[定时任务] 清执行记录失败：${e.message}`); }
    }
  };

  /**
   * 这条排期，这个人碰不碰得到。
   *
   * 排期表以前一条归属都不记：任何一个登录进来的人都能列出、改掉、删掉、甚至**手动触发**
   * 别人的定时任务。任务描述本身就是商业内容（「把本月华东区回款拉出来发给张总」），
   * 列表一拉就全看见了；手动触发更狠——用的是公司的额度，结果推到的是原主人的通知渠道。
   *
   * 判据跟会话那边（server.js 的 sessionAllowed）保持同一条，不另起一套：
   *   本人放行 → 管理员限本组织 → 升级上来的老任务没记归属，按公共处理（不然一升级全员任务消失）。
   * viewer 传空 = 内部调用（tick 循环、测试、CLI），不过闸。
   */
  function allowed(t, viewer) {
    if (!viewer || !t) return true;
    if (!t.user) return true;                       // 老任务：没记过归属，不能凭空判给谁
    if (t.user === viewer.username) return true;
    if (!viewer.admin) return false;
    return (t.org || "") === (viewer.org || "");     // 管理员也只看得到本组织的
  }

  /** viewer 省略 = 全部（tick 循环 / 测试 / 离职清理要看全表）；传了就按归属过滤 */
  function list(viewer) {
    return store.tasks
      .filter((t) => allowed(t, viewer))
      .map((t) => ({ ...t, running: running.has(t.id), running_since: running.get(t.id) ? new Date(running.get(t.id)).toISOString() : null }));
  }

  /** 单条取用，顺带过闸。取不到和没权限都返回 null——不区分，免得成了「这个 id 存不存在」的探针 */
  function get(id, viewer) {
    const t = store.tasks.find((x) => x.id === id);
    return t && allowed(t, viewer) ? t : null;
  }

  function add({ name, cron, at, task, catch_up, user, org }) {
    task = String(task || "").trim();
    if (!task) throw new Error("任务描述不能为空");
    // 只跑一次 vs 周期跑，二选一。两个都给会各跑各的（cron 每天响 + at 再响一次），
    // 而界面上只画得下一个时间——用户看到的和实际发生的就对不上了
    const once = at ? parseAt(at) : "";
    if (once && cron) throw new Error("「只跑一次」和「按周期跑」只能选一个");
    if (!once) parseCron(cron); // 校验
    const item = {
      id: "sch_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: String(name || "").trim() || task.slice(0, 30),
      cron: once ? "" : String(cron).trim(),
      // 只跑一次的时刻（ISO）。跑完 tick 会把 enabled 关掉并盖上 fired_at，
      // 记录留着不删——用户还要回头看「那条提醒到底响没响、结果是什么」
      ...(once ? { at: once } : {}),
      task,
      enabled: true,
      // 错过了要不要补：默认补。笔记本合上盖子过一夜，晨报不该就这么没了
      catch_up: catch_up !== false,
      // 归属。单机个人版这两个字段是空的，一切照旧；多人装机里它们是上面 allowed 的唯一依据，
      // 也是「这个人离职了，他的定时任务要跟着停」能落地的前提（见 lifecycle.js）
      user: String(user || ""),
      org: String(org || ""),
      created_at: new Date().toISOString(),
      last_run: null,
      last_result: null,
    };
    store.tasks.push(item);
    saveStore(store, file);
    return item;
  }

  /** 改一个已有任务（名字/时间/内容）。以前只能删了重建，改个时间点就丢了运行记录 */
  function update(id, patch, viewer) {
    const t = get(id, viewer);
    if (!t) return null;
    if (patch.name !== undefined) t.name = String(patch.name).trim() || t.name;
    if (patch.task !== undefined) {
      const v = String(patch.task).trim();
      if (!v) throw new Error("任务描述不能为空");
      t.task = v;
    }
    if (patch.at !== undefined) {
      if (patch.at) { t.at = parseAt(patch.at); t.cron = ""; t.enabled = true; delete t.fired_at; } // 改了时刻就是要它再响一次
      else delete t.at;                                                                            // 显式清空 = 改回周期任务
    }
    if (patch.cron !== undefined && patch.cron) {
      parseCron(patch.cron); // 校验：写坏了当场报，别等到永远不触发才发现
      t.cron = String(patch.cron).trim();
      delete t.at; // 排成周期的就不再是「只跑一次」了，留着 at 会在界面上画出两个时间
    }
    if (!t.cron && !t.at) throw new Error("排期时间不能清空：要么给 cron，要么给一次性时刻");
    if (patch.catch_up !== undefined) t.catch_up = !!patch.catch_up;
    saveStore(store, file);
    return t;
  }

  /** 运行记录，最近的在前。运行记录里带着任务产出的原文，跟任务本体同一条归属判据 */
  function runs(limit = 100, viewer) {
    const own = new Set(store.tasks.filter((t) => allowed(t, viewer)).map((t) => t.id));
    const mine = viewer ? store.runs.filter((r) => own.has(r.task_id)) : store.runs;
    return mine.slice(-Math.max(1, limit)).reverse();
  }

  function remove(id, viewer) {
    if (!get(id, viewer)) return false;               // 不是你的，就当没这条
    const before = store.tasks.length;
    store.tasks = store.tasks.filter((t) => t.id !== id);
    forgetRuns(store.runs.filter((r) => r.task_id === id));
    store.runs = store.runs.filter((r) => r.task_id !== id);
    saveStore(store, file);
    return store.tasks.length < before;
  }

  function toggle(id, enabled, viewer) {
    const t = get(id, viewer);
    if (!t) return false;
    t.enabled = enabled;
    saveStore(store, file);
    return true;
  }

  /** 错过了补不补跑 */
  function setCatchUp(id, on, viewer) {
    const t = get(id, viewer);
    if (!t) return false;
    t.catch_up = !!on;
    saveStore(store, file);
    return true;
  }

  /**
   * 某个人名下的排期全部停掉，返回停掉的那几条。办离职用（见 lifecycle.js）。
   *
   * 为什么是停用不是删除：定时任务是交接物。人走了，任务本身多半还得有人接着跑，
   * 删掉就只剩「上个月那份周报是怎么来的」这种没人答得上来的问题了。
   * 停用之后管理员在后台看得见、能改归属、能重新打开。
   */
  function disableOwnedBy(username) {
    const name = String(username || "");
    if (!name) return [];
    const hit = store.tasks.filter((t) => t.user === name && t.enabled);
    for (const t of hit) { t.enabled = false; t.disabled_reason = "原负责人已离职"; }
    if (hit.length) saveStore(store, file);
    return hit.map((t) => ({ id: t.id, name: t.name }));
  }

  /** 排期换负责人。离职交接用：不换的话这条任务永远停在那儿没人认领 */
  function reassign(id, username) {
    const t = store.tasks.find((x) => x.id === id);
    if (!t) return null;
    t.user = String(username || "");
    delete t.disabled_reason;
    saveStore(store, file);
    return t;
  }

  async function runOne(ref, trigger) {
    // list() 出去的是副本，外面拿着副本回来跑的话，进度会写在副本上存不下来——一律换回本体
    const item = store.tasks.find((t) => t.id === (ref && ref.id ? ref.id : ref));
    if (!item) throw new Error("任务不存在");
    if (running.has(item.id)) {
      const since = new Date(running.get(item.id)).toTimeString().slice(0, 5);
      throw new Error(`这个任务正在跑（${since} 开始），等它跑完再说`);
    }
    console.log(`[定时任务] 触发 (${trigger}): ${item.name}`);
    running.set(item.id, Date.now());
    const startedMs = Date.now();
    item.last_run = new Date().toISOString();
    item.last_trigger = trigger;
    const run = {
      id: "run_" + startedMs.toString(36) + Math.random().toString(36).slice(2, 6),
      task_id: item.id,
      name: item.name,
      trigger,
      started_at: item.last_run,
      ended_at: null,
      ok: null,
      ms: 0,
      result: "",
    };
    store.runs.push(run);
    if (store.runs.length > MAX_RUNS) forgetRuns(store.runs.splice(0, store.runs.length - MAX_RUNS));
    saveStore(store, file);
    const finish = (ok, text) => {
      run.ok = ok;
      run.ended_at = new Date().toISOString();
      run.ms = Date.now() - startedMs;
      run.result = String(text || "").slice(0, 500);
    };
    // 裁定判失败时不能在 try 里直接抛——那会被下面的 catch 接住，再套一层「出错:」。
    // 先记下来，等 finally 把 running 锁松开之后再抛出去。
    let verdictErr = null;
    // 这一趟的录像机。
    // 以前这儿是光秃秃一句 runTask({ history })：不给 emit 就没有事件，不给 sessionId 就没有会话，
    // 于是整趟执行只在运行记录上留下一句被截到 500 字的结果，想知道「它到底调了什么、卡在哪一步」
    // 一点痕迹都查不到。现在录进一段跟手动对话完全同构的会话，前端那条「看执行过程」直接回放它。
    // 录像本身不许影响执行：起录像失败就当没这回事继续跑，别让一条定时任务因为存盘问题不执行。
    let rec = null;
    if (recorder) {
      try {
        rec = recorder({ item, trigger, run });
      } catch (e) {
        console.warn(`[定时任务] ${item.name} 起执行记录失败（不影响执行）：${e.message}`);
      }
    }
    if (rec && rec.sessionId) {
      run.session_id = rec.sessionId;
      saveStore(store, file); // 先把 id 落盘：任务跑到一半崩了，那半段过程也还找得回来
    }
    const closeRec = (ok, text) => {
      if (!rec || !rec.done) return;
      try { rec.done(ok, text); } catch (e) { console.warn(`[定时任务] ${item.name} 执行记录收尾失败：${e.message}`); }
      rec = null; // 只收一次
    };
    try {
      // 每次执行用全新会话，避免历史无限增长
      const history = [{ role: "user", content: item.task }];
      // stopped 是 runTask 自己报的「撞上限 / 模型挂死 / 手动停止」。以前这里把它解构掉了，
      // 于是一个跑满 25 步被强制收尾的任务，运行记录里照样是个 ✅——活没干完却显示干成了。
      const { finalText, stopped } = await runtime.runTask({ history, ...((rec && rec.opts) || {}) });
      const v = judgeRun({ result: finalText, stopped });
      if (v.ok) {
        item.last_result = (finalText || "完成").slice(0, 500);
        finish(true, finalText || "完成");
        closeRec(true, finalText || "完成");
        saveStore(store, file);
        if (onResult) await onResult(item, finalText);
        return finalText;
      }
      // 把「看起来成功」翻译成「到底成不成」：判据和下一步动作单独存字段，
      // 好让运行记录能回答「这条为什么红」，而不只是「它红了」。
      const msg = verdictMessage(v, finalText);
      run.reason = v.reason;
      run.label = v.label;
      run.hint = v.hint;
      run.retryable = v.retryable;
      item.last_result = msg.slice(0, 500);
      finish(false, msg);
      closeRec(false, msg);
      saveStore(store, file);
      if (onResult) await onResult(item, msg);
      verdictErr = Object.assign(new Error(msg), { verdict: v });
    } catch (e) {
      // 同一个根因从 error 这个口子上来时也得有药方。不然「连不上上游」这类坑
      // 一次有诊断一次没有，全看它是被 agent 当正文汇报了出来、还是直接抛成了异常。
      const why = explainRunError(e.message);
      item.last_result = ("出错: " + why).slice(0, 500);
      finish(false, "出错: " + why);
      closeRec(false, "出错: " + why);
      saveStore(store, file);
      if (onResult) await onResult(item, "执行出错: " + why);
      throw e;
    } finally {
      running.delete(item.id);
      closeRec(false, "执行中断"); // 上面三条路都收过了；能走到这儿的只剩没预料到的退出方式
    }
    throw verdictErr;
  }

  /**
   * 「只跑一次」那条：到点了就放它走，然后当场关掉自己。
   *
   * 关掉这一下必须**同步**做在 fire 之前。fire 是异步的，等任务跑完再关的话，
   * 中间每一分钟的 tick 都会看见它还开着、时刻也还是过去时——一条五分钟的提醒会连着响到你关掉它。
   *
   * 关机错过了照样补：这正是一次性提醒最该补的场合（合上笔记本去开会，回来该看见它响过）。
   * 但补也有个头——隔了一天的「五分钟后叫我」再响就是骚扰了，那时候事早过去了。
   */
  function fireOnce(item, nowMs) {
    const due = Date.parse(item.at);
    if (isNaN(due)) { console.warn(`[定时任务] ${item.name} 的时刻「${item.at}」读不出来，关掉`); item.enabled = false; return; }
    if (due > nowMs) return;
    const late = nowMs - due;
    item.enabled = false;
    item.fired_at = new Date().toISOString();
    if (late > MAX_CATCHUP_MS || (item.catch_up === false && late > GAP_MS)) {
      item.last_result = `错过了（该在 ${new Date(due).toLocaleString("zh-CN")} 跑，晚了 ${Math.round(late / 60000)} 分钟）`;
      console.log(`[定时任务] ${item.name} 错过太久，不补跑了`);
      return;
    }
    fire(item, late > GAP_MS ? "补跑" : "定时");
  }

  function fire(item, trigger) {
    if (running.has(item.id)) {
      console.log(`[定时任务] ${item.name} 上一次还没跑完，跳过这次`);
      return false;
    }
    runOne(item, trigger).catch((e) => console.error(`[定时任务] ${item.name} 失败:`, e.message));
    return true;
  }

  /**
   * 中间断了一段（睡眠、应用关着）时，把那段时间里本该触发的任务捞出来。
   * 一段里命中几次也只补跑一次，补的是最近该跑的那次——补跑是「这件事还没做」，
   * 不是把闹钟按错过的次数重放一遍。返回补了哪些 id。
   */
  function catchUp(fromMs, toMs) {
    const fired = new Set();
    const start = Math.max(fromMs, toMs - MAX_CATCHUP_MS);
    if (toMs - fromMs > MAX_CATCHUP_MS) {
      console.warn(`[定时任务] 停了 ${Math.round((toMs - fromMs) / 3600000)} 小时，只补最近 24 小时的，更早的按过期丢掉`);
    }
    // 从断点后的下一分钟找到本次 tick 的前一分钟；当前这一分钟走正常路径，别重复
    const from = Math.floor(start / 60000) * 60000 + 60000;
    const to = Math.floor(toMs / 60000) * 60000;
    for (const item of store.tasks) {
      if (!item.enabled || item.catch_up === false) continue;
      if (item.at) continue; // 一次性的不走这条：fireOnce 只看「到点没」，本来就自带补跑
      let cron;
      try { cron = parseCron(item.cron); } catch { continue; }
      let at = null;
      for (let ms = from; ms < to; ms += 60000) {
        const d = new Date(ms);
        if (cronMatches(cron, d)) at = d;
      }
      if (!at) continue;
      item.missed_at = at.toISOString();
      console.log(`[定时任务] ${item.name} 错过了 ${at.toTimeString().slice(0, 5)} 那次，现在补跑`);
      if (fire(item, "补跑")) fired.add(item.id);
    }
    return fired;
  }

  function tick() {
    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (key === lastMinuteKey) return; // 每分钟只判断一次
    lastMinuteKey = key;
    const nowMs = now.getTime();
    let caught = new Set();
    if (lastTickMs && nowMs - lastTickMs > GAP_MS) {
      try { caught = catchUp(lastTickMs, nowMs); } catch (e) { console.warn("[定时任务] 补跑检查出错:", e.message); }
    }
    lastTickMs = nowMs;
    store.last_tick_at = now.toISOString();
    for (const item of store.tasks) {
      if (!item.enabled || caught.has(item.id)) continue; // 刚补跑过的这次就别再来一遍
      try {
        if (item.at) { fireOnce(item, nowMs); continue; }
        if (cronMatches(parseCron(item.cron), now)) fire(item, "cron");
      } catch (e) {
        console.warn(`[定时任务] ${item.name} cron 无效:`, e.message);
      }
    }
    saveStore(store, file);
  }

  const timer = setInterval(tick, 20000);
  timer.unref && timer.unref();

  return { list, get, add, update, remove, toggle, setCatchUp, disableOwnedBy, reassign, runOne, runs, tick, catchUp, stop: () => clearInterval(timer) };
}

module.exports = { createScheduler, parseCron, cronMatches, describeCron, parseAt, describeWhen, setActiveScheduler, activeScheduler, SCHEDULE_LABEL };
