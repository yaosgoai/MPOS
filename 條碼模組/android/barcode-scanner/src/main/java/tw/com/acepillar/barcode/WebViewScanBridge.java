package tw.com.acepillar.barcode;

import android.net.Uri;
import android.webkit.WebView;

import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Set;

/**
 * WebView 橋接（選用）：讓 App 內的網頁以 barcode-scan.js 呼叫原生掃描畫面。
 * 使用 androidx.webkit 的 WebMessageListener：只注入到「允許來源」的頁面（含 iframe），結果只回傳給發出請求的那個頁面，
 * 不用 addJavascriptInterface、不廣播 postMessage('*')。規格：《條碼模組規格書》第 7.3 節。
 *
 * <pre>
 * // Activity.onCreate（必須在 onCreate 內呼叫，因為要註冊 Activity Result）
 * WebViewScanBridge.install(this, webView, Set.of("https://example.github.io", "https://script.google.com"));
 * </pre>
 * 網頁端：BarcodeScan.scanLive() 會自動偵測 window.BarcodeBridge 並改用原生掃描。
 */
public final class WebViewScanBridge {
    /** 注入到網頁的物件名稱 */
    public static final String JS_NAME = "BarcodeBridge";

    private final ActivityResultLauncher<ScanOptions> launcher;
    private JavaScriptReplyProxy pendingReply;
    private String pendingId = "";

    private WebViewScanBridge(ComponentActivity activity) {
        launcher = activity.registerForActivityResult(new ScanContract(), this::onResult);
    }

    /**
     * @param allowedOriginRules 允許呼叫的網頁來源，例如 "https://example.github.io"、"https://*.example.com"（不可用 "*"）
     * @return 已安裝的橋接；此 WebView 版本不支援時回傳 null（網頁會自動改用瀏覽器相機或掃描頁）
     */
    public static WebViewScanBridge install(ComponentActivity activity, WebView web, Set<String> allowedOriginRules) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return null;
        final WebViewScanBridge b = new WebViewScanBridge(activity);
        WebViewCompat.addWebMessageListener(web, JS_NAME, allowedOriginRules,
                (WebView view, WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame, JavaScriptReplyProxy reply) ->
                        b.onMessage(message, reply));
        return b;
    }

    /** 網頁送來：{"t":"barcode-scan","v":1,"id":"…","formats":["itf"],"confirm":true} */
    private void onMessage(WebMessageCompat message, JavaScriptReplyProxy reply) {
        try {
            JSONObject o = new JSONObject(String.valueOf(message.getData()));
            if (!"barcode-scan".equals(o.optString("t"))) return;
            ScanOptions opts = new ScanOptions().requestId(o.optString("id")).confirm(o.optBoolean("confirm", true));
            JSONArray f = o.optJSONArray("formats");
            if (f != null) { String[] keys = new String[f.length()]; for (int i = 0; i < keys.length; i++) keys[i] = f.optString(i); opts.formats(keys); }
            if (o.has("hint")) opts.hint(o.optString("hint"));
            if (pendingReply != null) {   // 已有一個掃描進行中：先回覆前一個為取消
                sendCancel(pendingReply, pendingId);
            }
            pendingReply = reply;
            pendingId = opts.requestId;
            launcher.launch(opts);
        } catch (Exception e) {
            try { reply.postMessage(new JSONObject().put("t", "barcode-result").put("v", 1).put("status", "error").put("error", "bad_request").toString()); }
            catch (Exception ignored) { }
        }
    }

    private void onResult(ScanResult r) {
        JavaScriptReplyProxy reply = pendingReply;
        pendingReply = null;
        if (reply == null) return;
        try { reply.postMessage(r.toJson().toString()); } catch (Exception ignored) { }
    }

    private static void sendCancel(JavaScriptReplyProxy reply, String id) {
        try { reply.postMessage(new JSONObject().put("t", "barcode-result").put("v", 1).put("id", id).put("status", "cancel").toString()); }
        catch (Exception ignored) { }
    }
}
