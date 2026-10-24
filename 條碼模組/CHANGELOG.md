# 變更紀錄

## 1.0.0（2026-10-24）

- 由 IPC2DO 待辦管理系統的掃描功能抽出為獨立模組
- 網頁：`barcode-scan.js`（即時掃描、照片辨識、驗證、投票）、`scan.html`、`demo.html`
- Android：`barcode-scanner` Library（ML Kit＋ZXing 備援、Activity Result API、WebView 橋接）
- 投票改為「2.5 秒內累計」、漏讀不歸零、擋部分讀值；ITF 至少 8 碼、需 3 次
- ZXing 備援改為多種縮放（解決實物 ITF 條碼只在特定縮放讀得到的問題）
- 通訊協定加入請求代碼 `id` 與來源限定，不再使用 `postMessage('*')`
- 共用測試資料 `test/vectors.json`；網頁規則測試 39/39 通過
