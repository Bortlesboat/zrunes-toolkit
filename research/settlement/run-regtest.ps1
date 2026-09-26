#Requires -Version 7.4
# Requires native Rust and an existing Ubuntu WSL distribution.
# Downloads the pinned official Linux node, starts a fresh isolated regtest,
# runs the selected disposable experiment, and stops only the node it starts.
[CmdletBinding()]
param(
    [string] $Distribution = 'Ubuntu-24.04',
    [ValidateRange(20000, 60000)][int] $RpcPort = (Get-Random -Minimum 20000 -Maximum 59998),
    [string] $ArchivePath,
    [string] $ReplayCli
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskRoot = $PSScriptRoot
$nodeVersion = '6.4.0'
$archiveHash = 'e395623bd7dcb56024c14eecd622f6d747f4df2bb08363db1448406d7bd1811d'
$assetName = "zebrad-$nodeVersion-x86_64-unknown-linux-gnu.tar.gz"
$releaseUrl = "https://github.com/ZcashFoundation/zebra/releases/download/v$nodeVersion/$assetName"
$nodeDir = Join-Path $taskRoot ".local/zebra-$nodeVersion"
$runId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$runDir = Join-Path $taskRoot ".local/$runId"
$evidenceDir = Join-Path $taskRoot "evidence/$runId"
$nodeProcess = $null
if ($ReplayCli) { $ReplayCli = (Resolve-Path -LiteralPath $ReplayCli).Path }

function Invoke-WslChecked([string[]] $WslCommand) {
    $result = & wsl.exe -d $Distribution -- @WslCommand
    if ($LASTEXITCODE -ne 0) { throw "WSL command failed: $($WslCommand[0])" }
    return $result
}
function To-LinuxPath([string] $TaskPath) {
    return (Invoke-WslChecked @('wslpath', '-a', $TaskPath.Replace('\', '/'))).Trim()
}
function Quote-Sh([string] $Value) {
    $replacement = "'" + '"' + "'" + '"' + "'"
    return "'" + $Value.Replace("'", $replacement) + "'"
}

Push-Location $taskRoot
try {
    & cargo build --locked
    if ($LASTEXITCODE -ne 0) { throw 'Rust build failed' }
    New-Item -ItemType Directory -Force -Path $nodeDir, $runDir | Out-Null
    $archive = Join-Path $nodeDir $assetName
    if ($ArchivePath -and -not (Test-Path -LiteralPath $archive)) {
        if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveHash) {
            throw 'Supplied archive checksum mismatch'
        }
        Copy-Item -LiteralPath $ArchivePath -Destination $archive
    }
    if (-not (Test-Path -LiteralPath $archive)) {
        $download = "$archive.$runId.download"
        try {
            Invoke-WebRequest -Uri $releaseUrl -OutFile $download -ConnectionTimeoutSeconds 120 -OperationTimeoutSeconds 120
            if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveHash) {
                throw 'Downloaded Zebra release archive checksum mismatch'
            }
            Move-Item -LiteralPath $download -Destination $archive
        } finally {
            if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download }
        }
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveHash) {
        throw 'Pinned Zebra release archive checksum mismatch'
    }
    $linuxNodeDir = To-LinuxPath $nodeDir
    $linuxRunDir = To-LinuxPath $runDir
    Invoke-WslChecked @('tar', '-xzf', (To-LinuxPath $archive), '-C', $linuxNodeDir) | Out-Null
    $linuxNode = "$linuxNodeDir/zebrad"
    $linuxConfig = "$linuxRunDir/zebrad.toml"
    $nodeReported = Invoke-WslChecked @($linuxNode, '--version')
    if ($nodeReported.Trim() -ne "zebrad $nodeVersion") { throw 'Unexpected node version' }
    @"
[network]
network = "Regtest"
listen_addr = "127.0.0.1:$($RpcPort + 1)"
initial_mainnet_peers = []
initial_testnet_peers = []
cache_dir = false

[network.testnet_parameters.activation_heights]
"NU6.3" = 1

[state]
ephemeral = true
cache_dir = "$linuxRunDir/state"
delete_old_database = false

[rpc]
listen_addr = "127.0.0.1:$RpcPort"
enable_cookie_auth = false
cookie_dir = "$linuxRunDir/cookie"

[mining]
miner_address = "t27eWDgjFYJGVXmzrXeVjnb5J3uXDM9xH9v"
"@ | Set-Content -LiteralPath (Join-Path $runDir 'zebrad.toml') -Encoding utf8NoBOM
    $launch = "#!/bin/sh`nset -eu`necho `$`$ > $(Quote-Sh "$linuxRunDir/node.pid")`nexec $(Quote-Sh $linuxNode) -c $(Quote-Sh $linuxConfig) start`n"
    [IO.File]::WriteAllText((Join-Path $runDir 'start-node.sh'), $launch, [Text.UTF8Encoding]::new($false))
    $nodeProcess = Start-Process -FilePath wsl.exe -WindowStyle Hidden -PassThru `
        -ArgumentList @('-d', $Distribution, '--', 'sh', "`"$linuxRunDir/start-node.sh`"") `
        -RedirectStandardOutput (Join-Path $runDir 'node.out.log') `
        -RedirectStandardError (Join-Path $runDir 'node.err.log')
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($nodeProcess.HasExited) { throw "Node exited; inspect $runDir/node.err.log" }
        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$RpcPort" -Method Post -ContentType 'application/json' `
                -Body '{"jsonrpc":"2.0","id":1,"method":"getblockchaininfo","params":[]}' -TimeoutSec 2
            $boundByOwnedNode = Select-String -LiteralPath (Join-Path $runDir 'node.out.log') `
                -SimpleMatch "Opened RPC endpoint at 127.0.0.1:$RpcPort" -Quiet
            if ($response.result.blocks -eq 0 -and $boundByOwnedNode) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw 'Fresh regtest did not become ready' }
    & (Join-Path $taskRoot 'target/debug/zrunes-settlement.exe') demo $RpcPort $evidenceDir 2>&1 | Tee-Object -FilePath (Join-Path $runDir 'flow.log')
    if ($LASTEXITCODE -ne 0) { throw "Native flow failed; inspect $runDir/flow.log" }
    if ($ReplayCli) {
        & node $ReplayCli sync --rpc "http://127.0.0.1:$RpcPort" --network regtest `
            --state (Join-Path $evidenceDir 'rpc-replay.json') --from 1 |
            Tee-Object -FilePath (Join-Path $evidenceDir 'rpc-ledger.json')
        if ($LASTEXITCODE -ne 0) { throw 'Independent RPC ledger replay failed' }
    }
    $receiptPath = Join-Path $evidenceDir 'receipt.json'
    $receipt = Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json -AsHashtable
    $receipt['run_at_utc'] = (Get-Date).ToUniversalTime().ToString('o')
    $receipt['scenario'] = 'transparent-full-lot-sale'
    $receipt['node_release'] = @{ version = $nodeVersion; archive_url = $releaseUrl; archive_sha256 = $archiveHash }
    $receipt['runtime'] = @{ rust = (& rustc --version); operating_system = 'Windows with isolated WSL Linux node' }
    $sourceHashes = [ordered]@{}
    foreach ($source in @('Cargo.toml', 'Cargo.lock', 'src/main.rs', 'run-regtest.ps1')) {
        $sourceHashes[$source] = (Get-FileHash -LiteralPath (Join-Path $taskRoot $source) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $receipt['source_files_sha256'] = $sourceHashes
    $receipt | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $receiptPath -Encoding utf8NoBOM
    Write-Host "Verified receipt: $receiptPath"
} finally {
    if ($null -ne $nodeProcess -and -not $nodeProcess.HasExited) {
        $pidFile = Join-Path $runDir 'node.pid'
        if (Test-Path -LiteralPath $pidFile) {
            $nodePidText = (Get-Content -Raw -LiteralPath $pidFile).Trim()
            if ($nodePidText -notmatch '^\d+$') { throw 'Invalid owned node PID; refusing process stop' }
            $commandLine = Invoke-WslChecked @('cat', "/proc/$nodePidText/cmdline")
            if (-not $commandLine.Contains($linuxNode) -or -not $commandLine.Contains($linuxConfig)) {
                throw 'Node process ownership check failed; refusing process stop'
            }
            Invoke-WslChecked @('kill', '-TERM', $nodePidText) | Out-Null
            if (-not $nodeProcess.WaitForExit(30000)) { Write-Warning 'Owned node is still shutting down; logs retained.' }
        }
    }
    Pop-Location
}
