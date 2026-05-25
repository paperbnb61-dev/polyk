# Deploy extreme-edge paper bot to Railway (24/7, no Postgres).
# Run after: npx @railway/cli login
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "==> Railway extreme bot deploy" -ForegroundColor Cyan

$cli = "npx --yes @railway/cli"
Invoke-Expression "$cli whoami" | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "Run first: npx @railway/cli login" -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path ".env")) {
  Write-Host "Missing .env in repo root" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path ".railway")) {
  Write-Host "Link Railway project (polyk — pick paper bot service, NOT Postgres):" -ForegroundColor Yellow
  Invoke-Expression "$cli link"
}

Write-Host "==> Clear Postgres / old paper vars" -ForegroundColor Cyan
Invoke-Expression "$cli variables set DATABASE_URL=" | Out-Null

$skip = @(
  "POLYMARKET_PRIVATE_KEY", "POLYMARKET_FUNDER_ADDRESS", "POLYMARKET_SIGNATURE_TYPE",
  "LIVE_", "COLLECT_", "UI_COLLECT_", "BACKTEST_", "PAPER_", "CELE_"
)

Get-Content ".env" | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) { return }
  if ($line -notmatch "^([A-Za-z_][A-Za-z0-9_]*)=(.*)$") { return }
  $name = $Matches[1]
  $value = $Matches[2]
  foreach ($prefix in $skip) {
    if ($name.StartsWith($prefix)) { return }
  }
  if ($name -match "^(EXTREME_|TELEGRAM_)") {
    Write-Host "  set $name"
    Invoke-Expression "$cli variables set ${name}=$value" | Out-Null
  }
}

Write-Host "==> Deploy (npm run extreme)" -ForegroundColor Cyan
Invoke-Expression "$cli up --detach" | Out-Host

Write-Host "==> Logs (Ctrl+C to exit):" -ForegroundColor Cyan
Invoke-Expression "$cli logs"
