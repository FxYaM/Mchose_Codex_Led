"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { isOwnedHook, mergeOwnedHooks, removeOwnedHooks } = require("../install-hooks.cjs");

const packageDirectory = "C:\\Users\\Test Person\\.codex\\mchose-led";
const options = { packageDirectory };
const owned = { type: "command", command: `"C:\\node.exe" "${packageDirectory}\\hook-handler.cjs"` };
const other = { type: "command", command: "notify-other.exe" };

test("reinstall preserves unrelated entries and matcher in a mixed hook group", () => {
  const original = { otherSetting: true, hooks: { Stop: [{ matcher: "custom", hooks: [owned, other] }] } };
  const before = structuredClone(original);
  const merged = mergeOwnedHooks(original, owned.command, options);
  assert.deepEqual(merged.hooks.Stop[0], { matcher: "custom", hooks: [other] });
  assert.equal(merged.hooks.Stop.length, 2);
  assert.equal(merged.otherSetting, true);
  assert.deepEqual(original, before);
  assert.deepEqual(mergeOwnedHooks(merged, owned.command, options), merged);
});

test("uninstall removes only this installation's hooks and retains other groups", () => {
  const otherInstall = { type: "command", command: '"C:\\another\\mchose-led\\hook-handler.cjs"' };
  const original = { hooks: {
    Stop: [{ hooks: [owned, other] }, { hooks: [otherInstall] }],
    SessionEnd: [{ hooks: [owned] }],
    CustomEvent: [{ hooks: [other] }],
  } };
  const removed = removeOwnedHooks(original, options);
  assert.deepEqual(removed.hooks.Stop, [{ hooks: [other] }, { hooks: [otherInstall] }]);
  assert.deepEqual(removed.hooks.SessionEnd, []);
  assert.deepEqual(removed.hooks.CustomEvent, original.hooks.CustomEvent);
});

test("ownership normalizes Windows case and slash variants and rejects prefix matches", () => {
  const variant = { command: owned.command.replaceAll("\\", "/").toUpperCase() };
  assert.equal(isOwnedHook(variant, packageDirectory), true);
  assert.equal(isOwnedHook({ command: `${owned.command.slice(0, -1)}.backup"` }, packageDirectory), false);
  assert.equal(isOwnedHook(other, packageDirectory), false);
  assert.equal(isOwnedHook(null, packageDirectory), false);
});

test("the remove CLI backs up and updates only an isolated hooks document", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-hooks-test-"));
  try {
    const codexDirectory = path.join(temporary, ".codex");
    fs.mkdirSync(codexDirectory);
    const handlerPath = path.resolve(__dirname, "..", "hook-handler.cjs");
    const hooksPath = path.join(codexDirectory, "hooks.json");
    const original = JSON.stringify({ hooks: { Stop: [{ hooks: [
      { type: "command", command: `"${process.execPath}" "${handlerPath}"` }, other,
    ] }] } });
    fs.writeFileSync(hooksPath, original);
    const result = spawnSync(process.execPath, [path.resolve(__dirname, "..", "install-hooks.cjs"), "--remove"], {
      env: { ...process.env, USERPROFILE: temporary }, encoding: "utf8", windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(hooksPath, "utf8")).hooks.Stop, [{ hooks: [other] }]);
    const backups = fs.readdirSync(codexDirectory).filter((name) => name.startsWith("hooks.json.backup-"));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(codexDirectory, backups[0]), "utf8"), original);
  } finally {
    const resolved = path.resolve(temporary);
    if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) || !path.basename(resolved).startsWith("mchose-hooks-test-")) {
      throw new Error(`Refusing unsafe test cleanup: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
