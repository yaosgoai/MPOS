package tw.com.acepillar.barcode;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import org.junit.Test;

import java.awt.image.BufferedImage;
import java.io.File;
import java.nio.ByteBuffer;

import javax.imageio.ImageIO;

/**
 * 以實物照片（test/images）測 ZXing 備援：模擬相機影像（0°／90° 轉向、三種距離），十字對準條碼。
 * 單元測試的工作目錄為模組目錄（android/barcode-scanner），照片在 ../../test/images。
 */
public class ZxingFallbackTest {

    private static final double[] SCALES = { 1.0, 1.5, 2.0 };
    private static final int[] ROTATIONS = { 0, 90 };

    @Test public void itfPhotoA() throws Exception { check("itf_2666432011_a.jpg", 0.545); }
    @Test public void itfPhotoB() throws Exception { check("itf_2666432011_b.jpg", 0.545); }

    /** barcodeCenterY：條碼中心在照片高度的比例（模擬使用者把十字對準條碼） */
    private static void check(String name, double barcodeCenterY) throws Exception {
        BufferedImage im = ImageIO.read(new File("../../test/images/" + name));
        for (double scale : SCALES) {
            for (int rot : ROTATIONS) {
                int W = (int) (im.getWidth() * scale), H = (int) (im.getHeight() * scale);
                int cy = (int) (H * barcodeCenterY), ch = Math.min(cy, H - cy) * 2, top = cy - ch / 2;
                byte[] up = new byte[W * ch];   // 轉正後、以條碼為中心的灰階畫面
                for (int y = 0; y < ch; y++) for (int x = 0; x < W; x++) {
                    int p = im.getRGB((int) (x / scale), (int) ((top + y) / scale));
                    up[y * W + x] = (byte) ((((p >> 16) & 255) * 299 + ((p >> 8) & 255) * 587 + (p & 255) * 114) / 1000);
                }
                int sw = rot % 180 == 0 ? W : ch, sh = rot % 180 == 0 ? ch : W;   // 感光元件方向（未轉正）
                byte[] s = new byte[sw * sh];
                for (int y = 0; y < ch; y++) for (int x = 0; x < W; x++) {
                    int sx = rot == 90 ? y : x, sy = rot == 90 ? sh - 1 - x : y;
                    s[sy * sw + sx] = up[y * W + x];
                }
                ZxingFallback.Decoded d = new ZxingFallback().decodeCenterBand(ByteBuffer.wrap(s), sw, sh, sw, 1, rot);
                assertNotNull(name + " scale=" + scale + " rot=" + rot, d);
                assertEquals(Format.ITF, d.format);
                assertEquals("2666432011", d.text);
            }
        }
    }
}
