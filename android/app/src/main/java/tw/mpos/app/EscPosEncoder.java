package tw.mpos.app;

import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

/**
 * 將 PrintJob 轉成 ESC/POS 位元組（移植自 WebPOS.py print_to_cpq3_bluetooth）。
 * 純 Java，不依賴 Android，可在 JVM 單元測試。
 */
public final class EscPosEncoder {
    private static final byte ESC = 0x1B, GS = 0x1D, FS = 0x1C, LF = 0x0A;

    private EscPosEncoder() {}

    public static int paperDots(int paperWidthMm) {
        return paperWidthMm == 80 ? 576 : 384;
    }

    public static Charset charsetFor(String name) {
        String n = name == null ? "" : name.trim().toLowerCase();
        String[] candidates;
        switch (n) {
            case "cp950": candidates = new String[]{"x-windows-950", "MS950", "Big5"}; break;
            case "gbk": candidates = new String[]{"GBK", "GB18030"}; break;
            case "gb18030": candidates = new String[]{"GB18030", "GBK"}; break;
            case "utf-8": case "utf8": return StandardCharsets.UTF_8;
            default: candidates = new String[]{"Big5", "x-windows-950", "MS950"}; break;
        }
        for (String c : candidates) {
            try {
                if (Charset.isSupported(c)) return Charset.forName(c);
            } catch (Exception ignored) { }
        }
        return StandardCharsets.UTF_8;
    }

    static byte[] darknessCommand(String darkness) {
        switch (darkness == null ? "normal" : darkness) {
            case "light": return new byte[]{ESC, 0x37, 0x05, 0x35, 0x02};
            case "dark": return new byte[]{ESC, 0x37, 0x09, 0x70, 0x02};
            case "extra_dark": return new byte[]{ESC, 0x37, 0x0B, (byte) 0x90, 0x02};
            default: return new byte[]{ESC, 0x37, 0x07, 0x50, 0x02};
        }
    }

    static byte[] lineSpacingCommand(int percent) {
        int p = Math.max(70, Math.min(160, percent));
        int dots = Math.max(16, Math.min(40, Math.round(24f * p / 100f)));
        return new byte[]{ESC, 0x33, (byte) dots};
    }

    static byte[] alignCommand(String align) {
        int n = "center".equals(align) ? 1 : "right".equals(align) ? 2 : 0;
        return new byte[]{ESC, 0x61, (byte) n};
    }

    static byte[] sizeCommand(int fontPt) {
        int n = fontPt >= 16 ? 0x11 : fontPt >= 12 ? 0x01 : 0x00;
        return new byte[]{GS, 0x21, (byte) n};
    }

    /** GS v 0 點陣條碼圖片：寬度依紙寬與 barcode_max_width_percent 計算 */
    public static byte[] ean13Raster(String ean13, int paperDots, int maxWidthPercent, int heightDots) {
        String bits = Ean13.bits(ean13);
        int target = paperDots * Math.max(50, Math.min(100, maxWidthPercent)) / 100;
        int module = Math.max(2, target / bits.length());
        int width = module * bits.length();
        if (width > paperDots) { module = Math.max(1, paperDots / bits.length()); width = module * bits.length(); }
        int widthBytes = (width + 7) / 8;
        byte[] row = new byte[widthBytes];
        for (int i = 0; i < bits.length(); i++) {
            if (bits.charAt(i) != '1') continue;
            for (int m = 0; m < module; m++) {
                int x = i * module + m;
                row[x / 8] |= (byte) (0x80 >> (x % 8));
            }
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(GS); out.write(0x76); out.write(0x30); out.write(0x00);
        out.write(widthBytes & 0xFF); out.write((widthBytes >> 8) & 0xFF);
        out.write(heightDots & 0xFF); out.write((heightDots >> 8) & 0xFF);
        for (int y = 0; y < heightDots; y++) out.write(row, 0, row.length);
        out.write(LF);
        return out.toByteArray();
    }

    /** ByteArrayOutputStream.writeBytes 需 API 33，改用相容寫法 */
    private static void put(ByteArrayOutputStream out, byte[] b) {
        out.write(b, 0, b.length);
    }

    private static void newlines(ByteArrayOutputStream out, int n) {
        for (int i = 0; i < n; i++) out.write(LF);
    }

    private static String spaces(int n) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) sb.append(' ');
        return sb.toString();
    }

    public static byte[] encode(PrintJob job) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        Charset cs = charsetFor(job.encoding);
        boolean multiByte = !StandardCharsets.UTF_8.equals(cs);
        int dots = paperDots(job.paperWidthMm);

        out.write(ESC); out.write(0x40); // 初始化
        if (multiByte) { out.write(FS); out.write(0x26); } // FS & 進入漢字模式
        put(out, darknessCommand(job.darkness));
        put(out, lineSpacingCommand(job.lineSpacingPercent));

        int topLines = (int) Math.max(0, Math.min(12, Math.round((job.marginTopMm + job.startYMm) / 3.5)));
        newlines(out, topLines);
        int baseLeft = (int) Math.max(0, Math.min(24, Math.round((job.marginLeftMm + job.startXMm) / 2.0)));

        for (PrintJob.Line line : job.lines) {
            newlines(out, Math.max(0, Math.round(line.spaceBefore / 12f)));
            put(out, alignCommand(line.align));
            if ("barcode".equals(line.role)) {
                if (Ean13.isValid(job.ean13)) put(out, ean13Raster(job.ean13, dots, job.barcodeMaxWidthPercent, 80));
            } else {
                put(out, sizeCommand(line.fontPt));
                if (line.bold) { out.write(ESC); out.write(0x45); out.write(1); }
                String text = line.text == null ? "" : line.text;
                if (!"center".equals(line.align) && !"right".equals(line.align)) {
                    int indent = baseLeft + Math.max(0, line.xOffset / 8);
                    if (indent > 0) text = spaces(indent) + text;
                }
                put(out, text.getBytes(cs));
                out.write(LF);
                put(out, sizeCommand(8));
                if (line.bold) { out.write(ESC); out.write(0x45); out.write(0); }
            }
            newlines(out, Math.max(0, Math.round(line.spaceAfter / 12f)));
        }

        put(out, alignCommand("left"));
        int feed = Math.max(0, Math.min(10, job.feedLinesAfter));
        if (feed > 0) { out.write(ESC); out.write(0x64); out.write(feed); }
        if (job.cutPaper) { out.write(GS); out.write(0x56); out.write(0x00); }
        if (job.openCashDrawer) put(out, cashDrawerCommand());
        return out.toByteArray();
    }

    /** ESC p 0 25 250：RJ11 錢箱腳位 2 脈衝 */
    public static byte[] cashDrawerCommand() {
        return new byte[]{ESC, 0x70, 0x00, 0x19, (byte) 0xFA};
    }
}
