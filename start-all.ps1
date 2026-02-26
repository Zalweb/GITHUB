param(
  [switch]$WithNgrok
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $root "Backend"
$frontendDir = Join-Path $root "Frontend"
$runDir = Join-Path $root ".run"

New-Item -ItemType Directory -Force -Path $runDir | Out-Null

Get-Process node,python,ngrok -ErrorAction SilentlyContinue | Stop-Process -Force

$backendPython = Join-Path $backendDir ".venv\Scripts\python.exe"
if (-not (Test-Path $backendPython)) {
  throw "Backend venv python not found: $backendPython"
}

$backend = Start-Process -FilePath $backendPython `
  -ArgumentList "-m","uvicorn","main:app","--host","0.0.0.0","--port","8000" `
  -WorkingDirectory $backendDir `
  -RedirectStandardOutput (Join-Path $runDir "backend.out.log") `
  -RedirectStandardError (Join-Path $runDir "backend.err.log") `
  -PassThru

$frontend = Start-Process -FilePath "npm.cmd" `
  -ArgumentList "run","dev","--","--host","0.0.0.0","--port","5173","--strictPort" `
  -WorkingDirectory $frontendDir `
  -RedirectStandardOutput (Join-Path $runDir "frontend.out.log") `
  -RedirectStandardError (Join-Path $runDir "frontend.err.log") `
  -PassThru

"$($backend.Id)" | Set-Content (Join-Path $runDir "backend.pid")
"$($frontend.Id)" | Set-Content (Join-Path $runDir "frontend.pid")

Start-Sleep -Seconds 3

$backendOk = $false
$frontendOk = $false

try {
  $backendOk = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8000/faces" -TimeoutSec 5).StatusCode -eq 200
} catch {}

try {
  $frontendOk = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:5173" -TimeoutSec 5).StatusCode -eq 200
} catch {}

Write-Host "Backend  : http://127.0.0.1:8000  (ok=$backendOk)"
Write-Host "Frontend : http://127.0.0.1:5173  (ok=$frontendOk)"
Write-Host "Logs     : $runDir"

if ($WithNgrok) {
  $ngrok = Start-Process -FilePath "ngrok" `
    -ArgumentList "http","5173","--log","stdout" `
    -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $runDir "ngrok.out.log") `
    -RedirectStandardError (Join-Path $runDir "ngrok.err.log") `
    -PassThru
  "$($ngrok.Id)" | Set-Content (Join-Path $runDir "ngrok.pid")
  Start-Sleep -Seconds 3

  try {
    $tunnels = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels"
    $publicUrl = ($tunnels.tunnels | Select-Object -First 1).public_url
    Write-Host "Ngrok    : $publicUrl"
  } catch {
    Write-Host "Ngrok    : started, but tunnel URL could not be read from 127.0.0.1:4040"
  }
}
