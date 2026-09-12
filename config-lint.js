"use strict";
/**
 * 配置体检 —— 手改 config.json 时写错了，当场说出来。
 *
 * 这个文件是明确让人手改的（README 里就写着往里填 API Key）。可它是一份 JSON：
 * 键名拼错一个字母、端口写成了带引号的 "3800"，程序既不会报错也不会生效，
 * 就当那一行不存在。用户看到的是「我明明改了啊，怎么一点反应没有」，
 * 然后开始怀疑是不是没保存、是不是要重启、是不是这个功能坏了——查半天，最后发现是少了个字母。
 *
 * 所以这儿只做三件很小的事，条条都是「不说就一定查不出来」的那种：
 *   1. 键名疑似拼错  —— 只在跟某个已知键**很像**的时候才喊（差一两个字母）。
 *      不像的一律闭嘴：程序自己也会往配置里加键（projects、security、shortcuts……），
 *      见一个生键就喊一句，喊到第三次用户就再也不看这些提示了。
 *   2. 类型写错     —— 该给数字给了字符串、该给数组给了对象这种。端口尤其常见。
 *   3. 取值不在册   —— provider 只认 openai / anthropic 两个。
 *
 * 不做的事：不判断值对不对（Key 有没有效、地址通不通），那是 wb doctor 和渠道测试的活儿。
 */

const KIND = (v) => (Array.isArray(v) ? "数组" : v === null ? "空值" : typeof v === "object" ? "对象" : typeof v === "number" ? "数字" : typeof v === "boolean" ? "是否" : "文本");

/** 编辑距离，只用来判「像不像」，所以够用就行 */
function distance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 9;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** 在一组已知键里找最像的那个。不够像就返回空——宁可不提示，也不要瞎猜 */
function nearest(key, known) {
  let best = "", bestD = 9;
  const k = key.toLowerCase();
  for (const c of known) {
    const d = distance(k, c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  // 短键容错要更严：ai / im 这种两三个字母的，差一个就是另一个词了
  const limit = key.length <= 4 ? 1 : 2;
  return bestD <= limit ? best : "";
}

/**
 * 程序自己会往配置里加、但模板里没写的正经设置项。
 *
 * 列在这儿只为一件事：别让下面「是不是拼错了」的逻辑误伤它们。最典型的是 providers——
 * 它跟模板里的 provider 只差一个字母，不列出来就会被当成拼写错误天天喊。
 */
const KNOWN_EXTRA = {
  "": ["active_project", "assist_model", "assistant", "backup", "diagram", "embedding", "evolve", "last_picked_model",
       "media", "media_models", "model_follow_last", "onboarding", "persona", "pet", "projects", "providers",
       "security", "shortcuts", "workspace_dir"],
  server: ["host"],
  agent: ["auto_continue_rounds", "compact_keep_chars", "compact_keep_turns", "compact_threshold_chars", "engine",
          "engine_options", "failover_model", "max_context_chars", "max_tokens_budget"],
  im: ["permission_mode", "qq", "session_idle_hours", "wechat_ilink", "wechat_mp", "wecom_app"],
};

// 值必须在册的几个键。写错这里不是「不生效」，是启动直接抛一句用户看不懂的话
const ENUMS = {
  provider: ["openai", "anthropic"],
  "agent.engine": ["builtin", "claude-code", "codex"],
};

/**
 * 体检。
 * @param {object} config   实际读到的配置（还没被 fillDefaults 补过默认值的那份最准，补过的也能查）
 * @param {object} defaults config.example.json 的内容，当「已知键都长什么样」的底册
 * @returns {Array<{level:"warn"|"bad", path:string, text:string, hint:string}>}
 */
function lint(config, defaults) {
  const out = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return out;
  const def = defaults && typeof defaults === "object" ? defaults : {};

  const walk = (cur, dft, prefix) => {
    const extra = KNOWN_EXTRA[prefix] || [];
    const known = Object.keys(dft).filter((k) => !k.startsWith("_")).concat(extra);
    for (const [k, v] of Object.entries(cur)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (k.startsWith("_")) continue; // 模板里那几条 _说明 / _mcp_示例 是写给人看的注释
      // 取值在不在册，先于「这个键认不认识」判：agent.engine 这类模板里压根没写，
      // 但写错了是启动当场抛错，比一个不生效的键严重得多
      if (ENUMS[p] && typeof v === "string" && v && !ENUMS[p].includes(v)) {
        out.push({ level: "bad", path: p, text: `${p} 写的是「${v}」，不在可选范围里`, hint: `只认这几个：${ENUMS[p].join(" / ")}。` });
      }
      if (!(k in dft)) {
        if (extra.includes(k)) continue; // 程序自己加的，正经设置项
        const guess = nearest(k, known);
        // 只有「很像某个已知键」才喊。生键天天有，不像的一概不管——喊三次狼，用户就再也不看这些提示了
        if (guess) out.push({ level: "warn", path: p, text: `配置里有个 ${p}，但没有这个设置项`, hint: `是不是想写 ${prefix ? prefix + "." : ""}${guess}？写错的那一行现在完全不生效。` });
        continue;
      }
      const want = KIND(dft[k]);
      const got = KIND(v);
      // 模板里留空的（""、null、[]）不拿来判类型：那本来就是「等你填」的占位
      const templateIsBlank = dft[k] === "" || dft[k] === null || (Array.isArray(dft[k]) && !dft[k].length);
      if (!templateIsBlank && want !== got && !(want === "数字" && got === "文本" && v === "")) {
        out.push({
          level: p === "server.port" ? "bad" : "warn",
          path: p,
          text: `${p} 应该是${want}，现在写的是${got}（${JSON.stringify(v).slice(0, 40)}）`,
          hint: want === "数字" ? `去掉两边的引号：${k}: ${String(v).replace(/^"|"$/g, "") || 3800}` : `照 config.example.json 里 ${p} 的写法改。`,
        });
      }
      // 只往下钻一层，跟 server.js 的 fillDefaults 同一个深度：再深就是 models 这种用户自定表了
      if (!prefix && KIND(dft[k]) === "对象" && KIND(v) === "对象") walk(v, dft[k], p);
    }
  };
  walk(config, def, "");
  return out;
}

/** 排成一行一条，给启动日志和 wb doctor 共用，免得两边说法不一样 */
function lines(found) {
  return found.map((f) => `${f.level === "bad" ? "×" : "▲"} ${f.text}　${f.hint}`);
}

module.exports = { lint, lines, nearest, distance, ENUMS, KNOWN_EXTRA };
