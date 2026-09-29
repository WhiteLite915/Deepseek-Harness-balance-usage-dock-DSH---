# Install this plugin into the DSH Desktop profile.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# It edits the profile manifest and patch layer and copies the package into the
# profile's own node_modules. Add -Uninstall to remove it again.

param(
	[switch]$Uninstall,
	[string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'

$packageDir = Split-Path $PSScriptRoot -Parent

# Prefer the Node that ships with the running DSH installation.
$runtimeRoots = @(
	(Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime'),
	(Join-Path ${env:ProgramFiles} 'DeepSeek Harness\resources\runtime')
) | Where-Object { $_ -and (Test-Path $_) }

$node = $null
foreach ($root in $runtimeRoots) {
	$candidate = Join-Path $root 'primary-runtime\dependencies\node\bin\node.exe'
	if (Test-Path $candidate) { $node = $candidate; break }
}
if (-not $node) {
	$found = Get-Command node -ErrorAction SilentlyContinue
	if ($found) { $node = $found.Source }
}
if (-not $node) { throw 'cannot find a Node executable; install Node.js 20+ or pass one on PATH' }

Write-Host "node     $node"
$arguments = @((Join-Path $packageDir 'scripts\install.mjs'), '--profile-dir', $ProfileDir)
if ($Uninstall) { $arguments += '--uninstall' }
& $node @arguments
if ($LASTEXITCODE -ne 0) { throw "installer exited with $LASTEXITCODE" }
