"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { appendLog } = require("../lib/common.cjs");

test("logs rotate into three bounded archives and retain recent events", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-log-test-"));
  try {
    for (let index = 0; index < 400; index += 1) appendLog(directory, "info", `event-${index}`, "x".repeat(16000));
    const files = fs.readdirSync(directory).sort();
    assert.deepEqual(files, ["controller.log.jsonl", "controller.log.jsonl.1", "controller.log.jsonl.2", "controller.log.jsonl.3"]);
    for (const file of files) {
      assert.ok(fs.statSync(path.join(directory, file)).size <= 1024 * 1024);
      for (const line of fs.readFileSync(path.join(directory, file), "utf8").trim().split("\n")) JSON.parse(line);
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, files[0]), "utf8").trim().split("\n").at(-1)).message, "event-399");
    appendLog(directory, "error", "oversize", "x".repeat(100000));
    assert.match(fs.readFileSync(path.join(directory, files[0]), "utf8"), /details exceeded 64 KiB/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
