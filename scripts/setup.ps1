<#
  MPOS Cloud 首次設定（只需執行一次）
    1. 檢查 / 安裝 Git、Node.js、GitHub CLI
    2. 安裝 npm 套件（clasp、playwright）
    3. 登入 GitHub 與 Google（clasp）
    4. 匯出舊版 WebPOS 資料 → gas/src/Seed.js
    5. 建立 Apps Script 專案並推送程式
    6. 建立 GitHub repo、開啟 Pages（GitHub Actions 模式）、上傳 APK 簽章金鑰
    7. 執行一鍵部署
#>
param([string]$RepoName = '')

. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location $Root
$cfg = Read-DeployConfig

# ------------------------------------------------------------
Write-Step '1/7 檢查必要工具'
$need = @(
    @{ cmd = 'git';  id = 'Git.Git' },
    @{ cmd = 'node'; id = 'OpenJS.NodeJS.LTS' },
    @{ cmd = 'gh';   id = 'GitHub.cli' }
)
$installed = $false
foreach ($n in $need) {
    if (Test-Command $n.cmd) { Write-Ok "$($n.cmd) 已安裝"; continue }
    if (-not (Test-Command 'winget')) { Fail "找不到 $($n.cmd)，請手動安裝（winget id：$($n.id)）" }
    Write-Info "安裝 $($n.id) ..."
    Invoke-Native 'winget' @('install', '-e', '--id', $n.id, '--accept-source-agreements', '--accept-package-agreements') "安裝 $($n.id)"
    $installed = $true
}
if ($installed) {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    foreach ($n in $need) { if (-not (Test-Command $n.cmd)) { Fail "已安裝 $($n.cmd)，請關閉視窗後重新執行「首次設定.bat」。" } }
}

# ------------------------------------------------------------
Write-Step '2/7 安裝 npm 套件（clasp / playwright）'
Invoke-Native 'npm' @('ci') 'npm ci'
Invoke-Native 'npx' @('playwright', 'install', 'chromium') '安裝測試用瀏覽器'
Write-Ok 'npm 套件安裝完成'

# ------------------------------------------------------------
Write-Step '3/7 登入 GitHub 與 Google'
$ghStatus = Get-NativeOutput 'gh' @('auth', 'status') 'gh auth status' -AllowFail
if ($ghStatus -notmatch 'Logged in') {
    Write-Info '將開啟瀏覽器登入 GitHub ...'
    Invoke-Native 'gh' @('auth', 'login', '--web', '--git-protocol', 'https', '--scopes', 'repo,workflow') 'GitHub 登入'
}
$ghUser = (Get-NativeOutput 'gh' @('api', 'user', '--jq', '.login') '取得 GitHub 帳號').Trim()
Write-Ok "GitHub 帳號：$ghUser"
Invoke-Native 'gh' @('auth', 'setup-git') 'gh auth setup-git'

if (-not (Test-Path (Join-Path $HOME '.clasprc.json'))) {
    Write-Warn2 '請先到 https://script.google.com/home/usersettings 把「Google Apps Script API」切換為「開啟」'
    Start-Process 'https://script.google.com/home/usersettings'
    Read-Host '  開啟後按 Enter 繼續登入 Google'
    Invoke-Native $Clasp @('login') 'clasp login'
}
Write-Ok 'Google（clasp）已登入'

# ------------------------------------------------------------
Write-Step '4/7 匯出舊版 WebPOS 資料'
$oldDb = Join-Path (Split-Path $Root -Parent) 'private_files\taiyaki_pos.db'
$py = if (Test-Command 'python') { 'python' } elseif (Test-Command 'py') { 'py' } else { '' }
if ($py -and (Test-Path $oldDb)) {
    Invoke-Native $py @((Join-Path $PSScriptRoot 'export_seed.py'), $oldDb) '匯出舊資料'
} else {
    Write-Info '沿用專案內已匯出的 gas\src\Seed.js'
}

