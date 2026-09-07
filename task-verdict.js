"use strict";
/**
 * 定时任务「这一轮到底算不算干成了」的裁定。
 *
 * ## 为什么要有这一层
 *
 * scheduler.js 原来的判据是「runTask 没抛异常 = 成功」：
 *
 *     const { finalText } = await runtime.runTask({ history });
 *     finish(true, finalText || "完成");
 *
 * 于是下面这几种情况，运行记录里全是一片 ✅：
 *   · runTask 撞了「最大步数 / 最大运行时间」强制收尾——它自己 return 了 stopped，
 *     而调用方**把这个字段解构掉了**，活没干完却记成功；
 *   · finalText 整条就是上游报错的原话（余额不足 / 限流 / 连不上），没抛异常是因为
 *     报错发生在 agent 内部、被它当成正文汇报了出来；
 *   · agent 一个字都没吐（空 finalText），被 `finalText || "完成"` 补成了「完成」；
 *   · agent 说「我把活丢后台了，跑完通知你」就收工——而本轮进程一收尾，它起的后台
 *     子进程跟着被回收，没人接得住结果。
 *
 * 这一层就干一件事：把「看起来成功」翻译成「到底成不成」，并给一句能照着做的中文。
 *
 * ## 判据分两类，优先级不同
 *
 * 1. **结构信号**（`stopped`）——不猜，agent 自己报的。撞上限、模型挂死、手动停止，
 *    runTask 已经在 return 里写明白了，只是以前没人接。这类零误判。
 * 2. **文本信号**（正则）——只在结构信号没话说时才轮到，而且**刻意保守**：只在
 *    「整条回复就是那句报错」时才翻案（正文很短 + 命中特征）。agent 在长篇汇报里
 *    提一嘴「我遇到过限流但换了条路走通了」不算失败，那是它在如实交代过程。
 *
 * 判据顺序即优先级，越具体越靠前。「余额不足」必须排在「限流」前面——两者的原话
 * 都可能带 429，但充值和等窗口是两码事，指错方向比不指方向贵得多。
 *
 * 借鉴自 CatClaw 的 src/task-run-outcome.ts（那边是翻了 91 条真实运行日志、
 * 前后四次被逃逸打脸才磨出来的规则），这里按 OpenWorkBuddy 自己的报错文案和
 * 设置路径重写了药方，并把它独有的结构信号 `stopped` 提到了正则前面。
 */

/** 正文超过这个长度就认为 agent 真干活了，哪怕里面提到过报错关键词也不翻案。 */
const ERROR_ONLY_MAX_CHARS = 400;

/** 正文短于这个长度、且通篇在说「我丢后台了/稍后汇报」，就不算这一轮交付完成。 */
const DEFERRAL_MAX_CHARS = 300;

/** 「话没说完」同理：正文都几百字了，末尾断在逗号上也多半已经交付过了，别翻案。 */
const TRUNCATED_MAX_CHARS = 300;

