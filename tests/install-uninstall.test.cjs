"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const windowsOnly = { skip: process.platform !== "win32" ? "Windows PowerShell integration test" : false };
const packageDirectory = path.resolve(__dirname, "..");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-install-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const profile = path.join(root, "profile");
  const installed = path.join(profile, ".codex", "mchose-led");
  const runtime = path.join(root, "recovery");
  const hooksPath = path.join(profile, ".codex", "hooks.json");
  const logPath = path.join(root, "events.log");
  const registryPath = path.join(root, "registry.json");
  const registry = { UnrelatedApplication: "fixture-unrelated-startup" };
  const hooks = { hooks: { Stop: [{ hooks: [{ type: "command", command: "fixture-other-hook.exe", timeout: 3 }] }] } };
  fs.mkdirSync(source, { recursive: true });
  for (const file of ["install.ps1", "uninstall.ps1", "node-runtime.ps1", "mchose-led.ps1", "mchose-led-exec.ps1", "install-hooks.cjs", "hook-handler.cjs", "codex-exec-led.cjs", "package.json"]) {
    fs.copyFileSync(path.join(packageDirectory, file), path.join(source, file));
  }
  fs.cpSync(path.join(packageDirectory, "lib"), path.join(source, "lib"), { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(packageDirectory, "config.json"), "utf8"));
  config.runtimeDirectory = runtime;
  write(path.join(source, "config.json"), JSON.stringify(config));
  write(path.join(source, "vendor", "package.json"), '{"private":true}');
  write(path.join(source, "vendor", "package-lock.json"), '{"lockfileVersion":3}');
  write(path.join(source, "vendor", "node_modules", "node-hid", "index.js"), "module.exports = {};\n");
  write(path.join(source, "tests", "private-fixture.txt"), "must not be installed");
  write(path.join(source, ".git", "private-fixture.txt"), "must not be installed");
  write(path.join(source, "private-report.txt"), "must not be installed");
  write(path.join(source, "lib", "fixture-marker.txt"), "version one");
  write(path.join(runtime, "snapshots", "recovery-sentinel.bin"), "must survive uninstall");
  write(hooksPath, JSON.stringify(hooks));
  write(registryPath, JSON.stringify(registry));
  write(logPath, "");
  // This substitute never imports IPC, starts a daemon, or opens a HID device.
  write(path.join(source, "ledctl.cjs"), `
    const fs = require('node:fs');
    const path = require('node:path');
    const command = process.argv[2];
    fs.appendFileSync(process.env.FIXTURE_LOG, 'controller:' + command + '\\n');
    if (command === 'status') process.stdout.write(JSON.stringify({running:false}));
    else if (command === 'stop') {
      if (process.env.FIXTURE_FAIL_STOP === '1') process.exitCode = 7;
      else fs.writeFileSync(path.join(process.env.FIXTURE_RUNTIME, 'restored.txt'), 'restored');
    } else if (command !== 'start') throw new Error('unexpected fake controller command');
  `);
  const harness = path.join(root, "harness.ps1");
  write(harness, `
$ErrorActionPreference = 'Stop'
$global:FixtureRegistry = @{}
(Get-Content -LiteralPath $env:FIXTURE_REGISTRY -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object {
    $global:FixtureRegistry[$_.Name] = $_.Value
}
function Save-FixtureRegistry {
    [System.IO.File]::WriteAllText($env:FIXTURE_REGISTRY, ($global:FixtureRegistry | ConvertTo-Json -Depth 10))
}
function Assert-FixtureRegistryKey($key) {
    if ($key -ne 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run') { throw 'Unexpected registry access in test.' }
}
function New-Item {
    [CmdletBinding()] param([string]$Path, [string]$ItemType, [switch]$Force)
    if ($Path -like 'HKCU:*') {
        Assert-FixtureRegistryKey $Path
        return
    }
    Microsoft.PowerShell.Management\\New-Item @PSBoundParameters
}
function New-ItemProperty {
    [CmdletBinding()] param([string]$Path, [string]$Name, [string]$Value, [string]$PropertyType, [switch]$Force)
    Assert-FixtureRegistryKey $Path
    if ($Name -ne 'MCHOSECodexLED') { throw 'Attempted to replace another startup entry.' }
    $global:FixtureRegistry[$Name] = $Value
    Save-FixtureRegistry
    [System.IO.File]::AppendAllText($env:FIXTURE_LOG, "registry:add\n")
}
function Get-ItemProperty {
    [CmdletBinding()] param([string]$LiteralPath, [string]$Name)
    Assert-FixtureRegistryKey $LiteralPath
    if ($global:FixtureRegistry.ContainsKey($Name)) {
        $result = @{}
        $result[$Name] = $global:FixtureRegistry[$Name]
        return [pscustomobject]$result
    }
}
function Remove-ItemProperty {
    [CmdletBinding()] param([string]$LiteralPath, [string]$Name)
    Assert-FixtureRegistryKey $LiteralPath
    if ($Name -ne 'MCHOSECodexLED') { throw 'Attempted to remove another startup entry.' }
    $global:FixtureRegistry.Remove($Name)
    Save-FixtureRegistry
    [System.IO.File]::AppendAllText($env:FIXTURE_LOG, "registry:remove\n")
}
try {
    & $env:FIXTURE_SCRIPT
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`);
  const env = {
    ...process.env,
    USERPROFILE: profile,
    LOCALAPPDATA: path.join(root, "local"),
    ProgramFiles: path.join(root, "programs"),
    PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || ""),
    FIXTURE_LOG: logPath,
    FIXTURE_RUNTIME: runtime,
    FIXTURE_REGISTRY: registryPath,
  };
  delete env.MCHOSE_CODEX_LED_CONFIG;
  delete env.FIXTURE_FAIL_STOP;
  const run = (script, extraEnv = {}) => childProcess.spawnSync(
    path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness],
    { env: { ...env, ...extraEnv, FIXTURE_SCRIPT: script }, cwd: root, encoding: "utf8", timeout: 30000 },
  );
  const install = (extraEnv) => run(path.join(source, "install.ps1"), extraEnv);
  const uninstall = (extraEnv) => run(path.join(source, "uninstall.ps1"), extraEnv);
  return { root, source, profile, installed, runtime, config, hooksPath, hooks, registryPath, registry, logPath, run, install, uninstall };
}

