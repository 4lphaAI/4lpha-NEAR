param(
    [ValidateSet('all', 'watchdog', 'web', 'worker', 'meme', 'demo')]
    [string]$Service = 'all',
    [string]$Db = 'local',
    [switch]$NoBuild,
    [string]$EnvDir,
    [string]$FromId
)

# One-click local launcher for the 4lpha NEAR stack, like start-dev.cmd in the BSC repo. No questions:
# it builds, then opens watchdog, web (live hires on), worker, the Trade paper (meme) process and the demo simulation, each in its own console.
# The processes run from the folder that holds .env.local, so they use the QuickNode RPC; the meme process and the demo
# simulation always read public FastNEAR by design (paper and simulation only). Nothing here prints the RPC settings or the worker key.
# The web also serves the demo (Demo | Live on the deploy pages) from its own database, data\<Db>-demo.db, never the live one.
# The worker key is created once per database and kept next to it encrypted with Windows DPAPI (this Windows user only).

$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$port = 8090
$origin = "http://127.0.0.1:$port"
$entries = @{
    watchdog = @{ Title = '4lpha NEAR - Watchdog'; Script = 'dist\src\watchdog\main.js' }
    web = @{ Title = '4lpha NEAR - Web'; Script = 'dist\src\web\server.js' }
    worker = @{ Title = '4lpha NEAR - Worker'; Script = 'dist\src\worker\main.js' }
    meme = @{ Title = '4lpha NEAR - Meme paper'; Script = 'dist\src\meme\main.js' }
    demo = @{ Title = '4lpha NEAR - Demo simulation'; Script = 'dist\src\demo\main.js' }
}

function Find-EnvDir {
    if ($EnvDir) { return $EnvDir }
    foreach ($dir in @($repoPath, 'D:\4lpha-NEAR')) {
        if (Test-Path -LiteralPath (Join-Path $dir '.env.local')) { return $dir }
    }
    throw 'No .env.local found (it holds the QuickNode RPC). Pass -EnvDir with the folder that has it.'
}

