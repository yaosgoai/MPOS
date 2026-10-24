# 條碼模組：使用端開啟程式碼縮減（minify）時保留的類別
-keep class tw.com.acepillar.barcode.ScanOptions { *; }
-keep class tw.com.acepillar.barcode.ScanResult { *; }
-keep class tw.com.acepillar.barcode.BarcodeScannerActivity
-dontwarn com.google.zxing.**
