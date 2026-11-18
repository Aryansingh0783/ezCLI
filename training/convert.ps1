# Turn the trained adapter into a GGUF that llama.cpp loads on top of the Qwen3-8B GGUF with --lora.
# Run from D:\ezcli-finetune\ezCLI\training with the venv active:  .\convert.ps1
$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot\..\.."
python "$root\llama.cpp-src\convert_lora_to_gguf.py" "$PSScriptRoot\out\adapter" --base "$root\Qwen3-8B" --outfile "$PSScriptRoot\out\qwen3-8b-ezcli-tools-lora.gguf" --outtype f16
Get-Item "$PSScriptRoot\out\qwen3-8b-ezcli-tools-lora.gguf" | Select-Object FullName, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB) } }
