package tw.com.acepillar.barcode;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.Map;

/**
 * ZXing 備援辨識（一維條碼）：讀「轉正後畫面中央、穿過十字的水平帶」。
 * 用於 ML Kit 讀不到的情況（例如非 14 碼的 ITF、條碼前後空白不足）。
 * 不依賴 Android 類別，可在一般 JVM 單元測試（見 src/test）。
 * 規格：《條碼模組規格書》第 4.2 節。非執行緒安全（每個掃描畫面用一個實例）。
 */
public final class ZxingFallback {

    /** 辨識結果 */
    public static final class Decoded {
        public final Format format;
        public final String text;
        Decoded(Format format, String text) { this.format = format; this.text = text; }
    }

    /** 水平帶高度（佔轉正後畫面高度的百分比），由窄到寬依序嘗試 */
    private static final int[] BAND_HEIGHT_PERCENT = { 12, 20 };
    /** 水平帶寬度（佔畫面寬度的百分比） */
    private static final int BAND_WIDTH_PERCENT = 92;
    /** 縮放比例（百分比），依序嘗試 */
    private static final int[] SCALE_PERCENT = { 100, 80, 65, 50, 40 };

    private final MultiFormatReader reader = new MultiFormatReader();

    public ZxingFallback() {
        Map<DecodeHintType, Object> h = new EnumMap<>(DecodeHintType.class);
        h.put(DecodeHintType.POSSIBLE_FORMATS, Arrays.asList(BarcodeFormat.ITF, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
                BarcodeFormat.CODE_93, BarcodeFormat.CODABAR, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E));
        h.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        h.put(DecodeHintType.ALLOWED_LENGTHS, new int[]{ 6, 8, 10, 12, 14, 16, 18, 20, 22, 24 });   // ITF 允許長度（ZXing 預設只有 6～14）
        reader.setHints(h);
    }

    /**
     * @param y           亮度（Y）平面
     * @param width       感光元件影像寬度（未轉正）
     * @param height      感光元件影像高度（未轉正）
     * @param rowStride   每列位元組數
     * @param pixelStride 每像素位元組數（通常 1）
     * @param rotation    轉正需順時針旋轉的角度：0／90／180／270（CameraX ImageInfo.getRotationDegrees()）
     * @return 讀到且屬一維條碼時回傳結果，否則 null
     */
    public Decoded decodeCenterBand(ByteBuffer y, int width, int height, int rowStride, int pixelStride, int rotation) {
        int rot = ((rotation % 360) + 360) % 360;
        int dw = rot % 180 == 0 ? width : height, dh = rot % 180 == 0 ? height : width;   // 轉正後尺寸
        int bw = dw * BAND_WIDTH_PERCENT / 100, bx = (dw - bw) / 2;
        for (int pct : BAND_HEIGHT_PERCENT) {
            int bh = Math.min(dh, Math.max(40, dh * pct / 100));
            int by = Math.max(0, dh / 2 - bh / 2);
            if (by + bh > dh) bh = dh - by;
            byte[] out = new byte[bw * bh];
            for (int yy = 0; yy < bh; yy++) {
                for (int xx = 0; xx < bw; xx++) {
                    int X = bx + xx, Y = by + yy, sx, sy;
                    switch (rot) {
                        case 90: sx = Y; sy = height - 1 - X; break;
                        case 180: sx = width - 1 - X; sy = height - 1 - Y; break;
                        case 270: sx = width - 1 - Y; sy = X; break;
                        default: sx = X; sy = Y;
                    }
                    out[yy * bw + xx] = y.get(sy * rowStride + sx * pixelStride);
                }
            }
            // ZXing 對一維條碼的線寬很敏感（實測同一張照片只在特定縮放比例讀得到）：同一水平帶依序試多種縮放
            for (int sp : SCALE_PERCENT) {
                int ow = Math.max(1, bw * sp / 100), oh = Math.max(1, bh * sp / 100);
                byte[] img = sp == 100 ? out : downscale(out, bw, bh, ow, oh);
                try {
                    Result r = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(
                            new PlanarYUVLuminanceSource(img, ow, oh, 0, 0, ow, oh, false))));
                    Format f = map(r.getBarcodeFormat());
                    if (f != Format.UNKNOWN && r.getText() != null && !r.getText().isEmpty()) return new Decoded(f, r.getText());
                } catch (Exception ignored) {   // NotFoundException 等＝讀不到
                } finally {
                    reader.reset();
                }
            }
        }
        return null;
    }

    /** 面積平均縮小（灰階） */
    static byte[] downscale(byte[] src, int sw, int sh, int dw, int dh) {
        byte[] dst = new byte[dw * dh];
        for (int y = 0; y < dh; y++) {
            int y0 = y * sh / dh, y1 = Math.max(y0 + 1, (y + 1) * sh / dh);
            for (int x = 0; x < dw; x++) {
                int x0 = x * sw / dw, x1 = Math.max(x0 + 1, (x + 1) * sw / dw), sum = 0, n = 0;
                for (int yy = y0; yy < y1; yy++) for (int xx = x0; xx < x1; xx++) { sum += src[yy * sw + xx] & 0xFF; n++; }
                dst[y * dw + x] = (byte) (sum / n);
            }
        }
        return dst;
    }

    static Format map(BarcodeFormat f) {
        switch (f) {
            case ITF: return Format.ITF;
            case CODE_128: return Format.CODE_128;
            case CODE_39: return Format.CODE_39;
            case CODE_93: return Format.CODE_93;
            case CODABAR: return Format.CODABAR;
            case EAN_13: return Format.EAN_13;
            case EAN_8: return Format.EAN_8;
            case UPC_A: return Format.UPC_A;
            case UPC_E: return Format.UPC_E;
            default: return Format.UNKNOWN;
        }
    }
}
