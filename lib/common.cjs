"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function expandEnvironment(value) {
  if (typeof value !== "string") return value;
  return value.replace(/%([^%]+)%/g, (match, name) => process.env[name] || match);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (fallback !== undefined && error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function atomicWriteFile(filePath, data) {
  ensureDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const handle = fs.openSync(temporary, "wx");
  try {
    fs.writeFileSync(handle, data);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, filePath);
}

function atomicWriteJson(filePath, value) {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex").toUpperCase();
}

function isoFileTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeHexColor(value, fieldName = "color") {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${fieldName} must be a color such as #0060FF`);
  }
  return value.toUpperCase();
}

function colorToRgb(value) {
  const color = normalizeHexColor(value);
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function brightnessPercentToLevel(percent) {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new Error("brightnessPercent must be an integer from 1 to 100");
  }
  return Math.min(4, Math.max(1, Math.ceil(percent / 25)));
}

function validatePreset(name, preset) {
  if (!preset || typeof preset !== "object") throw new Error(`states.${name} must be an object`);
  if (preset.mode === "preserve") return;
  if (!new Set(["static", "breathing"]).has(preset.mode)) {
    throw new Error(`states.${name}.mode must be preserve, static, or breathing`);
  }
  normalizeHexColor(preset.color, `states.${name}.color`);
  brightnessPercentToLevel(preset.brightnessPercent);
  if (preset.mode === "breathing") {
    if (!Number.isInteger(preset.breathingSpeed) || preset.breathingSpeed < 1 || preset.breathingSpeed > 4) {
      throw new Error(`states.${name}.breathingSpeed must be an integer from 1 to 4`);
    }
  }
  if (preset.durationMs !== undefined && (!Number.isInteger(preset.durationMs) || preset.durationMs < 0)) {
    throw new Error(`states.${name}.durationMs must be a non-negative integer`);
  }
}

function loadConfig(packageDirectory, explicitPath) {
  const configPath = path.resolve(explicitPath || process.env.MCHOSE_CODEX_LED_CONFIG || path.join(packageDirectory, "config.json"));
  const config = readJson(configPath);
  if (config.schemaVersion !== 1) throw new Error("Unsupported config schemaVersion");
  for (const name of ["idle", "waiting", "running", "success", "error"]) {
    validatePreset(name, config.states[name]);
  }
  for (const name of ["success", "error"]) {
    if (!Number.isInteger(config.states[name].durationMs) || config.states[name].durationMs < 0) {
      throw new Error(`states.${name}.durationMs is required and must be a non-negative integer`);
    }
  }
  const nonNegativeTimings = ["commandDelayMs", "readbackDelayMs", "staleRunningTaskMs", "staleWaitingTaskMs"];
  for (const name of nonNegativeTimings) {
    if (!Number.isInteger(config.controller[name]) || config.controller[name] < 0) {
      throw new Error(`controller.${name} must be a non-negative integer`);
    }
  }
  for (const name of ["pollIntervalMs", "presencePollMs", "shutdownRestoreTimeoutMs"]) {
    if (!Number.isInteger(config.controller[name]) || config.controller[name] <= 0) {
      throw new Error(`controller.${name} must be a positive integer`);
    }
  }
  if (
    !Array.isArray(config.controller.reconnectBackoffMs) ||
    config.controller.reconnectBackoffMs.length === 0 ||
    config.controller.reconnectBackoffMs.some((value) => !Number.isInteger(value) || value <= 0)
  ) {
    throw new Error("controller.reconnectBackoffMs must be a non-empty array of positive integers");
  }
  if (typeof config.controller.cancelAsError !== "boolean") {
    throw new Error("controller.cancelAsError must be a boolean");
  }
  const watcherInput = config.codex?.stateDatabaseWatcher || {};
  if (watcherInput.enabled !== undefined && typeof watcherInput.enabled !== "boolean") {
    throw new Error("codex.stateDatabaseWatcher.enabled must be a boolean");
  }
  if (watcherInput.codexHome !== undefined && typeof watcherInput.codexHome !== "string") {
    throw new Error("codex.stateDatabaseWatcher.codexHome must be a path string");
  }
  if (watcherInput.includeSubagents !== undefined && typeof watcherInput.includeSubagents !== "boolean") {
    throw new Error("codex.stateDatabaseWatcher.includeSubagents must be a boolean");
  }
  const watcher = {
    enabled: watcherInput.enabled !== false,
    codexHome: watcherInput.codexHome || "%USERPROFILE%\\.codex",
    pollIntervalMs: watcherInput.pollIntervalMs ?? 350,
    initialLookbackMs: watcherInput.initialLookbackMs ?? config.controller.staleRunningTaskMs,
    includeSubagents: watcherInput.includeSubagents === true,
  };
  if (!Number.isInteger(watcher.pollIntervalMs) || watcher.pollIntervalMs < 100) {
    throw new Error("codex.stateDatabaseWatcher.pollIntervalMs must be an integer of at least 100");
  }
  if (!Number.isInteger(watcher.initialLookbackMs) || watcher.initialLookbackMs <= 0) {
    throw new Error("codex.stateDatabaseWatcher.initialLookbackMs must be a positive integer");
  }
  const failurePatterns = config.codex?.failurePatterns ?? [];
  if (!Array.isArray(failurePatterns) || failurePatterns.some((value) => typeof value !== "string")) {
    throw new Error("codex.failurePatterns must be an array of strings");
  }
  const codexHome = path.resolve(expandEnvironment(watcher.codexHome));
  const runtimeDirectory = path.resolve(expandEnvironment(config.runtimeDirectory));
  return {
    ...config,
    codex: {
      ...(config.codex || {}),
      stateDatabaseWatcher: { ...watcher, codexHome },
      failurePatterns,
    },
    configPath,
    runtimeDirectory,
  };
}

