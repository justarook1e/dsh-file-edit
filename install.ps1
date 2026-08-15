# dsh-file-edit installer (PowerShell 5.1+)
#
# Copies the package into the active DSH web profile and registers it in
# cordis.patch.yml. Idempotent — safe to run repeatedly (it overwrites the
# installed copy and skips the patch registration when already present).
#
# Usage:
#   .\install.ps1            install / update to this version
#   .\install.ps1 -Uninstall remove the plugin and its patch entry
#
# After install: restart DSH (host plugin + mount entry), then hard-refresh
# the web page (Ctrl+F5) so the browser picks up the client bundle.

param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

$homeDsh = $env:DSH_HOME
if ([string]::IsNullOrEmpty($homeDsh)) { $homeDsh = Join-Path $HOME '.dsh' }
$profileDir = Join-Path $homeDsh 'profiles\web'
$pkgDir = Join-Path $profileDir 'node_modules\dsh-file-edit'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'

# Where the package files come from:
#  * run from a cloned repo / downloaded install.ps1 file -> $PSScriptRoot
#  * run via `irm <url> | iex` (no script file on disk) -> download the
#    package files from the GitHub repo first (self-bootstrap)
if ([string]::IsNullOrEmpty($PSScriptRoot)) {
  $srcDir = Join-Path $env:TEMP 'dsh-file-edit-download'
  New-Item -ItemType Directory -Force -Path $srcDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $srcDir 'host'), (Join-Path $srcDir 'client\dist') | Out-Null
  $base = 'https://raw.githubusercontent.com/justarook1e/dsh-file-edit/main'
  Invoke-WebRequest -UseBasicParsing -Uri "$base/package.json" -OutFile (Join-Path $srcDir 'package.json') | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri "$base/host/index.mjs" -OutFile (Join-Path $srcDir 'host\index.mjs') | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri "$base/client/dist/client.js" -OutFile (Join-Path $srcDir 'client\dist\client.js') | Out-Null
  "downloaded package files from $base"
} else {
  $srcDir = $PSScriptRoot
}

$block = @"
# dsh-file-edit: workspace file browser with agent-change review (host + client web plugin).
# Package source lives at node_modules/dsh-file-edit/ inside this profile root.
- insert:
    - id: dsh-file-edit
      name: dsh-file-edit
"@

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-TextUtf8NoBom {
  param([string]$Path, [string]$Text)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

if (-not (Test-Path -LiteralPath $profileDir)) {
  throw "DSH profile dir not found: $profileDir`nSet DSH_HOME to your dsh home, or start DSH once to create it."
}

if ($Uninstall) {
  if (Test-Path -LiteralPath $pkgDir) {
    Remove-Item -LiteralPath $pkgDir -Recurse -Force
    "removed package: $pkgDir"
  } else {
    "package not installed — nothing to remove"
  }
  if (Test-Path -LiteralPath $patchFile) {
    $text = [System.IO.File]::ReadAllText($patchFile)
    if ($text -match 'id:\s*dsh-file-edit') {
      $new = $text -replace '(?ms)^# dsh-file-edit:.*?^      name: dsh-file-edit[ \t]*\r?\n', ''
      Write-TextUtf8NoBom -Path $patchFile -Text $new
      "removed the dsh-file-edit insert block from cordis.patch.yml"
    }
  }
  ""
  "Uninstall done. Restart DSH to apply."
  exit 0
}

foreach ($rel in @('package.json', 'host', 'client')) {
  if (-not (Test-Path -LiteralPath (Join-Path $srcDir $rel))) {
    throw "missing in source dir: $rel — run this script from the repository root"
  }
}

# 1. copy the package into the profile's node_modules
New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null
Copy-Item -LiteralPath (Join-Path $srcDir 'package.json') -Destination (Join-Path $pkgDir 'package.json') -Force
Copy-Item -LiteralPath (Join-Path $srcDir 'host') -Destination $pkgDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $srcDir 'client') -Destination $pkgDir -Recurse -Force
"copied package -> $pkgDir"

# 2. register the plugin in cordis.patch.yml (idempotent)
if (Test-Path -LiteralPath $patchFile) {
  $text = [System.IO.File]::ReadAllText($patchFile)
  if ($text -match 'id:\s*dsh-file-edit') {
    "already registered in cordis.patch.yml — skipped"
  } else {
    if (-not $text.EndsWith("`n")) { $text += "`n" }
    Write-TextUtf8NoBom -Path $patchFile -Text ($text + "`n" + $block)
    "registered in cordis.patch.yml"
  }
} else {
  Write-TextUtf8NoBom -Path $patchFile -Text $block
  "created cordis.patch.yml with the dsh-file-edit entry"
}

# 3. sanity check
$ok = (Test-Path -LiteralPath (Join-Path $pkgDir 'package.json')) -and
      (Test-Path -LiteralPath (Join-Path $pkgDir 'host\index.mjs')) -and
      (Test-Path -LiteralPath (Join-Path $pkgDir 'client\dist\client.js'))
if (-not $ok) { throw 'install verification failed: some package files are missing' }

""
"dsh-file-edit installed."
"Next steps:"
"  1. restart DSH (loads the host plugin and the new mount entry)"
"  2. hard-refresh the web page (Ctrl+F5) so the browser picks up the client bundle"
"  3. verify: sidebar workspace tree + the '文件' tab + modified-file bar appear,"
"     and the console shows '[dsh-file-edit] guard v1.10.0'"
