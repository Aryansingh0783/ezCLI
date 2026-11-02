# One-line ezCLI install for Windows. In PowerShell:
#
#   irm https://raw.githubusercontent.com/Aryansingh0783/ezCLI/main/install.ps1 | iex
#
# Finds the newest ezCLI release on GitHub, downloads its Windows installer (.msi), checks it
# against the SHA-256 published with the release, and runs it. Nothing else is downloaded.
# Agents (Claude Code, Codex, ...) are installed afterwards from inside ezCLI, which also sets
# up Node.js for them if this PC doesn't have it.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Older Windows PowerShell leaves TLS 1.2 off, and GitHub refuses anything older.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$repo = 'Aryansingh0783/ezCLI'
Write-Host 'Looking up the latest ezCLI release...'
# A release page appears when its build starts, minutes before the installers are attached, so look through
# the newest few for the first one that already has its Windows installer and checksum.
$releases = @(Invoke-RestMethod -UseBasicParsing -Headers @{ 'User-Agent' = 'ezcli-installer' } "https://api.github.com/repos/$repo/releases?per_page=8")
$release = $null; $msi = $null; $sum = $null
foreach ($r in $releases) {
  $m = $r.assets | Where-Object { $_.name -like '*_x64_en-US.msi' } | Select-Object -First 1
  if (-not $m) { continue }
  $s = $r.assets | Where-Object { $_.name -eq "$($m.name).sha256" } | Select-Object -First 1
  if ($s) { $release = $r; $msi = $m; $sum = $s; break }
}
if (-not $release) { throw "No ezCLI release with a Windows installer was found yet. Try again in a few minutes, or download one from https://github.com/$repo/releases" }
if ($releases[0].tag_name -ne $release.tag_name) { Write-Host "$($releases[0].tag_name) is still being built (its Windows installer is not published yet), so installing $($release.tag_name) instead." }

$dir = Join-Path $env:TEMP 'ezcli-install'
New-Item -ItemType Directory -Force $dir | Out-Null
$file = Join-Path $dir $msi.name
Write-Host "Downloading $($msi.name) ($([math]::Round($msi.size / 1MB, 1)) MB)..."
Invoke-WebRequest -UseBasicParsing $msi.browser_download_url -OutFile $file

# GitHub serves .sha256 files as binary, which Windows PowerShell returns as bytes; read it as a file.
$sumFile = "$file.sha256"
Invoke-WebRequest -UseBasicParsing $sum.browser_download_url -OutFile $sumFile
$want = ((Get-Content $sumFile -Raw).Trim() -split '\s+')[0].ToLower()
Remove-Item $sumFile -Force
$got = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
if ($got -ne $want) {
  Remove-Item $file -Force
  throw 'The download did not match the checksum published with the release, so it was not installed.'
}
Write-Host 'Checksum verified. Installing (Windows may ask for permission)...'

$p = Start-Process msiexec.exe -ArgumentList @('/i', "`"$file`"", '/passive', '/norestart') -Wait -PassThru
Remove-Item $file -Force -ErrorAction SilentlyContinue
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "The installer exited with code $($p.ExitCode)." }

Write-Host "ezCLI $($release.tag_name) is installed. Open it from the Start menu."
Write-Host 'To add an agent, choose it in ezCLI and press Install; ezCLI installs Node.js for it if needed.'