# ------------------------------------------------------------
Write-Step '5/7 建立 Apps Script 專案'
$claspJson = Join-Path $Root 'gas\.clasp.json'
if (Test-Path $claspJson) {
    $scriptId = (Get-Content $claspJson -Raw | ConvertFrom-Json).scriptId
    Write-Ok "已有 Apps Script 專案：$scriptId"
} else {
    $tmp = Join-Path $env:TEMP ('mpos-clasp-' + (Get-Random))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    Push-Location $tmp
    try {
        Invoke-Native $Clasp @('create-script', '--type', 'standalone', '--title', '茉莉花鯛魚燒 POS 管理後台', '--rootDir', '.') 'clasp create-script'
        $scriptId = (Get-Content (Join-Path $tmp '.clasp.json') -Raw | ConvertFrom-Json).scriptId
    } finally { Pop-Location }
    Write-Utf8File $claspJson (@{ scriptId = $scriptId; rootDir = 'src' } | ConvertTo-Json)
    Write-Ok "已建立 Apps Script 專案：$scriptId"
}
Set-ConfigValue $cfg 'scriptId' $scriptId
Save-DeployConfig $cfg
Push-Location (Join-Path $Root 'gas')
try { Invoke-Native $Clasp @('push', '-f') 'clasp push' } finally { Pop-Location }

Write-Warn2 '第一次需要在 Apps Script 編輯器執行 setup() 以授權並建立資料庫試算表：'
Write-Info '  1) 上方函式下拉選單選「setup」→ 按「執行」'
Write-Info '  2) 依畫面完成授權（若出現「Google 尚未驗證這個應用程式」→ 進階 → 前往專案）'
Write-Info '  3) 執行紀錄出現「MPOS 資料庫：https://docs.google.com/...」即完成'
Start-Process "https://script.google.com/d/$scriptId/edit"
Read-Host '  完成後按 Enter 繼續'

# ------------------------------------------------------------
Write-Step '6/7 建立 GitHub repo 與 Pages'
if (-not (Test-Path (Join-Path $Root '.git'))) {
    Invoke-Native 'git' @('init', '-b', 'main') 'git init'
}
$gitName = (Get-NativeOutput 'git' @('config', 'user.name') 'git config' -AllowFail).Trim()
if (-not $gitName) { Invoke-Native 'git' @('config', 'user.name', $ghUser) 'git config user.name' }
$gitMail = (Get-NativeOutput 'git' @('config', 'user.email') 'git config' -AllowFail).Trim()
if (-not $gitMail) { Invoke-Native 'git' @('config', 'user.email', "$ghUser@users.noreply.github.com") 'git config user.email' }

if (-not $cfg.repo) {
    if (-not $RepoName) {
        $RepoName = Read-Host '  GitHub repo 名稱（直接 Enter 使用 MPOS-Cloud）'
        if (-not $RepoName) { $RepoName = 'MPOS-Cloud' }
    }
    $repo = "$ghUser/$RepoName"
    $exists = Get-NativeOutput 'gh' @('repo', 'view', $repo, '--json', 'name') 'gh repo view' -AllowFail
    if ($exists -notmatch '"name"') {
        Write-Info 'GitHub Pages 免費方案需為公開 repo（GAS 網址本來就公開，管理功能有密碼保護；金鑰不會上傳）'
        Invoke-Native 'gh' @('repo', 'create', $repo, '--public', '--description', '茉莉花鯛魚燒 POS（GAS + GitHub Pages + Android）') 'gh repo create'
    }
    Set-ConfigValue $cfg 'repo' $repo
    Set-ConfigValue $cfg 'pagesUrl' ("https://{0}.github.io/{1}/" -f $ghUser.ToLower(), $RepoName)
    Save-DeployConfig $cfg
}
Write-Ok "GitHub repo：https://github.com/$($cfg.repo)"