function passed(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test("installer preflights dependency before stopping an existing installation", windowsOnly, (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.installed, { recursive: true });
  fs.copyFileSync(path.join(f.source, "ledctl.cjs"), path.join(f.installed, "ledctl.cjs"));
  write(path.join(f.installed, "unchanged.txt"), "existing installation");
  fs.rmSync(path.join(f.source, "vendor", "node_modules"), { recursive: true });
  const result = f.install();
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(f.logPath, "utf8"), "");
  assert.equal(fs.readFileSync(path.join(f.installed, "unchanged.txt"), "utf8"), "existing installation");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.registryPath)), f.registry);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.hooksPath)), f.hooks);
});

test("repeated installation preserves config and copies only runtime files without nested directories", windowsOnly, (t) => {
  const f = fixture(t);
  passed(f.install());
  const editedConfig = { ...f.config, fixtureUserChoice: "preserve me" };
  editedConfig.states.idle.color = "#112233";
  const configText = JSON.stringify(editedConfig, null, 3);
  write(path.join(f.installed, "config.json"), configText);
  write(path.join(f.source, "lib", "fixture-marker.txt"), "version two");
  passed(f.install());
  assert.equal(fs.readFileSync(path.join(f.installed, "config.json"), "utf8"), configText);
  assert.equal(fs.readFileSync(path.join(f.installed, "lib", "fixture-marker.txt"), "utf8"), "version two");
  assert.equal(fs.existsSync(path.join(f.installed, "lib", "lib")), false);
  assert.equal(fs.existsSync(path.join(f.installed, "vendor", "node_modules", "node_modules")), false);
  for (const file of ["tests", ".git", "private-report.txt", "install.ps1"]) {
    assert.equal(fs.existsSync(path.join(f.installed, file)), false, `${file} must not be installed`);
  }
  assert.equal(fs.readFileSync(path.join(f.installed, "vendor", "node_modules", "node-hid", "index.js"), "utf8"), "module.exports = {};\n");
  const registry = JSON.parse(fs.readFileSync(f.registryPath));
  assert.equal(registry.UnrelatedApplication, f.registry.UnrelatedApplication);
  assert.match(registry.MCHOSECodexLED, /mchose-led\.ps1/);
});

