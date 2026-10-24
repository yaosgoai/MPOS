package tw.com.acepillar.barcode;

/**
 * 讀值驗證與需讀到次數（防呆規則）。
 * 規格：《條碼模組規格書》第 5 章；網頁版 barcode-scan.js 的 validate()／requiredReads() 必須與此一致，
 * 以 test/vectors.json 的 rules 測試資料驗證。
 */
public final class BarcodeRules {
    private BarcodeRules() { }

    /** ITF 最少碼數（擋掉只讀到一段的部分讀值） */
    public static final int ITF_MIN_LENGTH = 8;

    /** 讀值是否合理：亂碼／控制字元、長度、純數字格式、EAN／UPC／ITF-14 檢查碼 */
    public static boolean isValid(Format f, String v) {
        if (v == null || v.trim().isEmpty()) return false;
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c == '\uFFFD') return false;                                                     // 解碼失敗的替代字元
            if (c < 0x20 && c != '\n' && c != '\r' && c != '\t' && c != 0x1D) return false;      // 控制字元（GS1 分隔符 0x1D 除外）
        }
        switch (f) {
            case EAN_13: return v.matches("\\d{13}") && eanCheck(v);
            case EAN_8: return v.matches("\\d{8}") && eanCheck(v);
            case UPC_A: return v.matches("\\d{12}") && eanCheck(v);
            case UPC_E: return v.matches("\\d{6,8}");
            case ITF: return v.matches("\\d{" + ITF_MIN_LENGTH + ",}") && v.length() % 2 == 0 && (v.length() != 14 || eanCheck(v));
            case CODABAR: return v.replaceAll("[ABCDabcd]", "").length() >= 4;
            case CODE_39: return v.length() >= 3 && v.matches("[0-9A-Z \\-.$/+%*]+");
            case CODE_93: return v.length() >= 3;
            case CODE_128: return v.length() >= 2;
            default: return true;   // QR／Data Matrix／PDF417／Aztec 本身有錯誤更正
        }
    }

    /** 同一內容需讀到幾次才採用：二維碼 2；EAN／UPC／Code128／ITF 3；Code39／93、Codabar 4 */
    public static int requiredReads(Format f) {
        switch (f) {
            case CODE_39: case CODE_93: case CODABAR: return 4;
            default: return f.oneD ? 3 : 2;
        }
    }

    /** EAN／UPC／ITF-14 檢查碼（最後一碼，GS1 Mod 10） */
    public static boolean eanCheck(String d) {
        int sum = 0, n = d.length();
        if (n < 2) return false;
        for (int i = 0; i < n - 1; i++) {
            int x = d.charAt(n - 2 - i) - '0';
            sum += (i % 2 == 0) ? x * 3 : x;
        }
        return (10 - sum % 10) % 10 == d.charAt(n - 1) - '0';
    }
}
