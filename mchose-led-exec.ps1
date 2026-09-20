$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'node-runtime.ps1')
$nodeRuntime = Get-MchoseNodeRuntime

& $nodeRuntime (Join-Path $PSScriptRoot 'codex-exec-led.cjs') @args
exit $LASTEXITCODE