function Get-WorkerKek([string]$keyFile, [bool]$newDatabase) {
    if (-not (Test-Path -LiteralPath $keyFile)) {
        if (-not $newDatabase) { throw "This database has no saved worker key ($keyFile). Start with another -Db name." }
        $bytes = New-Object byte[] 32
        $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $secure = ConvertTo-SecureString ([Convert]::ToBase64String($bytes)) -AsPlainText -Force
        Set-Content -LiteralPath $keyFile -Value (ConvertFrom-SecureString $secure) -Encoding ascii
    }
    $secure = ConvertTo-SecureString (Get-Content -LiteralPath $keyFile -Raw).Trim()
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

try {
    $envPath = Find-EnvDir
    $node = (Get-Command node.exe -ErrorAction Stop).Source

    if ($Service -ne 'all') {
        # One service in this console. The launcher has set the database, origin and switches.
        $entry = $entries[$Service]
        $Host.UI.RawUI.WindowTitle = $entry.Title
        Set-Location -LiteralPath $envPath
        if ($Service -eq 'web') { $env:FOURLPHA_LIVE_HIRES = '1' }
        if ($Service -eq 'worker') { $env:FOURLPHA_WORKER_LIVE = '1' }
        if ($Service -eq 'demo') {
            # The demo simulation runs on the demo database only, with the demo flag and none of the live switches or the worker key.
            if (-not $env:FOURLPHA_DEMO_DB_PATH) { throw 'No demo database was passed to this window. Start it from start-near.cmd.' }
            $env:FOURLPHA_DB_PATH = $env:FOURLPHA_DEMO_DB_PATH
            $env:FOURLPHA_DEMO = '1'
            foreach ($n in @('FOURLPHA_DEMO_DB_PATH', 'FOURLPHA_LIVE_HIRES', 'FOURLPHA_WORKER_LIVE', 'FOURLPHA_WORKER_KEK', 'FOURLPHA_RPC_URLS', 'FOURLPHA_ARCHIVAL_RPC_URL',
                'FOURLPHA_GRID_V1', 'FOURLPHA_GRID_V2', 'FOURLPHA_LP_V1', 'FOURLPHA_TRADE_V1', 'FOURLPHA_MEME_PAPER')) {
                Remove-Item ("Env:" + $n) -ErrorAction SilentlyContinue
            }
        }
        Write-Host $entry.Title
        Write-Host ('Database: ' + $env:FOURLPHA_DB_PATH)
        if ($Service -eq 'worker') { Write-Host 'LIVE worker: it acts on funded jobs within the signed policies.' -ForegroundColor Yellow }
        if ($Service -eq 'meme') { Write-Host 'Trade paper: no money, nothing is signed. Expect "RPC: public FastNEAR" below (by design).' }
        elseif ($Service -eq 'demo') { Write-Host 'Demo simulation: it simulates only. No wallet, no deposit, nothing is signed. Expect "RPC: public FastNEAR" below; any other RPC label is a stop.' }
        else { Write-Host 'Expect "RPC: QuickNode" below. Reads fall back to FastNEAR, then dRPC, if needed.' }
        Write-Host 'Press Ctrl+C to stop. Keep this window open while a job runs.'
        $nodeArgs = @()
        if ($Service -eq 'meme' -and $FromId) { $nodeArgs = @('--from-id', $FromId) }
        # A worker started right after the previous one was closed finds its lock still fresh (the lock expires
        # 60 seconds after the last heartbeat) and exits at once. Only such quick exits are retried, for about 2 minutes.
        for ($try = 1; $try -le 8; $try++) {
            $started = Get-Date
            & $node (Join-Path $repoPath $entry.Script) @nodeArgs
            if ($Service -ne 'worker' -or $LASTEXITCODE -eq 0 -or ((Get-Date) - $started).TotalSeconds -gt 20 -or $try -eq 8) { break }
            Write-Host "The worker stopped right after start (often the previous run's lock, which expires 60 seconds after it stopped). Retry $try of 7 in 15 seconds..." -ForegroundColor Yellow
            Start-Sleep -Seconds 15
        }
        Remove-Item Env:FOURLPHA_WORKER_KEK -ErrorAction SilentlyContinue
        Write-Host "Stopped (exit code $LASTEXITCODE)."
        return
    }

    $version = & $node --version
    if ($version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'Install Node.js 22 or newer.' }
    if (-not (Test-Path -LiteralPath (Join-Path $repoPath 'node_modules'))) { throw 'Missing dependencies. Run npm ci --ignore-scripts in the repo folder first.' }
    if ($Db -notmatch '^[A-Za-z0-9._-]{1,40}$') { throw 'Use letters, digits, dot, dash or underscore for -Db.' }
    if ($Db -match '-demo$') { throw 'A -Db name cannot end in -demo: data\<Db>-demo.db is the demo database of another -Db.' }

    Write-Host '4lpha NEAR local stack'
    Write-Host ('Code: ' + $repoPath)
    Write-Host ('Settings folder (.env.local): ' + $envPath)
    if (-not $NoBuild) {
        Write-Host 'Building (offline)...'
        Push-Location -LiteralPath $repoPath
        try { & npm.cmd run build --silent; if ($LASTEXITCODE -ne 0) { throw 'Build failed. See the output above.' } } finally { Pop-Location }
    }

    $dataDir = Join-Path $envPath 'data'
    if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
    $dbFile = Join-Path $dataDir "$Db.db"
    $newDatabase = -not (Test-Path -LiteralPath $dbFile)
    Write-Host ('Database: ' + $dbFile + $(if ($newDatabase) { ' (new)' } else { ' (existing)' }))
    $kek = Get-WorkerKek (Join-Path $dataDir "$Db.kek.dpapi") $newDatabase
    $demoDbFile = Join-Path $dataDir "${Db}-demo.db"
    Write-Host ('Demo database: ' + $demoDbFile)

    # The Trade paper start id is read on every start, not only for a new database: the scan only moves past an
    # auction it can read, and finished auctions read as empty, so a floor left far behind never catches up.
    # The meme process keeps the higher of this id and its saved floor, so passing it never lowers the floor.
    Write-Host 'Reading the open meme.cooking auctions for the Trade paper start id...'
    $startId = (& $node (Join-Path $repoPath 'scripts\meme-start-id.mjs') | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or "$startId" -notmatch '^\d+$') {
        $startId = ''
        Write-Host 'meme.cooking API unavailable: Trade paper keeps its saved start point (a new database starts from 0 and may not find open auctions).' -ForegroundColor Yellow
    } else { Write-Host ('Trade paper start id: ' + $startId) }

    # Shared settings for every console started below. Custom RPC overrides are cleared so .env.local decides.
    $env:FOURLPHA_DB_PATH = $dbFile
    $env:FOURLPHA_WEB_PORT = "$port"
    $env:FOURLPHA_WEB_ORIGIN = $origin
    $env:FOURLPHA_GRID_V1 = '1'
    $env:FOURLPHA_GRID_V2 = '1'
    $env:FOURLPHA_LP_V1 = '1'
    $env:FOURLPHA_TRADE_V1 = '1'
    $env:FOURLPHA_MEME_PAPER = '1'
    foreach ($n in @('FOURLPHA_RPC_URLS', 'FOURLPHA_ARCHIVAL_RPC_URL', 'FOURLPHA_LIVE_HIRES', 'FOURLPHA_WORKER_LIVE', 'FOURLPHA_WORKER_KEK', 'FOURLPHA_DEMO', 'FOURLPHA_DEMO_DB_PATH')) {
        Remove-Item ("Env:" + $n) -ErrorAction SilentlyContinue
    }

    foreach ($s in @('watchdog', 'web', 'worker', 'meme', 'demo')) {
        $arguments = '-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "{0}" -Service {1} -EnvDir "{2}"' -f $PSCommandPath, $s, $envPath
        if ($s -eq 'meme' -and $startId) { $arguments += ' -FromId ' + $startId }
        if ($s -eq 'worker') { $env:FOURLPHA_WORKER_KEK = $kek }
        # Only the web (the demo routes) and the demo simulation get the demo database path.
        if ($s -eq 'web' -or $s -eq 'demo') { $env:FOURLPHA_DEMO_DB_PATH = $demoDbFile }
        try { Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList $arguments -WorkingDirectory $envPath -WindowStyle Normal | Out-Null }
        finally { Remove-Item Env:FOURLPHA_WORKER_KEK -ErrorAction SilentlyContinue; Remove-Item Env:FOURLPHA_DEMO_DB_PATH -ErrorAction SilentlyContinue }
    }
    $kek = $null

    Write-Host ''
    Write-Host ('Opened Watchdog, Web, Worker, Meme paper and Demo simulation. App: ' + $origin)
    Write-Host 'LIVE: real-money hires are on. Nothing moves until you hire and send NEAR from your own wallet.' -ForegroundColor Yellow
    Write-Host 'Check "RPC: QuickNode" in the Web, Watchdog and Worker windows (Meme paper and Demo simulation use public FastNEAR by design).'
    Write-Host 'Demo: pick Demo on a deploy page. It simulates only, on the demo database; no wallet, nothing is signed.'
    Write-Host 'To stop: Ctrl+C in each window. Freeze or Stop and withdraw a running job first.'
    Start-Sleep -Seconds 3
    Start-Process $origin
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    if ($Service -eq 'all') { exit 1 }
}
