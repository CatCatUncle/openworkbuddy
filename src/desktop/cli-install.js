// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const MARKER = "OpenWorkBuddy CLI launcher";
const quote = value => "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
const batchQuote = value => String(value).replace(/%/g, "%%");

function launcher({ platform, executable, cli, dataHome }) {
  if (platform === "win32") return `@rem ${MARKER}\r\n@echo off\r\nsetlocal DisableDelayedExpansion\r\nfor /f "tokens=2 delims=:" %%C in ('chcp') do set "_owb_cli_cp=%%C"\r\nchcp 65001 >nul\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nif not defined OPENWORKBUDDY_HOME set "OPENWORKBUDDY_HOME=${dataHome ? batchQuote(dataHome) : "%USERPROFILE%\\OpenWorkBuddy"}"\r\n"${batchQuote(executable)}" "${batchQuote(cli)}" %*\r\nset "_owb_cli_exit=%errorlevel%"\r\nif defined _owb_cli_cp chcp %_owb_cli_cp% >nul\r\nexit /b %_owb_cli_exit%\r\n`;
  return `#!/bin/sh\n# ${MARKER}\nexport ELECTRON_RUN_AS_NODE=1\nif [ -z "\${OPENWORKBUDDY_HOME:-}" ]; then\n  export OPENWORKBUDDY_HOME=${dataHome ? quote(dataHome) : '"$HOME/OpenWorkBuddy"'}\nfi\nexec ${quote(executable)} ${quote(cli)} "$@"\n`;
}

function run(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 15000 }, (err, stdout) => err ? reject(err) : resolve(stdout)));
}

/** Per-user registration. It never changes the task's current working directory. */
async function installCli({ appDir, dataHome, executable = process.execPath, platform = process.platform, home = os.homedir(), env = process.env, runCommand = run }) {
  if (env.OPENWORKBUDDY_INSTALL_CLI === "0") return { ok: false, reason: "disabled" };
  if (!["darwin", "win32"].includes(platform)) return { ok: false, reason: "unsupported" };
  const cli = path.join(appDir, "cli.js");
  if (!fs.existsSync(cli) || !fs.existsSync(executable)) return { ok: false, reason: "missing-entry" };
  const bin = platform === "win32"
    ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "OpenWorkBuddy", "bin")
    : path.join(home, ".local", "bin");
  const file = path.join(bin, platform === "win32" ? "openworkbuddy.cmd" : "openworkbuddy");
  const text = launcher({ platform, executable, cli, dataHome });
  let previous = "";
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || !fs.readFileSync(file, "utf8").includes(MARKER)) return { ok: false, reason: "conflict", file };
    previous = fs.readFileSync(file, "utf8");
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  fs.mkdirSync(bin, { recursive: true });
  if (text !== previous) {
    const temp = file + "." + process.pid + ".tmp";
    try { fs.writeFileSync(temp, text, { mode: 0o755 }); fs.renameSync(temp, file); }
    finally { try { fs.unlinkSync(temp); } catch {} }
  }
  if (platform === "darwin") {
    fs.chmodSync(file, 0o755);
    const profile = path.join(home, /\/bash$/.test(env.SHELL || "") ? ".bash_profile" : ".zprofile");
    let current = "";
    try { current = fs.readFileSync(profile, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (!current.includes("# " + MARKER)) fs.appendFileSync(profile, '\n# ' + MARKER + '\nexport PATH="$HOME/.local/bin:$PATH"\n', { mode: 0o600 });
    return { ok: true, file, profile, restartTerminal: !(env.PATH || "").split(":").includes(bin) };
  }
  // Update only the user's PATH, then tell Explorer so new terminals inherit it.
  const ps = `$bin='${bin.replace(/'/g, "''")}';
$value=[Environment]::GetEnvironmentVariable('Path','User');
$parts=@($value -split ';' | Where-Object { $_ });
if (-not ($parts | Where-Object { $_.TrimEnd('\\') -ieq $bin.TrimEnd('\\') })) {
  [Environment]::SetEnvironmentVariable('Path',(@($bin)+$parts -join ';'),'User');
  Add-Type -Namespace OWB -Name EnvNotify -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr h, uint m, System.UIntPtr w, string l, uint f, uint t, out System.UIntPtr r);';
  $result=[UIntPtr]::Zero;
  [void][OWB.EnvNotify]::SendMessageTimeout([IntPtr]0xffff,0x1a,[UIntPtr]::Zero,'Environment',2,5000,[ref]$result);
}`;
  await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")]);
  return { ok: true, file, restartTerminal: true };
}

module.exports = { installCli, launcher };
