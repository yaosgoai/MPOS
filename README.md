# 茉莉花鯛魚燒 POS — MPOS Cloud

由原本的 `WebPOS.py`（Flask + Access + 電腦藍牙 COM Port）改為雲端架構：

```
┌──────────── Android 平板（MPOS App）───────────────┐
│  WebView 載入 GitHub Pages：docs/index.html（外殼）  │
│     └─ iframe ─> GAS Web App（POS 畫面 + 管理後台）  │
│            │  postMessage                           │
│            ▼                                        │
│  window.AndroidPOS ── 藍牙 SPP ──> CP-Q3 / XP-58 出單機│
└────────────────────────────────────────────────────┘
GAS 後端 ──> Google 試算表（settings / menu_items / note_presets / orders / order_items / receipt_layout）
```

- **畫面與邏輯都在 GAS**：改功能只要重新部署 GAS，App 不用重裝。
- **GitHub Pages 外殼**固定網址，內部包住 GAS 網址；GAS 網址存在 `docs/config.js`，由部署腳本自動更新。
- **Android App** 只負責全螢幕顯示外殼，並把 GAS 送來的列印工作轉成 ESC/POS 藍牙列印（含 EAN13 點陣條碼、切紙、開錢箱）。

## 第一次使用

1. 雙擊 **`首次設定.bat`**，依畫面操作：
   - 自動安裝 Git / Node.js / GitHub CLI（用 winget）
   - 登入 GitHub、Google（第一次需到 <https://script.google.com/home/usersettings> 開啟「Google Apps Script API」）
   - 建立 Apps Script 專案 → **在開啟的編輯器中選 `setup` 函式並按「執行」完成授權**（會建立資料庫試算表並匯入舊資料）
   - 建立 GitHub repo、開啟 Pages、上傳 APK 簽章金鑰
   - 最後自動執行一次完整部署
