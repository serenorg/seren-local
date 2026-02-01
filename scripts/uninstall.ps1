# ABOUTME: Windows uninstall script for Seren local runtime.
# ABOUTME: Removes npm package and optionally deletes user data.

$ErrorActionPreference = "Stop"

function Write-Ok($msg) { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "  $msg" -ForegroundColor White }

Write-Host ""
Write-Host "  Seren Runtime Uninstaller" -ForegroundColor Cyan
Write-Host ""

# Remove npm package
try {
    npm uninstall -g @serendb/runtime 2>$null
    Write-Ok "Removed @serendb/runtime"
}
catch {
    Write-Warn "Package not found or already removed."
}

# Ask about data directory
$dataDir = Join-Path $env:USERPROFILE ".seren"
if (Test-Path $dataDir) {
    $answer = Read-Host "  Remove data directory ($dataDir)? [y/N]"
    if ($answer -eq "y" -or $answer -eq "Y") {
        Remove-Item -Recurse -Force $dataDir
        Write-Ok "Removed $dataDir"
    } else {
        Write-Info "Kept $dataDir"
    }
} else {
    Write-Info "No data directory found."
}

Write-Host ""
Write-Ok "Uninstall complete."
Write-Host ""
