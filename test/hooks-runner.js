"use strict";

// Small cross-platform behaviors used by test/hooks.js. Keep shell syntax out of the tests.
const fs = require("fs");

const mode = process.argv[2];

switch (mode) {
  case "exit-3":
    process.stdout.write("hi");
    process.exitCode = 3;
    break;
  case "wait":
    setTimeout(() => {}, 5000);
    break;
  case "write-late":
    setTimeout(() => fs.writeFileSync("late.txt", "late"), 1500);
    break;
  case "cwd":
    process.stdout.write(process.cwd());
    break;
  case "flood":
    process.stdout.write("0123456789".repeat(20000));
    break;
  case "before-shell-fail":
    process.stdout.write("推送要人来做");
    process.exitCode = 1;
    break;
  case "write-ran":
    fs.writeFileSync("ran.txt", "ran");
    break;
  case "save-command":
    fs.writeFileSync("cmd.txt", process.env.OWB_COMMAND || "");
    break;
  case "print-file":
    process.stdout.write(`saw:${process.env.OWB_FILE || ""}`);
    break;
  case "edit-fail":
    process.stderr.write("lint 挂了");
    process.exitCode = 1;
    break;
  case "check-fixed": {
    let content = "";
    try { content = fs.readFileSync("ok.flag", "utf8"); } catch {}
    if (!content.includes("fixed")) {
      process.stdout.write("测试没过：还是坏的");
      process.exitCode = 1;
    }
    break;
  }
  default:
    process.stderr.write(`Unknown hook test mode: ${mode || "(missing)"}\n`);
    process.exitCode = 2;
}
