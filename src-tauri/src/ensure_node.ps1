# Run before an `npm install -g ...` on Windows. A brand-new PC has no Node.js, so npm does not
# exist and every npm-based agent install fails. This makes sure Node.js is there first:
#   1. winget (Node.js LTS), when winget is available and works;
#   2. otherwise the official portable Node.js LTS from nodejs.org, checked against the SHA-256
#      that nodejs.org publishes, unpacked to %LOCALAPPDATA%\Programs\nodejs (no admin rights,
#      no winget) and added to the user PATH.
# Older Windows PowerShell defaults to TLS 1.0, which current download sites refuse.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
$ProgressPreference = 'SilentlyContinue'

function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user, $env:Path) | Where-Object { $_ }) -join ';'
}

function Test-Npm { [bool](Get-Command npm -ErrorAction SilentlyContinue) }

if (-not (Test-Npm)) {
  Write-Output 'Node.js is not installed yet; it is needed for this agent. Installing Node.js LTS first...'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Output '> winget install OpenJS.NodeJS.LTS'
    try {
      winget install --id OpenJS.NodeJS.LTS -e --source winget --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-String | Write-Output
    } catch { Write-Output "winget did not finish: $_" }
    Update-SessionPath
  }
  if (-not (Test-Npm)) {
    Write-Output 'Installing the portable Node.js LTS from nodejs.org instead (no admin rights needed)...'
    $index = Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json'
    $version = ($index | Where-Object { $_.lts } | Select-Object -First 1).version
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $name = "node-$version-win-$arch"
    $zip = Join-Path $env:TEMP "$name.zip"
    Write-Output "> download $name.zip"
    Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$version/$name.zip" -OutFile $zip
    $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$version/SHASUMS256.txt").Content
    $line = ($sums -split "`n") | Where-Object { $_ -match ([regex]::Escape("$name.zip") + '\s*$') } | Select-Object -First 1
    $want = ($line -split '\s+')[0].ToLower()
    $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if (-not $want -or $got -ne $want) { Remove-Item $zip -Force; throw 'The Node.js download did not match its published checksum, so it was not installed.' }
    $programs = Join-Path $env:LOCALAPPDATA 'Programs'
    $dest = Join-Path $programs 'nodejs'
    New-Item -ItemType Directory -Force $programs | Out-Null
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $programs -Force
    Rename-Item (Join-Path $programs $name) 'nodejs'
    Remove-Item $zip -Force
    $prefix = Join-Path $env:APPDATA 'npm'
    New-Item -ItemType Directory -Force $prefix | Out-Null
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ })
    foreach ($dir in @($dest, $prefix)) { if ($parts -notcontains $dir) { $parts += $dir } }
    [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
    $env:Path = "$dest;$prefix;$env:Path"
    & (Join-Path $dest 'npm.cmd') config set prefix $prefix | Out-Null
  }
  if (-not (Test-Npm)) { throw 'Node.js could not be installed automatically. Install it from https://nodejs.org (LTS), then try again.' }
  Write-Output ("Node.js " + (node --version) + " is ready.")
}
