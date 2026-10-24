package tw.mpos.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** JSON → PrintJob */
public final class JobParser {
    private JobParser() {}

    public static PrintJob parse(JSONObject j) throws JSONException {
        if (j == null) throw new JSONException("列印資料是空的");
        PrintJob job = new PrintJob();
        job.orderNo = j.optString("order_no", "");
        job.ean13 = j.optString("ean13", "");
        JSONObject p = j.optJSONObject("printer");
        if (p != null) {
            job.paperWidthMm = p.optInt("paper_width_mm", 58);
            job.encoding = p.optString("encoding", "big5");
            job.darkness = p.optString("darkness", "normal");
            job.lineSpacingPercent = p.optInt("line_spacing_percent", 100);
            job.marginLeftMm = p.optDouble("margin_left_mm", 0);
            job.marginTopMm = p.optDouble("margin_top_mm", 0);
            job.startXMm = p.optDouble("start_x_mm", 0);
            job.startYMm = p.optDouble("start_y_mm", 0);
            job.barcodeMaxWidthPercent = p.optInt("barcode_max_width_percent", 88);
            job.openCashDrawer = p.optBoolean("open_cash_drawer", false);
            job.cutPaper = p.optBoolean("cut_paper", true);
            job.feedLinesAfter = p.optInt("feed_lines_after", 3);
        }
        JSONArray lines = j.optJSONArray("lines");
        if (lines == null || lines.length() == 0) throw new JSONException("列印資料沒有內容");
        for (int i = 0; i < lines.length(); i++) {
            JSONObject l = lines.getJSONObject(i);
            PrintJob.Line line = new PrintJob.Line();
            line.role = l.optString("role", "item");
            line.text = l.optString("text", "");
            line.fontPt = l.optInt("font_pt", 8);
            line.bold = l.optBoolean("bold", false);
            line.align = l.optString("align", "left");
            line.xOffset = l.optInt("x_offset", 0);
            line.spaceBefore = l.optInt("space_before", 0);
            line.spaceAfter = l.optInt("space_after", 0);
            job.lines.add(line);
        }
        return job;
    }
}
