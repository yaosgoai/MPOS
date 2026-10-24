package tw.mpos.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class CallMonitorTest {
    @Test
    public void dedupeSameNumberWithinWindow() {
        CallMonitor.Dedupe d = new CallMonitor.Dedupe(15000);
        assertFalse("沒有號碼的廣播不通知", d.accept(null, 0));
        assertFalse(d.accept("  ", 0));
        assertTrue(d.accept("0912345678", 1000));
        assertFalse("同號碼 15 秒內重複廣播只通知一次", d.accept("0912345678", 5000));
        assertTrue("不同號碼要通知", d.accept("0422223333", 6000));
        assertTrue("同號碼超過 15 秒視為新來電", d.accept("0422223333", 30000));
    }
}
