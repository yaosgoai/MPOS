package tw.com.acepillar.barcode;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.media.AudioManager;
import android.media.Image;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Size;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.OptIn;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ExperimentalGetImage;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.Preview;
import androidx.camera.core.SurfaceOrientedMeteringPointFactory;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.core.resolutionselector.ResolutionStrategy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 條碼即時掃描畫面：CameraX 預覽 + Google ML Kit；ML Kit 讀不到時以 ZXing 讀「穿過十字的水平帶」。
 * 讀值經 BarcodeRules 驗證、ReadVoter 投票後採用；可選擇顯示確認畫面。
 * 請勿直接啟動，改用 ScanContract。規格：《條碼模組規格書》第 4、6 章。
 */
public class BarcodeScannerActivity extends ComponentActivity {

    private ScanOptions opts;
    private ReadVoter voter;
    private ZxingFallback zxing;
    private ExecutorService exec;
    private BarcodeScanner scanner;
    private volatile boolean done = false;
    private PreviewView previewView;
    private View confirmBox;
    private ImageView confirmImg;
    private TextView confirmFmt, confirmText;
    private Format confirmFormat = Format.UNKNOWN;
    private String confirmEngine = "";

    private final ActivityResultLauncher<String> camPerm = registerForActivityResult(
            new ActivityResultContracts.RequestPermission(), granted -> {
                if (granted) startCamera();
                else finishWith(ScanResult.ERROR, null, null, null, "camera_permission");
            });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        opts = ScanOptions.readFrom(getIntent());
        voter = new ReadVoter(opts.voteWindowMs);
        zxing = opts.zxingFallback ? new ZxingFallback() : null;

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        previewView = new PreviewView(this);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        root.addView(previewView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(new FrameOverlay(this), new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView close = new TextView(this);
        close.setText("✕  取消");
        close.setTextColor(Color.WHITE);
        close.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        int pad = dp(14);
        close.setPadding(pad, pad + dp(20), pad, pad);
        close.setOnClickListener(v -> finishWith(ScanResult.CANCEL, null, null, null, null));
        root.addView(close, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.START));

        TextView hint = new TextView(this);
        hint.setText(opts.hint != null ? opts.hint : "把十字對準要讀的條碼，條碼盡量填滿方框寬度\n（一維條碼請橫放；點畫面可重新對焦）");
        hint.setTextColor(Color.WHITE);
        hint.setGravity(Gravity.CENTER);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        hint.setShadowLayer(4, 0, 0, Color.BLACK);
        FrameLayout.LayoutParams hp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        hp.bottomMargin = dp(90);
        root.addView(hint, hp);
        confirmBox = buildConfirm();
        confirmBox.setVisibility(View.GONE);
        root.addView(confirmBox, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        scanner = BarcodeScanning.getClient(new BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_ALL_FORMATS).build());
        exec = Executors.newSingleThreadExecutor();

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera();
        else camPerm.launch(Manifest.permission.CAMERA);
    }

