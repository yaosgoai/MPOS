package tw.mpos.app;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JS 介面 window.AndroidPOS（只給 GitHub Pages 外殼使用）
 *   getInfo()                         同步回傳 App 資訊
 *   call(id, method, paramsJson)      非同步，完成後呼叫 window.MPOSNative.onResult(id, ok, payload)
 */
public class PosBridge {
    private static final String TAG = "MPOS";
    private final WebView webView;
    private final BluetoothPrinter printer;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final String allowedOrigin;
    private volatile String currentUrl = "";

    public PosBridge(WebView webView, BluetoothPrinter printer, String shellUrl) {
        this.webView = webView;
        this.printer = printer;
        this.allowedOrigin = originOf(shellUrl);
    }

    static String originOf(String url) {
        try {
            Uri u = Uri.parse(url);
            String o = u.getScheme() + "://" + u.getHost();
            return u.getPort() > 0 ? o + ":" + u.getPort() : o;
        } catch (Exception e) {
            return "";
        }
    }

    /** 由 WebViewClient 在 UI 執行緒更新 */
    public void setCurrentUrl(String url) {
        currentUrl = url == null ? "" : url;
    }

    private boolean trusted() {
        return !allowedOrigin.isEmpty() && originOf(currentUrl).equals(allowedOrigin);
    }

    @JavascriptInterface
    public String getInfo() {
        JSONObject o = new JSONObject();
        try {
            o.put("app_version", BuildConfig.VERSION_NAME);
            o.put("version_code", BuildConfig.VERSION_CODE);
            o.put("shell_url", BuildConfig.SHELL_URL);
            o.put("bluetooth_permission", printer.hasPermission());
            JSONObject p = new JSONObject();
            if (trusted()) {
                p.put("name", printer.getName());
                p.put("address", printer.getAddress());
            }
            o.put("printer", p);
            o.put("trusted", trusted());
        } catch (Exception ignored) { }
        return o.toString();
    }

    @JavascriptInterface
    public void call(final String id, final String method, final String paramsJson) {
        if (!trusted()) {
            respond(id, false, "不受信任的頁面來源：" + currentUrl);
            return;
        }
        worker.execute(() -> {
            try {
                JSONObject params = new JSONObject(paramsJson == null || paramsJson.isEmpty() ? "{}" : paramsJson);
                JSONObject result = handle(method, params);
                respond(id, true, result.toString());
            } catch (Throwable e) {
                Log.w(TAG, "bridge " + method + " 失敗", e);
                respond(id, false, e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    private JSONObject handle(String method, JSONObject params) throws Exception {
        JSONObject r = new JSONObject();
        switch (method) {
            case "getInfo":
                return new JSONObject(getInfo());
            case "listPrinters":
                r.put("devices", printer.listBondedDevices());
                return r;
            case "setPrinter": {
                printer.setPrinter(params.optString("address"), params.optString("name"));
                JSONObject p = new JSONObject();
                p.put("name", printer.getName());
                p.put("address", printer.getAddress());
                r.put("printer", p);
                return r;
            }
            case "print": {
                PrintJob job = JobParser.parse(params.optJSONObject("job"));
                byte[] data = EscPosEncoder.encode(job);
                printer.write(data);
                r.put("printer", printer.getName().isEmpty() ? printer.getAddress() : printer.getName());
                r.put("bytes", data.length);
                r.put("order_no", job.orderNo);
                return r;
            }
            case "openDrawer":
                printer.write(EscPosEncoder.cashDrawerCommand());
                r.put("printer", printer.getName());
                return r;
            default:
                throw new IllegalArgumentException("不支援的方法：" + method);
        }
    }

    private void respond(String id, boolean ok, String payload) {
        final String js = "window.MPOSNative && window.MPOSNative.onResult("
                + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(payload == null ? "" : payload) + ")";
        main.post(() -> webView.evaluateJavascript(js, null));
    }

    public void shutdown() {
        worker.shutdownNow();
        printer.closeQuietly();
    }
}
