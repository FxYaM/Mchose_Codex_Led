"use strict";

const childProcess = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const { pipeName, sleep } = require("./common.cjs");

function sendIpc(message, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName());
    let response = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error("Timed out waiting for the MCHOSE LED daemon");
      error.code = "IPC_TIMEOUT";
      finish(error);
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(response.slice(0, newline));
        if (!parsed.ok) {
          const error = new Error(parsed.error?.message || "MCHOSE LED daemon rejected the request");
          error.details = parsed.error;
          finish(error);
        } else {
          finish(null, parsed);
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      if (!settled && !response.includes("\n")) finish(new Error("MCHOSE LED daemon closed without a response"));
    });
  });
}

async function daemonRunning() {
  try {
    await sendIpc({ type: "ping" }, 300);
    return true;
  } catch {
    return false;
  }
}

function spawnDaemon(packageDirectory, configPath) {
  const entry = path.join(packageDirectory, "ledctl.cjs");
  const args = [entry, "daemon"];
  if (configPath) args.push("--config", configPath);
  const child = childProcess.spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: packageDirectory,
  });
  child.unref();
  return child.pid;
}

async function ensureDaemon(packageDirectory, configPath, timeoutMs = 2400) {
  try {
    const response = await sendIpc({ type: "ping" }, 300);
    return { alreadyRunning: true, response };
  } catch {
    // No responsive instance owns the per-user named pipe, so start one below.
  }
  const pid = spawnDaemon(packageDirectory, configPath);
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    await sleep(60);
    try {
      const response = await sendIpc({ type: "ping" }, 300);
      return { alreadyRunning: false, pid, response };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`MCHOSE LED daemon did not start: ${lastError?.message || "timeout"}`);
}

module.exports = { daemonRunning, ensureDaemon, sendIpc, spawnDaemon };
