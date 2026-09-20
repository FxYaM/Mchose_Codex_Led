"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { atomicWriteJson } = require("../lib/common.cjs");
const {
  clearPendingRestore,
  createSnapshotFromState,
  loadSnapshot,
  markPendingRestore,
  pendingPath,
  pruneCompletedSnapshots,
  readPendingRestore,
} = require("../lib/snapshots.cjs");
const { createK99State } = require("./fixtures/k99-state.cjs");

function temporaryRuntime(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-retention-test-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("mchose-retention-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}

function snapshot(runtimeDirectory, kind = "takeover", verifiedAt = null) {
  const result = createSnapshotFromState(runtimeDirectory, createK99State(), kind);
  if (verifiedAt) {
    result.manifest.restoreVerifiedAt = verifiedAt;
    atomicWriteJson(path.join(result.directory, "manifest.json"), result.manifest);
  }
  return result;
}

test("retention deletes only old verified generated snapshots and preserves recovery material", (t) => {
  const runtimeDirectory = temporaryRuntime(t);
  const oldest = snapshot(runtimeDirectory, "takeover", "2026-01-01T00:00:00Z");
  const recent = snapshot(runtimeDirectory, "validation-test-entry", "2026-02-01T00:00:00Z");
  const newest = snapshot(runtimeDirectory, "takeover", "2026-03-01T00:00:00Z");
  const pending = snapshot(runtimeDirectory, "takeover", "2025-01-01T00:00:00Z");
  markPendingRestore(runtimeDirectory, pending);
  const preserved = [
    pending,
    snapshot(runtimeDirectory, "manual-baseline", "2025-01-01T00:00:00Z"),
    snapshot(runtimeDirectory, "legacy-baseline", "2025-01-01T00:00:00Z"),
    snapshot(runtimeDirectory),
  ];
  const damaged = snapshot(runtimeDirectory, "takeover", "2025-01-01T00:00:00Z");
  fs.writeFileSync(path.join(damaged.directory, "performance.bin"), Buffer.alloc(136));
  const extraData = snapshot(runtimeDirectory, "takeover", "2025-01-01T00:00:00Z");
  fs.writeFileSync(path.join(extraData.directory, "user-notes.txt"), "keep this");
  const unexpectedFile = snapshot(runtimeDirectory, "takeover", "2025-01-01T00:00:00Z");
  unexpectedFile.manifest.files.performance.name = "../outside.bin";
  atomicWriteJson(path.join(unexpectedFile.directory, "manifest.json"), unexpectedFile.manifest);
  preserved.push(damaged, extraData, unexpectedFile, recent, newest);
  assert.deepEqual(pruneCompletedSnapshots(runtimeDirectory, 2), [oldest.manifest.snapshotId]);
  assert.equal(fs.existsSync(oldest.directory), false);
  for (const entry of preserved) assert.equal(fs.existsSync(entry.directory), true, entry.manifest.snapshotId);
  assert.equal(readPendingRestore(runtimeDirectory).snapshotId, pending.manifest.snapshotId);
});

test("successful recovery automatically retains at most 20 verified generated snapshots", (t) => {
  const runtimeDirectory = temporaryRuntime(t);
  for (let index = 0; index < 21; index += 1) {
    const current = snapshot(runtimeDirectory);
    markPendingRestore(runtimeDirectory, current);
    assert.equal(clearPendingRestore(runtimeDirectory, current.manifest.snapshotId), true);
  }
  const directories = fs.readdirSync(path.join(runtimeDirectory, "snapshots"));
  assert.equal(directories.length, 20);
  for (const name of directories) {
    const loaded = loadSnapshot(path.join(runtimeDirectory, "snapshots", name));
    assert.ok(Number.isFinite(Date.parse(loaded.manifest.restoreVerifiedAt)));
  }
});

test("malformed recovery metadata prevents both retention and clearing", (t) => {
  const runtimeDirectory = temporaryRuntime(t);
  const old = snapshot(runtimeDirectory, "takeover", "2025-01-01T00:00:00Z");
  for (const value of [{}, null, false, { schemaVersion: 1, snapshotId: old.manifest.snapshotId }]) {
    atomicWriteJson(pendingPath(runtimeDirectory), value);
    assert.throws(() => pruneCompletedSnapshots(runtimeDirectory, 0), /Pending restore metadata is invalid/);
    assert.throws(() => clearPendingRestore(runtimeDirectory), /Pending restore metadata is invalid/);
    assert.equal(fs.existsSync(old.directory), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(pendingPath(runtimeDirectory), "utf8")), value);
  }
});
