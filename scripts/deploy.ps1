<#
  MPOS Cloud 一鍵部署
    1. 本機自動化測試（GAS 單元測試 + 外殼端對端測試）
    2. clasp push + 更新 GAS 部署（網址固定不變）
    3. GAS 線上健康檢查
    4. 寫入 docs/config.js → git commit / push
    5. 等待 GitHub Actions：Pages 部署、線上測試、APK 編譯、模擬器測試、Release
    6. 下載 APK 到 dist\（有接 Android 裝置時可直接安裝）

  模式（-Mode）：
    Turbo 極速部署驗證：只做 clasp push + 更新 GAS 部署（GAS 沒變更就跳過），推送 GitHub 不等待（約 15~40 秒）
          不跑任何測試、不做健康檢查；docs 沒變更時 commit 加 [skip ci]，GitHub 完全不跑 Actions
          適用：改畫面文字、版面、樣式等小修改，想最快看到結果
    Fast  快速部署驗證：本機單元測試 → GAS 部署 → GAS 線上健康檢查 → 推送 GitHub（不等待）（約 1~2 分鐘）
          GitHub Actions 只在背景更新網頁（docs 有變更時），略過自動化測試、線上冒煙測試、APK、模擬器
          適用：只改 GAS 畫面 / 後台、網頁外殼
    Full  完整部署驗證：本機單元 + 端對端測試 → GAS → Pages → 線上測試 → APK → 模擬器測試 → Release → 安裝
          適用：有改 Android App 或條碼模組 Android 部分（約 15~25 分鐘）

  參數：
    -SkipTests   略過本機測試
    -SkipGas     不重新部署 GAS
    -NoWait      推送後不等待 GitHub Actions
    -Message     部署說明
#>
param(
    [ValidateSet('Turbo', 'Fast', 'Full')]
    [string]$Mode = 'Full',
    [switch]$SkipTests,
    [switch]$SkipGas,
    [switch]$NoWait,
    [string]$Message = ''
)

. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location $Root
$cfg = Read-DeployConfig
if (-not $Message) { $Message = 'MPOS deploy ' + (Get-Date -Format 'yyyy-MM-dd HH:mm') }
$fast = ($Mode -eq 'Fast')
$sw = [Diagnostics.Stopwatch]::StartNew()
Write-Host ''
if ($Mode -eq 'Turbo') {
    # ============================================================
    #  極速部署驗證：最少步驟、不等待任何東西
    # ============================================================
    Write-Host '  ★ 極速部署驗證（只更新 GAS，GitHub 背景同步，不跑測試）' -ForegroundColor Cyan
    if (-not (Test-Path $Clasp)) { Invoke-Native 'npm' @('ci') 'npm ci' }
    if (-not (Test-Path (Join-Path $Root 'gas\.clasp.json'))) { Fail '找不到 gas\.clasp.json，請先執行「首次設定.bat」。' }
    if (-not $cfg.deploymentId) { Fail '尚未有 GAS 部署 ID，請先執行一次「一鍵部署_快速部署驗證.bat」或「完整部署驗證」。' }

    # 條碼模組網頁檔（毫秒級）
    Invoke-Native 'node' @((Join-Path $Root 'scripts\sync_barcode.js')) '同步條碼模組'

    # Android 有變更只提醒，不詢問（極速模式不重編 APK）
    $since = if ($cfg.PSObject.Properties.Name -contains 'lastFullSha') { $cfg.lastFullSha } else { '' }
    if ($since) {
        $androidChanged = (Get-NativeOutput 'git' @('diff', '--name-only', $since, '--', 'android', '條碼模組/android') 'git diff' -AllowFail).Trim()
        if ($androidChanged) { Write-Warn2 'Android App 有變更但極速模式不重編 APK，需要時請執行「完整部署驗證」。' }
    }

    # GAS：內容沒變就不 push / 不建新版本
    $gasDir = Join-Path $Root 'gas'
    $files = Get-ChildItem (Join-Path $gasDir 'src') -File -Recurse | Sort-Object FullName
    $files += Get-Item (Join-Path $gasDir 'appsscript.json') -ErrorAction SilentlyContinue
    $sb = New-Object Text.StringBuilder
    foreach ($f in $files) { if ($f) { [void]$sb.Append($f.Name).Append((Get-FileHash $f.FullName -Algorithm MD5).Hash) } }
    $md5 = [Security.Cryptography.MD5]::Create()
    $gasHash = [BitConverter]::ToString($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($sb.ToString()))).Replace('-', '')
    $lastHash = if ($cfg.PSObject.Properties.Name -contains 'lastGasHash') { $cfg.lastGasHash } else { '' }
    if ($gasHash -eq $lastHash) {
        Write-Ok 'GAS 程式沒有變更，略過 clasp push'
    } else {
        Push-Location $gasDir
        try {
            Invoke-Native $Clasp @('push', '-f') 'clasp push'
            $out = Get-NativeOutput $Clasp @('--json', 'create-deployment', '-d', $Message, '-i', $cfg.deploymentId) 'clasp 部署'
            $dep = ConvertFrom-LooseJson $out
            if (-not $dep -or -not $dep.deploymentId) { Write-Host $out; Fail '無法取得 GAS 部署 ID' }
            Set-ConfigValue $cfg 'lastGasHash' $gasHash
            Save-DeployConfig $cfg
            Write-Ok "GAS 已部署：版本 $($dep.versionNumber)（$([int]$sw.Elapsed.TotalSeconds) 秒）"
        } finally { Pop-Location }
    }

    # GitHub：有變更才推送；docs 沒變更就加 [skip ci]（不觸發任何 Actions）
    $wfDir = Join-Path $Root '.github\workflows'
    New-Item -ItemType Directory -Force -Path $wfDir | Out-Null
    Copy-Item (Join-Path $Root 'ci\ci-cd.yml') (Join-Path $wfDir 'ci-cd.yml') -Force
    Invoke-Native 'git' @('add', '-A') 'git add'
    $changes = (Get-NativeOutput 'git' @('status', '--porcelain') 'git status').Trim()
    if ($changes) {
        $docsChanged = (Get-NativeOutput 'git' @('diff', '--cached', '--name-only', '--', 'docs', '.github') 'git diff' -AllowFail).Trim()
        $msg = if ($docsChanged) { $Message + ' [fast]' } else { $Message + ' [skip ci]' }
        Invoke-Native 'git' @('commit', '-q', '-m', $msg) 'git commit'
        Invoke-Native 'git' @('push', '-q', 'origin', 'main') 'git push'
        if ($docsChanged) { Write-Ok '已推送；網頁外殼有變更，GitHub Pages 會在背景更新（約 1 分鐘，不需等待）' }
        else { Write-Ok '已推送原始碼備份（[skip ci]：不跑任何 GitHub Actions）' }
    } else {
        Write-Info '沒有需要推送到 GitHub 的變更'
    }

    Write-Step "極速部署完成（共 $([int]$sw.Elapsed.TotalSeconds) 秒）"
    Write-Info '平板上的 App 不用重裝：按右上角 ⟳（或重新開啟 App）即可看到新版畫面'
    Write-Info '（未執行任何測試；正式上線前建議跑一次「快速部署驗證」或「完整部署驗證」）'
    exit 0
}
if ($fast) { Write-Host '  ★ 快速部署驗證（GAS + 網頁，不重編 APK）' -ForegroundColor Cyan }
else { Write-Host '  ★ 完整部署驗證（含 APK 編譯、模擬器測試、安裝）' -ForegroundColor Cyan }

