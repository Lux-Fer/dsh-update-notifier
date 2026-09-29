# dsh-update-notifier 卸载 / 回滚脚本
# 用途：万一插件导致 dsh web 起不来，用这个一键撤销。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 [-Profile web] [-Restart]
param(
    [string]$Profile = 'web',
    [switch]$Restart
)

$ErrorActionPreference = 'Continue'
$env:DSH_HOME = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $env:DSH_HOME "profiles\$Profile"
$pj = Join-Path $profileDir 'package.json'

if (-not (Test-Path $pj)) {
    Write-Host "找不到 profile: $profileDir" -ForegroundColor Red
    exit 1
}

Write-Host "从 profile [$Profile] 卸载 dsh-update-notifier ..." -ForegroundColor Yellow

# 1) 摘掉 bundle 条目（插件真正生效的地方）
node -e @"
const fs = require('fs');
const p = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
const bundles = pkg?.dsh?.profile?.bundles ?? [];
const next = bundles.filter((b) => b !== 'dsh-update-notifier');
pkg.dsh.profile.bundles = next;
if (pkg.dependencies) { delete pkg.dependencies['dsh-update-notifier']; }
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + String.fromCharCode(10));
console.log('  bundles 剩余 ' + next.length + ' 项');
"@ $pj

# 2) 删除已安装的包目录
$mod = Join-Path $profileDir 'node_modules\dsh-update-notifier'
if (Test-Path $mod) {
    Remove-Item $mod -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  已删除 node_modules\dsh-update-notifier" -ForegroundColor Green
}

Write-Host "卸载完成。" -ForegroundColor Green

if ($Restart) {
    $restart = Join-Path $env:DSH_HOME 'restart-dsh-web.ps1'
    if (Test-Path $restart) {
        Write-Host "重启 dsh web ..." -ForegroundColor Yellow
        & powershell -NoProfile -ExecutionPolicy Bypass -File $restart
    }
}
