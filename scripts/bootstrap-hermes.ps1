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
$hermesBranch = if ($env:HERMES_BRANCH) { $env:HERMES_BRANCH } else { "main" }
$hermesGithubToken = if ($env:HERMES_GITHUB_TOKEN) {
    $env:HERMES_GITHUB_TOKEN
} else {
    $env:GITHUB_TOKEN
}
$hermesSourceUrl = $env:HERMES_SOURCE_URL
$hermesPythonVersion = if ($env:HERMES_PYTHON_VERSION) { $env:HERMES_PYTHON_VERSION } else { "3.11" }
$portablePythonRoot = if ($env:HERMES_PORTABLE_PYTHON_ROOT) {
    $env:HERMES_PORTABLE_PYTHON_ROOT
} else {
    Join-Path $runtimeRoot "python"
}
$bootstrapTempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("sz-gov-hermes-{0}" -f [guid]::NewGuid())

# Force uv to use a Python installation stored next to the bundled Hermes
# runtime. Otherwise a runner-local Python can leave absolute links and a
# machine-specific pyvenv.cfg in the packaged Electron app.
$env:HERMES_PYTHON_VERSION = $hermesPythonVersion
$env:UV_PYTHON_INSTALL_DIR = $portablePythonRoot
$env:UV_MANAGED_PYTHON = "1"
$env:UV_PYTHON = $null

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

Write-Host "Installing Hermes Agent for Windows into:"
Write-Host "  install dir: $installDir"
Write-Host "  hermes home: $hermesHome"

function Invoke-Git {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    & git @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

function Prepare-LocalHermesRepository {
    $localSourceRepo = Join-Path $bootstrapTempRoot "hermes-agent-source.git"
    $sourceRef = if ($env:HERMES_COMMIT) { $env:HERMES_COMMIT } else { $hermesBranch }

    if (-not (Test-Path (Join-Path $installDir ".git"))) {
        $usingProjectSource = [bool]($hermesSourceUrl -and -not $env:HERMES_COMMIT)
        $archiveUrl = if ($usingProjectSource) {
            $hermesSourceUrl
        } else {
            "https://codeload.github.com/NousResearch/hermes-agent/zip/$sourceRef"
        }
        $archiveFileName = if ($usingProjectSource) { "hermes-source.tar.gz" } else { "hermes-source.zip" }
        $archivePath = Join-Path $bootstrapTempRoot $archiveFileName
        $extractPath = Join-Path $bootstrapTempRoot "extract"

        Write-Host "Downloading Hermes source archive (no upstream git clone)..."
        $archiveParams = @{ Uri = $archiveUrl; OutFile = $archivePath; UseBasicParsing = $true }
        if ($hermesGithubToken) {
            $archiveParams.Headers = @{ Authorization = "Bearer $hermesGithubToken" }
        }
        Invoke-WebRequest @archiveParams
        New-Item -ItemType Directory -Force -Path $extractPath | Out-Null
        if ($usingProjectSource) {
            & tar.exe -xzf $archivePath -C $extractPath
            if ($LASTEXITCODE -ne 0) {
                throw "Unable to extract the Hermes source tarball."
            }
        } else {
            Expand-Archive -Path $archivePath -DestinationPath $extractPath -Force
        }

        $extractedDir = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
        if (-not $extractedDir) {
            throw "Hermes source archive did not contain a top-level directory."
        }

        if (Test-Path $installDir) {
            $backupDir = "$installDir.broken-" + (Get-Date -Format "yyyyMMdd-HHmmss")
            Move-Item -LiteralPath $installDir -Destination $backupDir
            Write-Host "Moved incomplete Hermes directory to $backupDir"
        }
        New-Item -ItemType Directory -Force -Path (Split-Path $installDir) | Out-Null
        Move-Item -LiteralPath $extractedDir.FullName -Destination $installDir

        Invoke-Git @("-C", $installDir, "init", "-b", $hermesBranch)
        Invoke-Git @("-C", $installDir, "-c", "user.name=SZ Gov Scope build", "-c", "user.email=build@localhost", "add", "-A")
        Invoke-Git @("-C", $installDir, "-c", "user.name=SZ Gov Scope build", "-c", "user.email=build@localhost", "commit", "-m", "Hermes source archive")
        Write-Host "Prepared Hermes source from ref: $sourceRef"
    } else {
        Write-Host "Using the existing Hermes source checkout."
    }

    New-Item -ItemType Directory -Force -Path $bootstrapTempRoot | Out-Null
    if (Test-Path $localSourceRepo) {
        Remove-Item -LiteralPath $localSourceRepo -Recurse -Force
    }
    Invoke-Git @("init", "--bare", $localSourceRepo)
    Invoke-Git @("-C", $localSourceRepo, "config", "receive.shallowUpdate", "true")
    Invoke-Git @("-C", $installDir, "checkout", "-B", $hermesBranch)
    & git -C $installDir remote remove origin 2>$null
    Invoke-Git @("-C", $installDir, "remote", "add", "origin", $localSourceRepo)
    Invoke-Git @("-C", $installDir, "push", "--force", "--set-upstream", "origin", $hermesBranch)
    Write-Host "Configured Hermes installer to update from the local source mirror."
}

function Remove-MacOSMetadata {
    $metadataFiles = Get-ChildItem -LiteralPath $runtimeRoot -Recurse -Force -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name.StartsWith("._") -or $_.Name -eq ".DS_Store" }
    if ($metadataFiles) {
        $metadataFiles | Remove-Item -Force -ErrorAction SilentlyContinue
        Write-Host "Removed $($metadataFiles.Count) macOS metadata files from $runtimeRoot"
    }
}

