package tw.mpos.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.nio.charset.Charset;
import java.util.Arrays;

import org.json.JSONObject;
import org.junit.Test;

public class EscPosEncoderTest {

    static int indexOf(byte[] data, byte[] pat) {
        outer:
        for (int i = 0; i <= data.length - pat.length; i++) {
            for (int j = 0; j < pat.length; j++) if (data[i + j] != pat[j]) continue outer;
            return i;
        }
        return -1;
    }

    @Test
    public void ean13CheckDigitMatchesGas() {
        assertEquals("4", Ean13.checkDigit("200000704001"));
        assertEquals("1", Ean13.checkDigit("400638133393"));
        assertTrue(Ean13.isValid("2000007040014"));
        assertEquals(117, Ean13.bits("2000007040014").length());
    }

    @Test
    public void rasterBarcodeHeaderAndSize() {
        byte[] r = EscPosEncoder.ean13Raster("2000007040014", 384, 88, 80);
        // GS v 0 m xL xH yL yH
        assertEquals(0x1D, r[0]);
        assertEquals(0x76, r[1]);
        int widthBytes = (r[4] & 0xFF) | ((r[5] & 0xFF) << 8);
        int height = (r[6] & 0xFF) | ((r[7] & 0xFF) << 8);
        assertEquals(80, height);
        assertTrue(widthBytes * 8 <= 384);
        assertEquals(8 + widthBytes * height + 1, r.length);
        // 80mm 紙寬條碼較寬
        byte[] wide = EscPosEncoder.ean13Raster("2000007040014", 576, 88, 80);
        assertTrue((wide[4] & 0xFF) > (r[4] & 0xFF));
    }

    @Test
    public void encodeReceiptFromGasJson() throws Exception {
        String json = "{\"order_no\":\"202607040001\",\"ean13\":\"2000007040014\","
                + "\"printer\":{\"paper_width_mm\":58,\"encoding\":\"big5\",\"darkness\":\"dark\",\"line_spacing_percent\":100,"
                + "\"open_cash_drawer\":true,\"cut_paper\":true,\"feed_lines_after\":3,\"margin_left_mm\":4},"
                + "\"lines\":[{\"role\":\"barcode\",\"text\":\"\",\"align\":\"center\"},"
                + "{\"role\":\"shop_name\",\"text\":\"茉莉花鯛魚燒\",\"font_pt\":16,\"bold\":true,\"align\":\"left\"},"
                + "{\"role\":\"total\",\"text\":\"合計：90 元\",\"font_pt\":12,\"bold\":true,\"space_before\":12}]}";
        PrintJob job = JobParser.parse(new JSONObject(json));
        assertEquals(3, job.lines.size());
        byte[] out = EscPosEncoder.encode(job);

        assertArrayEquals(new byte[]{0x1B, 0x40}, Arrays.copyOf(out, 2));            // ESC @
        assertTrue(indexOf(out, new byte[]{0x1B, 0x37, 0x09, 0x70, 0x02}) > 0);      // 濃
        assertTrue(indexOf(out, new byte[]{0x1D, 0x76, 0x30, 0x00}) > 0);            // 條碼
        assertTrue(indexOf(out, new byte[]{0x1D, 0x21, 0x11}) > 0);                  // 雙寬雙高
        assertTrue(indexOf(out, new byte[]{0x1B, 0x45, 0x01}) > 0);                  // 粗體
        Charset big5 = EscPosEncoder.charsetFor("big5");
        assertTrue("店名以 Big5 編碼且左邊界 2 個空白", indexOf(out, ("  茉莉花鯛魚燒").getBytes(big5)) > 0);
        assertTrue(indexOf(out, "合計：90 元".getBytes(big5)) > 0);
        assertTrue(indexOf(out, new byte[]{0x1D, 0x56, 0x00}) > 0);                  // 切紙
        byte[] drawer = EscPosEncoder.cashDrawerCommand();
        assertArrayEquals(drawer, Arrays.copyOfRange(out, out.length - drawer.length, out.length));
    }

    @Test
    public void charsetFallbacks() {
        assertEquals("Big5", EscPosEncoder.charsetFor("big5").name());
        assertEquals("GBK", EscPosEncoder.charsetFor("gbk").name());
        assertEquals("UTF-8", EscPosEncoder.charsetFor("utf-8").name());
        assertTrue(EscPosEncoder.charsetFor("cp950").name().toLowerCase().contains("950")
                || EscPosEncoder.charsetFor("cp950").name().equals("Big5"));
    }

    @Test(expected = org.json.JSONException.class)
    public void emptyJobRejected() throws Exception {
        JobParser.parse(new JSONObject("{\"lines\":[]}"));
    }
}
