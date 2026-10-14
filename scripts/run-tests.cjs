#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const requestedRoot = process.argv[2] || path.join("dist", "tests");
const root = path.resolve(process.cwd(), requestedRoot);

function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.isFile() && entry.name.endsWith(".test.js")) out.push(full);
  }
}

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`test root does not exist: ${root}`);
  process.exit(2);
}

const files = [];
collect(root, files);
files.sort();
if (files.length === 0) {
  console.error(`no compiled .test.js files found under ${root}`);
  process.exit(2);
}

const nodeArgs = [];
// Node 20 implements the WebSocket client behind its supported experimental
// flag, while newer supported Node releases expose it globally. The browser
// acceptance uses that client only to speak CDP; production code does not depend
// on this flag.
if (typeof globalThis.WebSocket !== "function") {
  if (!process.allowedNodeEnvironmentFlags.has("--experimental-websocket")) {
    console.error("this supported Node runtime has neither global WebSocket nor --experimental-websocket");
    process.exit(2);
  }
  nodeArgs.push("--experimental-websocket");
}
// Hosted Windows runners are materially slower at starting the many detached
// daemon/worker fixture processes in this suite. Running test files concurrently
// can turn bounded 12-15s production startup checks into false CI failures while
// each test passes in isolation. Serialize test files on Windows; individual
// tests can still exercise their own intentional concurrency.
if (process.platform === "win32") {
  nodeArgs.push("--test-concurrency=1");
}
nodeArgs.push("--test", ...files);

const child = spawnSync(process.execPath, nodeArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  windowsHide: true
});
if (child.error) throw child.error;
if (child.signal) {
  console.error(`test runner terminated by signal ${child.signal}`);
  process.exit(1);
}
process.exit(child.status == null ? 1 : child.status);
