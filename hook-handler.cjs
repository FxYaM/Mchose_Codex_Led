"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { appendLog, loadConfig, readControllerEnabled, serializeError } = require("./lib/common.cjs");
const { ensureDaemon, sendIpc } = require("./lib/ipc.cjs");

const packageDirectory = __dirname;

function deterministicEventId(payload, kind) {
  const material = JSON.stringify({
    kind,
    sessionId: payload.session_id,
    turnId: payload.turn_id,
    toolUseId: payload.tool_use_id,
    toolName: payload.tool_name,
    toolInput: payload.tool_input,
    hook: payload.hook_event_name,
  });
  return `hook-${crypto.createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}

function mapHook(payload, config) {
  const base = {
    source: "codex-hook",
    sessionId: payload.session_id || null,
    turnId: payload.turn_id || null,
    hookEventName: payload.hook_event_name,
  };
  let kind;
  switch (payload.hook_event_name) {
    case "UserPromptSubmit":
      kind = "turn_started";
      break;
    case "Stop": {
      const message = String(payload.last_assistant_message || "");
      const heuristicFailure =
        config.codex.desktopStopFailureHeuristics === true &&
        config.codex.failurePatterns.some((pattern) => message.toLowerCase().includes(String(pattern).toLowerCase()));
      kind = heuristicFailure ? "turn_failed" : "turn_completed";
      break;
    }
    case "Interrupt":
      kind = "turn_interrupted";
      break;
    case "PermissionRequest":
      kind = "turn_waiting";
      base.reason = `approval:${payload.tool_name || "unknown"}`;
      break;
    case "PreToolUse":
      if (!new Set(["request_user_input", "request_permissions"]).has(payload.tool_name)) return null;
      kind = "turn_waiting";
      base.reason = payload.tool_name;
      break;
    case "PostToolUse":
      kind = "turn_resumed";
      break;
    case "SessionEnd":
      kind = "session_end";
      break;
    default:
      return null;
  }
  return {
    ...base,
    kind,
    eventId: deterministicEventId(payload, kind),
    at: new Date().toISOString(),
  };
}

async function main() {
  const input = await new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
  const config = loadConfig(packageDirectory);
  const payload = JSON.parse(input || "{}");
  if (process.env.MCHOSE_CODEX_LED_WRAPPED_TASK) return;
  if (!readControllerEnabled(config.runtimeDirectory)) return;
  const event = mapHook(payload, config);
  if (event) {
    await ensureDaemon(packageDirectory, config.configPath, 1800);
    await sendIpc({ type: "event", event }, 700);
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      try {
        const config = loadConfig(packageDirectory);
        appendLog(config.runtimeDirectory, "error", "Codex hook adapter failed", serializeError(error));
      } catch {}
    })
    .finally(() => {
      // Every configured hook type accepts an empty JSON object, and hooks must
      // never delay or block the Codex task because the keyboard is unavailable.
      process.stdout.write("{}\n");
      process.exitCode = 0;
    });
}

module.exports = { mapHook };
