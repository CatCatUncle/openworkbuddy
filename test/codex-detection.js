"use strict";
/**
 * Windows 上 npm 安装的 Codex 是 codex.cmd。模型目录探测也必须走
 * win.launchPlan，不能像 execFile 那样直接启动 .cmd，否则 Node 抛 EINVAL，
 * 设置页会把已安装的 Codex 误报成未安装。
 *
 * 只跑本地假 CLI，不联网、不读用户真实 CODEX_HOME、不花订阅额度。
 *   node test/codex-detection.js
 */
require("./lib/own-home")("codex-detection");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const codex = require("../engines/codex");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-codex-probe-"));
  const priorHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  fs.writeFileSync(path.join(dir, "config.toml"), 'model = "gpt-from-config"\n');

  const makeShim = (name, failModels) => {
    const bin = path.join(dir, name + ".cmd");
    const script = `
const args = process.argv.slice(2);
const out = (text, code = 0) => process.stdout.write(text + "\\n", () => process.exit(code));
if (args[0] === "--version") out("codex-cli 9.9.9");
else if (args[0] === "debug" && args[1] === "models") {
  ${failModels ? 'process.stderr.write("debug models unavailable\\n", () => process.exit(1));' : 'out(JSON.stringify({ models: [{ slug: "gpt-fake" }, { slug: "hidden", visibility: "hide" }] }));'}
} else {
  process.stderr.write("unexpected args: " + JSON.stringify(args) + "\\n", () => process.exit(2));
}
`;
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(dir, name + ".js"), script);
      // npm-style shim shape: launchPlan should extract this JS entrypoint.
      fs.writeFileSync(bin, `@echo off\r\nnode "%~dp0${name}.js" %*\r\n`);
    } else {
      fs.writeFileSync(bin, "#!/usr/bin/env node\n" + script);
      fs.chmodSync(bin, 0o755);
    }
    return bin;
  };

  try {
    console.log("— Windows npm .cmd 垫片：Codex 模型探测 —");
    const found = await codex.detect({ bin: makeShim("codex-models-ok", false) });
    assert(found.installed && found.version === "codex-cli 9.9.9", "已安装 Codex 的版本探测应通过：" + JSON.stringify(found));
    assert(found.modelSource === "codex_account" && found.models.includes("gpt-fake") && !found.models.includes("hidden"),
      "账号型号应读到，隐藏型号应过滤：" + JSON.stringify(found));
    console.log("  ✅ .cmd shim 通过适配器执行，账号模型列表可读且隐藏项已过滤");

    const fallback = await codex.detect({ bin: makeShim("codex-models-fail", true) });
    assert(fallback.installed && fallback.modelSource === "codex_config" && fallback.models.includes("gpt-from-config"),
      "模型目录探测失败仍应显示已安装，并回退到本地配置：" + JSON.stringify(fallback));
    console.log("  ✅ 模型目录读取失败不再误报未安装，并回退到本地配置");
    console.log("Codex CLI 探测回归：2 项全过");
  } finally {
    if (priorHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("\n❌ " + (e && e.stack || e));
  process.exitCode = 1;
});
