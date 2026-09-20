$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'node-runtime.ps1')
$nodeRuntime = Get-MchoseNodeRuntime
$codexDirectory = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.codex'))
$installDirectory = [System.IO.Path]::GetFullPath((Join-Path $codexDirectory 'mchose-led'))
if (-not (Test-Path -LiteralPath $installDirectory)) {
    Write-Host 'MCHOSE Codex LED is not installed in the standard installation directory.'
    exit 0
}
if ((Split-Path -Parent $installDirectory) -ne $codexDirectory -or (Split-Path -Leaf $installDirectory) -ne 'mchose-led') {
    throw 'Refusing to remove an unexpected installation path.'
}
foreach ($directory in @($codexDirectory, $installDirectory)) {
    if ((Get-Item -LiteralPath $directory -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to uninstall through a linked directory: $directory"
    }
}
# Inspect one directory at a time so the inspection itself cannot follow a
# junction. Refuse linked contents before any recursive deletion is attempted.
$directories = New-Object 'System.Collections.Generic.Stack[string]'
$directories.Push($installDirectory)
while ($directories.Count -gt 0) {
    foreach ($item in (Get-ChildItem -LiteralPath $directories.Pop() -Force)) {
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw "Refusing to remove linked installation contents: $($item.FullName)"
        }
        if ($item.PSIsContainer) { $directories.Push($item.FullName) }
    }
}
$controller = Join-Path $installDirectory 'ledctl.cjs'
& $nodeRuntime $controller stop
if ($LASTEXITCODE -ne 0) {
    throw 'Restore is incomplete. Reconnect the keyboard and run mchose-led.ps1 restore --watch, then retry uninstall.'
}
# Retain configuration beside all recovery snapshots, even when runtimeDirectory is customized.
$configPath = Join-Path $installDirectory 'config.json'
$commonModule = Join-Path $installDirectory 'lib\common.cjs'
$runtimeDirectory = (& $nodeRuntime -e 'process.stdout.write(require(process.argv[1]).loadConfig(process.argv[2]).runtimeDirectory)' $commonModule $installDirectory | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $runtimeDirectory) { throw 'Cannot determine the recovery directory; uninstall aborted.' }
$resolvedRuntime = [System.IO.Path]::GetFullPath($runtimeDirectory).TrimEnd('\')
if ($resolvedRuntime.Equals($installDirectory, [System.StringComparison]::OrdinalIgnoreCase) -or $resolvedRuntime.StartsWith($installDirectory + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Recovery data is inside the installation directory. Move it to a separate runtimeDirectory before uninstalling.'
}
# A lexical path outside the installation can still point inside it through a
# junction. Preserve the installation if the recovery location is ambiguous.
$runtimeAncestor = $resolvedRuntime
while ($runtimeAncestor) {
    if ((Test-Path -LiteralPath $runtimeAncestor) -and ((Get-Item -LiteralPath $runtimeAncestor -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Recovery directory uses a linked path. Move it to a separate physical directory before uninstalling: $runtimeAncestor"
    }
    $runtimeAncestor = Split-Path -Parent $runtimeAncestor
}
New-Item -ItemType Directory -Force -Path $resolvedRuntime | Out-Null
$backupPath = Join-Path $resolvedRuntime ('uninstalled-config-' + [guid]::NewGuid().ToString('N') + '.json')
Copy-Item -LiteralPath $configPath -Destination $backupPath
& $nodeRuntime (Join-Path $installDirectory 'install-hooks.cjs') --remove
if ($LASTEXITCODE -ne 0) { throw 'Hook removal failed; program files have been retained.' }
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$registered = Get-ItemProperty -LiteralPath $runKey -Name 'MCHOSECodexLED' -ErrorAction SilentlyContinue
if ($registered) {
    $launcher = Join-Path $installDirectory 'mchose-led.ps1'
    if (-not ([string]$registered.MCHOSECodexLED).Contains('"' + $launcher + '"')) {
        throw 'The startup entry points to an unexpected command; program files have been retained.'
    }
    Remove-ItemProperty -LiteralPath $runKey -Name 'MCHOSECodexLED'
}
# The absolute target was validated above; recovery data resides outside this tree.
Remove-Item -LiteralPath $installDirectory -Recurse -Force
Write-Host "Uninstalled MCHOSE Codex LED. Configuration backup and recovery data retained at $resolvedRuntime"
