"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  atomicWriteFile,
  atomicWriteJson,
  ensureDirectory,
  isoFileTimestamp,
  readJson,
  sha256,
} = require("./common.cjs");
const {
  COMMANDS,
  validateColorResponse,
  validatePerformanceResponse,
} = require("./protocol.cjs");

const PENDING_FILE = "pending-restore.json";

function snapshotRoot(runtimeDirectory) {
  return ensureDirectory(path.join(runtimeDirectory, "snapshots"));
}

function stateDirectory(runtimeDirectory) {
  return ensureDirectory(path.join(runtimeDirectory, "state"));
}

function createSnapshotFromState(runtimeDirectory, state, kind, notes = []) {
  validatePerformanceResponse(state.performance);
  validateColorResponse(state.lightColor);
  const snapshotId = `${kind}-${isoFileTimestamp()}-${crypto.randomBytes(4).toString("hex")}`;
  const root = snapshotRoot(runtimeDirectory);
  const finalDirectory = path.join(root, snapshotId);
  const temporaryDirectory = path.join(root, `.tmp-${snapshotId}-${process.pid}`);
  fs.mkdirSync(temporaryDirectory, { recursive: false });
  try {
    const performanceName = "performance.bin";
    const colorName = "light-color.bin";
    atomicWriteFile(path.join(temporaryDirectory, performanceName), state.performance);
    atomicWriteFile(path.join(temporaryDirectory, colorName), state.lightColor);
    const manifest = {
      schemaVersion: 1,
      snapshotId,
      kind,
      capturedAt: new Date().toISOString(),
      device: state.identity,
      protocol: {
        reportId: state.performance[0],
        reportLength: 520,
        performanceResponseLength: state.performance.length,
        colorResponseLength: state.lightColor.length,
        readPerformanceCommand: COMMANDS.readPerformance,
        readColorCommand: COMMANDS.readColor,
        writePerformanceCommand: COMMANDS.writePerformance,
        writeColorCommand: COMMANDS.writeColor,
        performanceMarkerOffsets: [134, 135],
        colorMarkerOffsets: [514, 515],
      },
      files: {
        performance: {
          name: performanceName,
          length: state.performance.length,
          sha256: sha256(state.performance),
        },
        lightColor: {
          name: colorName,
          length: state.lightColor.length,
          sha256: sha256(state.lightColor),
        },
      },
      notes,
    };
    atomicWriteJson(path.join(temporaryDirectory, "manifest.json"), manifest);
    fs.renameSync(temporaryDirectory, finalDirectory);
    return { directory: finalDirectory, manifest, state };
  } catch (error) {
    for (const fileName of ["performance.bin", "light-color.bin", "manifest.json"]) {
      try { fs.unlinkSync(path.join(temporaryDirectory, fileName)); } catch {}
    }
    try { fs.rmdirSync(temporaryDirectory); } catch {}
    throw error;
  }
}

function captureSnapshot(runtimeDirectory, protocol, kind, notes = []) {
  const state = protocol.readState();
  return createSnapshotFromState(runtimeDirectory, state, kind, notes);
}

function pendingPath(runtimeDirectory) {
  return path.join(stateDirectory(runtimeDirectory), PENDING_FILE);
}

function markPendingRestore(runtimeDirectory, snapshot) {
  const pointer = {
    schemaVersion: 1,
    snapshotId: snapshot.manifest.snapshotId,
    snapshotDirectory: snapshot.directory,
    device: snapshot.manifest.device,
    createdAt: new Date().toISOString(),
    reason: "Controller took ownership before changing keyboard lighting",
  };
  atomicWriteJson(pendingPath(runtimeDirectory), pointer);
  return pointer;
}

function readPendingRestore(runtimeDirectory) {
  return readJson(pendingPath(runtimeDirectory), null);
}

function clearPendingRestore(runtimeDirectory, expectedSnapshotId) {
  const filePath = pendingPath(runtimeDirectory);
  const current = readJson(filePath, null);
  if (!current) return false;
  if (expectedSnapshotId && current.snapshotId !== expectedSnapshotId) {
    throw new Error(`Pending restore changed from ${expectedSnapshotId} to ${current.snapshotId}`);
  }
  fs.unlinkSync(filePath);
  return true;
}

function resolveSnapshotDirectory(runtimeDirectory, selector) {
  if (!selector) {
    const pending = readPendingRestore(runtimeDirectory);
    if (!pending) throw new Error("There is no pending restore snapshot");
    return path.resolve(pending.snapshotDirectory);
  }
  const direct = path.resolve(selector);
  if (fs.existsSync(direct)) return fs.statSync(direct).isDirectory() ? direct : path.dirname(direct);
  const byId = path.join(snapshotRoot(runtimeDirectory), selector);
  if (fs.existsSync(byId) && fs.statSync(byId).isDirectory()) return byId;
  throw new Error(`Snapshot not found: ${selector}`);
}

function loadSnapshot(snapshotDirectory) {
  const directory = path.resolve(snapshotDirectory);
  const manifest = readJson(path.join(directory, "manifest.json"));
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported snapshot schemaVersion");
  const performance = fs.readFileSync(path.join(directory, manifest.files.performance.name));
  const lightColor = fs.readFileSync(path.join(directory, manifest.files.lightColor.name));
  const checks = [
    ["performance", performance, manifest.files.performance],
    ["lightColor", lightColor, manifest.files.lightColor],
  ];
  for (const [label, buffer, file] of checks) {
    if (buffer.length !== file.length) throw new Error(`${label} snapshot length mismatch`);
    if (sha256(buffer) !== String(file.sha256).toUpperCase()) throw new Error(`${label} snapshot SHA-256 mismatch`);
  }
  validatePerformanceResponse(performance, manifest.protocol.reportId);
  validateColorResponse(lightColor, manifest.protocol.reportId);
  if (manifest.protocol.writeColorCommand !== COMMANDS.writeColor) {
    throw new Error(`Snapshot expects unsupported light-color write command ${manifest.protocol.writeColorCommand}`);
  }
  return {
    directory,
    manifest,
    state: { identity: manifest.device, performance, lightColor },
  };
}

function listSnapshots(runtimeDirectory) {
  const root = snapshotRoot(runtimeDirectory);
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".tmp-"))
    .map((entry) => {
      try {
        const loaded = loadSnapshot(path.join(root, entry.name));
        return {
          snapshotId: loaded.manifest.snapshotId,
          kind: loaded.manifest.kind,
          capturedAt: loaded.manifest.capturedAt,
          directory: loaded.directory,
          device: loaded.manifest.device,
        };
      } catch (error) {
        return { snapshotId: entry.name, directory: path.join(root, entry.name), invalid: error.message };
      }
    })
    .sort((left, right) => String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")));
}

module.exports = {
  captureSnapshot,
  clearPendingRestore,
  createSnapshotFromState,
  listSnapshots,
  loadSnapshot,
  markPendingRestore,
  pendingPath,
  readPendingRestore,
  resolveSnapshotDirectory,
  snapshotRoot,
  stateDirectory,
};
