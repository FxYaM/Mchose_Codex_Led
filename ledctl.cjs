#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  atomicWriteJson,
  ensureDirectory,
  isoFileTimestamp,
  loadConfig,
  readControllerEnabled,
  readJson,
  serializeError,
  sleep,
  writeControllerEnabled,
} = require("./lib/common.cjs");
const { runDaemon, daemonStatusPath, machineStatePath } = require("./lib/daemon.cjs");
const { resolveCodexExecutable } = require("./codex-exec-led.cjs");
const { daemonRunning, ensureDaemon, sendIpc } = require("./lib/ipc.cjs");
const { withHidOperationLock } = require("./lib/operation-lock.cjs");
const {
  DeviceOfflineError,
  IdentityMismatchError,
  K99Protocol,
  summarizeState,
} = require("./lib/protocol.cjs");
const {
  captureSnapshot,
  clearPendingRestore,
  listSnapshots,
  loadSnapshot,
  markPendingRestore,
  readPendingRestore,
  resolveSnapshotDirectory,
} = require("./lib/snapshots.cjs");

const packageDirectory = __dirname;

function takeOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function print(value) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return `MCHOSE K99 V2 / Codex LED controller

Usage:
  mchose-led.ps1 start
  mchose-led.ps1 autostart
  mchose-led.ps1 stop
  mchose-led.ps1 status
  mchose-led.ps1 idle|waiting|running|success|error
  mchose-led.ps1 auto
  mchose-led.ps1 read
  mchose-led.ps1 snapshot [--kind manual-baseline]
  mchose-led.ps1 snapshots
  mchose-led.ps1 restore [--snapshot <directory-or-id>] [--accept-device] [--watch]
  mchose-led.ps1 device-test [--duration-ms 5000]
  mchose-led.ps1 codex-info
  mchose-led.ps1 diagnose
  mchose-led.ps1 event <start|resume|waiting|success|error|interrupt> --task <id>
  mchose-led.ps1 daemon

Global option:
  --config <path>`;
}

function findNestedErrorByCode(error, code) {
  if (!error) return null;
  if (error.code === code) return error;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = findNestedErrorByCode(nested, code);
      if (found) return found;
    }
  }
  return findNestedErrorByCode(error.cause, code);
}

async function waitForDaemonStop(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await daemonRunning())) return true;
    await sleep(100);
  }
  return false;
}

async function stopDaemon(config, reason) {
  if (!(await daemonRunning())) return { wasRunning: false, stopped: true };
  await sendIpc({ type: "shutdown", reason }, 1000);
  const stopped = await waitForDaemonStop(config.controller.shutdownRestoreTimeoutMs + 2500);
  return { wasRunning: true, stopped };
}

function clearPersistedMachine(runtimeDirectory, source) {
  atomicWriteJson(machineStatePath(runtimeDirectory), {
    schemaVersion: 1,
    tasks: {},
    batch: null,
    transient: null,
    manual: null,
    terminalTasks: {},
    seenEventIds: [],
    lastEvent: {
      kind: "clear",
      source,
      receivedAt: new Date().toISOString(),
    },
  });
}

async function directRestore(config, protocol, selector, options) {
  return withHidOperationLock(config.runtimeDirectory, "direct-restore", async () => {
    const directory = resolveSnapshotDirectory(config.runtimeDirectory, selector);
    const snapshot = loadSnapshot(directory);
    let attempt = 0;
    const delays = config.controller.reconnectBackoffMs;
    for (;;) {
      try {
        const result = await protocol.restoreExact(snapshot.state, {
          acceptDevice: options.acceptDevice,
          commandDelayMs: config.controller.commandDelayMs,
          readbackDelayMs: config.controller.readbackDelayMs,
        });
        if (!result.ok) {
          return {
            ok: false,
            code: "READBACK_MISMATCH",
            snapshot: snapshot.manifest.snapshotId,
            performanceDifferences: result.performanceDifferences,
            colorDifferences: result.colorDifferences,
          };
        }
        const pending = readPendingRestore(config.runtimeDirectory);
        const pendingCleared = Boolean(
          pending &&
          pending.snapshotId === snapshot.manifest.snapshotId &&
          clearPendingRestore(config.runtimeDirectory, snapshot.manifest.snapshotId),
        );
        return {
          ok: true,
          snapshot: snapshot.manifest.snapshotId,
          pendingCleared,
          pendingRetained: pending && !pendingCleared ? pending.snapshotId : null,
          restoredState: summarizeState(result.after),
        };
      } catch (error) {
        if (error instanceof IdentityMismatchError) throw error;
        if (!(error instanceof DeviceOfflineError) || !options.watch) throw error;
        const delay = delays[Math.min(attempt, delays.length - 1)];
        attempt += 1;
        process.stderr.write(`Keyboard offline; restore remains pending. Retrying in ${delay} ms...\n`);
        await sleep(delay);
      }
    }
  });
}

