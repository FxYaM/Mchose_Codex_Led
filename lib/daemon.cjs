"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const {
  appendLog,
  atomicWriteJson,
  loadConfig,
  pipeName,
  readControllerEnabled,
  readJson,
  serializeError,
} = require("./common.cjs");
const { DeviceOfflineError, K99Protocol, summarizeState } = require("./protocol.cjs");
const {
  captureSnapshot,
  clearPendingRestore,
  loadSnapshot,
  markPendingRestore,
  readPendingRestore,
  resolveSnapshotDirectory,
} = require("./snapshots.cjs");
const { TaskStateMachine } = require("./state-machine.cjs");
const { acquireHidOperationLock } = require("./operation-lock.cjs");
const { CodexStateWatcher } = require("./codex-state-watcher.cjs");

function signatureFor(stateName, preset) {
  return `${stateName}:${JSON.stringify(preset)}`;
}

function machineStatePath(runtimeDirectory) {
  return path.join(runtimeDirectory, "state", "machine.json");
}

function daemonStatusPath(runtimeDirectory) {
  return path.join(runtimeDirectory, "state", "daemon-status.json");
}

function lockPath(runtimeDirectory) {
  return path.join(runtimeDirectory, "state", "daemon.lock.json");
}

function readMachineState(runtimeDirectory) {
  return readJson(machineStatePath(runtimeDirectory), {});
}

function writeMachineState(runtimeDirectory, machine) {
  atomicWriteJson(machineStatePath(runtimeDirectory), machine.serialize());
}

function writeStatus(runtimeDirectory, status) {
  atomicWriteJson(daemonStatusPath(runtimeDirectory), status);
}

