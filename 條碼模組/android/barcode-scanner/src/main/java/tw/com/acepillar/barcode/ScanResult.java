package tw.com.acepillar.barcode;

import android.app.Activity;
import android.content.Intent;

import org.json.JSONObject;

/**
 * 掃描結果。規格：《條碼模組規格書》第 6.3 節（與網頁版結果物件欄位一致）。
 * status：ok／cancel／error；error 代碼：camera_permission、camera_unavailable、internal。
 */
public final class ScanResult {
    public static final String OK = "ok", CANCEL = "cancel", ERROR = "error";

    static final String EXTRA_STATUS = "barcode.status";
    static final String EXTRA_TEXT = "barcode.text";
    static final String EXTRA_FORMAT = "barcode.format";
    static final String EXTRA_ENGINE = "barcode.engine";
    static final String EXTRA_ERROR = "barcode.error";

    public final String status;
    public final String text;
    /** 格式代碼，例如 "itf" */
    public final String format;
    /** 辨識引擎：mlkit／zxing */
    public final String engine;
    public final String error;
    public final String requestId;

    ScanResult(String status, String text, String format, String engine, String error, String requestId) {
        this.status = status; this.text = text; this.format = format; this.engine = engine; this.error = error;
        this.requestId = requestId == null ? "" : requestId;
    }

    public boolean isOk() { return OK.equals(status) && text != null; }

    static ScanResult parse(int resultCode, Intent data, String requestId) {
        if (data == null) return new ScanResult(CANCEL, null, null, null, null, requestId);
        String st = data.getStringExtra(EXTRA_STATUS);
        if (st == null) st = resultCode == Activity.RESULT_OK ? OK : CANCEL;
        return new ScanResult(st, data.getStringExtra(EXTRA_TEXT), data.getStringExtra(EXTRA_FORMAT),
                data.getStringExtra(EXTRA_ENGINE), data.getStringExtra(EXTRA_ERROR), requestId);
    }

    /** 轉成 JSON（WebView 橋接回傳網頁用；欄位同網頁版 barcode-result 訊息） */
    public JSONObject toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("t", "barcode-result").put("v", 1).put("id", requestId).put("status", status);
            if (text != null) o.put("text", text);
            if (format != null) o.put("format", format);
            if (engine != null) o.put("engine", engine);
            if (error != null) o.put("error", error);
        } catch (Exception ignored) { }
        return o;
    }
}
