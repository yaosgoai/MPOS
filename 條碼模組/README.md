# 條碼模組

手機／電腦相機讀取條碼的共用模組（Android 原生＋網頁）。完整規格見《條碼模組規格書.md》。

## 網頁：3 行引用

```html
<script src="barcode-scan.js"></script>
<script>
  BarcodeScan.scanLive({ scanPageUrl: 'https://<部署網域>/scan.html' })
    .then(r => { if (r.status === 'ok') console.log(r.format, r.text); });
</script>
```

- 照片辨識：`BarcodeScan.decodeFile(file).then(r => r && console.log(r.text))`
- 部署：把 `web/` 三個檔案放到可開相機的 HTTPS 網域（例如 GitHub Pages）
- 試用：開啟 `web/demo.html`

## Android：加入模組

`settings.gradle`
```gradle
include ':barcode-scanner'
project(':barcode-scanner').projectDir = new File(settingsDir, '<相對路徑>/條碼模組/android/barcode-scanner')
```
`app/build.gradle`
```gradle
implementation project(':barcode-scanner')
```
程式
```java
ActivityResultLauncher<ScanOptions> scan = registerForActivityResult(new ScanContract(), r -> {
    if (r.isOk()) use(r.text);
});
scan.launch(new ScanOptions());
```
App 內嵌網頁要用原生掃描：`WebViewScanBridge.install(this, webView, Set.of("https://<網頁網域>"));`

## 測試

```bash
node test/rules.test.js                 # 網頁版規則
./gradlew :barcode-scanner:test         # Android 規則
```
共用測試資料：`test/vectors.json`；實物條碼照片：`test/images/`。
