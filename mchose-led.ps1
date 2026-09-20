$ErrorActionPreference = 'Stop'

$nodeCandidates = @(
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'),
    (Join-Path $env:ProgramFiles 'nodejs\node.exe')
)

$pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($pathNode) {
    $nodeCandidates += $pathNode.Source
}

$nodeRuntime = $nodeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $nodeRuntime) {
    throw 'Node.js was not found. Install Node.js 18+ or keep the Codex bundled runtime available.'
}

& $nodeRuntime (Join-Path $PSScriptRoot 'ledctl.cjs') @args
exit $LASTEXITCODE
