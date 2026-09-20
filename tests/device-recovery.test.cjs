"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { deviceTest } = require("../ledctl.cjs");
const { loadConfig } = require("../lib/common.cjs");
const { operationLockPath } = require("../lib/operation-lock.cjs");
const {
  createSnapshotFromState,
  loadSnapshot,
  markPendingRestore,
  readPendingRestore,
} = require("../lib/snapshots.cjs");
const { createK99State } = require("./fixtures/k99-state.cjs");

function temporaryRuntime(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-recovery-test-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("mchose-recovery-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}

const config = loadConfig(path.resolve(__dirname, ".."));

test("device-test preserves an existing recovery pointer before reading or writing HID", async (t) => {
  const runtimeDirectory = temporaryRuntime(t);
  const original = createSnapshotFromState(runtimeDirectory, createK99State(), "takeover");
  const pending = markPendingRestore(runtimeDirectory, original);
  const calls = [];
  const protocol = {
    readState() { calls.push("read"); throw new Error("HID should not be read"); },
    async applyPreset() { calls.push("write"); throw new Error("HID should not be written"); },
    async restoreExact() { calls.push("restore"); throw new Error("HID should not be restored"); },
  };
  await assert.rejects(
    deviceTest({ ...config, runtimeDirectory }, protocol, 0),
    (error) => error.code === "PENDING_RESTORE" && error.details.snapshotId === original.manifest.snapshotId,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(readPendingRestore(runtimeDirectory), pending);
  assert.deepEqual(fs.readdirSync(path.join(runtimeDirectory, "snapshots")), [original.manifest.snapshotId]);
  assert.equal(fs.existsSync(path.join(runtimeDirectory, "test-results")), false);
  assert.equal(fs.existsSync(operationLockPath(runtimeDirectory)), false);
});

test("device-test still restores and verifies a fresh baseline when no recovery is pending", async (t) => {
  const runtimeDirectory = temporaryRuntime(t);
  const baseline = createK99State();
  const calls = [];
  const protocol = {
    readState() { calls.push("read"); return baseline; },
    async applyPreset() { calls.push("write"); return { skipped: false, before: baseline, after: baseline }; },
    async restoreExact(state) {
      calls.push("restore");
      assert.deepEqual(state.performance, baseline.performance);
      assert.deepEqual(state.lightColor, baseline.lightColor);
      return { ok: true, after: state };
    },
  };
  const result = await deviceTest({ ...config, runtimeDirectory }, protocol, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["read", "write", "restore"]);
  assert.equal(readPendingRestore(runtimeDirectory), null);
  assert.ok(Number.isFinite(Date.parse(loadSnapshot(result.snapshot.directory).manifest.restoreVerifiedAt)));
});

test("device-test keeps its recovery pointer when readback does not match", async (t) => {
  const runtimeDirectory = temporaryRuntime(t);
  const baseline = createK99State();
  const protocol = {
    readState() { return baseline; },
    async applyPreset() { return { skipped: false, before: baseline, after: baseline }; },
    async restoreExact() { return { ok: false, after: baseline, performanceDifferences: [{ offset: 18 }], colorDifferences: [] }; },
  };
  const result = await deviceTest({ ...config, runtimeDirectory }, protocol, 0);
  assert.equal(result.ok, false);
  assert.equal(readPendingRestore(runtimeDirectory).snapshotId, result.snapshot.snapshotId);
  assert.equal(loadSnapshot(result.snapshot.directory).manifest.restoreVerifiedAt, undefined);
});
