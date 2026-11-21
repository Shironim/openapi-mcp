# ==============================================================================
# openapi-mcp Standalone Binary Installer (Windows PowerShell)
# Usage:
#   irm https://raw.githubusercontent.com/Shironim/openapi-mcp/master/scripts/install.ps1 | iex
#
# Environment variables:
#   $env:OPENAPI_MCP_VERSION     Specific version tag to install (default: latest release)
#   $env:OPENAPI_MCP_INSTALL_DIR Target directory for binary (default: $env:LOCALAPPDATA\Programs\openapi-mcp)
#   $env:OPENAPI_MCP_REPO        GitHub repository slug (default: Shironim/openapi-mcp)
# ==============================================================================

[CmdletBinding()]
param (
    [string]$Version = $(if ($env:OPENAPI_MCP_VERSION) { $env:OPENAPI_MCP_VERSION } else { $env:VERSION }),
    [string]$InstallDir = $env:OPENAPI_MCP_INSTALL_DIR,
    [string]$Repo = $(if ($env:OPENAPI_MCP_REPO) { $env:OPENAPI_MCP_REPO } else { "Shironim/openapi-mcp" })
)

$ErrorActionPreference = "Stop"
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$BinaryName = "openapi-mcp.exe"

function Write-Info {
    param([string]$Message)
    Write-Host "[info] " -ForegroundColor Cyan -NoNewline
    Write-Host $Message
}

function Write-Success {
    param([string]$Message)
    Write-Host "[success] " -ForegroundColor Green -NoNewline
    Write-Host $Message -ForegroundColor White
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[warn] " -ForegroundColor Yellow -NoNewline
    Write-Host $Message
}

function Write-Err {
    param([string]$Message)
    Write-Host "[error] " -ForegroundColor Red -NoNewline
    Write-Host $Message
    exit 1
}

# 1. Architecture Check
if (-not [System.Environment]::Is64BitOperatingSystem) {
    Write-Err "openapi-mcp standalone binary requires 64-bit Windows (x64)."
}

$Target = "openapi-mcp-windows-x64.exe"
Write-Info "Detected Windows x64 architecture (target: $Target)"

# 2. Determine Download URL
if ($Version) {
    $BaseUrl = "https://github.com/$Repo/releases/download/$Version"
    Write-Info "Installing specified version: $Version"
} else {
    $BaseUrl = "https://github.com/$Repo/releases/latest/download"
    Write-Info "Fetching latest release from $Repo..."
}

$DownloadUrl = "$BaseUrl/$Target"
$ChecksumUrl = "$BaseUrl/checksums.txt"

# 3. Determine Installation Directory
if (-not $InstallDir) {
    $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\openapi-mcp"
}

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$TargetFile = Join-Path $InstallDir $BinaryName
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("openapi-mcp-install-" + [System.Guid]::NewGuid().ToString().Substring(0, 8))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
    $TempBin = Join-Path $TempDir $BinaryName
    Write-Info "Downloading $Target..."
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempBin -UseBasicParsing

    # checksums.txt uses the same sha256sum format for all release targets.
    $TempChecksums = Join-Path $TempDir "checksums.txt"
    Invoke-WebRequest -Uri $ChecksumUrl -OutFile $TempChecksums -UseBasicParsing
    $Filename = [regex]::Escape($Target)
    $Entries = @(Get-Content $TempChecksums | Where-Object { $_ -cmatch "^[a-f0-9]{64}\s+$Filename$" })
    if ($Entries.Count -ne 1) {
        throw "Missing or invalid SHA-256 checksum for $Target."
    }
    $ExpectedHash = ($Entries[0] -split '\s+')[0]
    $ActualHash = (Get-FileHash -Path $TempBin -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ExpectedHash -cne $ActualHash) {
        throw "Checksum verification failed for $Target."
    }
    Write-Info "Checksum verified: $ActualHash"

    $VersionCheck = Start-Process -FilePath $TempBin -ArgumentList '--version' -PassThru -Wait -NoNewWindow
    if ($VersionCheck.ExitCode -ne 0) {
        throw "Downloaded binary could not run on this system."
    }

    # 5. Move binary into place
    Move-Item -Path $TempBin -Destination $TargetFile -Force
} finally {
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# 6. Ensure InstallDir is in User PATH
$UserPath = [System.Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::User)
$PathEntries = $UserPath -split ';' | Where-Object { $_ -ne "" }

if ($PathEntries -notcontains $InstallDir) {
    Write-Info "Adding $InstallDir to User PATH..."
    $NewPath = if ($UserPath) { "$UserPath;$InstallDir" } else { $InstallDir }
    [System.Environment]::SetEnvironmentVariable("Path", $NewPath, [System.EnvironmentVariableTarget]::User)
    $env:Path = "$env:Path;$InstallDir"
    Write-Warn "Restart existing terminal sessions so 'openapi-mcp' is picked up in PATH."
}

Write-Host ""
Write-Success "openapi-mcp installed at: $TargetFile"

Write-Host ""
Write-Host "Quick Start:" -ForegroundColor White
Write-Host "  1. Run 'openapi-mcp --help' to inspect CLI options."
Write-Host "  2. Configure MCP client command: openapi-mcp serve"
Write-Host ""