Write-Step '0/6 檢查環境'
Require-Command git '請先執行「首次設定.bat」。'
Require-Command node '請先執行「首次設定.bat」。'
Require-Command gh '請先執行「首次設定.bat」。'
if (-not (Test-Path $Clasp)) { Invoke-Native 'npm' @('ci') 'npm ci' }
if (-not (Test-Path (Join-Path $Root 'gas\.clasp.json'))) { Fail '找不到 gas\.clasp.json，請先執行「首次設定.bat」。' }
if (-not $cfg.repo) { Fail 'deploy.config.json 沒有 GitHub repo，請先執行「首次設定.bat」。' }
Write-Ok "GitHub repo：$($cfg.repo)"

if ($fast) {
    $since = if ($cfg.PSObject.Properties.Name -contains 'lastFullSha') { $cfg.lastFullSha } else { '' }
    $androidChanged = ''
    if ($since) {
        $androidChanged = (Get-NativeOutput 'git' @('diff', '--name-only', $since, '--', 'android', '條碼模組/android') 'git diff' -AllowFail).Trim()
        $untracked = (Get-NativeOutput 'git' @('ls-files', '--others', '--exclude-standard', '--', 'android', '條碼模組/android') 'git ls-files' -AllowFail).Trim()
        if ($untracked) { $androidChanged = ($androidChanged + "`n" + $untracked).Trim() }
    } else {
        $androidChanged = '（尚未記錄上次完整部署）'
    }
    if ($androidChanged) {
        Write-Warn2 '偵測到 Android App 有變更，快速部署不會重編 APK：'
        Write-Host $androidChanged -ForegroundColor DarkGray
        $ans = Read-Host '  改用完整部署驗證嗎？(Y/n)'
        if ($ans -ne 'n') { $fast = $false; $Mode = 'Full'; Write-Info '已切換為完整部署驗證' }
    }
}

