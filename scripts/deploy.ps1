<#
  MPOS Cloud 一鍵部署
    1. 本機自動化測試（GAS 單元測試 + 外殼端對端測試）
    2. clasp push + 更新 GAS 部署（網址固定不變）
    3. GAS 線上健康檢查
    4. 寫入 docs/config.js → git commit / push
    5. 等待 GitHub Actions：Pages 部署、線上測試、APK 編譯、模擬器測試、Release
    6. 下載 APK 到 dist\（有接 Android 裝置時可直接安裝）

  參數：
    -SkipTests   略過本機測試
    -SkipGas     不重新部署 GAS
    -NoWait      推送後不等待 GitHub Actions
    -Message     部署說明
#>
param(
    [switch]$SkipTests,
    [switch]$SkipGas,
    [switch]$NoWait,
    [string]$Message = ''
)

. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location $Root
$cfg = Read-DeployConfig
if (-not $Message) { $Message = 'MPOS deploy ' + (Get-Date -Format 'yyyy-MM-dd HH:mm') }

Write-Step '0/6 檢查環境'
Require-Command git '請先執行「首次設定.bat」。'
Require-Command node '請先執行「首次設定.bat」。'
Require-Command gh '請先執行「首次設定.bat」。'
if (-not (Test-Path $Clasp)) { Invoke-Native 'npm' @('ci') 'npm ci' }
if (-not (Test-Path (Join-Path $Root 'gas\.clasp.json'))) { Fail '找不到 gas\.clasp.json，請先執行「首次設定.bat」。' }
if (-not $cfg.repo) { Fail 'deploy.config.json 沒有 GitHub repo，請先執行「首次設定.bat」。' }
Write-Ok "GitHub repo：$($cfg.repo)"

# ------------------------------------------------------------
Write-Step '1/6 本機自動化測試'
Invoke-Native 'node' @((Join-Path $Root 'scripts\sync_barcode.js')) '同步條碼模組'
if ($SkipTests) { Write-Warn2 '已略過本機測試（-SkipTests）' }
else {
    Invoke-Native 'npm' @('run', 'test:unit') 'GAS 單元測試'
    $pwOk = $true
    try { Invoke-Native 'npm' @('run', 'test:e2e') '外殼端對端測試' } catch { $pwOk = $false }
    if (-not $pwOk) {
        Write-Warn2 '端對端測試失敗；若是第一次執行，請先執行：npx playwright install chromium'
        Fail '本機測試未通過，已停止部署。'
    }
    Write-Ok '本機測試全部通過'
}

# ------------------------------------------------------------
Write-Step '2/6 部署 Google Apps Script'
$gasDir = Join-Path $Root 'gas'
if ($SkipGas -and $cfg.deploymentId) {
    Write-Warn2 '已略過 GAS 部署（-SkipGas）'
} else {
    Push-Location $gasDir
    try {
        Invoke-Native $Clasp @('push', '-f') 'clasp push'
        $deployArgs = @('--json', 'create-deployment', '-d', $Message)
        if ($cfg.deploymentId) { $deployArgs += @('-i', $cfg.deploymentId) }
        $out = Get-NativeOutput $Clasp $deployArgs 'clasp 部署'
        $dep = ConvertFrom-LooseJson $out
        if (-not $dep -or -not $dep.deploymentId) { Write-Host $out; Fail '無法取得 GAS 部署 ID' }
        Set-ConfigValue $cfg 'deploymentId' $dep.deploymentId
        Save-DeployConfig $cfg
        Write-Ok "GAS 已部署：版本 $($dep.versionNumber)"
    } finally { Pop-Location }
}
$gasUrl = Get-GasUrl $cfg.deploymentId
Write-Info "GAS 網址：$gasUrl"

# ------------------------------------------------------------
Write-Step '3/6 GAS 線上健康檢查'
$health = $null
for ($i = 0; $i -lt 3; $i++) {
    $health = Get-GasHealth $gasUrl
    if ($health -and $health.ok) { break }
    if ($health -and -not $health.db_configured) { break }
    Start-Sleep -Seconds 5
}
while (-not ($health -and $health.ok)) {
    Write-Warn2 'GAS 尚未就緒（第一次部署需要授權並建立資料庫）。'
    Write-Info  '即將開啟 Apps Script 編輯器，請：'
    Write-Info  '  1) 上方函式下拉選單選「setup」→ 按「執行」'
    Write-Info  '  2) 依畫面完成 Google 帳號授權（進階 → 前往專案）'
    Write-Info  '  3) 執行紀錄出現「MPOS 資料庫：https://docs.google.com/...」即完成'
    Start-Process "https://script.google.com/d/$($cfg.scriptId)/edit"
    $ans = Read-Host '  完成後按 Enter 重新檢查（輸入 s 略過檢查）'
    if ($ans -eq 's') { Write-Warn2 '已略過健康檢查，線上測試可能會失敗。'; break }
    $health = Get-GasHealth $gasUrl
}
if ($health -and $health.ok) { Write-Ok "GAS 健康檢查通過（$($health.version)，商品 $($health.menu_count) 項）" }