2. 部署完成後，APK 會下載到 `dist\`，複製到平板安裝（或接 USB 由腳本用 adb 直接安裝）。
3. 平板先到「設定 → 藍牙」配對出單機，再開 App →「設定」頁（管理密碼預設 **1234**）→ 選擇出單機 →「設為出單機」→「測試列印」。

## 日常部署（兩種）

| 檔案 | 何時用 | 內容 | 時間 |
|---|---|---|---|
| **`一鍵部署_快速部署驗證.bat`** | 只改 GAS 畫面 / 後台、網頁外殼 | 本機單元測試 → GAS 部署 → GAS 健康檢查 → 推送 GitHub（網頁在背景更新，不等待；略過 GitHub 上的自動化測試、線上冒煙測試、APK） | 約 1~2 分鐘 |
| **`一鍵部署_完整部署驗證.bat`** | 有改 Android App 或條碼模組 Android 部分 | 單元 + 端對端測試 → GAS → Pages → 線上測試 → APK → 模擬器測試 → Release → 安裝 | 約 15~25 分鐘 |

快速部署若偵測到 `android/` 或 `條碼模組/android/` 自上次完整部署後有變更，會提醒並可改走完整部署。
參數（PowerShell 執行 `scripts\deploy.ps1`）：`-Mode Fast|Full`、`-SkipTests`、`-SkipGas`、`-NoWait`、`-Message "說明"`。

## 安裝 APK 到平板

雙擊 **`一鍵安裝APK.bat`**：自動找 adb（沒有會下載 Google platform-tools）、選 `dist\` 最新 APK（沒有就從 GitHub Release 下載），偵測平板並安裝，裝好自動開啟 App。
- 平板擋 USB 安裝（小米等）會顯示設定步驟並在平板開啟「開發人員選項」，設定後按 Enter 重試
- 簽章不同 / 版本較新會詢問是否解除舊版後重裝
- USB 安裝不行時可改為推送到平板「Download」資料夾手動點安裝
- 參數：`-Latest` 先下載 GitHub 最新版、`-Force` 相同版本也重裝、`-Apk 路徑` 指定檔案

## 來電與掛單（v1.3）

- **來電清單**：App 偵測來電（需允許「電話」與「通話紀錄」權限、平板要有電話功能），號碼出現在分頁下方的來電清單；來過的號碼顯示客戶名稱。也可按「＋」手動記錄。
- **長按來電號碼**：① 直接新增來電點餐（記錄電話與客戶名稱，名稱可空白之後再補）② 查詢歷史交易品項（可「再訂一次」）。
- **掛單**：未付款先送出（可列印取餐單），之後在「訂單條碼」輸入單號或刷條碼叫回，再按「找零結帳 / 結帳」，單號不變。
- **訂單條碼**：已付款的訂單叫回時只顯示內容並可補印。
- 試算表新增 `customers`（客戶）、`calls`（來電紀錄）工作表；訂單新增付款狀態、客戶電話與名稱欄位（自動補欄位）。

## 條碼輸入（條碼模組）

GAS 畫面上**所有輸入欄位**旁都有條碼按鈕（密碼、日期、單據版型表格除外），按下即呼叫 `條碼模組` 掃描，結果帶回該欄位：
- **Android App**：條碼模組原生掃描畫面（ML Kit + ZXing），經 `WebViewScanBridge` 回傳
- **電腦 / 手機瀏覽器**：GAS iframe 不能開相機，改開 GitHub Pages 的 `barcode/scan.html` 新視窗
- 文字欄位直接帶入；多行備註換行附加；數字欄位只接受數字；「今日訂單」掃小票條碼會自動查詢
- 實體條碼槍（鍵盤模式）照常可直接刷入

`條碼模組/` 是唯一來源；`scripts/sync_barcode.js` 會在測試與部署前自動同步到 `gas/src/BarcodeScanLib.html`、`docs/barcode/`，請勿手動修改這些產生檔。

## 自動化測試

| 測試 | 位置 | 執行 |
|---|---|---|
| GAS 純邏輯（單號、EAN13、版型、列印工作） | `tests/gas/logic.test.js` | `npm run test:unit` |
| GAS 後端完整流程（記憶體版試算表模擬） | `tests/gas/api.test.js` | `npm run test:unit` |
| 外殼 ↔ GAS iframe ↔ 模擬 Android 橋接 端對端 | `tests/e2e/shell.e2e.test.js` | `npm run test:e2e` |
| 線上冒煙測試（真實 GAS + Pages） | `tests/live/live.test.js` | `PAGES_URL=... npm run test:live` |
| ESC/POS 編碼 JVM 單元測試 | `android/app/src/test` | GitHub Actions |
| App 載入外殼、GAS 握手、JS 橋接往返（模擬器） | `android/app/src/androidTest` | GitHub Actions |

`本機預覽.bat`：在電腦開本機模擬環境（不需 Google 帳號），瀏覽器開 <http://localhost:8080/> 即可操作 POS。

## 資料夾

```
gas/src/        GAS 後台：Config / Logic / Db / Api / Code / Seed(.js) + Index / Lookup / Styles(.html)
docs/           GitHub Pages 外殼：index.html、config.js
android/        Android App（Java，WebView + 藍牙 ESC/POS）
tests/          自動化測試
scripts/        setup.ps1、deploy.ps1、export_seed.py
ci/ci-cd.yml    GitHub Actions 工作流程（部署時自動複製到 .github/workflows/）
private/        APK 簽章金鑰（不會上傳 GitHub，請另外備份！遺失後新版 APK 無法覆蓋安裝）
```

## 注意事項

- **管理密碼**預設 1234，請到「後台管理 → 系統資訊」變更。後台管理與設定頁都需要密碼，後端也會驗證。
- GAS Web App 以「部署者身分執行、任何人可存取」，平板不需登入 Google；資料存在部署者的 Google 雲端硬碟。
- 每次部署都會建立一個 GAS 版本，Apps Script 上限 200 個版本，接近上限時可到編輯器「專案記錄」刪除舊版本。
- 列印設定（紙寬、編碼、濃度、行距、邊界、條碼寬度、開錢箱、切紙）存在試算表；**出單機選擇存在各台平板上**。
- 中文編碼預設 big5；若印出亂碼，改試 cp950 / gbk。
- 舊版 `WebPOS.py` 與 Access 資料庫完全不受影響，可並行使用。
- `api=health` 與 HTTP JSON API 只開放讀取 / 開單類功能；後台管理 API 只能從畫面（google.script.run + 密碼）呼叫。
