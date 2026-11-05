// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 连接器接入时的内置检查。
 *
 * toolward 是可选的外部程序，没装的时候连接器一条检查都不过：
 * curl | sh、云元数据地址这些写法照样显示「没问题」。skill-guard 管技能，这里管连接器。
 * 只看配置本身，不连网、不启动进程。规则走现有的提醒和审批：
 * 页面保存时提醒，agent 添加时摆审批卡（理由见 server.js connectorAdvice 上面）。
 */

/** @typedef {{ level: string, rule: string, file: string, why: string }} Finding */

const PIPE_TO_SHELL = /\b(curl|wget|iwr|invoke-webrequest)\b[^|\n]*\|\s*(sudo\s+)?(sh|bash|zsh|python\d?|node|iex|invoke-expression)\b/i;
const ENCODED = /(-enc(odedcommand)?\s|base64\s+(-d|--decode)[^|]*\|\s*(sh|bash)|\/dev\/tcp\/|\bnc\s+-e\b)/i;
const SHELL_BIN = /^(sh|bash|zsh|cmd|cmd\.exe|powershell|powershell\.exe|pwsh)$/i;
const SECRET_PATH = /(\.ssh[\\/]|\.aws[\\/]credentials|\.gnupg[\\/]|\.kube[\\/]config|[\\/]\.env\b|[\\/]secrets?\.(env|json)\b|[\\/]\.openworkbuddy[\\/]config)/i;
const RUNNER = /^(npx|bunx|pnpx|uvx|pipx)(\.cmd|\.exe)?$/i;
const METADATA = /^(169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200|fd00:ec2::254)$/i;
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

/** 包名后面有没有钉版本：some-pkg@1.2.3、@scope/pkg@1.2.3 */
function pinned(/** @type {string} */ spec) {
  return /^(@[^/]+\/)?[^@]+@\d/.test(spec);
}

/** @param {any} server @returns {Finding[]} */
function scanOne(server) {
  const name = String((server && server.name) || "");
  const file = `连接器「${name}」`;
  /** @type {Finding[]} */
  const out = [];
  const add = (/** @type {string} */ level, /** @type {string} */ rule, /** @type {string} */ why) => out.push({ level, rule, file, why });
  const command = String((server && server.command) || "").trim();
  const args = Array.isArray(server && server.args) ? server.args.map(String) : [];
  const line = [command, ...args].join(" ");

  if (command) {
    if (PIPE_TO_SHELL.test(line)) add("block", "CG101", "启动时从网上下载内容直接执行，内容随时能被换掉");
    if (ENCODED.test(line)) add("block", "CG102", "命令里有编码过的脚本或反弹连接的写法");
    if (SECRET_PATH.test(line)) add("block", "CG103", "启动参数指向密钥或凭据文件");
    if (SHELL_BIN.test(command.split(/[\\/]/).pop() || "")) add("warn", "CG104", "用 shell 启动，实际跑什么要看后面的命令");
    if (RUNNER.test(command.split(/[\\/]/).pop() || "")) {
      const spec = args.find((a) => !a.startsWith("-"));
      if (spec && !pinned(spec)) add("warn", "CG105", `${spec} 没有钉版本，上游发新版时这里跑的代码就变了`);
    }
  }

  const raw = String((server && server.url) || "").trim();
  if (raw) {
    /** @type {URL|null} */
    let url = null;
    try { url = new URL(raw); } catch {}
    if (url) {
      const host = url.hostname;
      if (METADATA.test(host)) add("block", "CG201", "地址是云服务器的元数据接口，能拿到这台机器的云凭据");
      if (url.username || url.password) add("warn", "CG202", "地址里写了账号或密码，会进日志和配置");
      if (url.protocol === "http:" && !LOCAL.test(host)) {
        const sends = Object.keys((server && server.headers) || {}).length > 0;
        add("warn", "CG203", sends ? "用明文 http 发送请求头里的令牌，路上能被看到" : "用明文 http 连接，内容路上能被看到");
      }
    }
  }
  return out;
}

/** @param {any[]} servers */
function scan(servers) {
  const findings = (Array.isArray(servers) ? servers : []).flatMap(scanOne);
  return { level: findings.some((f) => f.level === "block") ? "block" : findings.length ? "warn" : "ok", findings };
}

module.exports = { scan, scanOne };
