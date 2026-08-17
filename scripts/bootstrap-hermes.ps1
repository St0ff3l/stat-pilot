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
$installerUrl = "https://api.github.com/repos/NousResearch/hermes-agent/contents/scripts/install.ps1?ref=main"
$installerPath = Join-Path ([System.IO.Path]::GetTempPath()) ("hermes-install-{0}.ps1" -f [guid]::NewGuid())
$hermesGithubToken = if ($env:HERMES_GITHUB_TOKEN) {
    $env:HERMES_GITHUB_TOKEN
} else {
    $env:GITHUB_TOKEN
}

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

Write-Host "Installing Hermes Agent for Windows into:"
Write-Host "  install dir: $installDir"
Write-Host "  hermes home: $hermesHome"

try {
    if ($hermesGithubToken) {
        $env:GIT_CONFIG_COUNT = "2"
        $env:GIT_CONFIG_KEY_0 = "url.https://x-access-token:$hermesGithubToken@github.com/.insteadOf"
        $env:GIT_CONFIG_VALUE_0 = "https://github.com/"
        $env:GIT_CONFIG_KEY_1 = "http.https://github.com/.extraheader"
        $env:GIT_CONFIG_VALUE_1 = "AUTHORIZATION: bearer $hermesGithubToken"
    }

    $requestParams = @{
        Uri = $installerUrl
        OutFile = $installerPath
        Headers = @{ Accept = "application/vnd.github.raw" }
    }
    if ($hermesGithubToken) {
        $requestParams.Headers.Authorization = "Bearer $hermesGithubToken"
    }

    $downloaded = $false
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            Invoke-WebRequest @requestParams
            $downloaded = $true
            break
        } catch {
            if ($attempt -eq 5) {
                throw
            }
            $delay = [math]::Min(60, 5 * [math]::Pow(2, $attempt - 1))
            Write-Host "Hermes installer download failed; retrying in $delay seconds..."
            Start-Sleep -Seconds $delay
        }
    }
    if (-not $downloaded) {
        throw "Hermes installer download failed."
    }

    $installerParams = @{
        SkipSetup = $true
        NonInteractive = $true
        HermesHome = $hermesHome
        InstallDir = $installDir
    }

    if ($env:HERMES_COMMIT) {
        $installerParams.Commit = $env:HERMES_COMMIT
    }

    & $installerPath @installerParams
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
