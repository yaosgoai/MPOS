package tw.mpos.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;

import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Set;

import tw.com.acepillar.barcode.WebViewScanBridge;

/**
 * MPOS Android App：全螢幕 WebView 載入 GitHub Pages 外殼（index.html），
 * 外殼再以 iframe 載入 GAS 管理後台；列印透過 window.AndroidPOS 藍牙送出。
 */
public class MainActivity extends ComponentActivity {
    private static final int REQ_BT = 1001;
    private WebView webView;
    private PosBridge bridge;
    private WebViewScanBridge scanBridge;
    private CallMonitor callMonitor;

    public WebView getWebView() { return webView; }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        webView = new WebView(this);
        setContentView(webView);
        hideSystemBars();

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " MPOS-Android/" + BuildConfig.VERSION_NAME);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true); // GAS iframe 需要第三方 Cookie

        bridge = new PosBridge(webView, new BluetoothPrinter(this), BuildConfig.SHELL_URL);
        webView.addJavascriptInterface(bridge, "AndroidPOS");

        // 條碼模組：只注入到外殼網域與 GAS 網頁（含 iframe），網頁的掃描按鈕會自動改用原生相機掃描
        Set<String> scanOrigins = new LinkedHashSet<>(Arrays.asList(
                PosBridge.originOf(BuildConfig.SHELL_URL),
                "https://*.googleusercontent.com",
                "https://script.google.com"));
        scanBridge = WebViewScanBridge.install(this, webView, scanOrigins);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                bridge.setCurrentUrl(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                bridge.setCurrentUrl(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                Uri u = request.getUrl();
                String origin = PosBridge.originOf(u.toString());
                if (origin.equals(PosBridge.originOf(BuildConfig.SHELL_URL))) return false;
                // 其他網址（例如 APK 下載、Google 試算表）交給系統瀏覽器
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOffline(String.valueOf(error.getDescription()));
            }
        });

        if (savedInstanceState != null) webView.restoreState(savedInstanceState);
        else webView.loadUrl(BuildConfig.SHELL_URL);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() { showExitDialog(); }
        });

        requestRuntimePermissions();

        // 來電偵測：響鈴時把號碼送到 POS 畫面上方的來電清單
        callMonitor = new CallMonitor(this, phone -> {
            try {
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("phone", phone);
                o.put("at", System.currentTimeMillis());
                bridge.emitEvent("incoming_call", o);
            } catch (Exception ignored) { }
        });
        if (CallMonitor.hasPermissions(this)) callMonitor.start();
    }

    private void showOffline(String reason) {
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
                + "<body style='font-family:sans-serif;background:#f7efe3;color:#5e2808;text-align:center;padding-top:20vh'>"
                + "<h2>無法連線到 POS 系統</h2><p>" + android.text.Html.escapeHtml(reason) + "</p>"
                + "<button style='font-size:20px;padding:12px 24px;border:0;border-radius:12px;background:#8a3f12;color:#fff' "
                + "onclick=\"location.replace('" + BuildConfig.SHELL_URL + "')\">重新連線</button></body></html>";
        webView.loadDataWithBaseURL(BuildConfig.SHELL_URL, html, "text/html", "UTF-8", null);
    }

    /** 一次要求：藍牙（出單機）、電話狀態 + 通話紀錄（來電號碼） */
    private void requestRuntimePermissions() {
        java.util.List<String> need = new java.util.ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.BLUETOOTH_CONNECT);
        }
        if (CallMonitor.hasTelephony(this)) {
            if (checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.READ_PHONE_STATE);
            if (checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.READ_CALL_LOG);
        }
        if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), REQ_BT);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (callMonitor != null && CallMonitor.hasPermissions(this)) callMonitor.start();
    }

    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    private void showExitDialog() {
        new AlertDialog.Builder(this)
                .setTitle("離開 POS？")
                .setMessage("確定要關閉茉莉花鯛魚燒 POS 嗎？")
                .setPositiveButton("離開", (d, w) -> finish())
                .setNeutralButton("重新整理", (d, w) -> webView.loadUrl(BuildConfig.SHELL_URL))
                .setNegativeButton("取消", null)
                .show();
    }

    @Override
    protected void onDestroy() {
        if (callMonitor != null) callMonitor.stop();
        if (bridge != null) bridge.shutdown();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
