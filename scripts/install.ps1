# ABOUTME: Windows install script for Seren local runtime.
# ABOUTME: Checks Node.js, installs @serendb/runtime globally via npm.
#
# Usage: irm https://seren.com/install.ps1 | iex

$ErrorActionPreference = "Stop"

$MIN_NODE_MAJOR = 20
$PACKAGE = "@serendb/runtime"

function Write-Banner {
    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "  ║       Seren Runtime Installer            ║" -ForegroundColor Cyan
    Write-Host "  ║  Local AI agents, MCP, and file access   ║" -ForegroundColor Cyan
    Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Ok($msg) { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "  ✗ $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "  $msg" -ForegroundColor White }

function Test-NodeInstalled {
    try {
        $version = (node --version 2>$null)
        if (-not $version) { return $false }

        $major = [int]($version -replace '^v','').Split('.')[0]
        if ($major -lt $MIN_NODE_MAJOR) {
            Write-Err "Node.js $version found, but v${MIN_NODE_MAJOR}+ required."
            return $false
        }

        Write-Ok "Node.js $version found"
        return $true
    }
    catch {
        return $false
    }
}

function Show-NodeInstructions {
    Write-Err "Node.js v${MIN_NODE_MAJOR}+ is required but not found."
    Write-Host ""
    Write-Info "Install Node.js:"
    Write-Host ""
    Write-Host "  # Option 1: Download from nodejs.org" -ForegroundColor Gray
    Write-Host "  https://nodejs.org" -ForegroundColor White
    Write-Host ""
    Write-Host "  # Option 2: Use winget" -ForegroundColor Gray
    Write-Host "  winget install OpenJS.NodeJS.LTS" -ForegroundColor White
    Write-Host ""
    Write-Host "  # Option 3: Use chocolatey" -ForegroundColor Gray
    Write-Host "  choco install nodejs-lts" -ForegroundColor White
    Write-Host ""
    Write-Info "Then re-run this installer:"
    Write-Host "  irm https://seren.com/install.ps1 | iex" -ForegroundColor White
    Write-Host ""
    exit 1
}

function Test-NpmInstalled {
    try {
        $version = (npm --version 2>$null)
        if (-not $version) {
            Write-Err "npm not found. It should come with Node.js."
            Write-Err "Please reinstall Node.js from https://nodejs.org"
            exit 1
        }
        Write-Ok "npm $version found"
        return $true
    }
    catch {
        Write-Err "npm not found."
        exit 1
    }
}

function Test-BuildTools {
    # Check for Visual Studio Build Tools (needed by node-gyp for better-sqlite3)
    $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $hasVS = $false

    if (Test-Path $vsWhere) {
        $installs = & $vsWhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json 2>$null | ConvertFrom-Json
        if ($installs -and $installs.Count -gt 0) { $hasVS = $true }
    }

    if (-not $hasVS) {
        # Also check for standalone Build Tools via cl.exe in PATH
        try {
            $null = Get-Command cl.exe -ErrorAction Stop
            $hasVS = $true
        } catch {}
    }

    if (-not $hasVS) {
        Write-Warn "Visual Studio Build Tools not found."
        Write-Warn "The runtime uses a native SQLite module that requires a C++ compiler."
        Write-Host ""
        Write-Info "Install Visual Studio Build Tools:"
        Write-Host "  winget install Microsoft.VisualStudio.2022.BuildTools --override ""--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended""" -ForegroundColor White
        Write-Host ""
        Write-Info "Or download from:"
        Write-Host "  https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor White
        Write-Host ""
        Write-Info "Then re-run this installer."
        exit 1
    }

    Write-Ok "C++ build tools found"
}

function Install-Runtime {
    Write-Info "Installing ${PACKAGE}..."
    Write-Host ""

    try {
        npm install -g $PACKAGE
        Write-Host ""
        Write-Ok "${PACKAGE} installed successfully!"
    }
    catch {
        Write-Host ""
        Write-Warn "Global install failed."
        Write-Host ""
        Write-Info "Try running PowerShell as Administrator, then:"
        Write-Host "  npm install -g ${PACKAGE}" -ForegroundColor White
        Write-Host ""
        exit 1
    }
}

function Test-SerenCommand {
    try {
        $null = Get-Command seren -ErrorAction Stop
        Write-Ok "seren command is available"
    }
    catch {
        Write-Warn "seren command not found in PATH."
        Write-Warn "You may need to restart your terminal."
    }
}

function New-DataDir {
    $dataDir = Join-Path $env:USERPROFILE ".seren"
    if (-not (Test-Path $dataDir)) {
        New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
        Write-Ok "Created $dataDir\"
    }
}

# ── Main ───────────────────────────────────────────────────────────────

Write-Banner

if (-not (Test-NodeInstalled)) {
    Show-NodeInstructions
}

Test-NpmInstalled | Out-Null
Test-BuildTools
Install-Runtime
Test-SerenCommand
New-DataDir

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║          Installation Complete!          ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Start the runtime:" -ForegroundColor White
Write-Host "    seren" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Then open Seren in your browser:" -ForegroundColor White
Write-Host "    https://app.seren.com" -ForegroundColor Cyan
Write-Host ""
Write-Host "  The browser will automatically connect to your local runtime." -ForegroundColor Gray
Write-Host ""
