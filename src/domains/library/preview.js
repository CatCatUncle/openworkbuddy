// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const core = require("./preview-core");
const { isMainThread } = require("worker_threads");
const { previewWorker } = require("./preview-worker");
async function previewData(file, name, opts = {}) {
  return isMainThread ? previewWorker(file, name, opts) : core.previewData(file, name, opts);
}
module.exports = { ...core, previewData };
