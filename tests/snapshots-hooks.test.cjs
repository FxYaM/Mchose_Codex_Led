"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadConfig, readControllerEnabled, writeControllerEnabled } = require("../lib/common.cjs");
const { compareIdentity, DeviceOfflineError } = require("../lib/protocol.cjs");
const {
  clearPendingRestore,
  createSnapshotFromState,
  loadSnapshot,
  markPendingRestore,
  readPendingRestore,
} = require("../lib/snapshots.cjs");
const { mapHook } = require("../hook-handler.cjs");
const { directRestore } = require("../ledctl.cjs");
const { TaskStateMachine } = require("../lib/state-machine.cjs");
const { createK99State } = require("./fixtures/k99-state.cjs");

const packageDirectory = path.resolve(__dirname, "..");
const config = loadConfig(packageDirectory);
const fixtureState = createK99State();

test("snapshot commit, pending pointer, hash validation, and clear are coherent", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-led-test-"));
  try {
    const snapshot = createSnapshotFromState(temporary, fixtureState, "test", ["unit test"]);
    const loaded = loadSnapshot(snapshot.directory);
    assert.equal(loaded.manifest.snapshotId, snapshot.manifest.snapshotId);
    markPendingRestore(temporary, snapshot);
    assert.equal(readPendingRestore(temporary).snapshotId, snapshot.manifest.snapshotId);
    assert.equal(clearPendingRestore(temporary, snapshot.manifest.snapshotId), true);
    assert.equal(readPendingRestore(temporary), null);
    fs.writeFileSync(path.join(snapshot.directory, "performance.bin"), Buffer.alloc(136));
    assert.throws(() => loadSnapshot(snapshot.directory), /SHA-256/);
  } finally {
    const resolved = path.resolve(temporary);
    const safeRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    if (!resolved.startsWith(safeRoot) || !path.basename(resolved).startsWith("mchose-led-test-")) {
      throw new Error(`Refusing unsafe test cleanup: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test("snapshot identity tolerates endpoint re-enumeration when stable identity matches", () => {
  const moved = { ...fixtureState.identity, endpointPath: "different-port" };
  assert.equal(compareIdentity(fixtureState.identity, moved).length, 0);

  const wrongStableIdentity = { ...moved, release: moved.release + 1 };
  assert.equal(compareIdentity(fixtureState.identity, wrongStableIdentity).some((entry) => entry.field === "release"), true);
});

test("hook payloads map only to documented lifecycle meanings", () => {
  const common = { session_id: "S", turn_id: "T" };
  assert.equal(mapHook({ ...common, hook_event_name: "UserPromptSubmit" }, config).kind, "turn_started");
  assert.equal(mapHook({ ...common, hook_event_name: "Stop", last_assistant_message: "done" }, config).kind, "turn_completed");
  assert.equal(mapHook({ ...common, hook_event_name: "Interrupt" }, config).kind, "turn_interrupted");
  assert.equal(mapHook({ ...common, hook_event_name: "PermissionRequest", tool_name: "Bash" }, config).kind, "turn_waiting");
  assert.equal(mapHook({ ...common, hook_event_name: "PreToolUse", tool_name: "request_user_input" }, config).kind, "turn_waiting");
  assert.equal(mapHook({ ...common, hook_event_name: "PostToolUse", tool_name: "request_user_input" }, config).kind, "turn_resumed");
  assert.equal(mapHook({ ...common, hook_event_name: "PostToolUse", tool_name: "Bash" }, config).kind, "turn_resumed");
  assert.equal(mapHook({ ...common, hook_event_name: "PreToolUse", tool_name: "Bash" }, config), null);
});

test("approval invocations without an ID are not deduplicated by command contents", () => {
  const common = { session_id: "S", turn_id: "T", hook_event_name: "PermissionRequest", tool_name: "Bash" };
  const first = mapHook({ ...common, tool_input: { command: "first" } }, config);
  const retry = mapHook({ ...common, tool_input: { command: "first" } }, config);
  const second = mapHook({ ...common, tool_input: { command: "second" } }, config);
  assert.notEqual(first.eventId, retry.eventId);
  assert.notEqual(first.eventId, second.eventId);
});

test("a repeated identical approval waits again after its previous invocation completed", () => {
  const machine = new TaskStateMachine(config);
  const payload = { session_id: "S", turn_id: "T", tool_name: "Bash", tool_input: { command: "git status" } };
  machine.apply(mapHook({ ...payload, hook_event_name: "PermissionRequest" }, config));
  machine.apply(mapHook({ ...payload, hook_event_name: "PostToolUse", tool_use_id: "first" }, config));
  assert.equal(machine.desired(), "running");
  const repeated = machine.apply(mapHook({ ...payload, hook_event_name: "PermissionRequest" }, config));
  assert.equal(repeated.duplicate, false);
  assert.equal(machine.desired(), "waiting");
});

test("only the corresponding tool completion resolves a wait, including concurrent waits", () => {
  const machine = new TaskStateMachine(config);
  const payload = { session_id: "S", turn_id: "T", tool_name: "Bash", tool_input: { command: "first" } };
  const apply = (hook, extra = {}) => machine.apply(mapHook({ ...payload, hook_event_name: hook, ...extra }, config));
  apply("PermissionRequest", { tool_use_id: "A" });
  apply("PermissionRequest", { tool_use_id: "B" });
  apply("PostToolUse", { tool_use_id: "unrelated" });
  assert.equal(machine.desired(), "waiting");
  apply("PostToolUse", { tool_use_id: "A" });
  assert.equal(machine.desired(), "waiting");
  apply("PostToolUse", { tool_use_id: "B" });
  assert.equal(machine.desired(), "running");
});

test("approval correlation is independent of JSON object key order", () => {
  const payload = { session_id: "S", turn_id: "T", tool_name: "Bash" };
  const waiting = mapHook({ ...payload, hook_event_name: "PermissionRequest", tool_input: { command: "status", cwd: "repo" } }, config);
  const resumed = mapHook({ ...payload, hook_event_name: "PostToolUse", tool_input: { cwd: "repo", command: "status" } }, config);
  assert.equal(waiting.toolKey, resumed.toolKey);
});

test("restoring an unrelated explicit snapshot never clears the pending recovery source", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-led-test-"));
  try {
    const pendingSnapshot = createSnapshotFromState(temporary, fixtureState, "takeover", ["pending"]);
    const explicitSnapshot = createSnapshotFromState(temporary, fixtureState, "manual-baseline", ["explicit"]);
    markPendingRestore(temporary, pendingSnapshot);
    const fakeProtocol = {
      async restoreExact(state) {
        assert.ok(state.performance.equals(fixtureState.performance));
        return {
          ok: true,
          after: fixtureState,
          performanceDifferences: [],
          colorDifferences: [],
        };
      },
    };
    const result = await directRestore(
      { ...config, runtimeDirectory: temporary },
      fakeProtocol,
      explicitSnapshot.directory,
      { watch: false },
    );
    assert.equal(result.pendingCleared, false);
    assert.equal(result.pendingRetained, pendingSnapshot.manifest.snapshotId);
    assert.equal(readPendingRestore(temporary).snapshotId, pendingSnapshot.manifest.snapshotId);
  } finally {
    const resolved = path.resolve(temporary);
    const safeRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    if (!resolved.startsWith(safeRoot) || !path.basename(resolved).startsWith("mchose-led-test-")) {
      throw new Error(`Refusing unsafe test cleanup: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test("restore watch retries a mid-operation offline failure and keeps its recovery source", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-led-test-"));
  try {
    const snapshot = createSnapshotFromState(temporary, fixtureState, "takeover", ["watch retry"]);
    markPendingRestore(temporary, snapshot);
    let attempts = 0;
    const fakeProtocol = {
      async restoreExact() {
        attempts += 1;
        if (attempts === 1) throw new DeviceOfflineError("unplugged mid-restore");
        return { ok: true, after: fixtureState, performanceDifferences: [], colorDifferences: [] };
      },
    };
    const result = await directRestore(
      { ...config, runtimeDirectory: temporary, controller: { ...config.controller, reconnectBackoffMs: [1] } },
      fakeProtocol,
      null,
      { watch: true },
    );
    assert.equal(attempts, 2);
    assert.equal(result.ok, true);
    assert.equal(result.pendingCleared, true);
    assert.equal(readPendingRestore(temporary), null);
  } finally {
    const resolved = path.resolve(temporary);
    const safeRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    if (!resolved.startsWith(safeRoot) || !path.basename(resolved).startsWith("mchose-led-test-")) {
      throw new Error(`Refusing unsafe test cleanup: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test("controller enable state defaults on and persists explicit stop/start choices", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-led-test-"));
  try {
    assert.equal(readControllerEnabled(temporary), true);
    writeControllerEnabled(temporary, false, "test stop");
    assert.equal(readControllerEnabled(temporary), false);
    writeControllerEnabled(temporary, true, "test start");
    assert.equal(readControllerEnabled(temporary), true);
  } finally {
    const resolved = path.resolve(temporary);
    const safeRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    if (!resolved.startsWith(safeRoot) || !path.basename(resolved).startsWith("mchose-led-test-")) {
      throw new Error(`Refusing unsafe test cleanup: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
