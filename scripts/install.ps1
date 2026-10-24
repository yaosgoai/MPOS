<#
  MPOS 一鍵安裝 APK 到 Android 平板
    - 自動尋找 adb（沒有就下載 Google platform-tools 到 tools\）
    - 自動選最新 APK（dist\），或用 -Latest 從 GitHub Release 下載
    - 偵測平板、未授權 USB 偵錯、USB 安裝被擋、簽章不同、版本降級等狀況並引導處理
    - USB 安裝不行時，改用「推送到平板 Download 資料夾」手動點安裝
    - 安裝後驗證版本並啟動 App

  參數：
    -Apk <路徑>   指定 APK
    -Latest       先從 GitHub Release 下載最新 APK
    -Force        即使平板上已是相同版本也重新安裝
    -Ask          （一鍵部署呼叫用）沒有平板時直接略過，有平板時先詢問
#>
param(
    [string]$Apk = '',
    [switch]$Latest,
    [switch]$Force,
    [switch]$Ask
)

. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location $Root
$Package = 'tw.mpos.app'
$cfg = Read-DeployConfig

# ------------------------------------------------------------
function Find-Adb {
    $cmd = Get-Command 'adb' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $Root 'tools\platform-tools\adb.exe'),
        (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'),
        (Join-Path $env:USERPROFILE 'AppData\Local\Android\Sdk\platform-tools\adb.exe'),
        'C:\platform-tools\adb.exe',
        'C:\Android\platform-tools\adb.exe'
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    return ''
}

function Install-PlatformTools {
    $dest = Join-Path $Root 'tools'
    $zip = Join-Path $env:TEMP 'platform-tools-latest-windows.zip'
    Write-Info '下載 Google platform-tools（約 7 MB）...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' -OutFile $zip -UseBasicParsing
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Expand-Archive -Path $zip -DestinationPath $dest -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    return (Join-Path $dest 'platform-tools\adb.exe')
}

function Adb([string[]]$a) { return Get-NativeOutput $script:AdbExe $a ('adb ' + ($a -join ' ')) -AllowFail }
function AdbS([string]$serial, [string[]]$a) { return Adb (@('-s', $serial) + $a) }

function Get-Devices {
    $lines = (Adb @('devices')) -split "`n" | Select-Object -Skip 1
    $list = @()
    foreach ($l in $lines) {
        $p = $l.Trim() -split "\s+"
        if ($p.Count -ge 2 -and $p[0]) { $list += [pscustomobject]@{ Serial = $p[0]; State = $p[1] } }
    }
    return $list
}

function Get-InstalledVersionCode([string]$serial) {
    $out = AdbS $serial @('shell', 'dumpsys', 'package', $Package)
    if ($out -match 'versionCode=(\d+)') { return [int]$Matches[1] }
    return 0
}

function Get-ApkVersionCode([string]$path) {
    if ([IO.Path]::GetFileName($path) -match '-b(\d+)\.apk$') { return [int]$Matches[1] }
    return 0
}

function Show-RestrictedHelp([string]$brand) {
    Write-Warn2 '平板拒絕透過 USB 安裝（INSTALL_FAILED_USER_RESTRICTED）'
    if ($brand -match 'xiaomi|redmi|poco') {
        Write-Info '  小米 / 紅米 / POCO：設定 → 更多設定 → 開發人員選項'
        Write-Info '    1) 開啟「USB 安裝」（需登入小米帳號，可能要插 SIM 卡或連網）'
        Write-Info '    2) 開啟「USB 偵錯（安全性設定）」'
    } elseif ($brand -match 'oppo|realme|oneplus') {
        Write-Info '  OPPO / realme：開發人員選項 → 關閉「停用權限監控」或開啟「透過 USB 安裝」'
    } elseif ($brand -match 'vivo|iqoo') {
        Write-Info '  vivo：開發人員選項 → 開啟「USB 安裝」，並關閉「USB 安裝時驗證應用程式」'
    } else {
        Write-Info '  開發人員選項 → 開啟「USB 安裝」/「透過 USB 驗證應用程式」相關選項'
    }
    Write-Info '  重試時，平板會跳出「是否允許安裝」，請在幾秒內按「安裝 / 繼續安裝」'
}

