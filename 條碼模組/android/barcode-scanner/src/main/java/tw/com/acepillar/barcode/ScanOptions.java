package tw.com.acepillar.barcode;

import android.content.Intent;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * 掃描選項（以 Intent extras 傳給 BarcodeScannerActivity）。
 * 規格：《條碼模組規格書》第 6.1 節；與網頁版 scanLive(options) 的欄位名稱一致。
 *
 * <pre>
 * new ScanOptions().formats("itf", "code_128").confirm(true).hint("把十字對準條碼");
 * </pre>
 */
public final class ScanOptions {
    static final String EXTRA_FORMATS = "barcode.formats";
    static final String EXTRA_CONFIRM = "barcode.confirm";
    static final String EXTRA_WINDOW = "barcode.voteWindowMs";
    static final String EXTRA_HINT = "barcode.hint";
    static final String EXTRA_FALLBACK = "barcode.zxingFallback";
    static final String EXTRA_REQUEST_ID = "barcode.requestId";

    /** 允許的格式代碼；空白＝全部 */
    public final List<String> formats = new ArrayList<>();
    /** 讀到後是否顯示確認畫面（預設 true） */
    public boolean confirm = true;
    /** 投票時間視窗（毫秒，預設 2500） */
    public long voteWindowMs = ReadVoter.DEFAULT_WINDOW_MS;
    /** 畫面下方提示文字；null＝預設 */
    public String hint = null;
    /** ML Kit 讀不到時是否用 ZXing 備援（預設 true） */
    public boolean zxingFallback = true;
    /** 呼叫端自訂的請求代碼，原樣帶回 ScanResult（WebView 橋接用） */
    public String requestId = "";

    public ScanOptions formats(String... keys) { formats.clear(); formats.addAll(Arrays.asList(keys)); return this; }
    public ScanOptions confirm(boolean v) { confirm = v; return this; }
    public ScanOptions voteWindowMs(long v) { voteWindowMs = v; return this; }
    public ScanOptions hint(String v) { hint = v; return this; }
    public ScanOptions zxingFallback(boolean v) { zxingFallback = v; return this; }
    public ScanOptions requestId(String v) { requestId = v == null ? "" : v; return this; }

    void writeTo(Intent i) {
        i.putStringArrayListExtra(EXTRA_FORMATS, new ArrayList<>(formats));
        i.putExtra(EXTRA_CONFIRM, confirm);
        i.putExtra(EXTRA_WINDOW, voteWindowMs);
        if (hint != null) i.putExtra(EXTRA_HINT, hint);
        i.putExtra(EXTRA_FALLBACK, zxingFallback);
        i.putExtra(EXTRA_REQUEST_ID, requestId);
    }

    static ScanOptions readFrom(Intent i) {
        ScanOptions o = new ScanOptions();
        if (i == null) return o;
        ArrayList<String> f = i.getStringArrayListExtra(EXTRA_FORMATS);
        if (f != null) o.formats.addAll(f);
        o.confirm = i.getBooleanExtra(EXTRA_CONFIRM, true);
        o.voteWindowMs = i.getLongExtra(EXTRA_WINDOW, ReadVoter.DEFAULT_WINDOW_MS);
        o.hint = i.getStringExtra(EXTRA_HINT);
        o.zxingFallback = i.getBooleanExtra(EXTRA_FALLBACK, true);
        String r = i.getStringExtra(EXTRA_REQUEST_ID);
        o.requestId = r == null ? "" : r;
        return o;
    }

    /** 此格式是否在允許清單內 */
    boolean allows(Format f) {
        if (formats.isEmpty()) return f != Format.UNKNOWN;
        for (String k : formats) if (Format.fromKey(k) == f) return true;
        return false;
    }
}
