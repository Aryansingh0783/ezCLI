# Run the Rust unit tests on this Windows GNU-toolchain setup.
#
# Plain `cargo test` fails here for two reasons that have nothing to do with
# our code:
#   1. Tauri links comctl32 v6 (TaskDialogIndirect). Real app builds embed an
#      application manifest that selects it; cargo test binaries don't, so the
#      exe dies at startup with 0xC0000139 (entry point not found). A
#      side-by-side .manifest file fixes that without touching the build.
#   2. On the GNU target, WebView2Loader.dll is loaded dynamically and cargo
#      leaves it in target\debug, not next to the test exe in target\debug\deps,
#      so the exe dies with 0xC0000135 (DLL not found).
# The mingw-w64 toolchain (with as.exe/dlltool.exe) must be on PATH to link.
#
# Usage:  powershell -File scripts\test-rust.ps1

# Not 'Stop': Windows PowerShell 5.1 would turn cargo's ordinary stderr output
# ("Compiling…", "Finished…") into a terminating error. Failures are checked
# explicitly below instead.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$mingw = Join-Path $env:LOCALAPPDATA 'mingw-builds\mingw64\bin'
if (-not (Test-Path (Join-Path $mingw 'as.exe'))) {
    throw "mingw-w64 not found at $mingw. See HANDOFF.md section 2."
}
$env:PATH = "$mingw;$env:PATH"

Push-Location (Join-Path $repo 'src-tauri')
try {
    $json = cmd /c "cargo test --lib --no-run --message-format=json 2>nul"
    $exe = $json |
        ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } |
        Where-Object { $_ -and $_.reason -eq 'compiler-artifact' -and $_.profile.test -and $_.executable } |
        Select-Object -Last 1 -ExpandProperty executable
    if (-not $exe) { throw 'cargo did not produce a test executable; run `cargo test --lib --no-run` to see the error.' }

    $deps = Split-Path -Parent $exe
    $loader = Join-Path (Split-Path -Parent $deps) 'WebView2Loader.dll'
    if (Test-Path $loader) { Copy-Item $loader $deps -Force }

    @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency><dependentAssembly>
    <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
  </dependentAssembly></dependency>
</assembly>
'@ | Set-Content -LiteralPath "$exe.manifest" -Encoding UTF8

    & $exe @args
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
