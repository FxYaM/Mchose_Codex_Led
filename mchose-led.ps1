$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'node-runtime.ps1')
$nodeRuntime = Get-MchoseNodeRuntime

& $nodeRuntime (Join-Path $PSScriptRoot 'ledctl.cjs') @args
exit $LASTEXITCODE