# ------------------------------------------------------------
Write-Step '4/6 更新 GitHub Pages 設定並推送'
$config = @"
// 由 scripts/deploy.ps1 自動產生，請勿手動修改
window.MPOS_CONFIG = {
  "gasUrl": "$gasUrl",
  "repo": "$($cfg.repo)",
  "deployedAt": "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
};
"@
Write-Utf8File (Join-Path $Root 'docs\config.js') $config
# GitHub Actions 工作流程（原始檔在 ci\，部署時同步到 .github\workflows\）
$wfDir = Join-Path $Root '.github\workflows'
New-Item -ItemType Directory -Force -Path $wfDir | Out-Null
Copy-Item (Join-Path $Root 'ci\ci-cd.yml') (Join-Path $wfDir 'ci-cd.yml') -Force
Invoke-Native 'git' @('add', '-A') 'git add'
$changes = Get-NativeOutput 'git' @('status', '--porcelain') 'git status'
if ($changes.Trim()) {
    Invoke-Native 'git' @('commit', '-m', $Message) 'git commit'
} else {
    Invoke-Native 'git' @('commit', '--allow-empty', '-m', $Message) 'git commit'
}
Invoke-Native 'git' @('push', '-u', 'origin', 'main') 'git push'
$sha = (Get-NativeOutput 'git' @('rev-parse', 'HEAD') 'git rev-parse').Trim()
Write-Ok "已推送 $($sha.Substring(0,7)) 到 $($cfg.repo)"

if ($NoWait) {
    Write-Info "GitHub Actions 執行中：https://github.com/$($cfg.repo)/actions"
    exit 0
}

# ------------------------------------------------------------
Write-Step '5/6 等待 GitHub Actions（測試 → Pages → 線上測試 → APK → 模擬器測試 → Release）'
$run = $null
for ($i = 0; $i -lt 30 -and -not $run; $i++) {
    Start-Sleep -Seconds 4
    $json = Get-NativeOutput 'gh' @('run', 'list', '--repo', $cfg.repo, '--workflow', 'ci-cd.yml', '--commit', $sha, '--json', 'databaseId,number,url', '--limit', '1') 'gh run list' -AllowFail
    try { $list = $json | ConvertFrom-Json; if ($list -and $list.Count -gt 0) { $run = $list[0] } } catch { }
}
if (-not $run) { Fail "找不到這次推送的 GitHub Actions 執行紀錄：https://github.com/$($cfg.repo)/actions" }
Write-Info "Actions：$($run.url)"
Write-Info '（APK 編譯 + 模擬器測試約需 10~20 分鐘）'
& gh run watch $run.databaseId --repo $cfg.repo --exit-status --interval 20
if ($LASTEXITCODE -ne 0) {
    Write-Warn2 '以下是失敗步驟的紀錄（最後 80 行）：'
    $log = Get-NativeOutput 'gh' @('run', 'view', $run.databaseId, '--repo', $cfg.repo, '--log-failed') 'gh run view' -AllowFail
    ($log -split "`n" | Select-Object -Last 80) -join "`n" | Write-Host
    $logFile = Join-Path $Root 'dist\last-ci-failure.log'
    New-Item -ItemType Directory -Force -Path (Join-Path $Root 'dist') | Out-Null
    Write-Utf8File $logFile $log
    Write-Info "完整紀錄已存到：$logFile"
    Fail "GitHub Actions 失敗，請查看：$($run.url)"
}
Write-Ok 'GitHub Actions 全部通過'

# ------------------------------------------------------------
Write-Step '6/6 下載 APK'
$dist = Join-Path $Root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$tag = "app-v$($run.number)"
Invoke-Native 'gh' @('release', 'download', $tag, '--repo', $cfg.repo, '--pattern', '*.apk', '--dir', $dist, '--clobber') 'gh release download'
$apk = Get-ChildItem $dist -Filter "*-b$($run.number).apk" | Select-Object -First 1
if (-not $apk) { $apk = Get-ChildItem $dist -Filter '*.apk' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }
Write-Ok "APK：$($apk.FullName)"

if (-not $cfg.pagesUrl) {
    $pages = Get-NativeOutput 'gh' @('api', "repos/$($cfg.repo)/pages", '--jq', '.html_url') 'gh api pages' -AllowFail
    if ($pages -match '^https://') { Set-ConfigValue $cfg 'pagesUrl' $pages.Trim(); Save-DeployConfig $cfg }
}

Write-Step '部署完成'
Write-Info "外殼網址（Pages）：$($cfg.pagesUrl)"
Write-Info "GAS 後台網址    ：$gasUrl"
Write-Info "APK            ：$($apk.FullName)"
Write-Info "Release        ：https://github.com/$($cfg.repo)/releases/tag/$tag"

Write-Step '安裝 APK 到平板'
try {
    & (Join-Path $PSScriptRoot 'install.ps1') -Apk $apk.FullName -Ask
} catch {
    Write-Warn2 "APK 安裝未完成：$_"
    Write-Info  '部署本身已完成，可稍後執行「一鍵安裝APK.bat」重新安裝'
}
