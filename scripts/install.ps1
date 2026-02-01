# ABOUTME: Windows install script for Seren local runtime.
# ABOUTME: Auto-downloads Node.js if missing, installs @serendb/runtime into ~/.seren-local.
#
# Usage: irm https://seren.com/install.ps1 | iex

$ErrorActionPreference = "Stop"

$NODE_VERSION = "22.13.1"
$MIN_NODE_MAJOR = 20
$PACKAGE = "@serendb/runtime"
$SEREN_DIR = Join-Path $env:USERPROFILE ".seren-local"
$SEREN_NODE_DIR = Join-Path $SEREN_DIR "node"
$SEREN_BIN = Join-Path $SEREN_DIR "bin"
$SEREN_ICON_URL = "https://raw.githubusercontent.com/serenorg/seren-local/main/scripts/assets/seren-icon.png"
$script:SEREN_ICON_PATH = $null

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

# ── Check for existing Node.js ────────────────────────────────────────

function Find-Node {
    # Check Seren's private Node first
    $serenNode = Join-Path $SEREN_NODE_DIR "node.exe"
    if (Test-Path $serenNode) {
        $version = (& $serenNode --version 2>$null)
        if ($version) {
            $major = [int]($version -replace '^v','').Split('.')[0]
            if ($major -ge $MIN_NODE_MAJOR) {
                $script:NODE_BIN = $serenNode
                $script:NPM_BIN = Join-Path $SEREN_NODE_DIR "npm.cmd"
                Write-Ok "Seren Node.js $version found"
                return $true
            }
        }
    }

    # Check system Node
    try {
        $version = (node --version 2>$null)
        if ($version) {
            $major = [int]($version -replace '^v','').Split('.')[0]
            if ($major -ge $MIN_NODE_MAJOR) {
                $script:NODE_BIN = "node"
                $script:NPM_BIN = "npm"
                Write-Ok "System Node.js $version found"
                return $true
            }
            Write-Warn "System Node.js $version too old (need v${MIN_NODE_MAJOR}+)."
        }
    } catch {}

    return $false
}

# ── Download Node.js ──────────────────────────────────────────────────

function Install-Node {
    Write-Info "Downloading Node.js v${NODE_VERSION} for Windows x64..."

    $url = "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip"
    $tmpZip = Join-Path $env:TEMP "seren-node-$([System.IO.Path]::GetRandomFileName()).zip"
    $tmpExtract = Join-Path $env:TEMP "seren-node-extract-$([System.IO.Path]::GetRandomFileName())"

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $tmpZip -UseBasicParsing

        # Extract
        New-Item -ItemType Directory -Path $tmpExtract -Force | Out-Null
        Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force

        # Move to ~/.seren-local/node/
        $extracted = Get-ChildItem -Path $tmpExtract -Directory | Select-Object -First 1
        if (Test-Path $SEREN_NODE_DIR) { Remove-Item -Recurse -Force $SEREN_NODE_DIR }
        Move-Item -Path $extracted.FullName -Destination $SEREN_NODE_DIR

        $script:NODE_BIN = Join-Path $SEREN_NODE_DIR "node.exe"
        $script:NPM_BIN = Join-Path $SEREN_NODE_DIR "npm.cmd"

        $installedVersion = & $script:NODE_BIN --version
        Write-Ok "Installed Node.js ${installedVersion} to ${SEREN_NODE_DIR}\"
    }
    catch {
        Write-Err "Failed to download Node.js: $_"
        exit 1
    }
    finally {
        Remove-Item -Path $tmpZip -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Path $tmpExtract -ErrorAction SilentlyContinue
    }
}

# ── Check build tools ─────────────────────────────────────────────────

