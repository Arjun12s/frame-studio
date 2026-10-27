$ErrorActionPreference = "Stop"
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPython = Join-Path $project ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $venvPython)) {
    python -m venv (Join-Path $project ".venv")
}

& $venvPython -m pip install --disable-pip-version-check -r (Join-Path $project "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Could not install Frame Studio dependencies." }

$serverScript = Join-Path $project "server.py"
$serverLog = Join-Path $project "server.log"
$serverErrorLog = Join-Path $project "server-error.log"
$existingServer = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if (-not $existingServer) {
    $serverArgs = "-u `"$serverScript`""
    Start-Process -FilePath $venvPython -ArgumentList $serverArgs -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput $serverLog -RedirectStandardError $serverErrorLog
    $ready = $false
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $null = Invoke-WebRequest -Uri "http://127.0.0.1:8000/" -TimeoutSec 2
            $ready = $true
            break
        } catch { }
    }
    if (-not $ready) {
        $details = if (Test-Path -LiteralPath $serverErrorLog) { Get-Content -LiteralPath $serverErrorLog -Raw } else { "" }
        throw "Frame Studio did not start on port 8000. $details"
    }
}
Start-Process "http://127.0.0.1:8000"