async function runDaemon(packageDirectory, explicitConfigPath) {
  const config = loadConfig(packageDirectory, explicitConfigPath);
  const runtimeDirectory = config.runtimeDirectory;
  fs.mkdirSync(path.join(runtimeDirectory, "state"), { recursive: true });
  const protocol = new K99Protocol(config.device, { packageDirectory });
  const machine = new TaskStateMachine(config, readMachineState(runtimeDirectory));
  const startedAt = new Date().toISOString();
  const ipcPath = pipeName();
  let server;
  let reconciling = false;
  let reconcileRequested = false;
  let stopped = false;
  let shuttingDown = false;
  let shutdownDeadline = null;
  let shutdownReason = null;
  let requestedRestore = null;
  let currentOwnership = null;
  let ownershipActiveThisProcess = false;
  let lastAppliedSignature = null;
  let lastAppliedAt = null;
  let lastDeviceState = null;
  let lastError = null;
  let lastPresence = null;
  let lastPresenceCheckAt = 0;
  let retryTimer = null;
  let retryIndex = 0;
  let hidOperationLock = null;
  let codexStateWatcher = null;
  let lastWatcherHealth = null;

  const initialPending = readPendingRestore(runtimeDirectory);
  if (initialPending) {
    try {
      currentOwnership = loadSnapshot(initialPending.snapshotDirectory);
    } catch (error) {
      lastError = serializeError(error);
      appendLog(runtimeDirectory, "error", "Pending restore snapshot is invalid", lastError);
    }
  }

  function publicStatus() {
    return {
      schemaVersion: 1,
      pid: process.pid,
      startedAt,
      updatedAt: new Date().toISOString(),
      pipeName: ipcPath,
      shuttingDown,
      shutdownReason,
      enabled: readControllerEnabled(runtimeDirectory),
      desired: machine.desired(),
      machine: machine.summary(),
      deviceConnected: lastPresence,
      lastPresenceCheckAt: lastPresenceCheckAt ? new Date(lastPresenceCheckAt).toISOString() : null,
      ownershipSnapshot: currentOwnership
        ? {
            snapshotId: currentOwnership.manifest.snapshotId,
            directory: currentOwnership.directory,
          }
        : null,
      pendingRestore: readPendingRestore(runtimeDirectory),
      lastAppliedSignature,
      lastAppliedAt,
      lastDeviceState,
      lastError,
      codexStateWatcher: codexStateWatcher
        ? codexStateWatcher.status()
        : {
            enabled: config.codex.stateDatabaseWatcher.enabled,
            initialized: false,
            healthy: null,
          },
      configPath: config.configPath,
      runtimeDirectory,
    };
  }

  function persist() {
    writeMachineState(runtimeDirectory, machine);
    writeStatus(runtimeDirectory, publicStatus());
  }

  function resetRetry() {
    retryIndex = 0;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry() {
    if (retryTimer || stopped) return;
    const delays = config.controller.reconnectBackoffMs;
    const delay = delays[Math.min(retryIndex, delays.length - 1)];
    retryIndex += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      requestReconcile();
    }, delay);
    retryTimer.unref?.();
  }

  async function restoreLoadedSnapshot(loaded, reason) {
    appendLog(runtimeDirectory, "info", `Restoring snapshot: ${reason}`, {
      snapshotId: loaded.manifest.snapshotId,
    });
    const result = await protocol.restoreExact(loaded.state, {
      commandDelayMs: config.controller.commandDelayMs,
      readbackDelayMs: config.controller.readbackDelayMs,
    });
    if (!result.ok) {
      const mismatch = new Error("Snapshot restore readback mismatch");
      mismatch.details = {
        performanceDifferences: result.performanceDifferences,
        colorDifferences: result.colorDifferences,
      };
      throw mismatch;
    }
    const pending = readPendingRestore(runtimeDirectory);
    const restoredPending = Boolean(pending && pending.snapshotId === loaded.manifest.snapshotId);
    if (restoredPending) clearPendingRestore(runtimeDirectory, loaded.manifest.snapshotId);
    if (currentOwnership?.manifest.snapshotId === loaded.manifest.snapshotId) {
      currentOwnership = null;
      ownershipActiveThisProcess = false;
    }
    lastAppliedSignature = restoredPending ? "preserve" : null;
    lastAppliedAt = new Date().toISOString();
    lastDeviceState = summarizeState(result.after);
    appendLog(runtimeDirectory, "info", "Snapshot restored and verified", {
      snapshotId: loaded.manifest.snapshotId,
    });
    return result;
  }

  async function handleRequestedRestore() {
    if (!requestedRestore) return false;
    const request = requestedRestore;
    const directory = resolveSnapshotDirectory(runtimeDirectory, request.selector);
    const loaded = loadSnapshot(directory);
    await restoreLoadedSnapshot(loaded, "explicit restore request");
    requestedRestore = null;
    return true;
  }

  async function recoverPendingIfNeeded() {
    const pending = readPendingRestore(runtimeDirectory);
    if (!pending) {
      if (currentOwnership && currentOwnership.manifest.kind !== "takeover") currentOwnership = null;
      return false;
    }
    const loaded = loadSnapshot(pending.snapshotDirectory);
    await restoreLoadedSnapshot(loaded, "unclean-exit or active takeover recovery");
    return true;
  }

  async function ensureOwnership() {
    if (currentOwnership && readPendingRestore(runtimeDirectory)) return currentOwnership;
    const snapshot = captureSnapshot(runtimeDirectory, protocol, "takeover", [
      "Captured and atomically committed before the controller changed any lighting byte.",
      "A pending-restore pointer was committed before the first HID write.",
    ]);
    markPendingRestore(runtimeDirectory, snapshot);
    currentOwnership = snapshot;
    ownershipActiveThisProcess = true;
    appendLog(runtimeDirectory, "info", "Captured takeover snapshot", {
      snapshotId: snapshot.manifest.snapshotId,
      directory: snapshot.directory,
    });
    return snapshot;
  }

  async function reconcileOnce() {
    let deviceObserved = false;
    machine.tick();
    if (requestedRestore) {
      await handleRequestedRestore();
      deviceObserved = true;
      lastAppliedSignature = null;
    } else if (readPendingRestore(runtimeDirectory) && !ownershipActiveThisProcess) {
      await recoverPendingIfNeeded();
      deviceObserved = true;
      lastAppliedSignature = null;
    }

    if (shuttingDown) {
      const pending = readPendingRestore(runtimeDirectory);
      if (pending) {
        const loaded = currentOwnership || loadSnapshot(pending.snapshotDirectory);
        await restoreLoadedSnapshot(loaded, "daemon shutdown");
        deviceObserved = true;
      }
      await finishShutdown(0);
      return deviceObserved;
    }

    const desired = machine.desired();
    const preset = config.states[desired];
    if (preset.mode === "preserve") {
      const pending = readPendingRestore(runtimeDirectory);
      if (pending) {
        const loaded = currentOwnership || loadSnapshot(pending.snapshotDirectory);
        await restoreLoadedSnapshot(loaded, `${desired} state releases controller ownership`);
        deviceObserved = true;
      } else {
        lastAppliedSignature = "preserve";
      }
      return deviceObserved;
    }

    const signature = signatureFor(desired, preset);
    if (lastAppliedSignature === signature && currentOwnership) return deviceObserved;
    if (readPendingRestore(runtimeDirectory) && !ownershipActiveThisProcess) {
      await recoverPendingIfNeeded();
      deviceObserved = true;
    }
    await ensureOwnership();
    const result = await protocol.applyPreset(preset, {
      commandDelayMs: config.controller.commandDelayMs,
      readbackDelayMs: config.controller.readbackDelayMs,
    });
    deviceObserved = true;
    lastAppliedSignature = signature;
    lastAppliedAt = new Date().toISOString();
    lastDeviceState = summarizeState(result.after || result.before);
    appendLog(runtimeDirectory, "info", `Applied ${desired} lighting`, {
      skipped: result.skipped,
      reason: result.reason,
      performanceWritten: result.performanceWritten,
      colorWritten: result.colorWritten,
    });
    return deviceObserved;
  }

  async function reconcileLoop() {
    if (reconciling || stopped) {
      reconcileRequested = true;
      return;
    }
    reconciling = true;
    try {
      do {
        reconcileRequested = false;
        try {
          const deviceObserved = await reconcileOnce();
          if (stopped) return;
          lastError = null;
          if (deviceObserved) lastPresence = true;
          resetRetry();
        } catch (error) {
          lastError = serializeError(error);
          if (error instanceof DeviceOfflineError || error.code === "DEVICE_OFFLINE") lastPresence = false;
          appendLog(runtimeDirectory, "error", "Reconciliation failed", lastError);
          if (shuttingDown && Date.now() >= shutdownDeadline) {
            appendLog(runtimeDirectory, "error", "Shutdown restore timed out; pending snapshot retained", {
              pendingRestore: readPendingRestore(runtimeDirectory),
            });
            await finishShutdown(2);
            return;
          }
          scheduleRetry();
        }
        persist();
      } while (reconcileRequested && !stopped);
    } finally {
      reconciling = false;
    }
  }

  function requestReconcile() {
    reconcileRequested = true;
    void reconcileLoop();
  }

  async function finishShutdown(exitCode) {
    if (stopped) return;
    stopped = true;
    codexStateWatcher?.stop();
    resetRetry();
    try { persist(); } catch {}
    await new Promise((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      setTimeout(resolve, 500).unref?.();
    });
    if (hidOperationLock) {
      try {
        hidOperationLock.release();
      } catch (error) {
        appendLog(runtimeDirectory, "error", "Failed to release the HID operation lock", serializeError(error));
      }
      hidOperationLock = null;
    }
    try { fs.unlinkSync(lockPath(runtimeDirectory)); } catch {}
    appendLog(runtimeDirectory, exitCode === 0 ? "info" : "error", "Daemon stopped", {
      exitCode,
      pendingRestore: readPendingRestore(runtimeDirectory),
    });
    setTimeout(() => process.exit(exitCode), 20);
  }

  function initiateShutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    codexStateWatcher?.stop();
    shutdownReason = reason;
    shutdownDeadline = Date.now() + config.controller.shutdownRestoreTimeoutMs;
    requestReconcile();
  }

  function handleMessage(message) {
    switch (message.type) {
      case "ping":
        return { ok: true, status: publicStatus() };
      case "status":
        return { ok: true, status: publicStatus() };
      case "event": {
        if (shuttingDown || stopped || !readControllerEnabled(runtimeDirectory)) {
          return { ok: true, ignored: "controller-stopping-or-disabled", desired: machine.desired() };
        }
        // Official Codex hooks and the local SQLite watcher are complementary.
        // A readable/healthy database does not prove that the watcher observed
        // this specific turn, so never suppress a hook merely because the
        // watcher is healthy. TaskStateMachine already de-duplicates events by
        // event id and task key, and a later watcher failure can upgrade a
        // hook-reported success to error without resurrecting the task.
        const result = machine.apply(message.event);
        try {
          appendLog(runtimeDirectory, "info", "Controller event received", {
            source: message.event?.source || null,
            kind: message.event?.kind || null,
            sessionId: message.event?.sessionId || null,
            turnId: message.event?.turnId || null,
            taskKey: message.event?.taskKey || null,
            duplicate: result.duplicate === true,
            ignored: result.ignored || null,
            desired: result.desired,
          });
        } catch {}
        persist();
        requestReconcile();
        return { ok: true, duplicate: result.duplicate, desired: result.desired };
      }
      case "restore":
        requestedRestore = {
          selector: message.snapshot || null,
        };
        requestReconcile();
        return { ok: true, accepted: true };
      case "shutdown":
        initiateShutdown(message.reason || "stop command");
        return { ok: true, accepted: true };
      default:
        throw new Error(`Unsupported IPC request: ${message.type}`);
    }
  }

  server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.length > 1024 * 1024) socket.destroy(new Error("IPC message is too large"));
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      const line = input.slice(0, newline);
      input = "";
      try {
        const response = handleMessage(JSON.parse(line));
        socket.end(`${JSON.stringify(response)}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: serializeError(error) })}\n`);
      }
    });
    socket.on("error", () => {});
  });

  hidOperationLock = await acquireHidOperationLock(runtimeDirectory, "daemon", 3000);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(ipcPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    hidOperationLock.release();
    hidOperationLock = null;
    throw error;
  }

  atomicWriteJson(lockPath(runtimeDirectory), {
    schemaVersion: 1,
    pid: process.pid,
    startedAt,
    pipeName: ipcPath,
    executable: process.execPath,
  });
  appendLog(runtimeDirectory, "info", "Daemon started", { pid: process.pid, pipeName: ipcPath });
  persist();

  process.on("SIGINT", () => initiateShutdown("SIGINT"));
  process.on("SIGTERM", () => initiateShutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    lastError = serializeError(error);
    appendLog(runtimeDirectory, "error", "Uncaught exception", lastError);
    initiateShutdown("uncaughtException");
  });
  process.on("unhandledRejection", (error) => {
    lastError = serializeError(error instanceof Error ? error : new Error(String(error)));
    appendLog(runtimeDirectory, "error", "Unhandled rejection", lastError);
    initiateShutdown("unhandledRejection");
  });

  const tickTimer = setInterval(() => {
    const tick = machine.tick();
    if (tick.changed) {
      persist();
      requestReconcile();
    }
    if (shuttingDown && Date.now() >= shutdownDeadline) requestReconcile();
  }, config.controller.pollIntervalMs);

  const presenceTimer = setInterval(() => {
    if (!currentOwnership && !readPendingRestore(runtimeDirectory)) return;
    lastPresenceCheckAt = Date.now();
    let connected = false;
    try {
      protocol.selectDevice();
      connected = true;
    } catch {
      connected = false;
    }
    if (lastPresence !== null && connected !== lastPresence) {
      lastAppliedSignature = null;
      appendLog(runtimeDirectory, "info", connected ? "Keyboard reconnected" : "Keyboard disconnected");
      requestReconcile();
    }
    lastPresence = connected;
  }, config.controller.presencePollMs);

  tickTimer.unref?.();
  presenceTimer.unref?.();

  codexStateWatcher = new CodexStateWatcher(config, {
    isTaskActive: (key) => machine.tasks.has(key),
    onEvents: (events) => {
      if (stopped || shuttingDown || !readControllerEnabled(runtimeDirectory)) return;
      for (const event of events) {
        machine.apply(event);
      }
      if (events.length > 0) {
        try {
          appendLog(runtimeDirectory, "info", "Observed Codex task state transition", {
            source: "experimental-codex-local-state",
            kinds: events.map((event) => event.kind),
            count: events.length,
          });
        } catch {}
        try { persist(); } catch {}
        requestReconcile();
      }
    },
    onStatus: (watcherStatus) => {
      if (watcherStatus.healthy === lastWatcherHealth) return;
      lastWatcherHealth = watcherStatus.healthy;
      try {
        if (watcherStatus.healthy === true) {
          appendLog(runtimeDirectory, "info", "Codex local-state watcher is healthy", {
            source: watcherStatus.source,
            historyDatabase: watcherStatus.historyDatabase,
            stateDatabase: watcherStatus.stateDatabase,
          });
        } else if (watcherStatus.healthy === false) {
          appendLog(runtimeDirectory, "error", "Codex local-state watcher is unavailable; trusted hooks remain as fallback", watcherStatus.lastError);
        }
      } catch {}
      try { persist(); } catch {}
    },
  });
  codexStateWatcher.start();
  requestReconcile();
}

module.exports = {
  daemonStatusPath,
  lockPath,
  machineStatePath,
  runDaemon,
};
