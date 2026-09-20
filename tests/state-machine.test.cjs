"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadConfig } = require("../lib/common.cjs");
const { TaskStateMachine } = require("../lib/state-machine.cjs");

const config = loadConfig(path.resolve(__dirname, ".."));
const event = (kind, taskKey, eventId) => ({ kind, taskKey, eventId, source: "test" });

test("one task completing cannot override another running task", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_started", "A", "1"), 1000);
  machine.apply(event("turn_started", "B", "2"), 1001);
  machine.apply(event("turn_completed", "A", "3"), 1002);
  assert.equal(machine.desired(1002), "running");
  machine.apply(event("turn_waiting", "B", "4"), 1003);
  assert.equal(machine.desired(1003), "waiting");
  machine.apply(event("turn_resumed", "B", "5"), 1004);
  assert.equal(machine.desired(1004), "running");
  machine.apply(event("turn_failed", "B", "6"), 1005);
  assert.equal(machine.desired(1005), "error");
  machine.tick(1005 + config.states.error.durationMs + 1);
  assert.equal(machine.desired(1005 + config.states.error.durationMs + 1), "idle");
});

test("all-success batch shows success only after the last task", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_started", "A", "a1"), 2000);
  machine.apply(event("turn_started", "B", "a2"), 2001);
  machine.apply(event("turn_completed", "A", "a3"), 2002);
  assert.equal(machine.desired(2002), "running");
  machine.apply(event("turn_completed", "B", "a4"), 2003);
  assert.equal(machine.desired(2003), "success");
});

test("duplicate terminal event is idempotent", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_started", "A", "d1"), 3000);
  machine.apply(event("turn_completed", "A", "d2"), 3001);
  const before = machine.serialize();
  const duplicate = machine.apply(event("turn_completed", "A", "d2"), 3002);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(machine.serialize(), before);
});

test("interrupt is error by default and waiting is never success", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_started", "A", "i1"), 4000);
  machine.apply(event("turn_waiting", "A", "i2"), 4001);
  assert.equal(machine.desired(4001), "waiting");
  machine.apply(event("turn_interrupted", "A", "i3"), 4002);
  assert.equal(machine.desired(4002), "error");
});

test("manual state overrides until a new task lifecycle event arrives", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_started", "A", "m1"), 5000);
  machine.apply({ kind: "manual_state", state: "idle", eventId: "m2" }, 5001);
  assert.equal(machine.desired(5001), "idle");
  machine.apply(event("turn_resumed", "A", "m3"), 5002);
  assert.equal(machine.desired(5002), "running");
});

test("stale active task becomes an error terminal state", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_started", "A", "s1"), 6000);
  machine.tick(6000 + config.controller.staleRunningTaskMs + 1);
  assert.equal(machine.desired(6000 + config.controller.staleRunningTaskMs + 1), "error");
});

test("explicit clear removes active tasks so a later start cannot resurrect them", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_started", "old"), 1000);
  assert.equal(machine.desired(1000), "running");
  machine.apply({ kind: "clear", eventId: "explicit-stop" }, 1100);
  const restored = new TaskStateMachine(config, machine.serialize());
  assert.equal(restored.tasks.size, 0);
  assert.equal(restored.desired(1200), "idle");
});

test("terminal tombstones reject late resume and duplicate completion from another source", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_started", "A", "t1"), 7000);
  machine.apply(event("turn_completed", "A", "t2"), 7001);
  const firstExpiry = machine.transient.expiresAt;
  const lateResume = machine.apply(event("turn_resumed", "A", "t3"), 7002);
  const duplicateCompletion = machine.apply(event("turn_completed", "A", "t4"), 7003);
  assert.equal(lateResume.ignored, "terminal-task");
  assert.equal(duplicateCompletion.ignored, "duplicate-terminal-task");
  assert.equal(machine.tasks.size, 0);
  assert.equal(machine.desired(7003), "success");
  assert.equal(machine.transient.expiresAt, firstExpiry);
});

test("an authoritative failure upgrades success and can never be downgraded", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_started", "A", "u1"), 8000);
  machine.apply(event("turn_completed", "A", "u2"), 8001);
  machine.apply(event("turn_failed", "A", "u3"), 8002);
  assert.equal(machine.desired(8002), "error");
  const errorExpiry = machine.transient.expiresAt;
  machine.apply(event("turn_completed", "A", "u4"), 8003);
  assert.equal(machine.desired(8003), "error");
  assert.equal(machine.transient.expiresAt, errorExpiry);
});