function Invoke-PushFallback([string]$serial, [string]$apkPath) {
    $remote = '/sdcard/Download/MPOS.apk'
    Write-Info "推送 APK 到平板：$remote"
    $r = AdbS $serial @('push', $apkPath, $remote)
    if ($r -notmatch 'pushed|file') { Write-Host $r; Write-Warn2 '推送失敗，請手動把 APK 複製到平板'; return }
    AdbS $serial @('shell', 'am', 'start', '-a', 'android.intent.action.VIEW_DOWNLOADS') | Out-Null
    Write-Ok '已放到平板的「下載 / Download」資料夾'
    Write-Info '  請在平板上點「MPOS.apk」→ 安裝（第一次需允許「安裝不明應用程式」）'
}

function Install-ToDevice([string]$serial, [string]$apkPath) {
    $brand = (AdbS $serial @('shell', 'getprop', 'ro.product.brand')).Trim().ToLower()
    $model = (AdbS $serial @('shell', 'getprop', 'ro.product.model')).Trim()
    $sdk = (AdbS $serial @('shell', 'getprop', 'ro.build.version.release')).Trim()
    Write-Step "安裝到 $brand $model（Android $sdk，$serial）"

    $apkCode = Get-ApkVersionCode $apkPath
    $installed = Get-InstalledVersionCode $serial
    if ($installed -gt 0) { Write-Info "平板目前版本：build $installed；APK：build $apkCode" }
    if (-not $Force -and $apkCode -gt 0 -and $installed -eq $apkCode) {
        Write-Ok '平板上已是相同版本，略過（要重裝請加 -Force）'
        return $true
    }

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        Write-Info "USB 安裝中（第 $attempt 次）... 請留意平板上的確認視窗"
        $out = AdbS $serial @('install', '-r', $apkPath)
        if ($out -match 'Success') {
            $now = Get-InstalledVersionCode $serial
            Write-Ok "安裝完成（build $now）"
            AdbS $serial @('shell', 'monkey', '-p', $Package, '-c', 'android.intent.category.LAUNCHER', '1') | Out-Null
            Write-Ok '已在平板上啟動 鯛魚燒POS'
            return $true
        }
        Write-Host $out -ForegroundColor DarkGray

        if ($out -match 'INSTALL_FAILED_USER_RESTRICTED') {
            Show-RestrictedHelp $brand
            AdbS $serial @('shell', 'am', 'start', '-a', 'android.settings.APPLICATION_DEVELOPMENT_SETTINGS') | Out-Null
            Write-Info '  （已在平板上開啟「開發人員選項」）'
            $ans = Read-Host '  設定好後按 Enter 重試；輸入 p 改用推送檔案手動安裝；輸入 q 略過'
            if ($ans -eq 'q') { return $false }
            if ($ans -eq 'p') { Invoke-PushFallback $serial $apkPath; return $false }
            continue
        }
        if ($out -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE|INSTALL_FAILED_VERSION_DOWNGRADE|signatures do not match') {
            Write-Warn2 '平板上已有簽章不同或版本較新的 鯛魚燒POS，需要先解除安裝'
            Write-Info  '  （解除安裝會清除這台平板上記住的藍牙出單機，裝好後到「設定」重新選擇即可；訂單資料在雲端不受影響）'
            $ans = Read-Host '  要解除舊版後重裝嗎？(Y/n)'
            if ($ans -eq 'n') { return $false }
            AdbS $serial @('uninstall', $Package) | Out-Null
            continue
        }
        if ($out -match 'INSUFFICIENT_STORAGE') { Write-Warn2 '平板儲存空間不足，請清出空間後再試'; return $false }
        if ($out -match 'device offline|no devices|not found') {
            Write-Warn2 '平板連線中斷，請重新插 USB 線'
            Read-Host '  重新連接後按 Enter 重試' | Out-Null
            continue
        }
        Write-Warn2 'USB 安裝失敗，改用推送檔案方式'
        Invoke-PushFallback $serial $apkPath
        return $false
    }
    $ans = Read-Host '  多次重試仍失敗，要改用推送檔案手動安裝嗎？(Y/n)'
    if ($ans -ne 'n') { Invoke-PushFallback $serial $apkPath }
    return $false
}

