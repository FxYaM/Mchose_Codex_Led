#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig, readControllerEnabled } = require("./lib/common.cjs");
const { ensureDaemon, sendIpc } = require("./lib/ipc.cjs");

const packageDirectory = __dirname;

function newestExecutables(root, childBuilder) {
  if (!root || !fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => childBuilder(path.join(root, entry.name)))
    .filter((candidate) => fs.existsSync(candidate))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
}

function resolveCodexExecutable(config) {
  const configured = config.codex.codexExecutable;
  if (configured && configured !== "auto") {
    const explicit = path.resolve(configured);
    if (!fs.existsSync(explicit)) throw new Error(`Configured Codex executable does not exist: ${explicit}`);
    return explicit;
  }
  const candidates = [
    ...newestExecutables(
      path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin"),
      (directory) => path.join(directory, "codex.exe"),
    ),
    ...newestExecutables(
      path.join(process.env.USERPROFILE || "", ".vscode", "extensions"),
      (directory) => path.join(directory, "bin", "windows-x86_64", "codex.exe"),
    ).filter((candidate) => /openai\.chatgpt-/i.test(candidate)),
    ...(process.env.PATH || "").split(path.delimiter).map((directory) => path.join(directory, "codex.exe")),
  ];
  const executable = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!executable) throw new Error("No Codex CLI executable was found; set codex.codexExecutable in config.json");
  return executable;
}

async function emit(kind, taskKey, extra = {}) {
  await sendIpc({
    type: "event",
    event: {
      kind,
      taskKey,
      source: "codex-exec-json",
      eventId: `exec-${crypto.randomUUID()}`,
      at: new Date().toISOString(),
      ...extra,
    },
  });
}

async function main() {
  const config = loadConfig(packageDirectory);
  const codexExecutable = resolveCodexExecutable(config);
  if (!readControllerEnabled(config.runtimeDirectory)) {
    throw new Error("MCHOSE LED controller is stopped; run mchose-led.ps1 start first");
  }
  await ensureDaemon(packageDirectory, config.configPath);
  const taskKey = `exec:${crypto.randomUUID()}`;
  let args = process.argv.slice(2);
  if (args[0] === "--") args = args.slice(1);
  if (args.length === 0) {
    throw new Error("Usage: mchose-led-exec.ps1 [codex exec options] <prompt>");
  }
  if (args.includes("--json")) args = args.filter((arg) => arg !== "--json");

  await emit("turn_started", taskKey, { phase: "wrapper-spawn", codexExecutable });
  let terminalEmitted = false;
  let child;
  try {
    child = childProcess.spawn(codexExecutable, ["exec", "--json", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, MCHOSE_CODEX_LED_WRAPPED_TASK: taskKey },
      windowsHide: true,
      stdio: ["inherit", "pipe", "pipe"],
    });

  let stdoutBuffer = "";
  let terminal = null;
  let lastErrorEvent = null;

  const parseLine = (line) => {
    if (!line) return;
    try {
      const event = JSON.parse(line);
      if (event.type === "turn.completed") terminal = "turn_completed";
      else if (event.type === "turn.failed") terminal = "turn_failed";
      else if (event.type === "error") lastErrorEvent = event;
    } catch {
      // Preserve output exactly; an unrecognized line is not treated as a status event.
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      parseLine(line);
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  let interrupted = false;
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    try { child.kill("SIGINT"); } catch {}
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  // `exit` can fire before stdout/stderr pipes have drained. `close` is the
  // terminal boundary for a JSONL parser because it follows stdio closure.
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  parseLine(stdoutBuffer.trim());

  let outcome;
  if (interrupted) {
    outcome = "turn_interrupted";
  } else if (terminal === "turn_completed" && exit.code === 0) {
    outcome = "turn_completed";
  } else {
    outcome = "turn_failed";
  }
  await emit(outcome, taskKey, { exit, terminal, lastErrorEvent });
  terminalEmitted = true;
  process.exitCode = exit.code ?? (interrupted ? 130 : 1);
  } catch (error) {
    if (!terminalEmitted) {
      try {
        await emit("turn_failed", taskKey, {
          phase: child ? "wrapper-runtime" : "wrapper-spawn",
          wrapperError: { name: error.name, message: error.message, code: error.code },
        });
      } catch {
        // Preserve the original wrapper error if the status channel also failed.
      }
    }
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { resolveCodexExecutable };
