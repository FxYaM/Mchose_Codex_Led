"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TERMINAL_STATUS_TO_KIND = new Map([
  ["completed", "turn_completed"],
  ["failed", "turn_failed"],
  ["interrupted", "turn_interrupted"],
]);

function listVersionedDatabases(directory, prefix) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = entry.name.match(new RegExp(`^${prefix}_(\\d+)\\.sqlite$`, "i"));
      return match ? { path: path.join(directory, entry.name), version: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.version - left.version)
    .map((entry) => entry.path);
}

function findVersionedDatabase(directory, prefix) {
  return listVersionedDatabases(directory, prefix)[0] || null;
}

function openCompatibleDatabase(DatabaseSync, candidates, validationSql, label) {
  const failures = [];
  for (const candidate of candidates) {
    let database;
    try {
      database = new DatabaseSync(candidate, { readOnly: true });
      database.exec("PRAGMA query_only = ON");
      database.prepare(validationSql).all();
      return { database, path: candidate };
    } catch (error) {
      try { database?.close(); } catch {}
      failures.push({ file: path.basename(candidate), message: error?.message || String(error) });
    }
  }
  const incompatible = new Error(`No compatible Codex ${label} database was found`);
  incompatible.code = "CODEX_STATE_DATABASE_INCOMPATIBLE";
  incompatible.details = failures;
  throw incompatible;
}

function isSubagentSource(source) {
  if (typeof source !== "string" || !source.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(source);
    return Boolean(parsed?.subagent?.thread_spawn);
  } catch {
    return false;
  }
}

function eventForRow(row) {
  const status = String(row.status);
  const kind = status === "inProgress" ? "turn_started" : TERMINAL_STATUS_TO_KIND.get(status);
  if (!kind) return null;
  const eventAtSeconds = status === "inProgress" ? row.started_at : row.completed_at;
  return {
    kind,
    source: "codex-local-state",
    sessionId: String(row.thread_id),
    turnId: String(row.turn_id),
    eventId: `codex-local-state:${row.thread_id}:${row.turn_id}:${status}`,
    at: eventAtSeconds !== null && eventAtSeconds !== undefined && Number.isFinite(Number(eventAtSeconds))
      ? new Date(Number(eventAtSeconds) * 1000).toISOString()
      : new Date().toISOString(),
    experimentalSource: true,
  };
}

function fingerprint(row) {
  return `${row.status}:${row.started_at ?? ""}:${row.completed_at ?? ""}`;
}

function errorSummary(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code,
    details: error?.details,
  };
}

class CodexStateWatcher {
  constructor(config, callbacks = {}) {
    this.options = config.codex.stateDatabaseWatcher;
    this.onEvents = callbacks.onEvents || (() => {});
    this.onStatus = callbacks.onStatus || (() => {});
    this.isTaskActive = callbacks.isTaskActive || (() => false);
    this.now = callbacks.now || (() => Date.now());
    this.timer = null;
    this.polling = false;
    this.known = new Map();
    this.lastErrorSignature = null;
    this.lastErrorReportedAt = 0;
    this.lastSuccessfulPollAtMs = null;
    this.currentStatus = {
      enabled: this.options.enabled,
      source: "experimental-codex-local-state",
      officialInterface: false,
      initialized: false,
      healthy: this.options.enabled ? null : false,
      codexHome: this.options.codexHome,
      historyDatabase: null,
      stateDatabase: null,
      lastPollAt: null,
      lastSuccessfulPollAt: null,
      lastEventAt: null,
      observedRows: 0,
      activeRootTurns: 0,
      ignoredSubagentRows: 0,
      ignoredUnknownThreadRows: 0,
      ignoredStaleActiveRows: 0,
      lastError: null,
    };
  }

  status() {
    return { ...this.currentStatus };
  }

  updateStatus(patch) {
    this.currentStatus = { ...this.currentStatus, ...patch };
    this.onStatus(this.status());
  }

  reportError(error) {
    const now = this.now();
    const summary = errorSummary(error);
    const signature = `${summary.code || ""}:${summary.message}`;
    const shouldReport = signature !== this.lastErrorSignature || now - this.lastErrorReportedAt >= 60000;
    this.lastErrorSignature = signature;
    if (shouldReport) this.lastErrorReportedAt = now;
    this.updateStatus({
      healthy: false,
      lastPollAt: new Date(now).toISOString(),
      lastError: summary,
    });
    return shouldReport ? summary : null;
  }

