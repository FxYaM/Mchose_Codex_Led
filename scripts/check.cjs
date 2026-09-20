"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? files(fullPath) : [fullPath];
  });
}
const sources = [
  ...fs.readdirSync(root).filter((name) => name.endsWith(".cjs")).map((name) => path.join(root, name)),
  ...["lib", "tests", "scripts"].flatMap((name) => files(path.join(root, name))).filter((name) => name.endsWith(".cjs")),
];
for (const file of sources) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
for (const file of ["package.json", "config.json", "hooks-snippet.example.json", "vendor/package.json", "vendor/package-lock.json"]) {
  JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}
if (process.platform === "win32") {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "check-powershell.ps1")], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Checked ${sources.length} JavaScript files and project JSON.`);
