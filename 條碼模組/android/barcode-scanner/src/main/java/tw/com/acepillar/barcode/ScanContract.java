package tw.com.acepillar.barcode;

import android.content.Context;
import android.content.Intent;

import androidx.activity.result.contract.ActivityResultContract;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

/**
 * 對外唯一的呼叫入口（AndroidX Activity Result API）。
 *
 * <pre>
 * // 在 Activity／Fragment 的 onCreate 註冊
 * ActivityResultLauncher&lt;ScanOptions&gt; scan = registerForActivityResult(new ScanContract(), r -&gt; {
 *     if (r.isOk()) use(r.text, r.format);
 * });
 * // 需要掃描時
 * scan.launch(new ScanOptions().confirm(true));
 * </pre>
 * 規格：《條碼模組規格書》第 6.2 節。
 */
public final class ScanContract extends ActivityResultContract<ScanOptions, ScanResult> {
    private String lastRequestId = "";

    @NonNull
    @Override
    public Intent createIntent(@NonNull Context context, ScanOptions options) {
        ScanOptions o = options == null ? new ScanOptions() : options;
        lastRequestId = o.requestId;
        Intent i = new Intent(context, BarcodeScannerActivity.class);
        o.writeTo(i);
        return i;
    }

    @Override
    public ScanResult parseResult(int resultCode, @Nullable Intent intent) {
        return ScanResult.parse(resultCode, intent, lastRequestId);
    }
}
