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
   - 最後自動執行一次「一鍵部署」
2. 部署完成後，APK 會下載到 `dist\`，複製到平板安裝（或接 USB 由腳本用 adb 直接安裝）。
3. 平板先到「設定 → 藍牙」配對出單機，再開 App →「設定」頁（管理密碼預設 **1234**）→ 選擇出單機 →「設為出單機」→「測試列印」。

## 日常部署

雙擊 **`一鍵部署.bat`**，會依序：

| 步驟 | 內容 |
|---|---|
| 1 | 本機自動化測試（GAS 單元測試、外殼 + POS 端對端測試） |
| 2 | `clasp push` 並更新同一個 GAS 部署（網址不變） |
| 3 | GAS 線上健康檢查 `?api=health` |
| 4 | 寫入 `docs/config.js`，git commit / push |
| 5 | 等待 GitHub Actions：測試 → 部署 Pages → 線上冒煙測試 → 編譯 APK → Android 模擬器自動化測試 → 發佈 Release |
| 6 | 下載 APK 到 `dist\`，偵測到 Android 裝置可直接安裝 |

參數（在 PowerShell 執行 `scripts\deploy.ps1`）：`-SkipTests`、`-SkipGas`、`-NoWait`、`-Message "說明"`。
commit 訊息含 `[skip emulator]` 可略過模擬器測試。

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
- **畫面縮放 / 條碼確認方式**存在各台裝置（設定 → 系統資訊與本機畫面），選了立即生效，不必按「儲存設定」。預設「自動符合螢幕」讓 POS 點餐剛好一頁。
- **來電錄音**：在「來電記錄」長按一筆記錄會自動搜尋並播放該通電話的小米通話錄音（`MIUI/sound_recorder/call_rec`、`Recordings/call_rec` 等資料夾，檔名含電話號碼與時間）。需在小米「電話 → 設定 → 通話錄音」開啟自動錄音，並允許 App 的「音樂和音訊」權限；錄音檔在通話結束後才會產生。