function Test-BuildTools {
    $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $hasVS = $false

    if (Test-Path $vsWhere) {
        $installs = & $vsWhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json 2>$null | ConvertFrom-Json
        if ($installs -and $installs.Count -gt 0) { $hasVS = $true }
    }

    if (-not $hasVS) {
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

# ── Install runtime ───────────────────────────────────────────────────

function Install-Runtime {
    Write-Info "Installing ${PACKAGE}..."
    Write-Host ""

    # Install into Seren's private prefix
    New-Item -ItemType Directory -Path $SEREN_BIN -Force | Out-Null

    try {
        & $script:NPM_BIN install -g $PACKAGE --prefix $SEREN_DIR
        Write-Host ""
        Write-Ok "${PACKAGE} installed successfully!"
    }
    catch {
        Write-Host ""
        Write-Err "Installation failed: $_"
        exit 1
    }

    # Install OpenClaw messaging gateway (optional, non-fatal)
    Write-Info "Installing openclaw..."
    try {
        & $script:NPM_BIN install -g openclaw --prefix $SEREN_DIR
        Write-Ok "openclaw installed successfully!"
    }
    catch {
        Write-Warn "openclaw install failed (messaging features will be unavailable)."
        Write-Warn "You can install it later: npm install -g openclaw"
    }
}

# ── Set up PATH ───────────────────────────────────────────────────────

function Setup-Path {
    $currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($currentPath -notlike "*$SEREN_BIN*") {
        [Environment]::SetEnvironmentVariable("PATH", "$SEREN_BIN;$currentPath", "User")
        Write-Ok "Added $SEREN_BIN to user PATH"
    } else {
        Write-Ok "PATH already configured"
    }

    # Make available in current session
    $env:PATH = "$SEREN_BIN;$env:PATH"
}

# ── Icon helpers ─────────────────────────────────────────────────────

function Write-SerenIcon {
    try {
        $assets = Join-Path $SEREN_DIR "assets"
        New-Item -ItemType Directory -Path $assets -Force | Out-Null
        $script:SEREN_ICON_PATH = Join-Path $assets "seren-icon.png"
        Invoke-WebRequest -Uri $SEREN_ICON_URL -OutFile $script:SEREN_ICON_PATH -UseBasicParsing
        Write-Ok "Downloaded Seren icon"
    }
    catch {
        Write-Warn "Unable to download Seren icon: $_"
        $script:SEREN_ICON_PATH = $null
    }
}

function Convert-ToIco {
    param([string]$PngPath)
    if (-not (Test-Path $PngPath)) { return $null }
    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $bitmap = [System.Drawing.Bitmap]::FromFile($PngPath)
        $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
        $icoPath = Join-Path (Split-Path $PngPath -Parent) "seren-icon.ico"
        $stream = [System.IO.File]::Create($icoPath)
        $icon.Save($stream)
        $stream.Dispose()
        $icon.Dispose()
        $bitmap.Dispose()
        return $icoPath
    }
    catch {
        Write-Warn "Failed to convert icon: $_"
        return $null
    }
}

function New-DesktopShortcut {
    try {
        $desktop = [Environment]::GetFolderPath("Desktop")
        if (-not (Test-Path $desktop)) { return }

        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut((Join-Path $desktop "Seren Local.lnk"))
        $serenCmd = Join-Path $SEREN_BIN "seren.cmd"
        if (-not (Test-Path $serenCmd)) { $serenCmd = Join-Path $SEREN_BIN "seren" }
        $shortcut.TargetPath = $serenCmd
        $shortcut.WorkingDirectory = $SEREN_DIR

        if ($SEREN_ICON_PATH) {
            $ico = Convert-ToIco $SEREN_ICON_PATH
            if ($ico) { $shortcut.IconLocation = $ico }
        }

        $shortcut.Save()
        Write-Ok "Created desktop shortcut"
    }
    catch {
        Write-Warn "Failed to create desktop shortcut: $_"
    }
}

# ── Verify ────────────────────────────────────────────────────────────

function Test-SerenCommand {
    $serenCmd = Join-Path $SEREN_BIN "seren"
    if (Test-Path "$serenCmd.cmd") {
        Write-Ok "seren command is available"
    } elseif (Test-Path $serenCmd) {
        Write-Ok "seren command is available"
    } else {
        # Check npm's bin location within the prefix
        $npmBinDir = Join-Path $SEREN_DIR "bin"
        if (Test-Path (Join-Path $npmBinDir "seren.cmd")) {
            Write-Ok "seren command is available"
        } else {
            Write-Warn "seren command not found. You may need to restart your terminal."
        }
    }
}

function New-DataDir {
    $dataDir = Join-Path $SEREN_DIR "data"
    if (-not (Test-Path $dataDir)) {
        New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
        Write-Ok "Created $dataDir\"
    }
}

# ── Main ───────────────────────────────────────────────────────────────

Write-Banner

if (-not (Find-Node)) {
    Install-Node
}

Test-BuildTools
Install-Runtime
Setup-Path
Test-SerenCommand
New-DataDir
Write-SerenIcon
New-DesktopShortcut

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║          Installation Complete!          ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Start the runtime:" -ForegroundColor White
Write-Host "    seren" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Then open Seren in your browser:" -ForegroundColor White
Write-Host "    https://app.seren-local.com" -ForegroundColor Cyan
Write-Host ""
Write-Host "  The browser will automatically connect to your local runtime." -ForegroundColor Gray
if (Test-Path (Join-Path $SEREN_NODE_DIR "node.exe")) {
    Write-Host ""
    Write-Host "  Note: Node.js was installed to ${SEREN_NODE_DIR}\" -ForegroundColor Gray
    Write-Host "  To remove everything, delete ${SEREN_DIR}\" -ForegroundColor Gray
}
Write-Host ""