test("uninstall restores first and retains configuration, recovery data, unrelated hooks and startup entries", windowsOnly, (t) => {
  const f = fixture(t);
  passed(f.install());
  write(f.logPath, "");
  fs.unlinkSync(path.join(f.runtime, "restored.txt"));
  passed(f.uninstall());
  assert.equal(fs.existsSync(f.installed), false);
  assert.equal(fs.readFileSync(path.join(f.runtime, "restored.txt"), "utf8"), "restored");
  assert.equal(fs.readFileSync(path.join(f.runtime, "snapshots", "recovery-sentinel.bin"), "utf8"), "must survive uninstall");
  const backups = fs.readdirSync(f.runtime).filter((name) => /^uninstalled-config-.*\.json$/.test(name));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.runtime, backups[0]))), f.config);
  const remainingHooks = JSON.parse(fs.readFileSync(f.hooksPath));
  assert.deepEqual(remainingHooks.hooks.Stop, f.hooks.hooks.Stop);
  assert.equal(JSON.stringify(remainingHooks).includes("hook-handler.cjs"), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.registryPath)), f.registry);
  assert.deepEqual(fs.readFileSync(f.logPath, "utf8").trim().split(/\r?\n/), ["controller:stop", "registry:remove"]);
});

test("failed restoration blocks both upgrade and uninstall without deleting files or registrations", windowsOnly, (t) => {
  const f = fixture(t);
  passed(f.install());
  const controller = fs.readFileSync(path.join(f.installed, "ledctl.cjs"), "utf8");
  const hooks = fs.readFileSync(f.hooksPath, "utf8");
  const registry = fs.readFileSync(f.registryPath, "utf8");
  write(path.join(f.source, "ledctl.cjs"), "throw new Error('must never replace the installed controller');");
  assert.notEqual(f.install({ FIXTURE_FAIL_STOP: "1" }).status, 0);
  assert.notEqual(f.uninstall({ FIXTURE_FAIL_STOP: "1" }).status, 0);
  assert.equal(fs.readFileSync(path.join(f.installed, "ledctl.cjs"), "utf8"), controller);
  assert.equal(fs.readFileSync(f.hooksPath, "utf8"), hooks);
  assert.equal(fs.readFileSync(f.registryPath, "utf8"), registry);
  assert.equal(fs.readdirSync(f.runtime).some((name) => name.startsWith("uninstalled-config-")), false);
});

test("runtime selection tolerates an unusable bundled executable and falls back to PATH", windowsOnly, (t) => {
  const f = fixture(t);
  write(path.join(f.profile, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "bin", "node.exe"), "not an executable");
  const probe = path.join(f.source, "probe-runtime.ps1");
  write(probe, ". (Join-Path $PSScriptRoot 'node-runtime.ps1')\nGet-MchoseNodeRuntime\n");
  const result = f.run(probe);
  passed(result);
  assert.equal(result.stdout.trim(), process.execPath);
});

test("uninstall refuses linked installation contents without touching the linked target", windowsOnly, (t) => {
  const f = fixture(t);
  passed(f.install());
  const outside = path.join(f.root, "unrelated-files");
  write(path.join(outside, "keep.txt"), "unrelated data");
  fs.symlinkSync(outside, path.join(f.installed, "linked-directory"), "junction");
  const hooks = fs.readFileSync(f.hooksPath, "utf8");
  const registry = fs.readFileSync(f.registryPath, "utf8");
  const result = f.uninstall();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /linked installation contents/);
  assert.equal(fs.existsSync(f.installed), true);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "unrelated data");
  assert.equal(fs.readFileSync(f.hooksPath, "utf8"), hooks);
  assert.equal(fs.readFileSync(f.registryPath, "utf8"), registry);
});

test("uninstall refuses recovery data inside the install tree even when hidden by a junction", windowsOnly, (t) => {
  const f = fixture(t);
  passed(f.install());
  const inside = path.join(f.installed, "recovery-data");
  write(path.join(inside, "snapshot.bin"), "keep recovery data");
  const linkedRuntime = path.join(f.root, "linked-runtime");
  fs.symlinkSync(inside, linkedRuntime, "junction");
  write(path.join(f.installed, "config.json"), JSON.stringify({ ...f.config, runtimeDirectory: linkedRuntime }));
  const result = f.uninstall();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Recovery directory uses a linked path/);
  assert.equal(fs.readFileSync(path.join(inside, "snapshot.bin"), "utf8"), "keep recovery data");
  assert.equal(fs.existsSync(path.join(f.installed, "ledctl.cjs")), true);
});
