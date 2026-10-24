package tw.mpos.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 來電錄音（小米 MIUI / HyperOS 通話錄音）：依電話號碼 + 來電時間找出錄音檔並播放。
 *
 * 小米通話錄音常見位置：
 *   內部儲存空間/MIUI/sound_recorder/call_rec/0910670803(0910670803)_20261024174233.mp3
 *   內部儲存空間/Recordings/call_rec/…（HyperOS）
 * 檔名含電話號碼與通話開始時間；若存成聯絡人名稱沒有號碼，改用時間（±10 分鐘）比對。
 * 需要「音樂和音訊」權限（Android 13+ READ_MEDIA_AUDIO；12 以下 READ_EXTERNAL_STORAGE）。
 */
public class CallRecordings {
    static final String[] DIRS = {
            "MIUI/sound_recorder/call_rec", "Recordings/call_rec", "Recordings/Call", "Recordings/Call recordings",
            "Music/Recordings/Call Recordings", "Sounds/CallRecord", "CallRecordings", "Call"
    };
    static final long TIME_WINDOW_MS = 10 * 60 * 1000L;
    private static final Pattern DIGITS = Pattern.compile("\\d+");
    private static final Pattern AUDIO_EXT = Pattern.compile("(?i).+\\.(mp3|m4a|aac|amr|wav|ogg|opus|3gp|awb)$");

    private final Context ctx;
    private MediaPlayer player;
    private String playingUri = "";

    public CallRecordings(Context ctx) { this.ctx = ctx.getApplicationContext(); }

    public static String permission() {
        return Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_AUDIO : Manifest.permission.READ_EXTERNAL_STORAGE;
    }

    public static boolean hasPermission(Context c) {
        return c.checkSelfPermission(permission()) == PackageManager.PERMISSION_GRANTED;
    }

    /* ---------------- 純邏輯（單元測試） ---------------- */

    /** 電話比對鍵：只留數字，+886 / 886 開頭轉 0，取最後 9 碼 */
    static String phoneKey(String s) {
        String d = s == null ? "" : s.replaceAll("\\D", "");
        if (d.startsWith("886") && d.length() >= 11) d = "0" + d.substring(3);
        return d.length() > 9 ? d.substring(d.length() - 9) : d;
    }

    /** 檔名內任何一段數字（6~15 碼，非時間戳）與電話相同 */
    static boolean nameMatchesPhone(String name, String phone) {
        String key = phoneKey(phone);
        if (key.length() < 6 || name == null) return false;
        Matcher m = DIGITS.matcher(name);
        while (m.find()) {
            String g = m.group();
            if (g.length() < 6 || g.length() > 15) continue;
            if (g.length() == 14 && g.startsWith("20")) continue; // yyyyMMddHHmmss
            if (phoneKey(g).equals(key)) return true;
        }
        return false;
    }

    /** 從檔名解析通話時間：yyyyMMddHHmmss、yyyyMMdd_HHmmss、yyyy-MM-dd HH-mm-ss；解析不到回傳 0 */
    static long parseTimeFromName(String name) {
        if (name == null) return 0;
        List<String> runs = new ArrayList<>();
        Matcher m = DIGITS.matcher(name);
        while (m.find()) runs.add(m.group());
        for (int i = 0; i < runs.size(); i++) {
            String r = runs.get(i);
            String ts = null;
            if (r.length() == 14 && r.startsWith("20")) ts = r;
            else if (r.length() == 8 && r.startsWith("20") && i + 1 < runs.size() && runs.get(i + 1).length() == 6) ts = r + runs.get(i + 1);
            else if (r.length() == 4 && r.startsWith("20") && i + 5 < runs.size()) {
                StringBuilder sb = new StringBuilder(r);
                boolean ok = true;
                for (int k = 1; k <= 5; k++) { String p = runs.get(i + k); if (p.length() != 2) { ok = false; break; } sb.append(p); }
                if (ok) ts = sb.toString();
            }
            if (ts == null) continue;
            long t = toMillis(ts);
            if (t > 0) return t;
        }
        return 0;
    }

    static long toMillis(String ts) {
        try {
            int y = Integer.parseInt(ts.substring(0, 4)), mo = Integer.parseInt(ts.substring(4, 6)), d = Integer.parseInt(ts.substring(6, 8));
            int h = Integer.parseInt(ts.substring(8, 10)), mi = Integer.parseInt(ts.substring(10, 12)), s = Integer.parseInt(ts.substring(12, 14));
            if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return 0;
            Calendar c = Calendar.getInstance();
            c.clear();
            c.set(y, mo - 1, d, h, mi, s);
            return c.getTimeInMillis();
        } catch (Exception e) {
            return 0;
        }
    }

    /** 候選錄音 */
    static class Rec {
        String uri, name;
        long time, duration;
        boolean phoneMatch;
        long distance(long at) { return at > 0 && time > 0 ? Math.abs(time - at) : Long.MAX_VALUE / 2; }
    }