async function deviceTest(config, protocol, durationMs) {
  return withHidOperationLock(config.runtimeDirectory, "device-test", async () => {
    const resultsDirectory = ensureDirectory(path.join(config.runtimeDirectory, "test-results"));
    const resultPath = path.join(resultsDirectory, `device-test-${isoFileTimestamp()}-${crypto.randomBytes(3).toString("hex")}.json`);
    const result = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    requested: {
      state: "running",
      preset: config.states.running,
      durationMs,
    },
    deviceReadbackConfirmed: false,
    visualConfirmation: "not-yet-reported-by-user",
    snapshot: null,
    testError: null,
    restoreError: null,
    restoreMismatch: null,
    closeError: null,
    restoredAndVerified: false,
    };
    let snapshot;
    try {
    snapshot = captureSnapshot(config.runtimeDirectory, protocol, "validation-test-entry", [
      "Short blue breathing validation; this snapshot is the exact restoration source.",
    ]);
    result.snapshot = {
      snapshotId: snapshot.manifest.snapshotId,
      directory: snapshot.directory,
    };
    markPendingRestore(config.runtimeDirectory, snapshot);
    try {
      const applied = await protocol.applyPreset(config.states.running, {
        commandDelayMs: config.controller.commandDelayMs,
        readbackDelayMs: config.controller.readbackDelayMs,
      });
      result.deviceReadbackConfirmed = true;
      result.applied = {
        skipped: applied.skipped,
        performanceWritten: applied.performanceWritten,
        colorWritten: applied.colorWritten,
        readback: summarizeState(applied.after || applied.before),
      };
      await sleep(durationMs);
    } catch (error) {
      result.testError = serializeError(error);
      const closeError = findNestedErrorByCode(error, "HID_CLOSE_FAILED");
      if (closeError) result.closeError = serializeError(closeError);
    }

    try {
      const restored = await protocol.restoreExact(snapshot.state, {
        commandDelayMs: config.controller.commandDelayMs,
        readbackDelayMs: config.controller.readbackDelayMs,
      });
      if (!restored.ok) {
        result.restoreMismatch = {
          performanceDifferences: restored.performanceDifferences,
          colorDifferences: restored.colorDifferences,
        };
      } else {
        result.restoredAndVerified = true;
        result.restoredState = summarizeState(restored.after);
        clearPendingRestore(config.runtimeDirectory, snapshot.manifest.snapshotId);
      }
    } catch (error) {
      result.restoreError = serializeError(error);
      const closeError = findNestedErrorByCode(error, "HID_CLOSE_FAILED");
      if (closeError) result.closeError = serializeError(closeError);
    }
    } catch (error) {
      result.testError = result.testError || serializeError(error);
    }
    result.finishedAt = new Date().toISOString();
    result.ok =
      result.deviceReadbackConfirmed &&
      result.restoredAndVerified &&
      !result.testError &&
      !result.restoreError &&
      !result.restoreMismatch &&
      !result.closeError;
    atomicWriteJson(resultPath, result);
    return { ...result, resultPath };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const explicitConfig = takeOption(args, "--config");
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    print(usage());
    return;
  }
  if (command === "daemon") {
    await runDaemon(packageDirectory, explicitConfig);
    return;
  }

  const config = loadConfig(packageDirectory, explicitConfig);
  const protocol = new K99Protocol(config.device, { packageDirectory });

  switch (command) {
    case "start": {
      writeControllerEnabled(config.runtimeDirectory, true, "start command");
      const started = await ensureDaemon(packageDirectory, config.configPath);
      print({ ok: true, daemon: started.alreadyRunning ? "already-running" : "started", pid: started.pid || started.response?.status?.pid });
      break;
    }
    case "autostart": {
      // Windows logon entry calls this command. Respect an explicit prior `stop`
      // instead of silently re-enabling the controller on every sign-in.
      if (!readControllerEnabled(config.runtimeDirectory)) {
        print({ ok: true, daemon: "disabled", reason: "controller is persistently disabled" });
        break;
      }
      const started = await ensureDaemon(packageDirectory, config.configPath);
      print({ ok: true, daemon: started.alreadyRunning ? "already-running" : "started", pid: started.pid || started.response?.status?.pid });
      break;
    }
    case "stop": {
      writeControllerEnabled(config.runtimeDirectory, false, "stop command");
      const stopped = await stopDaemon(config, "manual stop command");
      if (stopped.stopped) clearPersistedMachine(config.runtimeDirectory, "manual-stop");
      const pending = readPendingRestore(config.runtimeDirectory);
      print({ ok: stopped.stopped && !pending, ...stopped, pendingRestore: pending });
      if (!stopped.stopped || pending) process.exitCode = 2;
      break;
    }
    case "status": {
      if (await daemonRunning()) {
        print((await sendIpc({ type: "status" }, 1000)).status);
      } else {
        print({
          running: false,
          enabled: readControllerEnabled(config.runtimeDirectory),
          savedStatus: readJson(daemonStatusPath(config.runtimeDirectory), null),
          pendingRestore: readPendingRestore(config.runtimeDirectory),
        });
      }
      break;
    }
    case "idle":
    case "waiting":
    case "running":
    case "success":
    case "error": {
      writeControllerEnabled(config.runtimeDirectory, true, `manual ${command} command`);
      await ensureDaemon(packageDirectory, config.configPath);
      const response = await sendIpc({
        type: "event",
        event: {
          kind: "manual_state",
          state: command,
          source: "manual-cli",
          eventId: `manual-${crypto.randomUUID()}`,
        },
      });
      print(response);
      break;
    }
    case "auto": {
      writeControllerEnabled(config.runtimeDirectory, true, "manual auto command");
      await ensureDaemon(packageDirectory, config.configPath);
      print(await sendIpc({
        type: "event",
        event: { kind: "manual_clear", source: "manual-cli", eventId: `manual-${crypto.randomUUID()}` },
      }));
      break;
    }
    case "event": {
      const action = args.shift();
      const task = takeOption(args, "--task");
      if (!task) throw new Error("event requires --task <id>");
      const kindByAction = {
        start: "turn_started",
        resume: "turn_resumed",
        waiting: "turn_waiting",
        success: "turn_completed",
        error: "turn_failed",
        interrupt: "turn_interrupted",
      };
      const kind = kindByAction[action];
      if (!kind) throw new Error(`Unsupported event action: ${action}`);
      writeControllerEnabled(config.runtimeDirectory, true, `manual event ${action}`);
      await ensureDaemon(packageDirectory, config.configPath);
      print(await sendIpc({
        type: "event",
        event: {
          kind,
          taskKey: task,
          source: "manual-event",
          eventId: `event-${crypto.randomUUID()}`,
        },
      }));
      break;
    }
    case "read": {
      if (readControllerEnabled(config.runtimeDirectory)) {
        throw new Error("Run stop before a direct HID read so hooks cannot restart the daemon during the operation");
      }
      if (await daemonRunning()) throw new Error("Stop the daemon before a direct HID read to keep all HID access serialized");
      const state = await withHidOperationLock(
        config.runtimeDirectory,
        "direct-read",
        async () => protocol.readState(),
      );
      print({ ok: true, state: summarizeState(state) });
      break;
    }
    case "snapshot": {
      if (readControllerEnabled(config.runtimeDirectory)) {
        throw new Error("Run stop before capturing a direct snapshot so hooks cannot restart the daemon during the operation");
      }
      if (await daemonRunning()) throw new Error("Stop the daemon before capturing a direct snapshot");
      const kind = takeOption(args, "--kind") || "manual-baseline";
      const snapshot = await withHidOperationLock(
        config.runtimeDirectory,
        "direct-snapshot",
        async () => captureSnapshot(
          config.runtimeDirectory,
          protocol,
          kind,
          ["Created by the manual snapshot command."],
        ),
      );
      print({ ok: true, snapshotId: snapshot.manifest.snapshotId, directory: snapshot.directory });
      break;
    }
    case "snapshots":
      print(listSnapshots(config.runtimeDirectory));
      break;
    case "restore": {
      const selector = takeOption(args, "--snapshot");
      const acceptDevice = takeFlag(args, "--accept-device");
      const watch = takeFlag(args, "--watch");
      writeControllerEnabled(config.runtimeDirectory, false, "restore command requires exclusive HID access");
      const pendingBeforeStop = readPendingRestore(config.runtimeDirectory);
      const stopResult = await stopDaemon(config, "restore command requested exclusive HID access");
      if (!stopResult.stopped) throw new Error("Daemon did not stop; refusing concurrent HID restore");
      clearPersistedMachine(config.runtimeDirectory, "restore-command");
      if (!selector && pendingBeforeStop && !readPendingRestore(config.runtimeDirectory)) {
        print({ ok: true, snapshot: pendingBeforeStop.snapshotId, restoredByDaemonShutdown: true });
        break;
      }
      const restored = await directRestore(config, protocol, selector, { acceptDevice, watch });
      print(restored);
      if (!restored.ok) process.exitCode = 4;
      break;
    }
    case "device-test": {
      if (readControllerEnabled(config.runtimeDirectory)) {
        throw new Error("Run stop before device-test so hooks cannot restart the daemon during the reversible test");
      }
      if (await daemonRunning()) throw new Error("Stop the daemon before the reversible device test");
      const durationMs = Number.parseInt(takeOption(args, "--duration-ms") || "5000", 10);
      if (!Number.isInteger(durationMs) || durationMs < 250 || durationMs > 60000) {
        throw new Error("--duration-ms must be from 250 to 60000");
      }
      const result = await deviceTest(config, protocol, durationMs);
      print(result);
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case "codex-info": {
      const executable = resolveCodexExecutable(config);
      const version = childProcess.spawnSync(executable, ["--version"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (version.error) throw version.error;
      print({
        ok: version.status === 0,
        executable,
        version: String(version.stdout || version.stderr || "").trim(),
        exitCode: version.status,
      });
      if (version.status !== 0) process.exitCode = version.status || 1;
      break;
    }
    case "diagnose": {
      let liveStatus = null;
      if (await daemonRunning()) {
        liveStatus = (await sendIpc({ type: "status" }, 1000)).status;
      } else {
        liveStatus = readJson(daemonStatusPath(config.runtimeDirectory), null);
      }
      const codexHome = path.resolve(config.codex.stateDatabaseWatcher.codexHome);
      const hooksPath = path.join(codexHome, "hooks.json");
      const hooksDocument = readJson(hooksPath, null);
      const expectedEvents = [
        "UserPromptSubmit",
        "Stop",
        "Interrupt",
        "PermissionRequest",
        "PreToolUse",
        "PostToolUse",
        "SessionEnd",
      ];
      const ownedHookEvents = [];
      if (hooksDocument?.hooks && typeof hooksDocument.hooks === "object") {
        for (const eventName of expectedEvents) {
          const groups = Array.isArray(hooksDocument.hooks[eventName]) ? hooksDocument.hooks[eventName] : [];
          if (groups.some((group) => group?.hooks?.some((entry) => String(entry?.command || "").includes("mchose-led\\hook-handler.cjs")))) {
            ownedHookEvents.push(eventName);
          }
        }
      }
      const machine = liveStatus?.machine || null;
      const lastEvent = machine?.lastEvent || null;
      print({
        ok: true,
        controller: {
          running: await daemonRunning(),
          enabled: readControllerEnabled(config.runtimeDirectory),
          desired: liveStatus?.desired || machine?.desired || null,
          lastAppliedSignature: liveStatus?.lastAppliedSignature || null,
          lastAppliedAt: liveStatus?.lastAppliedAt || null,
          deviceConnected: liveStatus?.deviceConnected ?? null,
          lastError: liveStatus?.lastError || null,
        },
        lighting: {
          idle: config.states.idle,
          waiting: config.states.waiting,
          running: config.states.running,
          success: config.states.success,
          error: config.states.error,
        },
        hooks: {
          path: hooksPath,
          fileExists: fs.existsSync(hooksPath),
          hookHandler: path.join(packageDirectory, "hook-handler.cjs"),
          hookHandlerExists: fs.existsSync(path.join(packageDirectory, "hook-handler.cjs")),
          expectedEventCount: expectedEvents.length,
          installedOwnedEventCount: ownedHookEvents.length,
          installedOwnedEvents: ownedHookEvents,
        },
        watcher: liveStatus?.codexStateWatcher || null,
        machine: {
          desired: machine?.desired || null,
          activeTasks: Array.isArray(machine?.tasks) ? machine.tasks.length : null,
          manual: machine?.manual || null,
          transient: machine?.transient || null,
          lastEvent: lastEvent ? {
            kind: lastEvent.kind || null,
            source: lastEvent.source || null,
            sessionId: lastEvent.sessionId || null,
            turnId: lastEvent.turnId || null,
            receivedAt: lastEvent.receivedAt || null,
          } : null,
        },
      });
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    print({ ok: false, error: serializeError(error) });
    if (error instanceof DeviceOfflineError) process.exitCode = 2;
    else if (error instanceof IdentityMismatchError) process.exitCode = 3;
    else process.exitCode = 1;
  });
}

module.exports = { deviceTest, directRestore };
