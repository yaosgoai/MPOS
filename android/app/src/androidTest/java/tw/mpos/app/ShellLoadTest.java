package tw.mpos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.webkit.WebView;

import androidx.test.ext.junit.rules.ActivityScenarioRule;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 模擬器自動化測試：App 開啟 → 載入 GitHub Pages 外殼 → 外殼載入 GAS iframe 並完成握手 → JS 橋接可往返。
 */
@RunWith(AndroidJUnit4.class)
public class ShellLoadTest {
    @Rule
    public ActivityScenarioRule<MainActivity> rule = new ActivityScenarioRule<>(MainActivity.class);

    private String eval(String js) throws Exception {
        AtomicReference<String> out = new AtomicReference<>();
        CountDownLatch latch = new CountDownLatch(1);
        rule.getScenario().onActivity(a -> {
            WebView w = a.getWebView();
            w.evaluateJavascript(js, v -> { out.set(v); latch.countDown(); });
        });
        assertTrue("evaluateJavascript 逾時", latch.await(10, TimeUnit.SECONDS));
        return out.get();
    }

    private void waitFor(String js, long timeoutMs, String what) throws Exception {
        long end = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < end) {
            if ("true".equals(eval(js))) return;
            Thread.sleep(1000);
        }
        throw new AssertionError("等待逾時：" + what + "；狀態=" + eval("JSON.stringify(window.MPOS_SHELL||null)"));
    }

    @Test
    public void shellLoadsGasAndBridgeWorks() throws Exception {
        waitFor("!!(window.MPOS_SHELL)", 60000, "外殼 index.html 載入");
        assertEquals("true", eval("!!window.AndroidPOS && window.MPOS_SHELL.native"));

        String info = eval("window.AndroidPOS.getInfo()");
        JSONObject o = new JSONObject(new JSONObject("{\"v\":" + info + "}").getString("v"));
        assertEquals(BuildConfig.VERSION_NAME, o.getString("app_version"));
        assertTrue("外殼來源應受信任", o.getBoolean("trusted"));

        // 非同步橋接往返（模擬器沒有藍牙，只驗證結果能回傳）
        eval("window.__r=null; var __o=MPOSNative.onResult; MPOSNative.onResult=function(i,ok,p){ if(i==='t1'){window.__r={ok:ok,p:p};} else __o(i,ok,p); }; AndroidPOS.call('t1','getInfo','{}'); true");
        waitFor("!!window.__r && window.__r.ok === true", 15000, "橋接 getInfo 回傳");

        // 條碼模組 WebView 橋接：WebView 支援 WEB_MESSAGE_LISTENER 時，外殼頁面要有 window.BarcodeBridge
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            assertEquals("true", eval("typeof window.BarcodeBridge === 'object' && typeof window.BarcodeBridge.postMessage === 'function'"));
        }

        // GAS iframe 完成握手（需已部署 GAS 並執行過 setup）
        waitFor("window.MPOS_SHELL.gasReady === true", 120000, "GAS 後台握手");
    }
}
