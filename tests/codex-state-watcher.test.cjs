"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { loadConfig } = require("../lib/common.cjs");
const { CodexStateWatcher, findVersionedDatabase } = require("../lib/codex-state-watcher.cjs");

const packageDirectory = path.resolve(__dirname, "..");

function removeTemporary(directory) {
  const resolved = path.resolve(directory);
  const safeRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!resolved.startsWith(safeRoot) || !path.basename(resolved).startsWith("mchose-led-watcher-")) {
    throw new Error(`Refusing unsafe test cleanup: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function fixture(nowMs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-led-watcher-"));
  const statePath = path.join(directory, "state_5.sqlite");
  const historyPath = path.join(directory, "thread_history_1.sqlite");
  const state = new DatabaseSync(statePath);
  const history = new DatabaseSync(historyPath);
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT)");
  history.exec(
    "CREATE TABLE thread_turns (" +
      "thread_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER" +
    ")",
  );
  const insertThread = state.prepare("INSERT INTO threads (id, source) VALUES (?, ?)");
  insertThread.run("root", "vscode");
  insertThread.run("child", JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "root" } } }));
  const insertTurn = history.prepare(
    "INSERT INTO thread_turns (thread_id, turn_id, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?)",
  );
  const nowSeconds = Math.floor(nowMs / 1000);
  insertTurn.run("root", "active", "inProgress", nowSeconds - 5, null);
  insertTurn.run("child", "child-active", "inProgress", nowSeconds - 4, null);
  insertTurn.run("root", "stale", "inProgress", nowSeconds - 40000, null);
  insertTurn.run("root", "historic", "completed", nowSeconds - 20, nowSeconds - 10);
  state.close();
  history.close();
  return { directory, historyPath, nowSeconds };
}

function watcherConfig(codexHome) {
  const config = loadConfig(packageDirectory);
  return {
    ...config,
    codex: {
      ...config.codex,
      stateDatabaseWatcher: {
        ...config.codex.stateDatabaseWatcher,
        codexHome,
        initialLookbackMs: 3600000,
        includeSubagents: false,
      },
    },
  };
}

test("bootstrap emits only fresh root inProgress turns", () => {
  const nowMs = 2000000000000;
  const data = fixture(nowMs);
  try {
    fs.writeFileSync(path.join(data.directory, "state_99.sqlite"), "");
    fs.writeFileSync(path.join(data.directory, "thread_history_99.sqlite"), "");
    const delivered = [];
    const watcher = new CodexStateWatcher(watcherConfig(data.directory), {
      now: () => nowMs,
      onEvents: (events) => delivered.push(...events),
    });
    const events = watcher.pollNow();
    assert.deepEqual(events.map((event) => [event.kind, event.sessionId, event.turnId]), [
      ["turn_started", "root", "active"],
    ]);
    assert.equal(delivered.length, 1);
    assert.equal(watcher.status().healthy, true);
    assert.equal(watcher.status().activeRootTurns, 1);
    assert.equal(watcher.status().ignoredSubagentRows, 1);
    assert.equal(watcher.status().ignoredStaleActiveRows, 1);
    assert.equal(watcher.status().stateDatabase, path.join(data.directory, "state_5.sqlite"));
    assert.equal(watcher.status().historyDatabase, path.join(data.directory, "thread_history_1.sqlite"));
  } finally {
    removeTemporary(data.directory);
  }
});

test("polling emits each terminal transition once and catches a short failed turn", () => {
  let nowMs = 2000000000000;
  const data = fixture(nowMs);
  try {
    const watcher = new CodexStateWatcher(watcherConfig(data.directory), { now: () => nowMs });
    watcher.pollNow();
    const history = new DatabaseSync(data.historyPath);
    history.prepare(
      "UPDATE thread_turns SET status = 'completed', completed_at = ? WHERE thread_id = 'root' AND turn_id = 'active'",
    ).run(data.nowSeconds + 1);
    nowMs += 1000;
    assert.deepEqual(watcher.pollNow().map((event) => event.kind), ["turn_completed"]);
    assert.deepEqual(watcher.pollNow(), []);
    history.prepare(
      "INSERT INTO thread_turns (thread_id, turn_id, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?)",
    ).run("root", "short-failure", "failed", data.nowSeconds + 1, data.nowSeconds + 1);
    nowMs += 500;
    assert.deepEqual(watcher.pollNow().map((event) => event.kind), ["turn_failed"]);
    history.prepare(
      "INSERT INTO thread_turns (thread_id, turn_id, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?)",
    ).run("root", "short-interrupt", "interrupted", data.nowSeconds + 1, data.nowSeconds + 2);
    nowMs += 1000;
    assert.deepEqual(watcher.pollNow().map((event) => event.kind), ["turn_interrupted"]);
    history.close();
  } finally {
    removeTemporary(data.directory);
  }
});

test("bootstrap repairs a persisted active task that completed while daemon was down", () => {
  const nowMs = 2000000000000;
  const data = fixture(nowMs);
  try {
    const watcher = new CodexStateWatcher(watcherConfig(data.directory), {
      now: () => nowMs,
      isTaskActive: (key) => key === "root:historic",
    });
    const events = watcher.pollNow();
    assert.deepEqual(events.map((event) => [event.kind, event.turnId]), [
      ["turn_completed", "historic"],
      ["turn_started", "active"],
    ]);
  } finally {
    removeTemporary(data.directory);
  }
});

test("missing or incompatible databases degrade without throwing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-led-watcher-"));
  try {
    const watcher = new CodexStateWatcher(watcherConfig(directory));
    assert.deepEqual(watcher.pollNow(), []);
    assert.equal(watcher.status().healthy, false);
    assert.equal(watcher.status().lastError.code, "CODEX_STATE_DATABASE_MISSING");
  } finally {
    removeTemporary(directory);
  }
});

test("an incompatible newest schema is reported when no compatible fallback exists", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-led-watcher-"));
  try {
    fs.writeFileSync(path.join(directory, "state_9.sqlite"), "");
    fs.writeFileSync(path.join(directory, "thread_history_9.sqlite"), "");
    const watcher = new CodexStateWatcher(watcherConfig(directory));
    assert.deepEqual(watcher.pollNow(), []);
    assert.equal(watcher.status().healthy, false);
    assert.equal(watcher.status().lastError.code, "CODEX_STATE_DATABASE_INCOMPATIBLE");
  } finally {
    removeTemporary(directory);
  }
});

test("database discovery selects the highest compatible filename version", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-led-watcher-"));
  try {
    fs.writeFileSync(path.join(directory, "thread_history_2.sqlite"), "");
    fs.writeFileSync(path.join(directory, "thread_history_11.sqlite"), "");
    fs.writeFileSync(path.join(directory, "thread_history_11.sqlite-wal"), "");
    assert.equal(findVersionedDatabase(directory, "thread_history"), path.join(directory, "thread_history_11.sqlite"));
  } finally {
    removeTemporary(directory);
  }
});