  readRows() {
    let DatabaseSync;
    try {
      ({ DatabaseSync } = require("node:sqlite"));
    } catch (error) {
      const unavailable = new Error(`node:sqlite is unavailable in ${process.version}; Codex local-state watching is disabled until a compatible Node.js runtime is used`);
      unavailable.code = "NODE_SQLITE_UNAVAILABLE";
      unavailable.cause = error;
      throw unavailable;
    }

    const historyCandidates = listVersionedDatabases(this.options.codexHome, "thread_history");
    const stateCandidates = listVersionedDatabases(this.options.codexHome, "state");
    if (historyCandidates.length === 0 || stateCandidates.length === 0) {
      const missing = new Error("Codex local state databases were not found");
      missing.code = "CODEX_STATE_DATABASE_MISSING";
      throw missing;
    }

    const stateSelection = openCompatibleDatabase(
      DatabaseSync,
      stateCandidates,
      "SELECT id, source FROM threads LIMIT 0",
      "thread metadata",
    );
    let historySelection;
    try {
      historySelection = openCompatibleDatabase(
        DatabaseSync,
        historyCandidates,
        "SELECT thread_id, turn_id, status, started_at, completed_at FROM thread_turns LIMIT 0",
        "thread history",
      );
      const state = stateSelection.database;
      const history = historySelection.database;
      const threadMetadata = new Map(
        state.prepare("SELECT id, source FROM threads").all().map((row) => [String(row.id), row.source]),
      );
      const cutoffSeconds = Math.floor((this.now() - this.options.initialLookbackMs) / 1000);
      const rows = history.prepare(
        "SELECT thread_id, turn_id, status, started_at, completed_at " +
        "FROM thread_turns " +
        "WHERE status = 'inProgress' OR started_at >= ? OR completed_at >= ? " +
        "ORDER BY started_at, thread_id, turn_id",
      ).all(cutoffSeconds, cutoffSeconds);
      return {
        historyDatabase: historySelection.path,
        stateDatabase: stateSelection.path,
        threadMetadata,
        rows,
      };
    } finally {
      try { historySelection?.database.close(); } finally { stateSelection.database.close(); }
    }
  }

  pollNow() {
    if (!this.options.enabled || this.polling) return [];
    this.polling = true;
    const pollStartedAtMs = this.now();
    try {
      const snapshot = this.readRows();
      const cutoffMs = pollStartedAtMs - this.options.initialLookbackMs;
      const nextKnown = new Map();
      const events = [];
      let ignoredSubagentRows = 0;
      let ignoredUnknownThreadRows = 0;
      let ignoredStaleActiveRows = 0;
      let activeRootTurns = 0;

      for (const row of snapshot.rows) {
        const threadId = String(row.thread_id);
        const turnId = String(row.turn_id);
        if (!snapshot.threadMetadata.has(threadId)) {
          ignoredUnknownThreadRows += 1;
          continue;
        }
        if (!this.options.includeSubagents && isSubagentSource(snapshot.threadMetadata.get(threadId))) {
          ignoredSubagentRows += 1;
          continue;
        }
        const key = `${threadId}:${turnId}`;
        const currentFingerprint = fingerprint(row);
        const previousFingerprint = this.known.get(key);
        nextKnown.set(key, currentFingerprint);
        const startedAtMs = Number(row.started_at) * 1000;
        const completedAtMs = Number(row.completed_at) * 1000;
        const isFreshActive = row.status === "inProgress" && Number.isFinite(startedAtMs) && startedAtMs >= cutoffMs;
        if (row.status === "inProgress") {
          if (isFreshActive) activeRootTurns += 1;
          else ignoredStaleActiveRows += 1;
        }

        let shouldEmit = false;
        if (!this.currentStatus.initialized) {
          shouldEmit = isFreshActive || (TERMINAL_STATUS_TO_KIND.has(row.status) && this.isTaskActive(key));
        } else if (previousFingerprint !== currentFingerprint) {
          if (previousFingerprint !== undefined) {
            shouldEmit = row.status !== "inProgress" || isFreshActive;
          } else if (isFreshActive) {
            shouldEmit = true;
          } else if (
            TERMINAL_STATUS_TO_KIND.has(row.status) &&
            Number.isFinite(completedAtMs) &&
            completedAtMs >= (this.lastSuccessfulPollAtMs || pollStartedAtMs) - 1500
          ) {
            shouldEmit = true;
          }
        }
        if (shouldEmit) {
          const event = eventForRow(row);
          if (event) events.push(event);
        }
      }

      this.known = nextKnown;
      this.lastSuccessfulPollAtMs = pollStartedAtMs;
      this.lastErrorSignature = null;
      const successfulAt = new Date(pollStartedAtMs).toISOString();
      this.updateStatus({
        initialized: true,
        healthy: true,
        historyDatabase: snapshot.historyDatabase,
        stateDatabase: snapshot.stateDatabase,
        lastPollAt: successfulAt,
        lastSuccessfulPollAt: successfulAt,
        observedRows: snapshot.rows.length,
        activeRootTurns,
        ignoredSubagentRows,
        ignoredUnknownThreadRows,
        ignoredStaleActiveRows,
        lastError: null,
        ...(events.length > 0 ? { lastEventAt: successfulAt } : {}),
      });
      if (events.length > 0) this.onEvents(events);
      return events;
    } catch (error) {
      this.reportError(error);
      return [];
    } finally {
      this.polling = false;
    }
  }

  start() {
    if (!this.options.enabled || this.timer) return;
    this.pollNow();
    this.timer = setInterval(() => this.pollNow(), this.options.pollIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = {
  CodexStateWatcher,
  eventForRow,
  findVersionedDatabase,
  isSubagentSource,
  listVersionedDatabases,
};