try {
    New-Item -ItemType Directory -Force -Path $bootstrapTempRoot | Out-Null
    Prepare-LocalHermesRepository
    Remove-MacOSMetadata

    $installerParams = @{
        SkipSetup = $true
        NonInteractive = $true
        HermesHome = $hermesHome
        InstallDir = $installDir
    }

    # The archive path preserves the requested source ref but cannot recreate
    # the upstream Git object ID. The local mirror therefore owns this build's
    # checkout, and the source ref is recorded in the build log above.

    $installerPath = Join-Path $installDir "scripts/install.ps1"
    if (-not (Test-Path $installerPath)) {
        throw "Hermes installer script not found in the prepared source: $installerPath"
    }

    & $installerPath @installerParams
    if ($LASTEXITCODE -ne 0) {
        throw "Hermes Windows installer failed with exit code $LASTEXITCODE."
    }

    & git -C $installDir remote set-url origin "https://github.com/NousResearch/hermes-agent.git" 2>$null

    $uvPath = Join-Path $hermesHome "bin\uv.exe"
    if (-not (Test-Path $uvPath)) {
        $uvCommand = Get-Command uv -ErrorAction SilentlyContinue
        if ($uvCommand) {
            $uvPath = $uvCommand.Source
        }
    }
    if (-not (Test-Path $uvPath)) {
        throw "Managed uv was not found after Hermes installation; cannot prepare portable Python."
    }

    Write-Host "Ensuring portable Python $hermesPythonVersion is bundled with Hermes..."
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $uvPath python install $hermesPythonVersion --install-dir $portablePythonRoot --no-bin
    $uvExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousEap
    if ($uvExitCode -ne 0) {
        throw "Portable Python installation failed with exit code $uvExitCode."
    }

    & node (Join-Path $projectRoot "scripts/prepare-portable-hermes-runtime.mjs")
    if ($LASTEXITCODE -ne 0) {
        throw "Portable Hermes runtime preparation failed with exit code $LASTEXITCODE."
    }

    Write-Host "Applying local Hermes runtime patches..."
    & node (Join-Path $projectRoot "scripts/patch-hermes-runtime.mjs")
    if ($LASTEXITCODE -ne 0) {
        throw "Hermes runtime patching failed with exit code $LASTEXITCODE."
    }
} finally {
    if (Test-Path $bootstrapTempRoot) {
        Remove-Item -LiteralPath $bootstrapTempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
