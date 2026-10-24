package tw.com.acepillar.barcode;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * 投票：同一內容在時間視窗（預設 2.5 秒）內讀到 BarcodeRules.requiredReads() 次才採用。
 * - 沒讀到或讀值不合格的畫面不歸零（呼叫端直接略過即可）
 * - 視窗內若有更長且包含此內容的讀值，視為部分讀取，不採用
 * 規格：《條碼模組規格書》第 5.3 節。執行緒安全。
 */
public final class ReadVoter {
    public static final long DEFAULT_WINDOW_MS = 2500;

    private final long windowMs;
    private final Map<String, List<Long>> votes = new HashMap<>();

    public ReadVoter() { this(DEFAULT_WINDOW_MS); }

    public ReadVoter(long windowMs) { this.windowMs = windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS; }

    /** 加入一次讀值（須先通過 BarcodeRules.isValid）；達到採用條件時回傳 true，並清空投票 */
    public synchronized boolean add(Format f, String text, long nowMs) {
        for (Iterator<Map.Entry<String, List<Long>>> it = votes.entrySet().iterator(); it.hasNext(); ) {
            List<Long> ts = it.next().getValue();
            for (Iterator<Long> t = ts.iterator(); t.hasNext(); ) if (nowMs - t.next() >= windowMs) t.remove();
            if (ts.isEmpty()) it.remove();
        }
        List<Long> mine = votes.get(text);
        if (mine == null) { mine = new ArrayList<>(); votes.put(text, mine); }
        mine.add(nowMs);
        for (String k : votes.keySet()) {
            if (!k.equals(text) && k.length() > text.length() && k.contains(text)) return false;   // 部分讀取
        }
        if (mine.size() < BarcodeRules.requiredReads(f)) return false;
        votes.clear();
        return true;
    }

    public boolean add(Format f, String text) { return add(f, text, System.currentTimeMillis()); }

    public synchronized void reset() { votes.clear(); }
}
