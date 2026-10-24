# MPOS Cloud 共用函式（PowerShell 5.1 / 7 相容）
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path $PSScriptRoot -Parent
$ConfigPath = Join-Path $Root 'deploy.config.json'
$Clasp = Join-Path $Root 'node_modules\.bin\clasp.cmd'

function Write-Step([string]$text) {
    Write-Host ''
    Write-Host ('=' * 64) -ForegroundColor DarkYellow
    Write-Host "  $text" -ForegroundColor Yellow
    Write-Host ('=' * 64) -ForegroundColor DarkYellow
}
function Write-Ok([string]$text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Info([string]$text) { Write-Host "  $text" -ForegroundColor Gray }
function Write-Warn2([string]$text) { Write-Host "  [注意] $text" -ForegroundColor Magenta }

function Fail([string]$text) {
    Write-Host ''
    Write-Host "  [失敗] $text" -ForegroundColor Red
    throw $text
}

# 執行外部指令，非 0 結束碼即中止
function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments, [string]$What)
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "$What 失敗（結束碼 $LASTEXITCODE）" }
}

# 執行外部指令並取得輸出文字
function Get-NativeOutput {
    param([string]$Exe, [string[]]$Arguments, [string]$What, [switch]$AllowFail)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    $text = ($out -join "`n")
    if ($code -ne 0 -and -not $AllowFail) { Write-Host $text; Fail "$What 失敗（結束碼 $code）" }
    return $text
}

function Test-Command([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Require-Command([string]$name, [string]$hint) {
    if (-not (Test-Command $name)) { Fail "找不到 $name。$hint" }
}

function Read-DeployConfig {
    if (Test-Path $ConfigPath) {
        return (Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    return [pscustomobject]@{ scriptId = ''; deploymentId = ''; repo = ''; pagesUrl = '' }
}

function Save-DeployConfig($cfg) {
    $json = $cfg | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($ConfigPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Set-ConfigValue($cfg, [string]$name, $value) {
    if ($cfg.PSObject.Properties.Name -contains $name) { $cfg.$name = $value }
    else { $cfg | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

function Write-Utf8File([string]$path, [string]$content) {
    [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

# 從混雜輸出中擷取 JSON 物件
function ConvertFrom-LooseJson([string]$text) {
    $start = $text.IndexOf('{'); $end = $text.LastIndexOf('}')
    if ($start -lt 0 -or $end -le $start) { return $null }
    try { return ($text.Substring($start, $end - $start + 1) | ConvertFrom-Json) } catch { return $null }
}

function Get-GasUrl([string]$deploymentId) {
    return "https://script.google.com/macros/s/$deploymentId/exec"
}

# 呼叫 GAS 健康檢查；回傳物件或 $null
function Get-GasHealth([string]$gasUrl) {
    try {
        $r = Invoke-WebRequest -Uri "$gasUrl`?api=health" -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 60
        $content = $r.Content
        if ($content -is [byte[]]) { $content = [System.Text.Encoding]::UTF8.GetString($content) }
        return ConvertFrom-LooseJson $content
    } catch {
        return $null
    }
}