    /** 篩選 + 排序：電話相符者優先；有來電時間時依時間差排序，否則新到舊 */
    static List<Rec> select(List<Rec> all, String phone, long at, int limit) {
        List<Rec> out = new ArrayList<>();
        for (Rec r : all) {
            r.phoneMatch = nameMatchesPhone(r.name, phone);
            boolean timeOk = at > 0 && r.time > 0 && Math.abs(r.time - at) <= TIME_WINDOW_MS;
            if (r.phoneMatch || timeOk) out.add(r);
        }
        Collections.sort(out, (a, b) -> {
            if (a.phoneMatch != b.phoneMatch) return a.phoneMatch ? -1 : 1;
            if (at > 0) return Long.compare(a.distance(at), b.distance(at));
            return Long.compare(b.time, a.time);
        });
        return out.size() > limit ? new ArrayList<>(out.subList(0, limit)) : out;
    }

    /* ---------------- 搜尋 ---------------- */

    public JSONObject find(String phone, long at) throws Exception {
        if (!hasPermission(ctx)) throw new SecurityException("需要「音樂和音訊」權限才能讀取通話錄音，請在跳出的視窗按「允許」後再試一次");
        Map<String, Rec> all = new LinkedHashMap<>();
        queryMediaStore(all);
        scanDirs(all);
        List<Rec> list = select(new ArrayList<>(all.values()), phone, at, 20);
        JSONArray arr = new JSONArray();
        for (Rec r : list) {
            JSONObject o = new JSONObject();
            o.put("uri", r.uri);
            o.put("name", r.name);
            o.put("time", r.time);
            o.put("duration", r.duration);
            o.put("phone_match", r.phoneMatch);
            arr.put(o);
        }
        JSONObject res = new JSONObject();
        res.put("recordings", arr);
        res.put("scanned", all.size());
        return res;
    }

    private void queryMediaStore(Map<String, Rec> out) {
        ContentResolver cr = ctx.getContentResolver();
        Uri base = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        boolean q = Build.VERSION.SDK_INT >= 29;
        String pathCol = q ? MediaStore.MediaColumns.RELATIVE_PATH : MediaStore.MediaColumns.DATA;
        String[] proj = {MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.DATE_MODIFIED,
                MediaStore.Audio.AudioColumns.DURATION, pathCol};
        String sel = pathCol + " LIKE ? OR " + pathCol + " LIKE ? OR " + pathCol + " LIKE ?";
        String[] args = {"%call%", "%sound_recorder%", "%錄音%"};
        try (Cursor c = cr.query(base, proj, sel, args, MediaStore.MediaColumns.DATE_MODIFIED + " DESC")) {
            if (c == null) return;
            int n = 0;
            while (c.moveToNext() && n++ < 5000) {
                Rec r = new Rec();
                r.name = c.getString(1);
                if (r.name == null) continue;
                r.uri = ContentUris.withAppendedId(base, c.getLong(0)).toString();
                long t = parseTimeFromName(r.name);
                r.time = t > 0 ? t : c.getLong(2) * 1000L;
                r.duration = c.getLong(3);
                out.put(r.name, r);
            }
        } catch (Exception ignored) { }
    }

    private void scanDirs(Map<String, Rec> out) {
        File root = Environment.getExternalStorageDirectory();
        for (String d : DIRS) {
            File dir = new File(root, d);
            File[] files;
            try { files = dir.listFiles(); } catch (Exception e) { files = null; }
            if (files == null) continue;
            for (File f : files) {
                if (!f.isFile() || !AUDIO_EXT.matcher(f.getName()).matches() || out.containsKey(f.getName())) continue;
                Rec r = new Rec();
                r.name = f.getName();
                r.uri = Uri.fromFile(f).toString();
                long t = parseTimeFromName(r.name);
                r.time = t > 0 ? t : f.lastModified();
                r.duration = 0;
                out.put(r.name, r);
            }
        }
    }

    /* ---------------- 播放 ---------------- */

    public synchronized JSONObject play(String uri) throws Exception {
        stop();
        MediaPlayer mp = new MediaPlayer();
        mp.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
        Uri u = Uri.parse(uri);
        if ("file".equals(u.getScheme())) mp.setDataSource(u.getPath());
        else mp.setDataSource(ctx, u);
        mp.prepare();
        mp.start();
        player = mp;
        playingUri = uri;
        return status();
    }

    public synchronized JSONObject togglePause() throws Exception {
        if (player != null) {
            if (player.isPlaying()) player.pause();
            else player.start();
        }
        return status();
    }

    public synchronized JSONObject seek(int ms) throws Exception {
        if (player != null) player.seekTo(Math.max(0, ms));
        return status();
    }

    public synchronized JSONObject stop() throws Exception {
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) { }
            try { player.release(); } catch (Exception ignored) { }
        }
        player = null;
        playingUri = "";
        return status();
    }

    public synchronized JSONObject status() throws Exception {
        JSONObject o = new JSONObject();
        o.put("uri", playingUri);
        o.put("loaded", player != null);
        boolean playing = false;
        int pos = 0, dur = 0;
        if (player != null) {
            try { playing = player.isPlaying(); pos = player.getCurrentPosition(); dur = player.getDuration(); } catch (Exception ignored) { }
        }
        o.put("playing", playing);
        o.put("position", pos);
        o.put("duration", dur);
        o.put("completed", player != null && !playing && dur > 0 && pos >= dur - 300);
        return o;
    }

    public void release() {
        try { stop(); } catch (Exception ignored) { }
    }
}