# ------------------------------------------------------------
Write-Step '1/6 本機自動化測試'
Invoke-Native 'node' @((Join-Path $Root 'scripts\sync_barcode.js')) '同步條碼模組'
if ($SkipTests) { Write-Warn2 '已略過本機測試（-SkipTests）' }
else {
    Invoke-Native 'npm' @('run', 'test:unit') 'GAS 單元測試'
}
if (-not $SkipTests -and -not $fast) {
    $pwOk = $true
    try { Invoke-Native 'npm' @('run', 'test:e2e') '外殼端對端測試' } catch { $pwOk = $false }
    if (-not $pwOk) {
        Write-Warn2 '端對端測試失敗；若是第一次執行，請先執行：npx playwright install chromium'
        Fail '本機測試未通過，已停止部署。'
    }
    Write-Ok '本機端對端測試通過'
}
if ($fast -and -not $SkipTests) { Write-Info '快速模式：略過端對端測試，部署後以線上冒煙測試驗證' }

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
$configPath = Join-Path $Root 'docs\config.js'
$oldConfig = if (Test-Path $configPath) { [IO.File]::ReadAllText($configPath) } else { '' }
if (-not $fast -or $oldConfig -notmatch [regex]::Escape($gasUrl)) { Write-Utf8File $configPath $config }
# GitHub Actions 工作流程（原始檔在 ci\，部署時同步到 .github\workflows\）
$wfDir = Join-Path $Root '.github\workflows'
New-Item -ItemType Directory -Force -Path $wfDir | Out-Null
Copy-Item (Join-Path $Root 'ci\ci-cd.yml') (Join-Path $wfDir 'ci-cd.yml') -Force
Invoke-Native 'git' @('add', '-A') 'git add'
if ($fast) { $Message = $Message + ' [fast]' }
$changes = Get-NativeOutput 'git' @('status', '--porcelain') 'git status'
if ($changes.Trim()) {
    Invoke-Native 'git' @('commit', '-m', $Message) 'git commit'
    Invoke-Native 'git' @('push', '-u', 'origin', 'main') 'git push'
} elseif ($fast) {
    Write-Info '沒有需要推送到 GitHub 的變更（只更新了 GAS）'
} else {
    Invoke-Native 'git' @('commit', '--allow-empty', '-m', $Message) 'git commit'
    Invoke-Native 'git' @('push', '-u', 'origin', 'main') 'git push'
}
$sha = (Get-NativeOutput 'git' @('rev-parse', 'HEAD') 'git rev-parse').Trim()
Write-Ok "已推送 $($sha.Substring(0,7)) 到 $($cfg.repo)"

if ($fast) {
    Write-Step '快速部署驗證完成'
    Write-Info "GAS 後台網址    ：$gasUrl"
    Write-Info "外殼網址（Pages）：$($cfg.pagesUrl)"
    if ($changes.Trim()) { Write-Info '網頁外殼若有變更，GitHub 會在背景更新（約 1~2 分鐘），不需等待' }
    Write-Info '平板上的 App 不用重裝：重新開啟 App（或按左下角 ⟳）即可看到新版畫面'
    Write-Info '（自動化測試 / 線上冒煙測試 / APK 只在「完整部署驗證」執行）'
    exit 0
}

if ($NoWait) {
    Write-Info "GitHub Actions 執行中：https://github.com/$($cfg.repo)/actions"
    exit 0
}

# ------------------------------------------------------------
if ($fast) { Write-Step '5/6 等待 GitHub Actions（單元測試 → Pages → 線上冒煙測試）' }
else { Write-Step '5/6 等待 GitHub Actions（測試 → Pages → 線上測試 → APK → 模擬器測試 → Release）' }
$run = $null
for ($i = 0; $i -lt 30 -and -not $run; $i++) {
    Start-Sleep -Seconds 4
    $json = Get-NativeOutput 'gh' @('run', 'list', '--repo', $cfg.repo, '--workflow', 'ci-cd.yml', '--commit', $sha, '--json', 'databaseId,number,url', '--limit', '1') 'gh run list' -AllowFail
    try { $list = $json | ConvertFrom-Json; if ($list -and $list.Count -gt 0) { $run = $list[0] } } catch { }
}
if (-not $run) { Fail "找不到這次推送的 GitHub Actions 執行紀錄：https://github.com/$($cfg.repo)/actions" }
Write-Info "Actions：$($run.url)"
if ($fast) { Write-Info '（快速模式約 3~5 分鐘）' } else { Write-Info '（APK 編譯 + 模擬器測試約需 10~20 分鐘）' }
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

if ($fast) {
    Write-Step '快速部署驗證完成'
    Write-Info "外殼網址（Pages）：$($cfg.pagesUrl)"
    Write-Info "GAS 後台網址    ：$gasUrl"
    Write-Info '平板上的 App 不用重裝：重新開啟 App（或按左下角 ⟳）即可看到新版畫面'
    exit 0
}
Set-ConfigValue $cfg 'lastFullSha' $sha
Save-DeployConfig $cfg

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
