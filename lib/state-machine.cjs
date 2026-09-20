"use strict";

const crypto = require("node:crypto");

function terminalSeverity(outcome) {
  if (outcome === "error") return 2;
  if (outcome === "success") return 1;
  return 0;
}

class TaskStateMachine {
  constructor(config, persisted = {}) {
    this.config = config;
    this.tasks = new Map(Object.entries(persisted.tasks || {}));
    this.batch = persisted.batch || null;
    this.transient = persisted.transient || null;
    this.latestBatchId = persisted.latestBatchId || this.batch?.id || this.transient?.batchId || null;
    this.manual = persisted.manual || null;
    this.terminalTasks = new Map(Object.entries(persisted.terminalTasks || {}));
    this.seenEventIds = Array.isArray(persisted.seenEventIds) ? persisted.seenEventIds.slice(-500) : [];
    this.lastEvent = persisted.lastEvent || null;
  }

  taskKey(event) {
    if (event.taskKey) return event.taskKey;
    if (!event.sessionId || !event.turnId) throw new Error(`${event.kind} requires taskKey or sessionId + turnId`);
    return `${event.sessionId}:${event.turnId}`;
  }

  rememberEvent(event) {
    const eventId = event.eventId || crypto.randomUUID();
    if (this.seenEventIds.includes(eventId)) return false;
    this.seenEventIds.push(eventId);
    if (this.seenEventIds.length > 500) this.seenEventIds.splice(0, this.seenEventIds.length - 500);
    event.eventId = eventId;
    this.lastEvent = { ...event, receivedAt: new Date().toISOString() };
    return true;
  }

  beginBatch(now) {
    if (!this.batch || this.tasks.size === 0) {
      this.batch = {
        id: crypto.randomUUID(),
        startedAt: now,
        outcome: null,
      };
      this.latestBatchId = this.batch.id;
    }
    this.transient = null;
  }

  recordOutcome(outcome) {
    if (!outcome) return;
    if (!this.batch) {
      this.batch = { id: crypto.randomUUID(), startedAt: Date.now(), outcome: null };
      this.latestBatchId = this.batch.id;
    }
    if (terminalSeverity(outcome) > terminalSeverity(this.batch.outcome)) this.batch.outcome = outcome;
  }

  rememberTerminal(key, outcome, event, now) {
    const previous = this.terminalTasks.get(key);
    this.terminalTasks.set(key, {
      key,
      outcome,
      source: event.source || previous?.source || "unknown",
      terminalKind: event.kind,
      updatedAt: now,
      batchId: previous?.batchId || this.batch?.id || this.transient?.batchId || null,
    });
    while (this.terminalTasks.size > 1000) {
      this.terminalTasks.delete(this.terminalTasks.keys().next().value);
    }
  }

  outcomeForTerminal(event) {
    if (event.kind === "turn_completed") return "success";
    if (event.kind === "turn_failed") return "error";
    if (event.kind === "turn_interrupted") return this.config.controller.cancelAsError !== false ? "error" : null;
    return null;
  }

  showUpgradedTerminalOutcome(outcome, now, batchId) {
    if (!outcome) return;
    if (batchId && this.batch?.id === batchId) {
      this.recordOutcome(outcome);
      return;
    }
    if (batchId && this.latestBatchId === batchId && !this.batch && this.tasks.size === 0) {
      this.transient = {
        state: outcome, startedAt: now,
        expiresAt: now + this.config.states[outcome].durationMs, batchId,
      };
    }
  }

  finalizeBatch(now) {
    const outcome = this.batch?.outcome;
    if (outcome === "success" || outcome === "error") {
      const durationMs = this.config.states[outcome].durationMs;
      this.transient = {
        state: outcome,
        startedAt: now,
        expiresAt: now + durationMs,
        batchId: this.batch.id,
      };
    } else {
      this.transient = null;
    }
    this.batch = null;
  }