test("terminal tombstones survive daemon state serialization", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_started", "A", "p1"), 9000);
  machine.apply(event("turn_interrupted", "A", "p2"), 9001);
  const restored = new TaskStateMachine(config, machine.serialize());
  const late = restored.apply(event("turn_resumed", "A", "p3"), 9002);
  assert.equal(late.ignored, "terminal-task");
  assert.equal(restored.tasks.size, 0);
  assert.equal(restored.desired(9002), "error");
});

test("hook and local-state watcher can report the same turn without fighting", () => {
  const machine = new TaskStateMachine(config);
  machine.apply({
    kind: "turn_started",
    sessionId: "S",
    turnId: "T",
    source: "codex-hook",
    eventId: "hook-start",
  }, 10000);
  assert.equal(machine.desired(10000), "running");

  machine.apply({
    kind: "turn_started",
    sessionId: "S",
    turnId: "T",
    source: "codex-local-state",
    eventId: "watcher-start",
  }, 10001);
  assert.equal(machine.tasks.size, 1);
  assert.equal(machine.desired(10001), "running");

  machine.apply({
    kind: "turn_completed",
    sessionId: "S",
    turnId: "T",
    source: "codex-hook",
    eventId: "hook-stop",
  }, 10002);
  assert.equal(machine.desired(10002), "success");

  machine.apply({
    kind: "turn_failed",
    sessionId: "S",
    turnId: "T",
    source: "codex-local-state",
    eventId: "watcher-failed",
  }, 10003);
  assert.equal(machine.tasks.size, 0);
  assert.equal(machine.desired(10003), "error");
});

test("normal idle and waiting presets are explicit configured lighting, not preserve", () => {
  assert.equal(config.states.idle.mode, "static");
  assert.equal(config.states.idle.color, "#FF69B4");
  assert.equal(config.states.waiting.mode, "static");
  assert.equal(config.states.waiting.color, "#FF69B4");
});

test("a delayed failure from a completed batch cannot contaminate the next batch", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_started", "old", "b1"), 1000);
  machine.apply(event("turn_completed", "old", "b2"), 1001);
  machine.apply(event("turn_started", "new", "b3"), 1002);
  machine.apply(event("turn_failed", "old", "b4"), 1003);
  assert.equal(machine.terminalTasks.get("old").outcome, "error");
  machine.apply(event("turn_completed", "new", "b5"), 1004);
  assert.equal(machine.desired(1004), "success");
  assert.equal(machine.batch, null);
});

test("a delayed failure cannot replace a newer batch's terminal indication", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_started", "old", "c1"), 1000);
  machine.apply(event("turn_completed", "old", "c2"), 1001);
  machine.apply(event("turn_started", "new", "c3"), 1002);
  machine.apply(event("turn_completed", "new", "c4"), 1003);
  const currentTransient = { ...machine.transient };
  machine.apply(event("turn_failed", "old", "c5"), 1004);
  assert.deepEqual(machine.transient, currentTransient);
  assert.equal(machine.desired(1004), "success");
});

test("a failure correction still affects another active task in its original batch", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_started", "A", "same1"), 1000);
  machine.apply(event("turn_started", "B", "same2"), 1001);
  machine.apply(event("turn_completed", "A", "same3"), 1002);
  machine.apply(event("turn_failed", "A", "same4"), 1003);
  machine.apply(event("turn_completed", "B", "same5"), 1004);
  assert.equal(machine.desired(1004), "error");
});

test("a watcher start cannot clear an explicit hook wait, including after serialization", () => {
  const machine = new TaskStateMachine(config);
  machine.apply({ ...event("turn_waiting", "A", "wait1"), source: "codex-hook", toolUseId: "request-1" }, 1000);
  const restored = new TaskStateMachine(config, machine.serialize());
  restored.apply({ ...event("turn_started", "A", "watch1"), source: "codex-local-state" }, 1001);
  assert.equal(restored.desired(1001), "waiting");
  assert.equal(restored.tasks.get("A").pendingWaits[0].toolUseId, "request-1");
  restored.apply({ ...event("turn_resumed", "A", "resume1"), source: "codex-hook", toolUseId: "request-1" }, 1002);
  assert.equal(restored.desired(1002), "running");
});