function pipeName() {
  const suffix = crypto.createHash("sha256").update(os.homedir().toLowerCase()).digest("hex").slice(0, 12);
  return `\\\\.\\pipe\\mchose-codex-led-${suffix}`;
}

function appendLog(runtimeDirectory, level, message, details) {
  ensureDirectory(runtimeDirectory);
  const entry = {
    at: new Date().toISOString(),
    level,
    message,
    ...(details === undefined ? {} : { details }),
  };
  const filePath = path.join(runtimeDirectory, "controller.log.jsonl");
  let line = `${JSON.stringify(entry)}\n`;
  if (Buffer.byteLength(line) > 64 * 1024) {
    line = `${JSON.stringify({ at: entry.at, level, message: String(message).slice(0, 4096), details: "Log details exceeded 64 KiB and were omitted." })}\n`;
  }
  // Rotation is best effort: a hook may be logging at the same time as the daemon.
  // A failed rotation must never prevent a recovery operation from continuing.
  const lockPath = `${filePath}.rotate.lock`;
  let lock;
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size + Buffer.byteLength(line) > 1024 * 1024) {
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 30000) fs.unlinkSync(lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      lock = fs.openSync(lockPath, "wx");
      if (fs.existsSync(filePath) && fs.statSync(filePath).size + Buffer.byteLength(line) > 1024 * 1024) {
        for (let index = 3; index >= 1; index -= 1) {
          const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
          const destination = `${filePath}.${index}`;
          if (fs.existsSync(destination)) fs.unlinkSync(destination);
          if (fs.existsSync(source)) fs.renameSync(source, destination);
        }
      }
    }
  } catch {
    // The next writer can retry; appending still preserves the current message.
  } finally {
    if (lock !== undefined) {
      try { fs.closeSync(lock); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
  fs.appendFileSync(filePath, line);
}

function controllerEnabledPath(runtimeDirectory) {
  return path.join(runtimeDirectory, "state", "controller-enabled.json");
}

function readControllerEnabled(runtimeDirectory) {
  const state = readJson(controllerEnabledPath(runtimeDirectory), null);
  return state ? state.enabled !== false : true;
}

function writeControllerEnabled(runtimeDirectory, enabled, reason) {
  const state = {
    schemaVersion: 1,
    enabled: enabled === true,
    changedAt: new Date().toISOString(),
    reason,
  };
  atomicWriteJson(controllerEnabledPath(runtimeDirectory), state);
  return state;
}

function serializeError(error) {
  if (!error) return null;
  if (error instanceof AggregateError) {
    return {
      name: error.name,
      message: error.message,
      errors: [...error.errors].map(serializeError),
      stack: error.stack,
    };
  }
  return {
    name: error.name || "Error",
    message: error.message || String(error),
    code: error.code,
    details: error.details,
    stack: error.stack,
  };
}

function diffOffsets(left, right, start = 0) {
  const maximum = Math.max(left.length, right.length);
  const differences = [];
  for (let index = start; index < maximum; index += 1) {
    if (left[index] !== right[index]) {
      differences.push({ offset: index, expected: right[index] ?? null, actual: left[index] ?? null });
    }
  }
  return differences;
}

module.exports = {
  appendLog,
  atomicWriteFile,
  atomicWriteJson,
  brightnessPercentToLevel,
  colorToRgb,
  controllerEnabledPath,
  diffOffsets,
  ensureDirectory,
  expandEnvironment,
  isoFileTimestamp,
  loadConfig,
  normalizeHexColor,
  pipeName,
  readJson,
  readControllerEnabled,
  serializeError,
  sha256,
  sleep,
  writeControllerEnabled,
};
