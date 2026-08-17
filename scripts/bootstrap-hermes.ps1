$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = if ($env:HERMES_RUNTIME_ROOT) {
    $env:HERMES_RUNTIME_ROOT
} else {
    Join-Path $projectRoot ".runtime"
}
$installDir = if ($env:HERMES_INSTALL_DIR) {
    $env:HERMES_INSTALL_DIR
} else {
    Join-Path $runtimeRoot "hermes-agent"
}
$hermesHome = if ($env:HERMES_HOME) {
    $env:HERMES_HOME
} else {
    Join-Path $runtimeRoot "hermes-home"
}
$installerUrl = "https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1"
$installerPath = Join-Path ([System.IO.Path]::GetTempPath()) ("hermes-install-{0}.ps1" -f [guid]::NewGuid())

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

Write-Host "Installing Hermes Agent for Windows into:"
Write-Host "  install dir: $installDir"
Write-Host "  hermes home: $hermesHome"

try {
    Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath

    $installerArgs = @(
        "-SkipSetup",
        "-NonInteractive",
        "-HermesHome", $hermesHome,
        "-InstallDir", $installDir
    )

    if ($env:HERMES_COMMIT) {
        $installerArgs += @("-Commit", $env:HERMES_COMMIT)
    }

    & $installerPath @installerArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Hermes Windows installer failed with exit code $LASTEXITCODE."
    }

    Write-Host "Applying local Hermes runtime patches..."
    & node (Join-Path $projectRoot "scripts/patch-hermes-runtime.mjs")
    if ($LASTEXITCODE -ne 0) {
        throw "Hermes runtime patching failed with exit code $LASTEXITCODE."
    }
} finally {
    Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
}
