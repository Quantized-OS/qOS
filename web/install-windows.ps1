[CmdletBinding()]
param(
    [ValidateSet("mainnet", "devnet", "insecure")]
    [string]$Mode = "mainnet",
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$BootstrapUrl = if ($env:QOS_BOOTSTRAP_URL) { $env:QOS_BOOTSTRAP_URL } else { "https://qos.systems/install.sh" }

function Show-Usage {
    @'
qOS Windows installer

Usage (PowerShell):
  irm https://qos.systems/install-windows.ps1 | iex

Devnet:
  $env:QOS_SETUP_MODE='devnet'; irm https://qos.systems/install-windows.ps1 | iex

Accessible mainnet software key (unsafe; confirmation is still required):
  $env:QOS_SETUP_MODE='insecure'; irm https://qos.systems/install-windows.ps1 | iex

qOS currently targets Ubuntu. This wrapper enables or reuses WSL 2 with an
Ubuntu 24.04 distribution, then runs the verified qOS GitHub Release bootstrap
in that environment. The default mainnet wizard asks whether to use your
existing external key or generate a local key through --insecure.

After setup, reopen qOS with:
  wsl -d Ubuntu-24.04 -- bash -lc qos
'@
}

if ($Help) {
    Show-Usage
    return
}

if ($env:QOS_SETUP_MODE) {
    $Mode = $env:QOS_SETUP_MODE.ToLowerInvariant()
}
if ($Mode -notin @("mainnet", "devnet", "insecure")) {
    throw "QOS_SETUP_MODE must be mainnet, devnet, or insecure."
}
if ($BootstrapUrl -notmatch '^https://[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+$') {
    throw "QOS_BOOTSTRAP_URL must be a safely encoded HTTPS URL."
}
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "This installer must run in Windows PowerShell or PowerShell on Windows."
}

$Wsl = Join-Path $env:SystemRoot "System32\wsl.exe"
if (-not (Test-Path -LiteralPath $Wsl -PathType Leaf)) {
    throw "wsl.exe is unavailable. qOS requires Windows 10 version 2004 or newer, or Windows 11."
}

function Get-UbuntuDistribution {
    $Names = @(& $Wsl --list --quiet 2>$null | ForEach-Object {
        ($_ -replace [char]0, '').Trim()
    } | Where-Object { $_ })
    return ($Names | Where-Object { $_ -eq "Ubuntu-24.04" } | Select-Object -First 1)
}

$Distribution = Get-UbuntuDistribution
if (-not $Distribution) {
    Write-Host "[qOS Windows] Ubuntu 24.04 on WSL 2 is not installed. Windows will request administrator approval."
    $Install = Start-Process -FilePath $Wsl -Verb RunAs -Wait -PassThru -ArgumentList @("--install", "-d", "Ubuntu-24.04")
    if ($Install.ExitCode -ne 0) {
        throw "WSL could not install Ubuntu 24.04. Run 'wsl --install -d Ubuntu-24.04' as Administrator, restart Windows if requested, then run this installer again."
    }
    $Distribution = Get-UbuntuDistribution
    if (-not $Distribution) {
        throw "Ubuntu needs a Windows restart before it can start. Restart Windows, then run the same qOS install command again."
    }
}

Write-Host "[qOS Windows] Using WSL distribution: $Distribution"
Write-Host "[qOS Windows] The first Ubuntu launch may ask you to create a Linux username and password."
Write-Host "[qOS Windows] Ensuring this Ubuntu distribution uses WSL 2."
& $Wsl --set-default-version 2 | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "Windows could not set WSL 2 as the default. Update WSL, restart Windows, and run this installer again."
}
& $Wsl --set-version $Distribution 2 | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "Windows could not convert $Distribution to WSL 2. Update WSL, restart Windows, and run this installer again."
}

$SetupSuffix = switch ($Mode) {
    "devnet" { " -s -- --devnet" }
    "insecure" { " -s -- --insecure" }
    default { "" }
}
$GuestCommand = @"
set -eu
if ! command -v curl >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl
fi
curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL '$BootstrapUrl' | sh$SetupSuffix
"@

Write-Host "[qOS Windows] Starting the verified qOS setup inside Ubuntu ($Mode)."
& $Wsl -d $Distribution -- bash -lc $GuestCommand
if ($LASTEXITCODE -ne 0) {
    throw "qOS setup inside Ubuntu exited with status $LASTEXITCODE."
}

Write-Host ""
Write-Host "[qOS Windows] Reopen qOS with:"
Write-Host "  wsl -d $Distribution -- bash -lc qos"
