"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureDirectory, sleep } = require("./common.cjs");

function operationLockPath(runtimeDirectory) {
  return path.join(ensureDirectory(path.join(runtimeDirectory, "state")), "hid-operation.lock.json");
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function readLock(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function estimatedBootTimeMs() {
  return Date.now() - (os.uptime() * 1000);
}

function removeStaleLock(filePath) {
  let metadata = null;
  let stats = null;
  let ageMs = 0;
  try {
    metadata = readLock(filePath);
    stats = fs.statSync(filePath);
    ageMs = Date.now() - stats.mtimeMs;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }

  // Windows can reuse a PID after reboot. A lock created before the current
  // system boot is therefore stale even when process.kill(pid, 0) says that
  // the recycled PID exists now. Use acquiredAt when available and fall back
  // to the file timestamp for older/incomplete metadata.
  const acquiredAtMs = Date.parse(metadata?.acquiredAt || "");
  const lockTimestampMs = Number.isFinite(acquiredAtMs) ? acquiredAtMs : stats.mtimeMs;
  const stalePreviousBoot = lockTimestampMs < (estimatedBootTimeMs() - 10_000);
  const staleKnownProcess = Number.isInteger(metadata?.pid) && !processIsAlive(metadata.pid);
  // A process can briefly expose an empty file between O_EXCL creation and its
  // metadata write. Only reap an unreadable lock after that window is long gone.
  const staleIncompleteLock = !metadata && ageMs >= 10_000;
  if (!stalePreviousBoot && !staleKnownProcess && !staleIncompleteLock) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function acquireHidOperationLock(runtimeDirectory, owner, timeoutMs = 3000) {
  const filePath = operationLockPath(runtimeDirectory);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let handle;
    try {
      handle = fs.openSync(filePath, "wx");
      const metadata = {
        schemaVersion: 1,
        token: crypto.randomUUID(),
        pid: process.pid,
        owner,
        acquiredAt: new Date().toISOString(),
      };
      try {
        fs.writeFileSync(handle, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
        fs.fsyncSync(handle);
      } catch (error) {
        try { fs.closeSync(handle); } catch {}
        try { fs.unlinkSync(filePath); } catch {}
        throw error;
      }
      let released = false;
      return {
        filePath,
        metadata,
        release() {
          if (released) return;
          released = true;
          try { fs.closeSync(handle); } finally {
            const current = readLock(filePath);
            if (current?.token === metadata.token) {
              try { fs.unlinkSync(filePath); } catch (error) {
                if (error?.code !== "ENOENT") throw error;
              }
            }
          }
        },
      };
    } catch (error) {
      if (handle !== undefined) {
        try { fs.closeSync(handle); } catch {}
      }
      if (error?.code !== "EEXIST") throw error;
      if (removeStaleLock(filePath)) continue;
      if (Date.now() >= deadline) {
        const busy = new Error("Another MCHOSE LED process owns exclusive HID access");
        busy.code = "HID_OPERATION_LOCKED";
        busy.details = { filePath, owner: readLock(filePath) };
        throw busy;
      }
      await sleep(75);
    }
  }
}

async function withHidOperationLock(runtimeDirectory, owner, callback, timeoutMs = 3000) {
  const lock = await acquireHidOperationLock(runtimeDirectory, owner, timeoutMs);
  try {
    return await callback(lock);
  } finally {
    lock.release();
  }
}

module.exports = {
  acquireHidOperationLock,
  estimatedBootTimeMs,
  operationLockPath,
  processIsAlive,
  withHidOperationLock,
};
