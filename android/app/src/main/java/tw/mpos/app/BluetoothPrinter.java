package tw.mpos.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.util.Set;
import java.util.UUID;

/**
 * 藍牙 SPP（序列埠）熱感印表機：CP-Q3、芯烨 XP-58 系列等。
 * 出單機 MAC 位址記錄在本機 SharedPreferences。
 */
public class BluetoothPrinter {
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final String PREFS = "mpos_printer";
    private static final int CHUNK = 512;

    private final Context ctx;
    private BluetoothSocket socket;
    private String socketAddress = "";

    public BluetoothPrinter(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    private SharedPreferences prefs() {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public String getAddress() { return prefs().getString("address", ""); }

    public String getName() { return prefs().getString("name", ""); }

    public void setPrinter(String address, String name) {
        prefs().edit().putString("address", address == null ? "" : address).putString("name", name == null ? "" : name).apply();
        closeQuietly();
    }

    public boolean hasPermission() {
        return Build.VERSION.SDK_INT < 31 || ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    @SuppressLint("MissingPermission")
    private BluetoothAdapter adapter() throws IOException {
        BluetoothManager bm = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter a = bm == null ? null : bm.getAdapter();
        if (a == null) throw new IOException("此裝置沒有藍牙功能");
        if (!hasPermission()) throw new IOException("尚未允許「附近的裝置」(藍牙) 權限，請到 App 設定開啟");
        if (!a.isEnabled()) throw new IOException("藍牙未開啟，請先開啟藍牙");
        return a;
    }

    @SuppressLint("MissingPermission")
    public JSONArray listBondedDevices() throws Exception {
        Set<BluetoothDevice> devices = adapter().getBondedDevices();
        JSONArray arr = new JSONArray();
        if (devices != null) {
            for (BluetoothDevice d : devices) {
                JSONObject o = new JSONObject();
                o.put("name", d.getName() == null ? "" : d.getName());
                o.put("address", d.getAddress());
                arr.put(o);
            }
        }
        return arr;
    }

    @SuppressLint("MissingPermission")
    private synchronized OutputStream connect() throws IOException {
        String address = getAddress();
        if (address.isEmpty()) throw new IOException("尚未選擇藍牙出單機，請到「設定」頁選擇");
        if (socket != null && socket.isConnected() && address.equals(socketAddress)) return socket.getOutputStream();
        closeQuietly();
        BluetoothAdapter a = adapter();
        try {
            // Android 12+ 需 BLUETOOTH_SCAN 才能呼叫；沒有權限就略過
            if (Build.VERSION.SDK_INT < 31) a.cancelDiscovery();
        } catch (SecurityException ignored) { }
        BluetoothDevice device = a.getRemoteDevice(address);
        IOException last = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            BluetoothSocket s = null;
            try {
                if (attempt == 0) s = device.createRfcommSocketToServiceRecord(SPP_UUID);
                else if (attempt == 1) s = device.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
                else {
                    // 部分便宜印表機 SDP 不完整，改用 channel 1
                    Method m = device.getClass().getMethod("createRfcommSocket", int.class);
                    s = (BluetoothSocket) m.invoke(device, 1);
                }
                s.connect();
                socket = s;
                socketAddress = address;
                return s.getOutputStream();
            } catch (Exception e) {
                last = e instanceof IOException ? (IOException) e : new IOException(e.getMessage(), e);
                if (s != null) try { s.close(); } catch (IOException ignored) { }
            }
        }
        throw new IOException("連線藍牙出單機失敗（" + getName() + " " + address + "）：" + (last == null ? "" : last.getMessage()));
    }

    /** 寫出資料；連線中斷時自動重連一次 */
    public synchronized void write(byte[] data) throws IOException {
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                OutputStream os = connect();
                for (int off = 0; off < data.length; off += CHUNK) {
                    os.write(data, off, Math.min(CHUNK, data.length - off));
                    os.flush();
                }
                return;
            } catch (IOException e) {
                closeQuietly();
                if (attempt == 1) throw e;
            }
        }
    }

    public synchronized void closeQuietly() {
        if (socket != null) {
            try { socket.close(); } catch (IOException ignored) { }
        }
        socket = null;
        socketAddress = "";
    }
}