# 連結 origin；若 GitHub 上已有內容（例如建立時附的 README），以遠端歷史為基底，保留本機檔案
$remotes = Get-NativeOutput 'git' @('remote') 'git remote' -AllowFail
if ($remotes -notmatch 'origin') { Invoke-Native 'git' @('remote', 'add', 'origin', "https://github.com/$($cfg.repo).git") 'git remote add' }
$hasLocalCommit = (Get-NativeOutput 'git' @('rev-parse', '--verify', 'HEAD') 'git rev-parse' -AllowFail) -match '^[0-9a-f]{40}'
$remoteHeads = Get-NativeOutput 'git' @('ls-remote', '--heads', 'origin') 'git ls-remote' -AllowFail
if (-not $hasLocalCommit -and $remoteHeads -match 'refs/heads/(main|master)') {
    $remoteBranch = $Matches[1]
    Invoke-Native 'git' @('fetch', 'origin', $remoteBranch) 'git fetch'
    Invoke-Native 'git' @('reset', "origin/$remoteBranch") 'git reset（保留本機檔案）'
    Write-Ok "已接上 GitHub 既有內容（$remoteBranch），本機檔案會在部署時一併推送"
}
$visibility = (Get-NativeOutput 'gh' @('repo', 'view', $cfg.repo, '--json', 'visibility', '--jq', '.visibility') 'gh repo view' -AllowFail).Trim()
if ($visibility -eq 'PRIVATE') {
    Write-Warn2 '此 repo 是私人的：GitHub Pages 需付費方案才能用在私人 repo。'
    $ans = Read-Host '  要改成公開嗎？(Y/n)'
    if ($ans -ne 'n') { Invoke-Native 'gh' @('repo', 'edit', $cfg.repo, '--visibility', 'public', '--accept-visibility-change-consequences') '改為公開' }
}

$pg = Get-NativeOutput 'gh' @('api', '-X', 'POST', "repos/$($cfg.repo)/pages", '-f', 'build_type=workflow') 'Pages' -AllowFail
if ($pg -notmatch 'html_url') { Get-NativeOutput 'gh' @('api', '-X', 'PUT', "repos/$($cfg.repo)/pages", '-f', 'build_type=workflow') 'Pages' -AllowFail | Out-Null }
Write-Ok "GitHub Pages：$($cfg.pagesUrl)"

$ks = Join-Path $Root 'private\mpos-release.jks'
$ksProps = Join-Path $Root 'private\keystore.properties'
if ((Test-Path $ks) -and (Test-Path $ksProps)) {
    $props = @{}
    Get-Content $ksProps | Where-Object { $_ -match '=' } | ForEach-Object { $k, $v = $_ -split '=', 2; $props[$k.Trim()] = $v.Trim() }
    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($ks))
    Invoke-Native 'gh' @('secret', 'set', 'MPOS_KEYSTORE_BASE64', '--repo', $cfg.repo, '--body', $b64) '上傳金鑰'
    Invoke-Native 'gh' @('secret', 'set', 'MPOS_KEYSTORE_PASSWORD', '--repo', $cfg.repo, '--body', $props['MPOS_KEYSTORE_PASSWORD']) '上傳金鑰密碼'
    Invoke-Native 'gh' @('secret', 'set', 'MPOS_KEY_ALIAS', '--repo', $cfg.repo, '--body', $props['MPOS_KEY_ALIAS']) '上傳金鑰別名'
    Invoke-Native 'gh' @('secret', 'set', 'MPOS_KEY_PASSWORD', '--repo', $cfg.repo, '--body', $props['MPOS_KEY_PASSWORD']) '上傳金鑰密碼'
    Write-Ok 'APK 簽章金鑰已上傳到 GitHub Secrets（請另外備份 private\ 資料夾）'
} else {
    Write-Warn2 '找不到 private\mpos-release.jks，APK 會使用 debug 簽章'
}

# ------------------------------------------------------------
Write-Step '7/7 執行一鍵部署'
& (Join-Path $PSScriptRoot 'deploy.ps1') -Message 'MPOS Cloud 首次部署'
