package tw.mpos.app;

/** EAN13 編碼（與 GAS Logic.js ean13Bits 相同規則，含左右各 11 模組靜區） */
public final class Ean13 {
    private static final String[] L = {"0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"};
    private static final String[] G = {"0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"};
    private static final String[] R = {"1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"};
    private static final String[] P = {"OOOOOO", "OOEOEE", "OOEEOE", "OOEEEO", "OEOOEE", "OEEOOE", "OEEEOO", "OEOEOE", "OEOEEO", "OEEOEO"};
    public static final int MODULES = 117;

    private Ean13() {}

    public static String checkDigit(String ean12) {
        if (ean12 == null || !ean12.matches("\\d{12}")) throw new IllegalArgumentException("EAN13 前 12 碼必須是數字");
        int odd = 0, even = 0;
        for (int i = 0; i < 12; i++) {
            int d = ean12.charAt(i) - '0';
            if (i % 2 == 0) odd += d; else even += d;
        }
        return String.valueOf((10 - ((odd + even * 3) % 10)) % 10);
    }

    public static boolean isValid(String code) {
        return code != null && code.matches("\\d{13}") && checkDigit(code.substring(0, 12)).equals(code.substring(12));
    }

    public static String bits(String code) {
        if (!isValid(code)) throw new IllegalArgumentException("EAN13 無效：" + code);
        String parity = P[code.charAt(0) - '0'];
        StringBuilder b = new StringBuilder("00000000000101");
        for (int i = 1; i <= 6; i++) b.append((parity.charAt(i - 1) == 'O' ? L : G)[code.charAt(i) - '0']);
        b.append("01010");
        for (int i = 7; i <= 12; i++) b.append(R[code.charAt(i) - '0']);
        b.append("10100000000000");
        return b.toString();
    }
}
