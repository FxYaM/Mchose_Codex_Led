#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { loadConfig, readControllerEnabled } = require("./lib/common.cjs");
const { ensureDaemon, sendIpc } = require("./lib/ipc.cjs");

const packageDirectory = __dirname;

function newestExecutables(root, childBuilder, fileSystem) {
  if (!root || !fileSystem.existsSync(root)) return [];
  return fileSystem.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => childBuilder(path.join(root, entry.name)))
    .filter((candidate) => fileSystem.existsSync(candidate))
    .sort((left, right) => fileSystem.statSync(right).mtimeMs - fileSystem.statSync(left).mtimeMs);
}

function resolveCodexExecutable(config, { env = process.env, fileSystem = fs } = {}) {
  const configured = config.codex.codexExecutable;
  if (configured && configured !== "auto") {
    const explicit = path.resolve(configured);
    if (!fileSystem.existsSync(explicit)) throw new Error(`Configured Codex executable does not exist: ${explicit}`);
    return explicit;
  }
  const candidates = [
    ...newestExecutables(
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin"),
      (directory) => path.join(directory, "codex.exe"),
      fileSystem,
    ),
    ...newestExecutables(
      env.USERPROFILE && path.join(env.USERPROFILE, ".vscode", "extensions"),
      (directory) => path.join(directory, "bin", "windows-x86_64", "codex.exe"),
      fileSystem,
    ).filter((candidate) => /openai\.chatgpt-/i.test(candidate)),
    ...(env.PATH || "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, "codex.exe")),
  ];
  const executable = candidates.find((candidate) => candidate && fileSystem.existsSync(candidate));
  if (!executable) throw new Error("No Codex CLI executable was found; set codex.codexExecutable in config.json");
  return executable;
}

async function emit(kind, taskKey, extra, sendStatus) {
  await sendStatus({
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

async function runCodex(args, {
  config,
  codexExecutable = resolveCodexExecutable(config),
  spawn = childProcess.spawn,
  startDaemon = ensureDaemon,
  controllerEnabled = readControllerEnabled,
  sendStatus = sendIpc,
  stdout = process.stdout,
  stderr = process.stderr,
  signalSource = process,
  cwd = process.cwd(),
  env = process.env,
}) {
  if (args[0] === "--") args = args.slice(1);
  if (args.length === 0) {
    throw new Error("Usage: mchose-led-exec.ps1 [codex exec options] <prompt>");
  }
  if (args.includes("--json")) args = args.filter((arg) => arg !== "--json");

  const warn = (message) => stderr.write(`[MCHOSE LED] ${message}\n`);
  let statusEnabled = false;
  try {
    if (controllerEnabled(config.runtimeDirectory)) {
      await startDaemon(packageDirectory, config.configPath);
      statusEnabled = true;
    } else {
      warn("Controller is stopped; running Codex without lighting.");
    }
  } catch (error) {
    warn(`Lighting is unavailable; running Codex without lighting: ${error.message || error}`);
  }

  // Status reporting must never prevent a CLI task or replace its exit code.
  const taskKey = `exec:${crypto.randomUUID()}`;
  const notify = async (kind, extra) => {
    if (!statusEnabled) return;
    try {
      await emit(kind, taskKey, extra, sendStatus);
    } catch (error) {
      warn(`Could not report ${kind}: ${error.message || error}`);
    }
  };
  await notify("turn_started", { phase: "wrapper-spawn", codexExecutable });

  let child;
  let interrupted = false;
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    try { child.kill("SIGINT"); } catch {}
  };
  try {
    child = spawn(codexExecutable, ["exec", "--json", ...args], {
      cwd,
      env: { ...env, MCHOSE_CODEX_LED_WRAPPED_TASK: taskKey },
      windowsHide: true,
      stdio: ["inherit", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let terminal = null;
    let lastErrorEvent = null;
    const decoder = new StringDecoder("utf8");

    const parseLine = (line) => {
      if (!line) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "turn.completed") terminal = "turn_completed";
        else if (event.type === "turn.failed") terminal = "turn_failed";
        else if (event.type === "error") lastErrorEvent = event;
      } catch {
        // Unrecognized output is preserved, but is not a status event.
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout.write(chunk);
      stdoutBuffer += decoder.write(chunk);
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline === -1) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        parseLine(line);
      }
    });
    child.stderr.on("data", (chunk) => stderr.write(chunk));

    signalSource.once("SIGINT", interrupt);
    signalSource.once("SIGTERM", interrupt);

    // `close` follows stdio closure, so the last JSONL event is not lost.
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    parseLine((stdoutBuffer + decoder.end()).trim());

    let outcome;
    if (interrupted) {
      outcome = "turn_interrupted";
    } else if (terminal === "turn_completed" && exit.code === 0) {
      outcome = "turn_completed";
    } else {
      outcome = "turn_failed";
    }
    await notify(outcome, { exit, terminal, lastErrorEvent });
    return exit.code ?? (interrupted ? 130 : 1);
  } catch (error) {
    await notify("turn_failed", {
      phase: child ? "wrapper-runtime" : "wrapper-spawn",
      wrapperError: { name: error.name, message: error.message, code: error.code },
    });
    throw error;
  } finally {
    signalSource.removeListener("SIGINT", interrupt);
    signalSource.removeListener("SIGTERM", interrupt);
  }
}

if (require.main === module) {
  Promise.resolve().then(() => runCodex(process.argv.slice(2), { config: loadConfig(packageDirectory) })).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { resolveCodexExecutable, runCodex };
