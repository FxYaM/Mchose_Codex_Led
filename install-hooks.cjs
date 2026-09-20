"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson, isoFileTimestamp, readJson } = require("./lib/common.cjs");

function commandForHook() {
  // The installer has already selected and validated this Node runtime.
  return `"${process.execPath}" "${path.join(__dirname, "hook-handler.cjs")}"`;
}

function hook(command) {
  return { type: "command", command, timeout: 3 };
}

function isOwnedHook(entry, packageDirectory = __dirname) {
  const normalize = (value) => String(value).replaceAll("/", "\\").toLowerCase();
  const target = normalize(path.win32.join(packageDirectory, "hook-handler.cjs"));
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s"'])${escaped}(?=$|[\\s"'])`).test(normalize(entry?.command || ""));
}

function removeOwnedHooks(document, options = {}) {
  const packageDirectory = options.packageDirectory || __dirname;
  const hooks = { ...(document.hooks || {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    hooks[event] = groups.flatMap((group) => {
      if (!Array.isArray(group?.hooks)) return [group];
      const retained = group.hooks.filter((entry) => !isOwnedHook(entry, packageDirectory));
      if (retained.length === group.hooks.length) return [group];
      return retained.length > 0 ? [{ ...group, hooks: retained }] : [];
    });
  }
  return { ...document, hooks };
}

function mergeOwnedHooks(document, command, options = {}) {
  const merged = removeOwnedHooks(document, options);
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
    if (!Array.isArray(merged.hooks[event])) merged.hooks[event] = [];
    merged.hooks[event] = [...merged.hooks[event], group];
  }
  return merged;
}

function main() {
  const codexDirectory = path.join(process.env.USERPROFILE, ".codex");
  const hooksPath = path.join(codexDirectory, "hooks.json");
  const document = readJson(hooksPath, { hooks: {} });
  const removing = process.argv.includes("--remove");
  const updated = removing ? removeOwnedHooks(document) : mergeOwnedHooks(document, commandForHook());
  if (fs.existsSync(hooksPath)) {
    const backup = `${hooksPath}.backup-${isoFileTimestamp()}-${Date.now()}`;
    fs.copyFileSync(hooksPath, backup, fs.constants.COPYFILE_EXCL);
    process.stdout.write(`Backed up existing hooks to ${backup}\n`);
  } else if (removing) {
    process.stdout.write(`No hooks file exists at ${hooksPath}\n`);
    return;
  }
  atomicWriteJson(hooksPath, updated);
  process.stdout.write(`${removing ? "Removed" : "Merged"} MCHOSE LED hooks ${removing ? "from" : "into"} ${hooksPath}\n`);
  if (!removing) process.stdout.write("To enable waiting/approval hooks, review and trust changed groups with /hooks in the interactive Codex CLI TUI.\n");
}

if (require.main === module) main();

module.exports = { isOwnedHook, mergeOwnedHooks, removeOwnedHooks };
