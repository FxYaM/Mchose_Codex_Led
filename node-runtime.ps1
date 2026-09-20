function Get-MchoseNodeRuntime {
    $candidates = @(
        (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'),
        (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    )
    $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($pathNode) { $candidates += $pathNode.Source }
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            try {
                # Single quotes inside JavaScript survive Windows PowerShell 5.1's
                # legacy native-command argument handling.
                & $candidate --no-warnings -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1); require('node:sqlite');" 2>$null
                if ($LASTEXITCODE -eq 0) { return $candidate }
            }
            catch {
                # An unusable bundled runtime must not prevent trying system Node.
            }
        }
    }
    throw 'Node.js 24+ with node:sqlite was not found. Install a supported Node.js LTS runtime.'
}
