"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson, isoFileTimestamp, readJson } = require("./lib/common.cjs");

function nodeRuntime() {
  const bundled = path.join(
    process.env.USERPROFILE,
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "node",
    "bin",
    "node.exe",
  );
  return fs.existsSync(bundled) ? bundled : process.execPath;
}

function commandForHook() {
  return `"${nodeRuntime()}" "${path.join(__dirname, "hook-handler.cjs")}"`;
}

function hook(command) {
  return { type: "command", command, timeout: 3 };
}

function isOwnedGroup(group) {
  return group.hooks?.some((entry) => String(entry.command || "").includes("mchose-led\\hook-handler.cjs"));
}

function replaceOwnedGroup(groups, group) {
  const retained = groups.filter((candidate) => !isOwnedGroup(candidate));
  retained.push(group);
  return retained;
}

function main() {
  const codexDirectory = path.join(process.env.USERPROFILE, ".codex");
  const hooksPath = path.join(codexDirectory, "hooks.json");
  const document = readJson(hooksPath, { hooks: {} });
  if (!document.hooks || typeof document.hooks !== "object") document.hooks = {};
  if (fs.existsSync(hooksPath)) {
    const backup = `${hooksPath}.backup-${isoFileTimestamp()}`;
    fs.copyFileSync(hooksPath, backup);
    process.stdout.write(`Backed up existing hooks to ${backup}\n`);
  }
  const command = commandForHook();
  const definitions = {
    UserPromptSubmit: { hooks: [hook(command)] },
    Stop: { hooks: [hook(command)] },
    Interrupt: { hooks: [hook(command)] },
    PermissionRequest: { hooks: [hook(command)] },
    PreToolUse: { matcher: "^(request_user_input|request_permissions)$", hooks: [hook(command)] },
    PostToolUse: { matcher: ".*", hooks: [hook(command)] },
    SessionEnd: { hooks: [hook(command)] },
  };
  for (const [event, group] of Object.entries(definitions)) {
    if (!Array.isArray(document.hooks[event])) document.hooks[event] = [];
    document.hooks[event] = replaceOwnedGroup(document.hooks[event], group);
  }
  atomicWriteJson(hooksPath, document);
  process.stdout.write(`Merged MCHOSE LED hooks into ${hooksPath}\n`);
  process.stdout.write("To enable waiting/approval hooks, review and trust changed groups with /hooks in the interactive Codex CLI TUI.\n");
}

main();
