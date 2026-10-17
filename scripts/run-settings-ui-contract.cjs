#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const names = [
  "every registered Settings provider declares a contract profile and executable browser fixture",
  "every registered provider satisfies the universal Settings UI contract",
  "Settings refreshes providers without blanking an already-loaded form",
  "the installed-package model list renders while the capability probe is still hanging (T6, production-default timing)",
  "Command Code first capability read blocks controls, but later refreshes keep known Permission/Reasoning usable",
  "WorkBuddy Reasoning is strictly model-specific across model switches and keeps the same-model saved max",
  "Command Code Reasoning offers exactly the selected model\'s own efforts and switches locally (T7)",
  "Command Code default and rate-limit-fallback Reasoning selects are independent (T7b)",
  "WorkBuddy Full Access and default/fallback Reasoning save and reopen from a fresh provider read (T7c)"
];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = `^(?:${names.map(escapeRegex).join("|")})$`;
const files = [
  path.resolve(process.cwd(), "dist", "tests", "unit", "settings-ui-contract-registry.test.js"),
  path.resolve(process.cwd(), "dist", "tests", "integration", "hub-ui-browser.test.js")
];

const nodeArgs = [];
if (typeof globalThis.WebSocket !== "function") {
  if (!process.allowedNodeEnvironmentFlags.has("--experimental-websocket")) {
    console.error("this supported Node runtime has neither global WebSocket nor --experimental-websocket");
    process.exit(2);
  }
  nodeArgs.push("--experimental-websocket");
}
if (process.platform === "win32") nodeArgs.push("--test-concurrency=1");
nodeArgs.push("--test", "--test-name-pattern", pattern, ...files);

const child = spawnSync(process.execPath, nodeArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  windowsHide: true
});
if (child.error) throw child.error;
if (child.signal) {
  console.error(`settings UI contract runner terminated by signal ${child.signal}`);
  process.exit(1);
}
process.exit(child.status == null ? 1 : child.status);
