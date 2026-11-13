param(
    [ValidateSet('all', 'web', 'sim')]
    [string]$Service = 'all',
    [switch]$NoBuild,
    [string]$EnvDir
)

# One-click launcher for the 4lpha NEAR demo (no funds), next to start-near.ps1. No questions:
# it builds, then opens the demo web and the demo simulation, each in its own console, and opens the browser.
# The demo signs nothing, holds no wallet key, never calls OutLayer and reads only public FastNEAR.
# It uses its own database (data\demo.db) and its own port (8091), so a live stack on 8090 keeps running.
# .env.local is optional: when present it only supplies NEAR_AI_API_KEY (LP AI ranges) and the data plane
# settings (price chart); nothing here prints any of its values.

$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$port = 8091
$origin = "http://127.0.0.1:$port"
$entries = @{
    web = @{ Title = '4lpha NEAR - Demo web'; Script = 'dist\src\web\server.js' }
    sim = @{ Title = '4lpha NEAR - Demo simulation'; Script = 'dist\src\demo\main.js' }
}

function Find-EnvDir {
    if ($EnvDir) { return $EnvDir }
    foreach ($dir in @($repoPath, 'D:\4lpha-NEAR')) {
        if (Test-Path -LiteralPath (Join-Path $dir '.env.local')) { return $dir }
    }
    return $repoPath
}

try {
    $envPath = Find-EnvDir
    $node = (Get-Command node.exe -ErrorAction Stop).Source

    if ($Service -ne 'all') {
        # One service in this console. The launcher has set the database, port and demo flag.
        $entry = $entries[$Service]
        $Host.UI.RawUI.WindowTitle = $entry.Title
        Set-Location -LiteralPath $envPath
        Write-Host $entry.Title
        Write-Host ('Database: ' + $env:FOURLPHA_DB_PATH)
        Write-Host 'Demo: no wallet, no deposit, nothing is signed. Expect "RPC: public FastNEAR" below; any other RPC label is a stop.'
        if ($Service -eq 'sim') { Write-Host 'One "cycle" line a minute. "unreadable" above 0 on many ticks in a row means public FastNEAR is throttling.' }
        Write-Host 'Press Ctrl+C to stop.'
        & $node (Join-Path $repoPath $entry.Script)
        Write-Host "Stopped (exit code $LASTEXITCODE)."
        return
    }

    $version = & $node --version
    if ($version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'Install Node.js 22 or newer.' }
    if (-not (Test-Path -LiteralPath (Join-Path $repoPath 'node_modules'))) { throw 'Missing dependencies. Run npm ci --ignore-scripts in the repo folder first.' }

    Write-Host '4lpha NEAR demo (no funds)'
    Write-Host ('Code: ' + $repoPath)
    if (Test-Path -LiteralPath (Join-Path $envPath '.env.local')) { Write-Host ('Settings folder (.env.local): ' + $envPath) }
    else { Write-Host 'No .env.local: LP AI ranges are off and the price chart is hidden. The demo still runs.' -ForegroundColor Yellow }
    if (-not $NoBuild) {
        Write-Host 'Building (offline)...'
        Push-Location -LiteralPath $repoPath
        try { & npm.cmd run build --silent; if ($LASTEXITCODE -ne 0) { throw 'Build failed. See the output above.' } } finally { Pop-Location }
    }

    $dataDir = Join-Path $envPath 'data'
    if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
    $dbFile = Join-Path $dataDir 'demo.db'
    Write-Host ('Database: ' + $dbFile + $(if (Test-Path -LiteralPath $dbFile) { ' (existing)' } else { ' (new)' }))

    # Shared settings for both consoles. Everything that belongs to a live stack is cleared.
    $env:FOURLPHA_DB_PATH = $dbFile
    $env:FOURLPHA_WEB_PORT = "$port"
    $env:FOURLPHA_WEB_ORIGIN = $origin
    $env:FOURLPHA_DEMO = '1'
    foreach ($n in @('FOURLPHA_LIVE_HIRES', 'FOURLPHA_WORKER_LIVE', 'FOURLPHA_WORKER_KEK', 'FOURLPHA_RPC_URLS', 'FOURLPHA_ARCHIVAL_RPC_URL',
        'FOURLPHA_GRID_V1', 'FOURLPHA_GRID_V2', 'FOURLPHA_LP_V1', 'FOURLPHA_TRADE_V1', 'FOURLPHA_MEME_PAPER')) {
        Remove-Item ("Env:" + $n) -ErrorAction SilentlyContinue
    }

    foreach ($s in @('web', 'sim')) {
        $arguments = '-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "{0}" -Service {1} -EnvDir "{2}"' -f $PSCommandPath, $s, $envPath
        Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList $arguments -WorkingDirectory $envPath -WindowStyle Normal | Out-Null
    }

    Write-Host ''
    Write-Host ('Opened Demo web and Demo simulation. App: ' + $origin)
    Write-Host 'Open a deploy page and press "Start demo agent" (Demo is selected without a wallet). The first market sample arrives within a minute;'
    Write-Host 'Schedule buy and Auto DCA buy once about 30 minutes of price history exist.'
    Write-Host 'To stop: Ctrl+C in both windows. Demo agents are kept in data\demo.db for the next start.'
    Start-Sleep -Seconds 3
    Start-Process ($origin + '/deploy/grid')
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    if ($Service -eq 'all') { exit 1 }
}
