// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const assert = require("assert/strict"), fs = require("fs"), path = require("path");
const { verifiedMainCi } = require("../scripts/release-ci");
try {
  const sha = "a".repeat(40), now = Date.now();
  const good = { id: 123, head_sha: sha, head_branch: "main", event: "push", path: ".github/workflows/test.yml", status: "completed", conclusion: "success", updated_at: new Date(now - 60000).toISOString() };
  assert.equal(verifiedMainCi([good], sha, now), good);
  for (const patch of [{ head_sha: "b".repeat(40) }, { head_branch: "topic" }, { event: "pull_request" }, { event: "workflow_dispatch" }, { status: "in_progress" }, { conclusion: "failure" }, { path: ".github/workflows/other.yml" }, { updated_at: new Date(now - 86400001).toISOString() }, { updated_at: new Date(now + 60000).toISOString() }, { updated_at: "invalid" }, { id: "123" }]) assert.equal(verifiedMainCi([{ ...good, ...patch }], sha, now), null);
  assert.equal(verifiedMainCi([], sha, now), null); assert.equal(verifiedMainCi([good], "main", now), null);
  const yaml = fs.readFileSync(path.join(__dirname, "../.github/workflows/release.yml"), "utf8");
  assert.ok(yaml.includes("actions: read") && yaml.includes("node scripts/release-ci.js"));
  assert.equal((yaml.match(/if: steps\.ci\.outputs\.passed != 'true'/g) || []).length, 2);
  assert.ok(yaml.includes("- run: npm ci") && yaml.includes("- run: npm test") && yaml.includes("needs: test"));
  const upgrade = yaml.slice(yaml.indexOf("- **升级 / Upgrade**"));
  assert.ok(upgrade.includes("`git status`") && upgrade.includes("`git pull --ff-only`") && upgrade.includes("`npm ci`"), "Release instructions preserve local work and use locked dependencies");
  assert.ok(!upgrade.includes("`git pull`"), "Release instructions must not recommend an unguarded merge");
  const testYaml = fs.readFileSync(path.join(__dirname, "../.github/workflows/test.yml"), "utf8");
  const preflight = testYaml.indexOf("run: node test/lib/css-token-gate.js");
  assert.ok(preflight > 0 && preflight < testYaml.indexOf("- run: npm ci"), "UI color preflight runs before dependency installation and the full suite");
  const e2e = fs.readFileSync(path.join(__dirname, "e2e.js"), "utf8");
  assert.ok(e2e.includes('require("./lib/css-token-gate")(path.join(__dirname, ".."))'), "E2E reuses the same color gate");
  require("./lib/css-token-gate")();
  const os = require("os"), cp = require("child_process"), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-release-notes-"));
  try {
    const git = (...args) => cp.execFileSync("git", args, { cwd: tmp, encoding: "utf8" });
    git("init", "-q"); for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) git("config", key, value);
    const old = Array.from({ length: 10 }, (_, n) => "- **10-29** Previous release " + n), fresh = Array.from({ length: 5 }, (_, n) => "- **10-30** Current release " + n);
    fs.writeFileSync(path.join(tmp, "README.md"), old.join("\n\n")); git("add", "."); git("commit", "-qm", "before"); git("tag", "v0.1.0");
    fs.writeFileSync(path.join(tmp, "README.md"), [...fresh, ...old.slice(0, 5)].join("\n\n")); git("add", "."); git("commit", "-qm", "after"); git("tag", "v0.1.1");
    const notes = require("../scripts/release-notes").main("v0.1.1", { cwd: tmp });
    assert.deepEqual(notes.split("\n").filter(line => line.startsWith("- **")), fresh, "retained history is not announced again after README reflow");
    assert(yaml.includes("name: ${{ github.ref_name }}"), "Release title is exactly the version tag");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log("✓ Release CI: exact SHA, main push, trusted workflow, freshness and full-test fallback");
} catch (e) { console.error(e.stack || e); process.exitCode = 1; }