test("a delayed failure upgrades the latest batch after its success indication expires and state is reloaded", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_started", "A", "expired1"), 1000);
  machine.apply(event("turn_completed", "A", "expired2"), 1001);
  const delayedAt = 1001 + config.states.success.durationMs + 1000;
  machine.tick(delayedAt);
  assert.equal(machine.desired(delayedAt), "idle");
  assert.equal(machine.transient, null);
  const restored = new TaskStateMachine(config, JSON.parse(JSON.stringify(machine.serialize())));
  restored.apply(event("turn_failed", "A", "expired3"), delayedAt + 1);
  assert.equal(restored.desired(delayedAt + 1), "error");
  assert.equal(restored.transient.expiresAt, delayedAt + 1 + config.states.error.durationMs);
});

test("a terminal-only observed turn retains its batch identity for later authoritative failure", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_completed", "A", "terminal-only1"), 1000);
  const delayedAt = 1000 + config.states.success.durationMs + 1000;
  machine.tick(delayedAt);
  machine.apply(event("turn_failed", "A", "terminal-only2"), delayedAt + 1);
  assert.equal(machine.desired(delayedAt + 1), "error");
});

test("an old failure stays silent after a newer completed batch also expires", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_completed", "old", "expired-new1"), 1000);
  machine.apply(event("turn_started", "new", "expired-new2"), 1001);
  machine.apply(event("turn_completed", "new", "expired-new3"), 1002);
  const delayedAt = 1002 + config.states.success.durationMs + 1000;
  machine.tick(delayedAt);
  const restored = new TaskStateMachine(config, machine.serialize());
  restored.apply(event("turn_failed", "old", "expired-new4"), delayedAt + 1);
  assert.equal(restored.desired(delayedAt + 1), "idle");
  assert.equal(restored.transient, null);
});

test("an authoritative failure correction preserves an explicit manual override", () => {
  const machine = new TaskStateMachine(config);
  machine.apply(event("turn_completed", "A", "override1"), 1000);
  machine.apply({ kind: "manual_state", state: "waiting", eventId: "override2" }, 1001);
  machine.apply(event("turn_failed", "A", "override3"), 1002);
  assert.equal(machine.desired(1002), "waiting");
  assert.equal(machine.terminalTasks.get("A").outcome, "error");
});

test("legacy persisted waits can resume while new correlated waits retain strict matching", () => {
  const legacy = new TaskStateMachine(config, {
    tasks: { A: { key: "A", phase: "waiting", source: "codex-hook", startedAt: 1000, updatedAt: 1000 } },
    batch: { id: "legacy-batch", startedAt: 1000, outcome: null },
  });
  legacy.apply({ ...event("turn_resumed", "A", "legacy-resume"), source: "codex-hook", toolUseId: "next-tool" }, 1001);
  assert.equal(legacy.desired(1001), "running");
  legacy.apply({ ...event("turn_waiting", "A", "new-wait"), source: "codex-hook", toolUseId: "pending-tool" }, 1002);
  legacy.apply({ ...event("turn_resumed", "A", "unrelated-resume"), source: "codex-hook", toolUseId: "unrelated-tool" }, 1003);
  assert.equal(legacy.desired(1003), "waiting");
  legacy.apply({ ...event("turn_resumed", "A", "matched-resume"), source: "codex-hook", toolUseId: "pending-tool" }, 1004);
  assert.equal(legacy.desired(1004), "running");
});

test("an interruption without an error indication still establishes the newest batch", () => {
  const machine = new TaskStateMachine({ ...config, controller: { ...config.controller, cancelAsError: false } });
  machine.apply(event("turn_completed", "old", "quiet1"), 1000);
  machine.apply(event("turn_interrupted", "new", "quiet2"), 1001);
  machine.apply(event("turn_failed", "old", "quiet3"), 1002);
  assert.equal(machine.desired(1002), "idle");
  machine.apply(event("turn_failed", "new", "quiet4"), 1003);
  assert.equal(machine.desired(1003), "error");
});
