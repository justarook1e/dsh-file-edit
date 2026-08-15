# dsh-file-edit installer (PowerShell 5.1+)
#
# Copies the package into the active DSH web profile and registers it in
# cordis.patch.yml. Idempotent - safe to run repeatedly (it overwrites the
# installed copy and skips the patch registration when already present).
#
# Usage:
#   irm https://raw.githubusercontent.com/justarook1e/dsh-file-edit/main/install.ps1 | iex
#   .\install.ps1            (from a cloned repo / downloaded copy with the package files)
#   .\install.ps1 -Uninstall (remove the plugin and its patch entry)
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

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-TextUtf8NoBom {
  param([string]$Path, [string]$Text)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

$block = @"
# dsh-file-edit: workspace file browser with agent-change review (host + client web plugin).
# Package source lives at node_modules/dsh-file-edit/ inside this profile root.
- insert:
    - id: dsh-file-edit
      name: dsh-file-edit
"@

if (-not (Test-Path -LiteralPath $profileDir)) {
  throw "DSH profile dir not found: $profileDir`nSet DSH_HOME to your dsh home, or start DSH once to create it."
}

# ---------- uninstall ----------
# Needs nothing from the repo: handled BEFORE any download so removing the
# plugin never touches the network.
if ($Uninstall) {
  if (Test-Path -LiteralPath $pkgDir) {
    Remove-Item -LiteralPath $pkgDir -Recurse -Force
    "removed package: $pkgDir"
  } else {
    "package not installed - nothing to remove"
  }
  if (Test-Path -LiteralPath $patchFile) {
    $text = [System.IO.File]::ReadAllText($patchFile)
    if ($text -match 'id:\s*dsh-file-edit') {
      # Line-based removal (tolerant to indentation drift): drop the marker
      # comment block, its `- insert:` line and the id/name entry lines. Also
      # covers a hand-placed `- insert:` entry without the marker comment.
      $lines = $text -split "`r?`n"
      $out = New-Object System.Collections.Generic.List[string]
      $i = 0
      while ($i -lt $lines.Count) {
        $line = $lines[$i]
        if ($line -match '^#\s*dsh-file-edit:') {
          $i++
          while ($i -lt $lines.Count -and $lines[$i] -match '^\s*#') { $i++ }
          if ($i -lt $lines.Count -and $lines[$i] -match '^-\s*insert:') { $i++ }
          # Entry lines: `- id: dsh-file-edit` carries the dash; `name: ...`
          # is its mapping continuation and has none — both must go.
          while ($i -lt $lines.Count -and $lines[$i] -match '^\s*-?\s*(id|name):\s*dsh-file-edit\s*$') { $i++ }
          continue
        }
        if ($line -match '^-\s*insert:') {
          $j = $i + 1
          $isOurs = $false
          while ($j -lt $lines.Count -and $lines[$j] -match '^\s*-?\s*(id|name):\s*\S') {
            if ($lines[$j] -match ':\s*dsh-file-edit\s*$') { $isOurs = $true }
            $j++
          }
          if ($isOurs) { $i = $j; continue }
        }
        $out.Add($line)
        $i++
      }
      $new = [string]::Join("`r`n", $out)
      # If no list content remains (other entries, or the `[]` skeleton),
      # restore the empty-list skeleton so the patch file stays valid YAML
      # (a comments-only file parses to null).
      $hasList = [regex]::IsMatch($new, '(?m)^\s*-\s') -or [regex]::IsMatch($new, '(?m)^\s*\[\]\s*$')
      if (-not $hasList) {
        $new = $new.TrimEnd("`r", "`n", " ") + "`n`n[]`n"
      }
      Write-TextUtf8NoBom -Path $patchFile -Text $new
      "removed the dsh-file-edit insert block from cordis.patch.yml"
    } else {
      "not registered in cordis.patch.yml - nothing to remove"
    }
  }
  ""
  "Uninstall done. Restart DSH to apply."
  return
}

# ---------- resolve the package source ----------
# Prefer the script's own directory (cloned repo / downloaded copy). Fall back
# to downloading the package files from GitHub when there is no script file
# (`irm | iex`) OR when the directory next to the script has no package.json
# (a standalone saved install.ps1).
$srcDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($srcDir) -or -not (Test-Path -LiteralPath (Join-Path $srcDir 'package.json'))) {
  $srcDir = Join-Path $env:TEMP 'dsh-file-edit-download'
  New-Item -ItemType Directory -Force -Path $srcDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $srcDir 'host'), (Join-Path $srcDir 'client\dist') | Out-Null
  $base = 'https://raw.githubusercontent.com/justarook1e/dsh-file-edit/main'
  Invoke-WebRequest -UseBasicParsing -Uri "$base/package.json" -OutFile (Join-Path $srcDir 'package.json') | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri "$base/host/index.mjs" -OutFile (Join-Path $srcDir 'host\index.mjs') | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri "$base/client/dist/client.js" -OutFile (Join-Path $srcDir 'client\dist\client.js') | Out-Null
  "downloaded package files from $base"
}

foreach ($rel in @('package.json', 'host', 'client')) {
  if (-not (Test-Path -LiteralPath (Join-Path $srcDir $rel))) {
    throw "missing in source dir: $rel - run this script from the repository root"
  }
}

# ---------- install ----------
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
    "already registered in cordis.patch.yml - skipped"
  } else {
    # A lone `[]` (the empty-list skeleton) would start a NEW YAML document
    # when our entry is appended after it and DSH would fail to parse the
    # overlay ("end of the stream or a document separator is expected").
    # Strip standalone `[]` lines so the entry merges into the same array.
    $text = [regex]::Replace($text, '(?m)^\[\]\s*\r?\n', '')
    $text = $text.TrimEnd("`r", "`n", " ")
    if ($text.Length -gt 0) { $text += "`n`n" }
    Write-TextUtf8NoBom -Path $patchFile -Text ($text + $block)
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
"  3. verify: sidebar workspace tree + the Files tab + modified-file bar appear,"
"     and the console shows '[dsh-file-edit] guard v1.10.0'"
