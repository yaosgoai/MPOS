package tw.com.acepillar.barcode;

/**
 * 條碼格式（與網頁版 barcode-scan.js 的格式代碼一致：小寫加底線，例如 "itf"、"ean_13"）。
 * 規格：《條碼模組規格書》第 3 章。
 */
public enum Format {
    QR_CODE("qr_code", "QR Code", false),
    DATA_MATRIX("data_matrix", "Data Matrix", false),
    PDF417("pdf417", "PDF417", false),
    AZTEC("aztec", "Aztec", false),
    EAN_13("ean_13", "EAN-13", true),
    EAN_8("ean_8", "EAN-8", true),
    UPC_A("upc_a", "UPC-A", true),
    UPC_E("upc_e", "UPC-E", true),
    CODE_128("code_128", "Code 128", true),
    CODE_39("code_39", "Code 39", true),
    CODE_93("code_93", "Code 93", true),
    ITF("itf", "ITF", true),
    CODABAR("codabar", "Codabar", true),
    UNKNOWN("unknown", "條碼", false);

    /** 格式代碼（跨平台共用） */
    public final String key;
    /** 顯示名稱 */
    public final String label;
    /** 是否為一維條碼 */
    public final boolean oneD;

    Format(String key, String label, boolean oneD) {
        this.key = key;
        this.label = label;
        this.oneD = oneD;
    }

    /** 由格式代碼取得格式；不認得時回傳 UNKNOWN */
    public static Format fromKey(String key) {
        if (key == null) return UNKNOWN;
        String k = key.trim().toLowerCase().replace('-', '_');
        if (k.equals("pdf_417")) k = "pdf417";
        for (Format f : values()) if (f.key.equals(k)) return f;
        return UNKNOWN;
    }
}
