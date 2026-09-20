$ErrorActionPreference = 'Stop'

$installDirectory = Join-Path $env:USERPROFILE '.codex\mchose-led'
$runtimeDirectory = Join-Path $env:LOCALAPPDATA 'MCHOSECodexLED'
. (Join-Path $PSScriptRoot 'node-runtime.ps1')
$nodeRuntime = Get-MchoseNodeRuntime
$sourceDirectory = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$targetDirectory = [System.IO.Path]::GetFullPath($installDirectory).TrimEnd('\')
if ($sourceDirectory.Equals($targetDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Run install.ps1 from a separate source checkout, not from the installed directory.'
}
# Validate the native dependency before stopping or replacing a working installation.
& $nodeRuntime -e 'require(process.argv[1]);' (Join-Path $PSScriptRoot 'vendor\node_modules\node-hid')
if ($LASTEXITCODE -ne 0) { throw 'The HID dependency is unavailable. Run npm.cmd --prefix vendor ci first.' }

$installedController = Join-Path $installDirectory 'ledctl.cjs'
$installedConfig = Join-Path $installDirectory 'config.json'
if (Test-Path -LiteralPath $installedController) {
    # Stop through the currently installed code before replacing any file. This
    # gives that process a chance to restore its exact takeover snapshot and
    # guarantees the subsequent start loads the new implementation.
    $oldDaemonPid = $null
    try {
        $statusDocument = ((& $nodeRuntime $installedController status) | Out-String) | ConvertFrom-Json
        if ($statusDocument.running -ne $false -and $statusDocument.pid) {
            $oldDaemonPid = [int]$statusDocument.pid
        }
    }
    catch {
        # The stop command below remains authoritative; status is used only to
        # wait for the old process to release loaded runtime files.
    }
    & $nodeRuntime $installedController stop
    if ($LASTEXITCODE -ne 0) {
        throw "Existing controller could not stop and restore safely (exit $LASTEXITCODE). Run restore --watch before reinstalling."
    }
    if ($oldDaemonPid) {
        for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
            if (-not (Get-Process -Id $oldDaemonPid -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 100
        }
        if (Get-Process -Id $oldDaemonPid -ErrorAction SilentlyContinue) {
            throw "Existing daemon PID $oldDaemonPid did not exit; refusing to overwrite loaded files."
        }
    }
}

New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
$runtimeFiles = @(
    'config.json', 'package.json', 'ledctl.cjs', 'hook-handler.cjs', 'codex-exec-led.cjs',
    'install-hooks.cjs', 'mchose-led.ps1', 'mchose-led-exec.ps1', 'node-runtime.ps1', 'uninstall.ps1', 'lib'
)
$runtimeFiles | ForEach-Object {
    # A reinstall is an application update, not a configuration reset.
    if ($_ -eq 'config.json' -and (Test-Path -LiteralPath $installedConfig)) {
        Write-Host "Preserved existing configuration at $installedConfig"
    }
    else {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $_) -Destination $installDirectory -Recurse -Force
    }
}
$installedVendor = Join-Path $installDirectory 'vendor'
New-Item -ItemType Directory -Force -Path $installedVendor | Out-Null
foreach ($vendorFile in @('package.json', 'package-lock.json', 'node_modules')) {
    Copy-Item -LiteralPath (Join-Path (Join-Path $PSScriptRoot 'vendor') $vendorFile) -Destination $installedVendor -Recurse -Force
}

# v1.2 migration: older builds used mode=preserve for idle/waiting. That
# restores whatever lighting happened to exist before takeover (including
# lights-off), which is not the desired normal state. Migrate only legacy
# preserve values; never overwrite a user's existing static/breathing color.
$installedConfigDocument = Get-Content -LiteralPath $installedConfig -Raw | ConvertFrom-Json
$configChanged = $false
if ($installedConfigDocument.states.idle.mode -eq 'preserve') {
    $installedConfigDocument.states.idle = [pscustomobject]@{
        mode = 'static'
        color = '#FF69B4'
        brightnessPercent = 75
    }
    $configChanged = $true
}
if ($installedConfigDocument.states.waiting.mode -eq 'preserve') {
    $idle = $installedConfigDocument.states.idle
    $installedConfigDocument.states.waiting = [pscustomobject]@{
        mode = $idle.mode
        color = $idle.color
        brightnessPercent = $idle.brightnessPercent
    }
    if ($idle.mode -eq 'breathing' -and $idle.PSObject.Properties.Name -contains 'breathingSpeed') {
        Add-Member -InputObject $installedConfigDocument.states.waiting -NotePropertyName breathingSpeed -NotePropertyValue $idle.breathingSpeed
    }
    $configChanged = $true
}
if ($configChanged) {
    $json = $installedConfigDocument | ConvertTo-Json -Depth 20
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($installedConfig, $json + [Environment]::NewLine, $utf8NoBom)
    Write-Host 'Migrated legacy idle/waiting preserve lighting to explicit normal lighting.'
}

$legacySource = Join-Path $installDirectory 'snapshots\legacy-baseline-k99v2-258a-010c-20260913T142853+0800'
$legacyTarget = Join-Path $runtimeDirectory 'snapshots\legacy-baseline-k99v2-258a-010c-20260913T142853+0800'
if ((Test-Path -LiteralPath $legacySource) -and -not (Test-Path -LiteralPath $legacyTarget)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $legacyTarget) | Out-Null
    Copy-Item -LiteralPath $legacySource -Destination $legacyTarget -Recurse
}

# Run the newly installed stop path once as a migration step. Besides keeping
# hooks disabled during the remaining update, this clears any active task state
# left by an older daemon that could not observe terminal events while stopped.
& $nodeRuntime (Join-Path $installDirectory 'ledctl.cjs') stop
if ($LASTEXITCODE -ne 0) { throw "Post-copy controller cleanup failed with exit code $LASTEXITCODE" }

& $nodeRuntime (Join-Path $installDirectory 'install-hooks.cjs')
if ($LASTEXITCODE -ne 0) { throw "Hook installation failed with exit code $LASTEXITCODE" }

& $nodeRuntime (Join-Path $installDirectory 'ledctl.cjs') start
if ($LASTEXITCODE -ne 0) { throw "Controller start failed with exit code $LASTEXITCODE" }

# Start the controller automatically after this Windows user signs in. This is
# deliberately per-user (HKCU) and does not require Administrator privileges.
# The `autostart` command respects a persistent manual `stop`, so disabling the
# controller remains durable across reboot until the user runs `start` again.
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$launcher = Join-Path $installDirectory 'mchose-led.ps1'
$autoStartCommand = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" autostart' -f $launcher
New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name 'MCHOSECodexLED' -Value $autoStartCommand -PropertyType String -Force | Out-Null

Write-Host "Installed to $installDirectory"
Write-Host 'Registered per-user Windows logon autostart (HKCU Run: MCHOSECodexLED).'
Write-Host 'Desktop lifecycle detection uses Codex hooks plus the read-only local-state watcher as complementary sources.'
Write-Host 'If hooks are not yet trusted, run codex interactively, enter /hooks, trust the 7 MCHOSE groups, then fully restart Desktop/VS Code.'
Write-Host 'Run mchose-led.ps1 diagnose for a one-command status report.'
