$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runDir = Join-Path $root ".run"

Get-Process node,python,ngrok -ErrorAction SilentlyContinue | Stop-Process -Force

if (Test-Path (Join-Path $runDir "backend.pid")) { Remove-Item (Join-Path $runDir "backend.pid") -Force }
if (Test-Path (Join-Path $runDir "frontend.pid")) { Remove-Item (Join-Path $runDir "frontend.pid") -Force }
if (Test-Path (Join-Path $runDir "ngrok.pid")) { Remove-Item (Join-Path $runDir "ngrok.pid") -Force }

Write-Host "Stopped node/python/ngrok processes."
