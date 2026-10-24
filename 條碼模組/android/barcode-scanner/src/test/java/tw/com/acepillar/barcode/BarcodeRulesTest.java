package tw.com.acepillar.barcode;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 與 test/vectors.json 的 rules／requiredReads／voter 相同的測試案例（網頁版 rules.test.js 也測同一份資料）。
 * 執行：./gradlew :barcode-scanner:test
 */
public class BarcodeRulesTest {

    private static void v(String fmt, String text, boolean expected) {
        assertEquals(fmt + " " + text, expected, BarcodeRules.isValid(Format.fromKey(fmt), text));
    }

    @Test public void rules() {
        v("itf", "2666432011", true);
        v("itf", "432011", false);
        v("itf", "266643201", false);
        v("itf", "15400141288763", true);
        v("itf", "15400141288764", false);
        v("ean_13", "4710088410000", false);
        v("ean_13", "4006381333931", true);
        v("ean_8", "96385074", true);
        v("upc_a", "036000291452", true);
        v("upc_a", "036000291453", false);
        v("code_39", "AB-12", true);
        v("code_39", "ab", false);
        v("code_128", "A", false);
        v("codabar", "A1234B", true);
        v("qr_code", "https://example.com/?a=1", true);
        v("qr_code", "abc�", false);
        v("code_128", "AB\u0001C", false);
    }

    @Test public void requiredReads() {
        assertEquals(2, BarcodeRules.requiredReads(Format.QR_CODE));
        assertEquals(3, BarcodeRules.requiredReads(Format.ITF));
        assertEquals(3, BarcodeRules.requiredReads(Format.EAN_13));
        assertEquals(4, BarcodeRules.requiredReads(Format.CODE_39));
        assertEquals(4, BarcodeRules.requiredReads(Format.CODABAR));
    }

    @Test public void voterAcceptsWithinWindow() {
        ReadVoter vt = new ReadVoter(2500);
        assertFalse(vt.add(Format.ITF, "2666432011", 0));
        assertFalse(vt.add(Format.ITF, "2666432011", 400));
        assertTrue(vt.add(Format.ITF, "2666432011", 900));
    }

    @Test public void voterExpiresOldReads() {
        ReadVoter vt = new ReadVoter(2500);
        assertFalse(vt.add(Format.ITF, "2666432011", 0));
        assertFalse(vt.add(Format.ITF, "2666432011", 1000));
        assertFalse(vt.add(Format.ITF, "2666432011", 3000));
        assertTrue(vt.add(Format.ITF, "2666432011", 3400));
    }

    @Test public void voterRejectsPartialRead() {
        ReadVoter vt = new ReadVoter(2500);
        assertFalse(vt.add(Format.ITF, "2666432011", 0));
        assertFalse(vt.add(Format.ITF, "66643201", 100));
        assertFalse(vt.add(Format.ITF, "66643201", 200));
        assertFalse(vt.add(Format.ITF, "66643201", 300));
        assertFalse(vt.add(Format.ITF, "2666432011", 400));
        assertTrue(vt.add(Format.ITF, "2666432011", 500));
    }
}