// 「这活我没干完，我起了个后台 / 等会儿再说」——定时任务里这等于没干。
// 动词写全一点：只收「后台继续/运行」的话，「已在后台**启动**」「我会在后台**盯着**」整句逃逸。
const DEFERRAL_MARKERS =
  /后台(继续|运行|跑|轮询|执行|处理|启动|盯|监控|待命)|[（(]?(丢|放|扔|挂)(到|进|在)?后台|已设.{0,6}(轮询|监听|定时|唤醒)|仍在(运行|执行|进行|跑)|正在(运行|执行|抓取|生成|部署|构建)|运行中|等待中|稍后(再|会|将)?(汇报|通知|反馈|推送|同步)|still running|in the background|will (report|notify|update|follow up)|kicked off|polling/i;

// 比上面更硬的证据：整条回复就是个占位收尾。它能**单独成案**，不必先过上面那道门——
// 「我等会儿再说」比「有东西在跑」更明确地说明这一轮没交付。
const TERMINAL_DEFERRAL_MARKERS =
  /等待中|等候中|稍后[^。；\n]{0,10}(汇报|通知|反馈|推送|同步|发你|发给|给你|提供)|(完成|结束|退出|报错|跑完|出来|好了)(后|时)?[^。；\n]{0,14}(再|会|将)?[^。；\n]{0,6}(通知|汇报|反馈|继续|推送|同步)(你|我|一下)?|still running|will (report|notify|update|follow up)|i'?ll (report|update|let you know)/i;

// 有这些词说明活已经落地了。注意不能用裸的「完成」——「完成后会通知你」恰恰是没完成。
const COMPLETION_MARKERS =
  /已(完成|推送|生成|部署|更新|发布|提交|写入|发送|保存)|完毕|✅|done|completed|finished|pushed|deployed/i;

/**
 * 「话说到一半就没了」——正文以**下文提示符**收尾：冒号、逗号、顿号、破折号。
 * 敢用标点单独成案是因为这是结构信号不是关键词猜测：冒号的语义就是「下文马上来」，
 * 而下文没来；一条交付完成的回复不会停在逗号上。
 */
const DANGLING_TAIL = /[：:，,、]\s*$|——\s*$/;

/**
 * 同一类的另一种收尾：最后一句在**宣布下一步动作**，句子完整，可下一步没来。
 * `let me` 后面刻意排掉 `know`：`Let me know if you need more.` 是客套收尾不是宣告，
 * 而它恰恰是长篇汇报最爱的结尾句，不排掉会把真交付判成失败。
 */
const ANNOUNCEMENT_TAIL =
  /\b(let me(?! know)|let'?s|i'?m going to|i am going to)\b[^.!?\n]{0,60}[.!]?\s*$/i;

/**
 * 上游故障分类表。顺序即优先级。
 * retryable：这一类**过一会儿重跑可能就好**（限流、瞬时断流）。余额不足和 key 失效
 * 重跑一百遍还是一样，标 false——不然「自动重试」就变成了每小时白烧一轮。
 */
const UPSTREAM_FAILURES = [
  {
    test: /余额不足|欠费|credit balance is too low|insufficient (credit|balance|quota)|billing|payment required|402/i,
    label: "渠道余额 / 额度不足",
    hint: "去 设置 → 模型 给这条渠道充值，或换一条有余额的；不换的话每天到点都会白跑一轮。想让它自己接上，在 设置 → 智能体设置 里指定「备用渠道」。",
    retryable: false,
  },
  {
    test: /invalid[_ ]api[_ ]key|incorrect api key|401 Unauthorized|\b401\b|authentication[_ ]error|无效的?\s*(API\s*)?[Kk]ey|未授权/i,
    label: "渠道 Key 失效或没权限",
    hint: "设置 → 模型 里重填这条渠道的 API Key（多半是过期、被回收或复制时少了一截）。重跑解决不了，任务会一直红到 Key 换掉为止。",
    retryable: false,
  },
  {
    test: /rate[_ ]?limit|usage limit reached|\b429\b|too many requests|overloaded|请求过于频繁/i,
    label: "被限流 / 额度打满",
    hint: "等窗口重置就好。如果固定在这个点撞限流，把任务时间挪开高峰，或在 设置 → 智能体设置 配一条「备用渠道」分流。",
    retryable: true,
  },
  {
    // 必须排在「连不上上游」前面：拿到过半截响应 = 连是连上了，别派人去查代理。
    // 这条是本机记忆 feedback_stream_broken_not_network 的落地：断流≠断网。
    test: /空闲超时|stream idle timeout|partial response received|stream (was )?(interrupted|closed) (mid|during)|incomplete stream|上游在流中途报错|finish_reason=error|连接建立后没有收到任何内容/i,
    label: "上游那条流中途断了",
    hint: "**不是网络配置问题，别去动代理的 skip-proxy**：既然收到了半截响应，说明 DNS、证书、TCP 三件事全成了，断在后面——上游那条流中途不出字了。这类多半是瞬时的，重跑通常就好；固定时段复现的话，先怀疑本机睡眠或网络切换把长连接掐了。",
    retryable: true,
  },
  {
    // 这里刻意**不**收裸的 `LLM 接口错误`：那是个通配符，会把所有上游报错都吸过来，
    // 然后一律开出「查代理 DNS」这张具体药方。通配的活交给最后那条兜底规则。
    test: /Unable to connect|ECONNREFUSED|ConnectionRefused|ENOTFOUND|EAI_AGAIN|CERTIFICATE_VERIFICATION|self.signed certificate|socket hang up|ETIMEDOUT|EAI_NODATA|fetch failed/i,
    label: "连不上上游（网络 / DNS / 代理）",
    hint: "老坑：代理开 fake-ip 模式会污染 DNS，导致证书校验失败。把上游域名加进代理的 skip-proxy，或临时关掉代理再试。",
    retryable: true,
  },
  {
    // 用 ^…$ 锚死整条正文：这几个字太常见，agent 在长篇里写「第一次超时，重试后拿到了」
    // 是**成功**，不能翻案。只吃「整条回复就这一句」的情形。
    test: /^\s*(request timed out|请求超时|操作超时|read timeout|gateway time-?out|超时了?)[.。!！]?\s*$/i,
    label: "上游请求超时",
    hint: "这一轮只回了一句超时就结束了，活没干。别去动代理——请求超时说明连接是建起来了、上游迟迟不回。多半是瞬时的；固定时段复现就看看这台机器当时是不是睡过去了。",
    retryable: true,
  },
  // 兜底，排最后。宁可说「认不出」，也不要拿一张具体药方去套一个没认出来的病。
  {
    test: /LLM 接口错误|API Error|upstream error|\b5\d\d\b\s*(error)?/i,
    label: "上游报错（未归类）",
    hint: "这条不属于余额 / Key / 限流 / 断网那几类常见故障，照原话查。反复出现就把原话贴进 issue，好给它单开一条判据。",
    retryable: true,
  },
];

/** 最后一次命中的位置；没命中返回 -1。用它比较「落点是交付还是等待」。 */
function lastMatchIndex(pattern, text) {
  const g = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  let index = -1;
  for (const m of text.matchAll(g)) if (typeof m.index === "number") index = m.index;
  return index;
}

/**
 * 裁定一次 agent 运行的真实成败。
 *
 * @param {object} p
 * @param {string|null} p.result   agent 产出的最终正文（空 = 一个字都没有）
 * @param {string|null} p.error    执行层已经捕获到的异常（有值就已经是红的，这里只负责给它配一句诊断）
 * @param {string|null} p.stopped  runTask 返回的 stopped 字段：撞上限 / 模型挂死 / 手动停止
 * @returns {{ok:true}|{ok:false,reason:string,label:string,hint:string,retryable:boolean}}
 */
function judgeRun({ result, error, stopped } = {}) {
  if (error) return { ok: true }; // 已经是 error 了，轮不到这里翻案（诊断走 explainRunError）
  const text = String(result == null ? "" : result).trim();
  const stop = String(stopped == null ? "" : stopped).trim();

  // ---------- 第一类：结构信号。agent 自己报的，不猜 ----------
  if (stop) {
    if (stop.startsWith("已手动停止")) {
      return {
        ok: false, reason: "stopped", retryable: false,
        label: "被手动停止",
        hint: "这一轮是人按停的，没跑完。定时任务通常不该有人按停——如果不是你干的，看看是不是应用退出/重启把它掐了。",
      };
    }
    if (stop.startsWith("模型响应超时") || stop.startsWith("模型挂")) {
      return {
        ok: false, reason: "model_stall", retryable: true,
        label: "模型中途挂死（" + stop + "）",
        hint: "模型连续不出字，被空闲超时掐断，活没干完。多半是瞬时的，下个周期照跑；老是这样就在 设置 → 模型 换条渠道，或调大「模型响应超时」。",
      };
    }
    // 剩下的是「已达最大步数 / 已达最大运行时间」。注意它跟前两类的区别：
    // 这类**干了活只是没干完**，重跑一遍是从零开始重做，不是接着做——所以不建议重试，
    // 该做的是开自动续跑（它会带着 PROGRESS.md 从断点接上）或者把任务拆小。
    return {
      ok: false, reason: "budget_exhausted", retryable: false,
      label: "跑满预算被强制收尾（" + stop + "）",
      hint: "任务没做完就被上限掐了。三条路：把任务拆小；在 设置 → 智能体设置 调大步数/时长上限；或者打开「长任务自动续跑」——它靠工作目录的 PROGRESS.md 从断点接着做，不会重头再来。直接重跑是从零开始重做，最贵。",
    };
  }

  // ---------- 第二类：文本信号。只在结构信号没话说时才轮到 ----------
  if (!text) {
    return {
      ok: false, reason: "no_output", retryable: true,
      label: "Agent 一个字都没产出",
      hint: "这一轮 agent 没吐一个字就结束了——多半是渠道直接拒了、或者模型返回了空响应。翻这一条的会话日志看它停在哪；任务本身还在，下个周期照跑。",
    };
  }

  // 只在「整条结果就是那句报错」时翻案：正文短 + 命中特征。
  if (text.length <= ERROR_ONLY_MAX_CHARS) {
    for (const p of UPSTREAM_FAILURES) {
      if (p.test.test(text)) {
        return { ok: false, reason: "upstream_error", label: p.label, hint: p.hint, retryable: p.retryable };
      }
    }
  }

  // 「我把活丢后台了，跑完再通知你」——定时任务这一轮实际上什么都没交付。
  // 完成词的豁免按**落点**算，不按「出现过没有」算：一篇 ≤300 字的回复，最后落在
  // 「等待中」上就是没交付；落在「已推送 ✅」上才算交付。子步骤完成 ≠ 这一轮交付完成。
  const deliveredAt = lastMatchIndex(COMPLETION_MARKERS, text);
  const waitingAt = lastMatchIndex(TERMINAL_DEFERRAL_MARKERS, text);
  if (
    text.length <= DEFERRAL_MAX_CHARS &&
    (DEFERRAL_MARKERS.test(text) || waitingAt >= 0) &&
    (deliveredAt < 0 || waitingAt > deliveredAt)
  ) {
    return {
      ok: false, reason: "deferred", retryable: false,
      label: "Agent 把活丢给后台就收工了",
      hint: "定时任务这一轮必须同步干完：本轮一收尾，它起的后台轮询/子进程就跟着被回收，没人接得住结果。在任务描述里写明「阻塞等到脚本退出、拿到结果再汇报」，或者把耗时那步拆成独立任务。",
    };
  }

  // 「开场白说完就没了」——正文短、停在冒号/逗号这类下文提示符上，且**通篇没有一处完成词**。
  // 这里完成词按「出现过没有」豁免，跟上面刻意不同：那条防的是「子步骤完成≠交付完成」，
  // 必须比落点；这条防的是「话没说完」，而一条已经写出「已推送 ✅」的回复即便末尾被截断，
  // 该交付的事实上已经交付了。新判据宁可漏判也不误判。
  if (
    text.length <= TRUNCATED_MAX_CHARS &&
    (DANGLING_TAIL.test(text) || ANNOUNCEMENT_TAIL.test(text)) &&
    deliveredAt < 0
  ) {
    return {
      ok: false, reason: "truncated", retryable: true,
      label: "Agent 话说到一半就收工了",
      hint: "只吐了个开场白（正文停在冒号/逗号上）就结束了，活没干。多半是它把要执行的命令「说」了出来却没真发出去。翻这一条的会话日志看它停在哪一步；反复出现就把任务描述的第一句改成「先执行、拿到结果再开口」。",
    };
  }

  return { ok: true };
}

/**
 * 给执行层已经抛出的 error 补上中文诊断。
 *
 * 为什么需要：同一个根因，走哪条路上来决定了用户看到什么。断网从 **result** 上来时
 * judgeRun 认得出、通知里带着能照做的话；同样的断网只要是从 **error** 上来的，
 * judgeRun 第一行就让路了，用户收到的只有一句 `出错: LLM 接口错误 502: …`——
 * 同一个坑，一次有药方一次没有，全看它从哪个口子冒出来。
 *
 * 认不出来就原样返回，绝不套壳：agent 自己产的超时文案本来就是说人话的中文。
 */
function explainRunError(error) {
  const raw = String(error == null ? "" : error).trim();
  if (!raw) return error;
  for (const p of UPSTREAM_FAILURES) {
    if (p.test.test(raw)) return `${p.label}——${p.hint}\n上游原话：${raw.slice(0, 300)}`;
  }
  return error;
}

/** 拼给运行记录 / IM 通知的一句话。 */
function verdictMessage(v, result) {
  const raw = String(result == null ? "" : result).trim();
  return `${v.label}——${v.hint}${raw ? "\n上游原话：" + raw.slice(0, 300) : ""}`;
}

module.exports = { judgeRun, explainRunError, verdictMessage, UPSTREAM_FAILURES };
