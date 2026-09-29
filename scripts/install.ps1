# dsh-update-notifier 一键安装脚本
# 用法：powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-Profile web]
param(
    [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'
$pluginDir = Split-Path -Parent $PSScriptRoot
$dshBin = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'

if (-not (Test-Path $dshBin)) {
    Write-Host "找不到 dsh：$dshBin" -ForegroundColor Red
    exit 1
}

Write-Host "安装 dsh-update-notifier 到 profile [$Profile] ..." -ForegroundColor Yellow
& node $dshBin plugin --profile $Profile add "file:$($pluginDir.Replace('\','/'))"

Write-Host ""
Write-Host "验证插件树 ..." -ForegroundColor Yellow
& node $dshBin --profile $Profile --dump-config | Select-String 'dsh-update-notifier'

Write-Host ""
Write-Host "完成。重启 dsh web 后生效：" -ForegroundColor Green
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File \$env:USERPROFILE\.dsh\restart-dsh-web.ps1"