# ------------------------------------------------------------
# 1. 決定 APK
$dist = Join-Path $Root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
if ($Latest) {
    if (-not $cfg.repo) { Fail 'deploy.config.json 沒有 GitHub repo' }
    Require-Command gh '請先執行「首次設定.bat」'
    Write-Info "從 GitHub Release 下載最新 APK（$($cfg.repo)）..."
    Invoke-Native 'gh' @('release', 'download', '--repo', $cfg.repo, '--pattern', '*.apk', '--dir', $dist, '--clobber') '下載最新 APK'
}
if (-not $Apk) {
    $f = Get-ChildItem $dist -Filter '*.apk' -ErrorAction SilentlyContinue |
        Sort-Object @{ Expression = { Get-ApkVersionCode $_.Name } }, LastWriteTime -Descending | Select-Object -First 1
    if (-not $f -and $cfg.repo -and (Test-Command 'gh')) {
        Write-Info 'dist\ 沒有 APK，從 GitHub Release 下載最新版...'
        Invoke-Native 'gh' @('release', 'download', '--repo', $cfg.repo, '--pattern', '*.apk', '--dir', $dist, '--clobber') '下載最新 APK'
        $f = Get-ChildItem $dist -Filter '*.apk' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }
    if (-not $f) { Fail '找不到 APK，請先執行「一鍵部署.bat」' }
    $Apk = $f.FullName
}
if (-not (Test-Path $Apk)) { Fail "找不到 APK：$Apk" }
Write-Ok "APK：$Apk"

# 2. adb
$script:AdbExe = Find-Adb
if (-not $script:AdbExe) {
    if ($Ask) { Write-Info '電腦沒有 adb，略過自動安裝（可執行「一鍵安裝APK.bat」）'; exit 0 }
    $ans = Read-Host '  電腦沒有 adb，要自動下載 Google platform-tools 嗎？(Y/n)'
    if ($ans -eq 'n') { Fail '需要 adb 才能從電腦安裝；也可以把 APK 複製到平板手動安裝' }
    $script:AdbExe = Install-PlatformTools
}
Write-Ok "adb：$script:AdbExe"
Adb @('start-server') | Out-Null

# 3. 平板
$devices = @(Get-Devices)
if ($Ask) {
    if (-not ($devices | Where-Object { $_.State -eq 'device' })) { Write-Info '沒有偵測到 Android 平板，略過自動安裝（之後可執行「一鍵安裝APK.bat」）'; exit 0 }
    $ans = Read-Host '  偵測到 Android 平板，要直接安裝 APK 嗎？(Y/n)'
    if ($ans -eq 'n') { exit 0 }
}
for ($wait = 0; $true; $wait++) {
    $devices = @(Get-Devices)
    $unauth = $devices | Where-Object { $_.State -eq 'unauthorized' }
    $ready = @($devices | Where-Object { $_.State -eq 'device' })
    if ($ready.Count -gt 0) { break }
    if ($unauth) {
        Write-Warn2 '平板尚未授權這台電腦：請在平板上勾選「一律允許」並按「允許 USB 偵錯」'
    } else {
        Write-Warn2 '沒有偵測到 Android 平板'
        Write-Info  '  1) 用可傳輸資料的 USB 線連接平板'
        Write-Info  '  2) 平板：設定 → 關於平板 → 連點「版本號碼」7 次開啟開發人員選項'
        Write-Info  '  3) 開發人員選項 → 開啟「USB 偵錯」'
        Write-Info  '  4) USB 模式選「檔案傳輸」'
    }
    $ans = Read-Host '  準備好後按 Enter 重新偵測（輸入 q 離開）'
    if ($ans -eq 'q') { exit 1 }
}

# 4. 安裝（多台平板全部安裝）
$results = @()
foreach ($d in $ready) {
    $ok = Install-ToDevice $d.Serial $Apk
    $results += [pscustomobject]@{ 平板 = $d.Serial; 結果 = $(if ($ok) { '完成' } else { '未完成' }) }
}

Write-Step '安裝結果'
foreach ($r in $results) { if ($r.結果 -eq '完成') { Write-Ok "$($r.平板)：完成" } else { Write-Warn2 "$($r.平板)：未完成" } }
if ($results | Where-Object { $_.結果 -eq '完成' }) {
    Write-Info '平板首次使用：設定 → 藍牙配對出單機 → 開 App → 設定頁（密碼 1234）→ 選出單機 → 測試列印'
}