  apply(rawEvent, now = Date.now()) {
    const event = { ...rawEvent };
    if (!this.rememberEvent(event)) return { duplicate: true, desired: this.desired(now) };
    const taskKinds = new Set([
      "turn_started",
      "turn_resumed",
      "turn_waiting",
      "turn_completed",
      "turn_failed",
      "turn_interrupted",
    ]);
    const activeKinds = new Set(["turn_started", "turn_resumed", "turn_waiting"]);
    const terminalKinds = new Set(["turn_completed", "turn_failed", "turn_interrupted"]);
    let key = null;
    if (taskKinds.has(event.kind)) key = this.taskKey(event);
    if (activeKinds.has(event.kind) && this.terminalTasks.has(key)) {
      return { duplicate: false, ignored: "terminal-task", desired: this.desired(now) };
    }
    if (terminalKinds.has(event.kind)) {
      const previousTerminal = this.terminalTasks.get(key);
      if (previousTerminal) {
        const outcome = this.outcomeForTerminal(event);
        if (terminalSeverity(outcome) > terminalSeverity(previousTerminal.outcome)) {
          this.rememberTerminal(key, outcome, event, now);
          this.showUpgradedTerminalOutcome(outcome, now, previousTerminal.batchId);
        }
        return { duplicate: false, ignored: "duplicate-terminal-task", desired: this.desired(now) };
      }
    }
    if (taskKinds.has(event.kind)) this.manual = null;

    switch (event.kind) {
      case "turn_started":
      case "turn_resumed": {
        const previous = this.tasks.get(key);
        // SQLite only knows inProgress. It cannot supersede a hook's explicit wait.
        if (event.kind === "turn_started" && previous?.phase === "waiting") break;
        let pendingWaits = previous?.pendingWaits || [];
        if (
          event.kind === "turn_resumed" && event.source === "codex-hook" && previous?.phase === "waiting" &&
          // Older persisted tasks predate correlation metadata. Preserve their
          // original next-PostToolUse resume behavior once during migration.
          Array.isArray(previous.pendingWaits)
        ) {
          const matchingIndex = pendingWaits.findIndex((wait) =>
            wait.toolUseId && event.toolUseId
              ? wait.toolUseId === event.toolUseId
              : Boolean(wait.toolKey && event.toolKey && wait.toolKey === event.toolKey),
          );
          if (matchingIndex < 0) break;
          pendingWaits = pendingWaits.filter((_, index) => index !== matchingIndex);
          if (pendingWaits.length > 0) {
            this.tasks.set(key, { ...previous, pendingWaits, updatedAt: now });
            break;
          }
        } else {
          pendingWaits = [];
        }
        if (this.tasks.size === 0) this.beginBatch(now);
        this.tasks.set(key, {
          key,
          sessionId: event.sessionId || null,
          turnId: event.turnId || null,
          source: event.source || "unknown",
          phase: "running",
          pendingWaits,
          startedAt: this.tasks.get(key)?.startedAt || now,
          updatedAt: now,
        });
        break;
      }
      case "turn_waiting": {
        if (this.tasks.size === 0) this.beginBatch(now);
        const previous = this.tasks.get(key);
        const pendingWaits = [...(previous?.pendingWaits || [])];
        if (!event.toolUseId || !pendingWaits.some((wait) => wait.toolUseId === event.toolUseId)) {
          pendingWaits.push({
            toolUseId: event.toolUseId || null,
            toolKey: event.toolKey || null,
            reason: event.reason || "user-or-approval",
          });
        }
        this.tasks.set(key, {
          key,
          sessionId: event.sessionId || previous?.sessionId || null,
          turnId: event.turnId || previous?.turnId || null,
          source: event.source || previous?.source || "unknown",
          phase: "waiting",
          waitingReason: event.reason || "user-or-approval",
          pendingWaits,
          startedAt: previous?.startedAt || now,
          updatedAt: now,
        });
        break;
      }
      case "turn_completed":
      case "turn_failed":
      case "turn_interrupted": {
        this.tasks.delete(key);
        if (!this.batch) this.beginBatch(now);
        const outcome = this.outcomeForTerminal(event);
        this.recordOutcome(outcome);
        this.rememberTerminal(key, outcome, event, now);
        if (this.tasks.size === 0) this.finalizeBatch(now);
        break;
      }
      case "session_end": {
        const keys = [...this.tasks.entries()]
          .filter(([, task]) => task.sessionId === event.sessionId)
          .map(([key]) => key);
        for (const key of keys) {
          this.tasks.delete(key);
          this.rememberTerminal(key, "error", event, now);
        }
        if (keys.length > 0) this.recordOutcome("error");
        if (keys.length > 0 && this.tasks.size === 0) this.finalizeBatch(now);
        break;
      }
      case "manual_state": {
        if (!["idle", "waiting", "running", "success", "error"].includes(event.state)) {
          throw new Error(`Unsupported manual state: ${event.state}`);
        }
        const duration = ["success", "error"].includes(event.state)
          ? this.config.states[event.state].durationMs
          : null;
        this.transient = null;
        this.manual = {
          state: event.state,
          startedAt: now,
          expiresAt: duration === null ? null : now + duration,
        };
        break;
      }
      case "manual_clear": {
        this.manual = null;
        break;
      }
      case "clear": {
        this.tasks.clear();
        this.batch = null;
        this.latestBatchId = null;
        this.transient = null;
        this.manual = null;
        this.terminalTasks.clear();
        break;
      }
      default:
        throw new Error(`Unsupported controller event: ${event.kind}`);
    }
    return { duplicate: false, desired: this.desired(now) };
  }

