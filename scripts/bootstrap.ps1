[CmdletBinding()]
param(
    [ValidateSet("native", "docker")]
    [string]$Mode = "native",

    [ValidateSet("none", "claude", "codex", "cursor", "all")]
    [string]$Client = "none",

    [switch]$NoMigrate,
    [switch]$SkipMcpInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message"
}

function Require-Command {
    param(
        [string]$Name,
        [string]$InstallHint
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required. $InstallHint"
    }
}

function Get-NpmCommand {
    $npmCmd = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
    if ($npmCmd) {
        return $npmCmd.Source
    }

    $npm = Get-Command "npm" -ErrorAction SilentlyContinue
    if ($npm) {
        return $npm.Source
    }

    throw "npm is required. Install Node.js 20 or newer; npm is included with Node."
}

function New-HexSecret {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [System.Convert]::ToHexString($bytes).ToLowerInvariant()
}

function Get-EnvFileValue {
    param(
        [string]$Content,
        [string]$Key
    )

    $pattern = "(?im)^\s*$([regex]::Escape($Key))\s*=\s*(.+?)\s*$"
    $matches = [regex]::Matches($Content, $pattern)
    if ($matches.Count -eq 0) {
        return ""
    }
    $match = $matches[$matches.Count - 1]
    return $match.Groups[1].Value.Trim().Trim('"').Trim("'")
}

function Ensure-DockerEnv {
    $envPath = Join-Path $RepoRoot ".env"
    if (Test-Path $envPath) {
        Write-Host "Using existing .env: $envPath"
        $content = Get-Content -Path $envPath -Raw
        $dbPassword = Get-EnvFileValue -Content $content -Key "DB_PASSWORD"
        $apiKeys = Get-EnvFileValue -Content $content -Key "SCG_API_KEYS"
        $adminApiKeys = Get-EnvFileValue -Content $content -Key "SCG_ADMIN_API_KEYS"
        if ($dbPassword -eq "" -or $dbPassword -match "(?i)^(postgres|password|changeme|change_me_before_deploying|change-me-before-deploying|change_me_before_running|change-me-before-running)$") {
            throw "Existing .env has a missing or weak DB_PASSWORD. Replace it with a strong generated value before Docker startup."
        }
        if ($apiKeys -eq "" -or $apiKeys -eq "your-secret-key-here" -or ($apiKeys.Split(",") | Where-Object { $_.Trim().Length -lt 32 }).Count -gt 0) {
            throw "Existing .env has missing or weak SCG_API_KEYS. Set at least one 32+ character API key before Docker startup."
        }
        $regularKeyList = $apiKeys.Split(",") | ForEach-Object { $_.Trim() }
        $adminKeyList = $adminApiKeys.Split(",") | ForEach-Object { $_.Trim() }
        if ($adminApiKeys -eq "" -or ($adminKeyList | Where-Object { $_.Length -lt 32 }).Count -gt 0) {
            throw "Existing .env must define 32+ character SCG_ADMIN_API_KEYS for Docker production mode."
        }
        if (($adminKeyList | Where-Object { $regularKeyList -contains $_ }).Count -gt 0) {
            throw "SCG_ADMIN_API_KEYS must not reuse a SCG_API_KEYS credential."
        }
        return
    }

    $apiKey = New-HexSecret
    $dbPassword = New-HexSecret
    $adminApiKey = New-HexSecret
    @(
        "# ContextZero Docker bootstrap configuration",
        "DB_PASSWORD=$dbPassword",
        "SCG_API_KEYS=$apiKey",
        "SCG_ADMIN_API_KEYS=$adminApiKey",
        "SCG_REPOS_PATH=.",
        "SCG_ALLOWED_BASE_PATHS=/repos",
        "SCG_MAX_FILES_PER_REPO=20000",
        "SCG_MAX_FILE_SIZE_BYTES=1048576",
        "SCG_INGEST_WORKERS=4",
        "SCG_PYTHON_TIMEOUT_MS=30000",
        "DB_SSL_ALLOW_INSECURE_PRIVATE_NETWORK=true",
        ""
    ) | Set-Content -Path $envPath -Encoding utf8
    Write-Host "Created Docker .env with generated secrets: $envPath"
}

function Install-PythonDependency {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) {
        Write-Host "Python was not found. Python files will fail extraction until Python 3 and libcst are installed."
        return
    }

    Write-Step "Installing Python LibCST dependency"
    & python -m pip install --user libcst
}

function Ensure-PostgresBestEffort {
    if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
        Write-Host "psql was not found. Skipping database creation; npm run doctor will report exact DB status."
        return
    }

    Write-Step "Preparing PostgreSQL database when local tools allow it"
    if (Get-Command createdb -ErrorAction SilentlyContinue) {
        & createdb scg_v2 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "createdb scg_v2 skipped or already exists."
        }
    }

    & psql -d scg_v2 -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Could not verify pg_trgm with psql. npm run doctor will give the exact database fix."
    }
}

if ($Mode -eq "docker") {
    Write-Step "Bootstrapping ContextZero with Docker Compose"
    Require-Command "docker" "Install Docker Desktop, then rerun this script."
    Ensure-DockerEnv
    & docker compose up -d --build
    & docker compose ps
    Write-Host ""
    Write-Host "Docker mode is running. REST health: http://localhost:3100/health"
    exit 0
}

Write-Step "Bootstrapping ContextZero natively"
Require-Command "node" "Install Node.js 20 or newer."
$NpmCommand = Get-NpmCommand

Install-PythonDependency
Ensure-PostgresBestEffort

Write-Step "Installing Node dependencies"
& $NpmCommand ci

$setupArgs = @()
if (-not $NoMigrate) {
    $setupArgs += "--migrate"
}

Write-Step "Running ContextZero setup"
if ($setupArgs.Count -gt 0) {
    & $NpmCommand run setup -- @setupArgs
} else {
    & $NpmCommand run setup
}

if (-not $SkipMcpInstall -and $Client -ne "none") {
    Write-Step "Installing MCP config for $Client"
    & $NpmCommand run mcp:install -- --client $Client
}

Write-Host ""
Write-Host "Bootstrap complete. Run npm run doctor any time to re-check the machine."
