"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { resolveCodexExecutable } = require("../codex-exec-led.cjs");

test("an explicitly configured Codex executable is preserved", () => {
  const resolved = resolveCodexExecutable({ codex: { codexExecutable: process.execPath } });
  assert.equal(resolved, path.resolve(process.execPath));
});

test("automatic Codex discovery finds an installed executable", () => {
  const resolved = resolveCodexExecutable({ codex: { codexExecutable: "auto" } });
  assert.match(resolved, /codex\.exe$/i);
});