    @Override
    public void onBackPressed() {
        finishWith(ScanResult.CANCEL, null, null, null, null);
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try {
                ProcessCameraProvider provider = future.get();
                Preview p = new Preview.Builder().build();
                p.setSurfaceProvider(previewView.getSurfaceProvider());
                // 一維條碼線條很細：分析影像用高解析度（預設 640x480 讀不到）
                ResolutionSelector rs = new ResolutionSelector.Builder()
                        .setResolutionStrategy(new ResolutionStrategy(new Size(1920, 1080), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                        .build();
                ImageAnalysis ia = new ImageAnalysis.Builder()
                        .setResolutionSelector(rs)
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build();
                ia.setAnalyzer(exec, this::analyze);
                provider.unbindAll();
                Camera cam = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, p, ia);
                focusCenter(cam);
                previewView.setOnClickListener(v -> focusCenter(cam));   // 點畫面＝重新對焦中央
            } catch (Exception e) {
                finishWith(ScanResult.ERROR, null, null, null, "camera_unavailable");
            }
        }, ContextCompat.getMainExecutor(this));
    }

    @OptIn(markerClass = ExperimentalGetImage.class)
    private void analyze(ImageProxy proxy) {
        Image img = proxy.getImage();
        if (img == null || done) { proxy.close(); return; }
        final int rot = proxy.getImageInfo().getRotationDegrees();
        InputImage in = InputImage.fromMediaImage(img, rot);
        // 條碼座標是「轉正後」的影像座標；影像中心＝畫面十字（預覽為置中裁切）
        final int iw = rot % 180 == 0 ? proxy.getWidth() : proxy.getHeight();
        final int ih = rot % 180 == 0 ? proxy.getHeight() : proxy.getWidth();
        final int cx = iw / 2, cy = ih / 2, tol = Math.max(4, Math.min(iw, ih) * 3 / 100);
        // 在分析執行緒處理結果：ML Kit 沒讀到時，要趁影像還沒關閉前改用 ZXing
        scanner.process(in).addOnCompleteListener(exec, task -> {
            try {
                if (done) return;
                List<Barcode> list = task.isSuccessful() && task.getResult() != null ? task.getResult() : new ArrayList<>();
                // 只讀「十字正對到」的條碼：外框（略放寬）須包含畫面中心；多個時取中心最接近十字者
                Barcode best = null; long bestDist = Long.MAX_VALUE;
                for (Barcode b : list) {
                    String v = b.getRawValue();
                    Rect r = b.getBoundingBox();
                    if (v == null || v.isEmpty() || r == null) continue;
                    if (!opts.allows(fromMlKit(b.getFormat()))) continue;
                    Rect hit = new Rect(r.left - tol, r.top - tol, r.right + tol, r.bottom + tol);
                    if (!hit.contains(cx, cy)) continue;
                    long dx = r.centerX() - cx, dy = r.centerY() - cy, dist = dx * dx + dy * dy;
                    if (dist < bestDist) { bestDist = dist; best = b; }
                }
                Format fmt = null; String val = null, engine = null;
                if (best != null && BarcodeRules.isValid(fromMlKit(best.getFormat()), best.getRawValue())) {
                    fmt = fromMlKit(best.getFormat()); val = best.getRawValue(); engine = "mlkit";
                } else if (zxing != null) {
                    ImageProxy.PlaneProxy y = proxy.getPlanes()[0];   // 亮度平面
                    ZxingFallback.Decoded d = zxing.decodeCenterBand(y.getBuffer(), proxy.getWidth(), proxy.getHeight(),
                            y.getRowStride(), y.getPixelStride(), rot);
                    if (d != null && opts.allows(d.format) && BarcodeRules.isValid(d.format, d.text)) { fmt = d.format; val = d.text; engine = "zxing"; }
                }
                if (val == null || !voter.add(fmt, val)) return;
                done = true;
                if (opts.confirm) showConfirm(fmt, val, engine);
                else {
                    final Format f = fmt; final String t = val, e = engine;
                    runOnUiThread(() -> { beep(); finishWith(ScanResult.OK, t, f, e, null); });
                }
            } catch (Exception ignored) {
            } finally {
                proxy.close();
            }
        });
    }

    static Format fromMlKit(int f) {
        switch (f) {
            case Barcode.FORMAT_QR_CODE: return Format.QR_CODE;
            case Barcode.FORMAT_DATA_MATRIX: return Format.DATA_MATRIX;
            case Barcode.FORMAT_PDF417: return Format.PDF417;
            case Barcode.FORMAT_AZTEC: return Format.AZTEC;
            case Barcode.FORMAT_EAN_13: return Format.EAN_13;
            case Barcode.FORMAT_EAN_8: return Format.EAN_8;
            case Barcode.FORMAT_UPC_A: return Format.UPC_A;
            case Barcode.FORMAT_UPC_E: return Format.UPC_E;
            case Barcode.FORMAT_CODE_128: return Format.CODE_128;
            case Barcode.FORMAT_CODE_39: return Format.CODE_39;
            case Barcode.FORMAT_CODE_93: return Format.CODE_93;
            case Barcode.FORMAT_ITF: return Format.ITF;
            case Barcode.FORMAT_CODABAR: return Format.CODABAR;
            default: return Format.UNKNOWN;
        }
    }

    private void finishWith(String status, String text, Format f, String engine, String error) {
        Intent data = new Intent();
        data.putExtra(ScanResult.EXTRA_STATUS, status);
        if (text != null) data.putExtra(ScanResult.EXTRA_TEXT, text);
        if (f != null) data.putExtra(ScanResult.EXTRA_FORMAT, f.key);
        if (engine != null) data.putExtra(ScanResult.EXTRA_ENGINE, engine);
        if (error != null) data.putExtra(ScanResult.EXTRA_ERROR, error);
        setResult(ScanResult.OK.equals(status) ? RESULT_OK : RESULT_CANCELED, data);
        finish();
    }

    /** 對焦／測光在畫面中央（十字位置），3 秒後自動取消 */
    private void focusCenter(Camera cam) {
        try {
            MeteringPoint pt = new SurfaceOrientedMeteringPointFactory(1f, 1f).createPoint(0.5f, 0.5f);
            FocusMeteringAction act = new FocusMeteringAction.Builder(pt, FocusMeteringAction.FLAG_AF | FocusMeteringAction.FLAG_AE)
                    .setAutoCancelDuration(3, TimeUnit.SECONDS).build();
            cam.getCameraControl().startFocusAndMetering(act);
        } catch (Exception ignored) { }
    }

    /* ---------------- 確認畫面：凍結當下畫面＋辨識內容，對照無誤再使用 ---------------- */
    private View buildConfirm() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(0xF0000000);
        box.setPadding(dp(16), dp(36), dp(16), dp(24));
        box.setClickable(true);
        TextView title = new TextView(this);
        title.setText("請對照畫面確認內容是否正確");
        title.setTextColor(Color.WHITE); title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18); title.setGravity(Gravity.CENTER);
        box.addView(title);
        confirmImg = new ImageView(this);
        confirmImg.setScaleType(ImageView.ScaleType.FIT_CENTER);
        LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        ip.topMargin = dp(10); ip.bottomMargin = dp(10);
        box.addView(confirmImg, ip);
        confirmFmt = new TextView(this);
        confirmFmt.setTextColor(0xFF9CA3AF); confirmFmt.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14); confirmFmt.setGravity(Gravity.CENTER);
        box.addView(confirmFmt);
        confirmText = new TextView(this);
        confirmText.setTextColor(Color.WHITE); confirmText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22); confirmText.setGravity(Gravity.CENTER);
        confirmText.setTextIsSelectable(true);
        confirmText.setPadding(0, dp(6), 0, dp(14));
        box.addView(confirmText);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        Button again = new Button(this); again.setText("↻ 重新掃描"); again.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        Button use = new Button(this); use.setText("✔ 正確，使用"); use.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        use.setTextColor(Color.WHITE); use.setBackgroundColor(0xFF1A73E8);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(0, dp(54), 1f);
        bp.setMargins(dp(6), 0, dp(6), 0);
        row.addView(again, bp);
        row.addView(use, new LinearLayout.LayoutParams(bp));
        box.addView(row);
        again.setOnClickListener(v -> { confirmBox.setVisibility(View.GONE); voter.reset(); done = false; });
        use.setOnClickListener(v -> finishWith(ScanResult.OK, String.valueOf(confirmText.getTag()), confirmFormat, confirmEngine, null));
        return box;
    }

    private void showConfirm(Format fmt, String text, String engine) {
        runOnUiThread(() -> {
            beep();
            Bitmap shot = null;
            try { shot = previewView.getBitmap(); } catch (Exception ignored) { }
            if (shot != null) {   // 只顯示取景框（中央正方形）
                int w = shot.getWidth(), h = shot.getHeight(), sz = (int) (Math.min(w, h) * 0.75f);
                try { shot = Bitmap.createBitmap(shot, (w - sz) / 2, (h - sz) / 2, sz, sz); } catch (Exception ignored) { }
            }
            confirmImg.setImageBitmap(shot);
            confirmFormat = fmt;
            confirmEngine = engine;
            confirmFmt.setText(fmt.label + "（已比對 " + BarcodeRules.requiredReads(fmt) + " 次一致）");
            confirmText.setText(text);
            confirmText.setTag(text);
            confirmBox.setVisibility(View.VISIBLE);
        });
    }

    @SuppressWarnings("deprecation")
    private void beep() {
        try { new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80).startTone(ToneGenerator.TONE_PROP_BEEP, 120); } catch (Exception ignored) { }
        try {
            Vibrator vib = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vib != null) {
                if (Build.VERSION.SDK_INT >= 26) vib.vibrate(VibrationEffect.createOneShot(80, VibrationEffect.DEFAULT_AMPLITUDE));
                else vib.vibrate(80);
            }
        } catch (Exception ignored) { }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (exec != null) exec.shutdown();
        if (scanner != null) scanner.close();
    }

    private int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density); }

    /** 取景框：外圍變暗、正方形框（四角加粗）、正中央十字 */
    private static class FrameOverlay extends View {
        private final Paint dim = new Paint(), border = new Paint(Paint.ANTI_ALIAS_FLAG), corner = new Paint(Paint.ANTI_ALIAS_FLAG), cross = new Paint(Paint.ANTI_ALIAS_FLAG);

        FrameOverlay(Context c) {
            super(c);
            float d = c.getResources().getDisplayMetrics().density;
            dim.setColor(0x99000000);
            border.setColor(0xCCFFFFFF); border.setStyle(Paint.Style.STROKE); border.setStrokeWidth(1.5f * d);
            corner.setColor(0xFF34D399); corner.setStyle(Paint.Style.STROKE); corner.setStrokeWidth(5 * d); corner.setStrokeCap(Paint.Cap.ROUND);
            cross.setColor(0xFFFF3B30); cross.setStyle(Paint.Style.STROKE); cross.setStrokeWidth(2.5f * d); cross.setStrokeCap(Paint.Cap.ROUND);
        }

        @Override
        protected void onDraw(Canvas cv) {
            float w = getWidth(), h = getHeight();
            float size = Math.min(w, h) * 0.7f;
            float l = (w - size) / 2, t = (h - size) / 2, r = l + size, b = t + size;
            cv.drawRect(0, 0, w, t, dim);
            cv.drawRect(0, b, w, h, dim);
            cv.drawRect(0, t, l, b, dim);
            cv.drawRect(r, t, w, b, dim);
            cv.drawRect(new RectF(l, t, r, b), border);
            float c = size * 0.12f;
            cv.drawLine(l, t, l + c, t, corner); cv.drawLine(l, t, l, t + c, corner);
            cv.drawLine(r, t, r - c, t, corner); cv.drawLine(r, t, r, t + c, corner);
            cv.drawLine(l, b, l + c, b, corner); cv.drawLine(l, b, l, b - c, corner);
            cv.drawLine(r, b, r - c, b, corner); cv.drawLine(r, b, r, b - c, corner);
            float cx = (l + r) / 2, cy = (t + b) / 2, k = size * 0.08f;
            cv.drawLine(cx - k, cy, cx + k, cy, cross);
            cv.drawLine(cx, cy - k, cx, cy + k, cross);
        }
    }
}
