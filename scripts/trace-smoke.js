// SPDX-License-Identifier: MIT
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
// 真实安装包/源码启动核对；隔离账号和工作区，只用本机 CLI，不连接用户的消息渠道。
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), http = require("http"), crypto = require("crypto"), assert = require("assert/strict");
const root = path.resolve(__dirname, ".."), pkg = require(path.join(root, "package.json"));
const product = pkg.productName || "OpenWorkBuddy", prefix = pkg.name.toUpperCase();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "trace-smoke-"));
const pause = ms => new Promise(r => setTimeout(r, ms));
let child, ws, seq = 0, logs = "";
const pending = new Map();
function cmd(method, params = {}) { return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) {
  const r = await cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expression, seconds = 20) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) { if (await evaluate(expression)) return; await pause(250); }
  throw Error("页面核对超时：" + expression.slice(0, 80));
}
async function librarySmoke() {
  await evaluate("document.getElementById('onb-mask')?.classList.remove('show');openPageView('lib');true");
  await waitFor("!!document.getElementById('lb-q')");
  await evaluate(`window._libraryInput=document.getElementById('lb-q');_libraryInput.focus();
    window._librarySearches=[];window._libraryFetch=window.fetch;
    window.fetch=(url,opt)=>{if(String(url).startsWith('/api/library/search?')){_librarySearches.push(url);return new Promise(resolve=>setTimeout(()=>resolve(_libraryFetch(url,opt)),700));}return _libraryFetch(url,opt);};true`);
  for (const letter of "ppt") { await cmd("Input.insertText", { text: letter }); await pause(320); }
  await pause(1100);
  assert(await evaluate("document.getElementById('lb-q')===_libraryInput && _libraryInput.value==='ppt' && _libraryInput.selectionStart===3 && document.activeElement===_libraryInput && document.querySelector('.lib-where').textContent.includes('ppt')"), "慢搜索返回时英文顺序、焦点和光标必须正确");
  console.log("PASS 资料库实际键入 ppt，搜索返回后文字、光标和焦点保持正确");
  await evaluate(`window._beforeComposition=_librarySearches.length;_libraryInput.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));_libraryInput.value='pin';_libraryInput.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));true`);
  await pause(400);
  assert(await evaluate("_librarySearches.length===_beforeComposition && document.getElementById('lb-q')===_libraryInput"), "输入法未确认不能开始搜索");
  await evaluate(`_libraryInput.value='拼音';_libraryInput.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'拼音'}));_libraryInput.dispatchEvent(new InputEvent('input',{bubbles:true}));true`);
  await pause(1300);
  assert(await evaluate("_librarySearches.length===_beforeComposition+1 && _libraryInput.value==='拼音' && document.getElementById('lb-q')===_libraryInput"), "输入法确认后只搜索一次最终文字");
  await evaluate("window.fetch=_libraryFetch;true");
  console.log("PASS 输入法未确认不搜索，确认后仅搜索一次最终文字");
}
async function pageSearchSmoke() {
  for (const [kind, selector, render, query, sequence] of [
    ["proj", "#pj-q", "renderProjPage", "document.getElementById('assist-page')._q", "_projSeq"],
    ["autom", "#at-q", "renderAutomPage", "automState.q", "_automSeq"],
  ]) {
    await evaluate(`openPageView(${JSON.stringify(kind)});true`);
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
    await evaluate(`window._pageInput=document.querySelector(${JSON.stringify(selector)});_pageInput.focus();
      window._pageFetch=window.fetch;window._pageFetches=0;
      window.fetch=(url,opt)=>{if(/^\\/api\\/(projects|schedules)(?:[?\/]|$)/.test(String(url)))_pageFetches++;return _pageFetch(url,opt);};true`);
    for (const letter of "ppt") { await cmd("Input.insertText", { text: letter }); await pause(300); }
    assert(await evaluate(`document.querySelector(${JSON.stringify(selector)})===_pageInput && _pageInput.value==='ppt' && _pageInput.selectionStart===3 && document.activeElement===_pageInput && _pageFetches===0`), kind + " 搜索需保留输入与光标，不重复请求列表");
    console.log("PASS " + kind + " 实际键入 ppt 保持焦点和顺序，搜索未重复请求接口");
    await evaluate(`window._beforePageSearch=document.getElementById('assist-page')[${JSON.stringify(sequence)}];
      _pageInput.value='queued';_pageInput.dispatchEvent(new InputEvent('input',{bubbles:true}));
      _pageInput.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      _pageInput.value='pin';_pageInput.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));true`);
    await pause(350);
    assert(await evaluate(`${query}==='ppt' && document.getElementById('assist-page')[${JSON.stringify(sequence)}]===_beforePageSearch`), kind + " 组词前需取消未执行的搜索");
    await evaluate(`_pageInput.value='拼音';_pageInput.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'拼音'}));_pageInput.dispatchEvent(new InputEvent('input',{bubbles:true}));true`);
    await pause(350);
    assert(await evaluate(`${query}==='拼音' && document.getElementById('assist-page')[${JSON.stringify(sequence)}]===_beforePageSearch+1 && document.querySelector(${JSON.stringify(selector)})===_pageInput`), kind + " 确认输入后仅更新一次");
    await evaluate(`_pageInput.setSelectionRange(0,1,'backward');${render}().then(()=>true)`);
    assert(await evaluate(`document.querySelector(${JSON.stringify(selector)})===_pageInput && _pageInput.selectionStart===0 && _pageInput.selectionEnd===1 && _pageInput.selectionDirection==='backward' && document.activeElement===_pageInput`), kind + " 刷新数据时需保留原输入框与选区");
    const action = kind === "proj" ? "#pj-new" : "#at-new";
    await evaluate(`_pageInput.value='ppt';_pageInput.dispatchEvent(new InputEvent('input',{bubbles:true}));window._pageAction=document.querySelector(${JSON.stringify(action)});_pageAction.focus();true`);
    await pause(350);
    assert(await evaluate(`document.querySelector(${JSON.stringify(action)})===_pageAction && document.activeElement===_pageAction`), kind + " 搜索返回时不能抢走已移到按钮的焦点");
    await evaluate("window.fetch=_pageFetch;true");
    console.log("PASS " + kind + " 输入法确认后仅更新一次，刷新数据不重建输入框");
  }
  await evaluate(`window._runsFetch=window.fetch;window._releaseRuns=null;window.fetch=(url,opt)=>String(url).startsWith('/api/schedules/runs?')?new Promise(resolve=>{_releaseRuns=()=>resolve(_runsFetch(url,opt));}):_runsFetch(url,opt);automState.tab='runs';window._pendingRuns=renderAutomPage();true`);
  await waitFor("typeof _releaseRuns==='function'");
  await evaluate("automState.tab='tasks';renderAutomPage().then(()=>true)");
  await evaluate("_releaseRuns();_pendingRuns.then(()=>true)");
  assert(await evaluate("automState.tab==='tasks' && !!document.getElementById('at-q')"), "迟到的运行记录不能覆盖已切回的自动化列表");
  await evaluate("window.fetch=_runsFetch;true");
  console.log("PASS 运行记录迟到时不会覆盖已切回的任务列表");
  await evaluate("_pageInput.value='abandoned';_pageInput.dispatchEvent(new InputEvent('input',{bubbles:true}));openPageView('trace');true");
  await pause(400);
  assert(await evaluate("pageKind==='trace' && !document.getElementById('at-q')"), "离开页面后不能被旧搜索重新打开");
  console.log("PASS 页面切换后旧搜索不会覆盖新页面");
}
(async () => {
  const a = path.join(temp, "project-a"), b = path.join(temp, "project-b");
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(path.join(temp, "config.json"), JSON.stringify({ workspace_dir: a,
    projects: [{ name: "追踪项目A", dir: a }, { name: "追踪项目B", dir: b }], active_project: "追踪项目A",
    server: { host: "127.0.0.1", port: 0 }, models: [], provider: "openai", mcp_servers: [], im: {},
    agent: { engine: "codex", max_steps: 10, engine_options: { codex: { enabled: true, model: "gpt-6-luna", network: false } } },
  }));
  const listener = http.createServer(); await new Promise(r => listener.listen(0, "127.0.0.1", r));
  const debug = listener.address().port; await new Promise(r => listener.close(r));
  const source = process.argv.includes("--source");
  const executable = source ? path.join(root, "node_modules/.bin/electron")
    : process.argv.find((v, i) => i > 1 && !v.startsWith("--")) || path.join(root, "dist/mac-arm64", product + ".app/Contents/MacOS/" + product);
  const env = { ...process.env, [prefix + "_HOME"]: temp, [prefix + "_INSTALL_CLI"]: "0", PORT: "0", OWB_USER_DATA_DIR: path.join(temp, "profile"), OWB_SHELL_HIDDEN: "1", OWB_IMPORT_HOME: path.join(temp, "no-import") };
  for (const k of Object.keys(env)) if (/API.?KEY|TOKEN|SECRET|PASSWORD/i.test(k)) delete env[k];
  child = cp.spawn(executable, [...(source ? [root] : []), "--remote-debugging-port=" + debug], { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", x => { logs += x; }); child.stderr.on("data", x => { logs += x; });
  let state, targets;
  for (let i = 0; i < 400; i++) {
    if (child.exitCode !== null) throw Error("应用启动失败，退出码 " + child.exitCode);
    child.stdin.write("status\n"); await pause(250);
    const line = logs.split("\n").filter(x => x.startsWith("OWB_CTL ")).at(-1);
    if (!line) continue;
    state = JSON.parse(line.slice(8));
    if (!state.pageUp) continue;
    try { targets = await fetch("http://127.0.0.1:" + debug + "/json/list").then(r => r.json()); } catch {}
    if (targets && targets.some(t => t.type === "page")) break;
  }
  assert(state && state.pageUp, "应用必须实际启动并加载页面");
  const base = "http://127.0.0.1:" + state.port;
  const target = targets.find(t => t.type === "page" && t.url.startsWith(base)); assert(target);
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = event => { const d = JSON.parse(event.data), p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result); } };
  await evaluate(`fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'追踪检查',password:${JSON.stringify(crypto.randomBytes(16).toString("base64url"))}})}).then(r=>r.json())`);
  await cmd("Page.navigate", { url: base });
  await waitFor("typeof send==='function' && typeof curBusy==='function'"); await pause(1200);
  if (process.argv.includes("--search-only")) { await librarySmoke(); await pageSearchSmoke(); return; }
  if (process.argv.includes("--library-only")) { await librarySmoke(); return; }
  await evaluate(`document.getElementById('onb-mask')?.classList.remove('show');inputEl.value='请用工具执行 printf trace-smoke，然后回复追踪验证完成。只执行这一条命令，不联网、不改其他文件。';inputEl.dispatchEvent(new Event('input'));void send();true`);
  await pause(1200); await waitFor("!curBusy()", 180);
  const before = await evaluate("fetch('/api/traces').then(r=>r.json())");
  assert(before.traces && before.traces.length, "实际对话必须产生 Trace");
  console.log("PASS 实际对话已写入 Trace");
  const id = before.traces[0].id;
  const detail = await evaluate(`fetch('/api/traces/'+${JSON.stringify(id)}).then(r=>r.json())`);
  const tools = detail.trace.observations.filter(o => o.metadata && o.metadata.tool);
  if (!process.argv.includes("--expect-missing")) {
    assert(tools.length && tools.some(o => String(o.output).includes("trace-smoke")), "本机引擎工具步骤和实际输出必须可见");
    console.log("PASS 本机引擎工具步骤与结果可见");
  }
  const switched = await evaluate(`fetch('/api/projects/switch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'追踪项目B'})}).then(r=>r.json())`); assert(switched.ok);
  const after = await evaluate("fetch('/api/traces').then(r=>r.json())");
  console.log("跨项目核对：切换前 " + before.traces.length + " 条，切换后 " + after.traces.length + " 条");
  if (process.argv.includes("--expect-missing")) { assert(!after.traces.some(t => t.id === id), "旧版缺陷应能够复现"); console.log("PASS 已复现旧安装包切换项目后丢失追踪列表"); return; }
  assert(after.traces.some(t => t.id === id), "切换项目后仍须能读取原对话轨迹");
  await evaluate("openPageView('trace');true"); await waitFor("!!document.querySelector('[data-trace]')");
  await evaluate("document.querySelector('[data-trace]').click();true"); await pause(800);
  const label = await evaluate("document.querySelector('[data-view=hub] .tx').textContent.trim()"); assert.equal(label, "专家 · 技能 · 连接器");
  console.log("PASS 追踪页面显示记录，侧栏完整名称正确");
  await cmd("Page.navigate", { url: base }); await waitFor("typeof openPageView==='function'"); await pause(900);
  await evaluate("document.getElementById('onb-mask')?.classList.remove('show');openPageView('trace');true"); await waitFor("!!document.querySelector('[data-trace]')");
  console.log("PASS 刷新后记录仍可见");
  await librarySmoke();
  await pageSearchSmoke();
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(async () => {
  try { ws && ws.close(); child && child.stdin.write("quit\n"); await pause(1500); if (child && child.exitCode === null) process.kill(-child.pid, "SIGKILL"); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