  tick(now = Date.now()) {
    let changed = false;
    if (this.manual?.expiresAt !== null && this.manual?.expiresAt <= now) {
      this.manual = null;
      changed = true;
    }
    if (this.transient?.expiresAt <= now) {
      this.transient = null;
      changed = true;
    }
    let staleFailure = false;
    for (const [key, task] of this.tasks) {
      const limit = task.phase === "waiting"
        ? this.config.controller.staleWaitingTaskMs
        : this.config.controller.staleRunningTaskMs;
      if (Number.isFinite(limit) && limit > 0 && now - task.updatedAt >= limit) {
        this.tasks.delete(key);
        this.rememberTerminal(key, "error", { kind: "turn_failed", source: "stale-task-timeout" }, now);
        staleFailure = true;
        changed = true;
      }
    }
    if (staleFailure) {
      this.recordOutcome("error");
      if (this.tasks.size === 0) this.finalizeBatch(now);
    }
    return { changed, desired: this.desired(now) };
  }

  desired(now = Date.now()) {
    if (this.manual && (this.manual.expiresAt === null || this.manual.expiresAt > now)) {
      return this.manual.state;
    }
    if ([...this.tasks.values()].some((task) => task.phase === "running")) return "running";
    if (this.tasks.size > 0) return "waiting";
    if (this.transient && this.transient.expiresAt > now) return this.transient.state;
    return "idle";
  }

  serialize() {
    return {
      schemaVersion: 1,
      tasks: Object.fromEntries(this.tasks),
      batch: this.batch,
      latestBatchId: this.latestBatchId,
      transient: this.transient,
      manual: this.manual,
      terminalTasks: Object.fromEntries(this.terminalTasks),
      seenEventIds: this.seenEventIds,
      lastEvent: this.lastEvent,
    };
  }

  summary(now = Date.now()) {
    return {
      desired: this.desired(now),
      tasks: [...this.tasks.values()],
      batch: this.batch,
      latestBatchId: this.latestBatchId,
      transient: this.transient,
      manual: this.manual,
      terminalTaskCount: this.terminalTasks.size,
      lastEvent: this.lastEvent,
    };
  }
}

module.exports = { TaskStateMachine };
