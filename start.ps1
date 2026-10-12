# ============================================================
#  StockCouncil 一键启动（PowerShell）
# ============================================================
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '[x] 未检测到 Node.js，请先安装 Node >= 20： https://nodejs.org/' -ForegroundColor Red
  exit 1
}

$v = (node --version).TrimStart('v').Split('.')[0]
if ([int]$v -lt 20) {
  Write-Host "[!] 当前 Node 版本为 $((node --version))，建议升级到 >= 20。" -ForegroundColor Yellow
}

if (-not (Test-Path '.env') -and (Test-Path '.env.example')) {
  Copy-Item '.env.example' '.env'
  Write-Host '[i] 未发现 .env，已从 .env.example 复制一份，请按需填写 API Key。' -ForegroundColor Cyan
}

Write-Host '[i] 正在启动 StockCouncil ...' -ForegroundColor Cyan
node server/index.mjs