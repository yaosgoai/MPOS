package tw.mpos.app;

import java.util.ArrayList;
import java.util.List;

/** GAS 送來的列印工作（對應 Logic.js buildPrintJob） */
public class PrintJob {
    public String orderNo = "";
    public String ean13 = "";

    public int paperWidthMm = 58;
    public String encoding = "big5";
    public String darkness = "normal";
    public int lineSpacingPercent = 100;
    public double marginLeftMm = 0;
    public double marginTopMm = 0;
    public double startXMm = 0;
    public double startYMm = 0;
    public int barcodeMaxWidthPercent = 88;
    /** 條碼列印方式：escstar（ESC * 點陣，相容性最高）/ raster（GS v 0）/ gsk（印表機內建 EAN13）/ none */
    public String barcodeMode = "escstar";
    public boolean openCashDrawer = false;
    public boolean cutPaper = true;
    public int feedLinesAfter = 3;

    public final List<Line> lines = new ArrayList<>();

    public static class Line {
        public String role = "item";
        public String text = "";
        public int fontPt = 8;
        public boolean bold = false;
        public String align = "left";
        public int xOffset = 0;
        public int spaceBefore = 0;
        public int spaceAfter = 0;
        /** 只用於 role=barcode：覆寫整張的條碼列印方式（條碼相容性測試用） */
        public String barcodeMode = "";

        public Line() {}

        public Line(String role, String text) {
            this.role = role;
            this.text = text;
        }
    }
}
