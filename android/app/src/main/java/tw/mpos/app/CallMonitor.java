package tw.mpos.app;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.telephony.TelephonyManager;

/**
 * 來電偵測：電話響鈴時取得來電號碼，交給 POS 畫面（來電清單）。
 * 需要權限：READ_PHONE_STATE（收到響鈴事件）＋ READ_CALL_LOG（取得號碼，Android 9 以上）。
 * 只在 App 開啟期間偵測；平板沒有電話功能（沒有 SIM）時不會有事件。
 */
public class CallMonitor {
    public interface Listener { void onIncomingCall(String phone); }

    /** 同一號碼在短時間內的重複廣播只通知一次（系統常會送兩次：一次沒號碼、一次有號碼） */
    public static final class Dedupe {
        private final long windowMs;
        private String lastPhone = "";
        private long lastAt = 0;

        public Dedupe(long windowMs) { this.windowMs = windowMs; }

        public synchronized boolean accept(String phone, long nowMs) {
            if (phone == null) return false;
            String p = phone.trim();
            if (p.isEmpty()) return false;
            if (p.equals(lastPhone) && nowMs - lastAt < windowMs) return false;
            lastPhone = p;
            lastAt = nowMs;
            return true;
        }
    }

    private final Context ctx;
    private final Listener listener;
    private final Dedupe dedupe = new Dedupe(15000);
    private BroadcastReceiver receiver;

    public CallMonitor(Context ctx, Listener listener) {
        this.ctx = ctx.getApplicationContext();
        this.listener = listener;
    }

    public static boolean hasPermissions(Context c) {
        boolean state = c.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED;
        boolean log = c.checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED;
        return state && log;
    }

    public static boolean hasTelephony(Context c) {
        return c.getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY);
    }

    @SuppressWarnings("deprecation")
    public void start() {
        if (receiver != null) return;
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!TelephonyManager.ACTION_PHONE_STATE_CHANGED.equals(intent.getAction())) return;
                String state = intent.getStringExtra(TelephonyManager.EXTRA_STATE);
                if (!TelephonyManager.EXTRA_STATE_RINGING.equals(state)) return;
                String number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER);
                if (dedupe.accept(number, System.currentTimeMillis())) listener.onIncomingCall(number.trim());
            }
        };
        IntentFilter f = new IntentFilter(TelephonyManager.ACTION_PHONE_STATE_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(receiver, f, Context.RECEIVER_EXPORTED);
        else ctx.registerReceiver(receiver, f);
    }

    public void stop() {
        if (receiver == null) return;
        try { ctx.unregisterReceiver(receiver); } catch (Exception ignored) { }
        receiver = null;
    }
}
