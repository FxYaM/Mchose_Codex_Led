"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  acquireHidOperationLock,
  estimatedBootTimeMs,
  operationLockPath,
  processIsAlive,
} = require("../lib/operation-lock.cjs");

function removeTemporary(directory) {
  const resolved = path.resolve(directory);
  const safeRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!resolved.startsWith(safeRoot) || !path.basename(resolved).startsWith("mchose-led-lock-test-")) {
    throw new Error(`Refusing unsafe test cleanup: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

test("the HID operation lock is exclusive and releases cleanly", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-led-lock-test-"));
  try {
    assert.equal(processIsAlive(process.pid), true);
    const first = await acquireHidOperationLock(temporary, "first", 100);
    assert.equal(fs.existsSync(operationLockPath(temporary)), true);
    await assert.rejects(
      acquireHidOperationLock(temporary, "second", 120),
      (error) => error.code === "HID_OPERATION_LOCKED" && error.details.owner.owner === "first",
    );
    first.release();
    assert.equal(fs.existsSync(operationLockPath(temporary)), false);
    const second = await acquireHidOperationLock(temporary, "second", 100);
    second.release();
  } finally {
    removeTemporary(temporary);
  }
});


test("a lock from a previous boot is stale even if Windows reused the PID", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-led-lock-test-"));
  try {
    const filePath = operationLockPath(temporary);
    fs.writeFileSync(filePath, `${JSON.stringify({
      schemaVersion: 1,
      token: "previous-boot-token",
      pid: process.pid,
      owner: "daemon",
      acquiredAt: new Date(estimatedBootTimeMs() - 60_000).toISOString(),
    }, null, 2)}\n`, "utf8");

    const replacement = await acquireHidOperationLock(temporary, "replacement", 200);
    assert.equal(replacement.metadata.owner, "replacement");
    replacement.release();
  } finally {
    removeTemporary(temporary);
  }
});
