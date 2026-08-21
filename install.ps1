# dsh-file-edit installer (official dsh bundle install)
#
# Installs dsh-file-edit through the standard DSH plugin management pipeline
# (`dsh plugin --profile web add`), exactly like npm-registry bundles such as
# @dingyi222666/dsh-session-notification. The package declares `dsh.bundle`
# (see package.json / cordis.patch.yml), so the CLI's reconcile step
# automatically appends it to `dsh.profile.bundles`; nothing is copied into
# node_modules by hand and no user-layer patch is written.
#
# Usage:
#   One-command (from GitHub):
#     irm https://raw.githubusercontent.com/justarook1e/dsh-file-edit/main/install.ps1 | iex
#   Local clone:
#     .\install.ps1
#   Uninstall:
#     .\install.ps1 -Uninstall
#
# After install: restart DSH (loads the new bundle layer), then hard-refresh
# the web page (Ctrl+F5) so the browser picks up the client bundle.

param(
  [switch]$Uninstall,
  [string]$ProfileName = 'web',
  [string]$Dsh = ''
)

$ErrorActionPreference = 'Stop'

function Resolve-DshInvocation {
  param([string]$Dsh)
  if (-not [string]::IsNullOrEmpty($Dsh)) { return @{ Exe = $Dsh; Script = $null } }
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  # Only a real executable/sh script is usable; an alias or function has no
  # Source, so fall through to the known installation paths.
  if ($cmd -and $cmd.Source) { return @{ Exe = $cmd.Source; Script = $null } }
  $fallback = Join-Path $env:USERPROFILE 'deepseek-harness\apps\cli\lib\bin.js'
  if (Test-Path -LiteralPath $fallback) { return @{ Exe = 'node'; Script = $fallback } }
  throw "dsh CLI not found on PATH; install dsh or pass -Dsh '<path-to-dsh-cli>'"
}

function Invoke-Dsh {
  param($Inv, [string[]]$Rest)
  # Child stdout flows straight to the console; the native exit code is
  # picked up by the caller via $LASTEXITCODE (never capture it here, or the
  # child's output lines would land in the assignment).
  if ($Inv.Script) { & $Inv.Exe $Inv.Script @Rest } else { & $Inv.Exe @Rest }
}

$dshInv = Resolve-DshInvocation -Dsh $Dsh

if ($Uninstall) {
  "removing dsh-file-edit from profile '$ProfileName' ..."
  Invoke-Dsh $dshInv @('plugin', '--profile', $ProfileName, 'remove', 'dsh-file-edit')
  if ($LASTEXITCODE -ne 0) { throw "dsh plugin remove failed with exit code $LASTEXITCODE" }
  ""
  "Uninstall done. Restart DSH to apply."
  return
}

# Package source: prefer this script's own directory (a clone / checkout);
# when streamed via `irm | iex` there is no script file, so install straight
# from the GitHub repository.
$spec = 'github:justarook1e/dsh-file-edit'
if ($PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'package.json'))) {
  $spec = "file:$PSScriptRoot"
  "installing from local checkout: $PSScriptRoot"
} else {
  "installing from GitHub: $spec"
}

Invoke-Dsh $dshInv @('plugin', '--profile', $ProfileName, 'add', $spec)
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed with exit code $LASTEXITCODE" }

""
"dsh-file-edit installed into profile '$ProfileName' (managed bundle)."
"Next steps:"
"  1. restart DSH (loads the new bundle layer)"
"  2. hard-refresh the web page (Ctrl+F5) so the browser picks up the client bundle"
"  3. verify: sidebar workspace tree + the Files tab + modified-file bar appear,"
"     and the console shows '[dsh-file-edit] guard v1.20.0'"
