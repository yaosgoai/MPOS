package tw.mpos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;

public class CallRecordingsTest {
    private static long t(int y, int mo, int d, int h, int mi, int s) {
        Calendar c = Calendar.getInstance();
        c.clear();
        c.set(y, mo - 1, d, h, mi, s);
        return c.getTimeInMillis();
    }

    @Test
    public void phoneKeyNormalizes() {
        assertEquals("910670803", CallRecordings.phoneKey("0910-670-803"));
        assertEquals("910670803", CallRecordings.phoneKey("+886 910 670 803"));
        assertEquals("047561234", CallRecordings.phoneKey("04-756-1234"));
    }

    @Test
    public void matchesMiuiFileNames() {
        assertTrue(CallRecordings.nameMatchesPhone("0910670803(0910670803)_20261024174233.mp3", "0910670803"));
        assertTrue(CallRecordings.nameMatchesPhone("王先生(+886910670803)_20261024174233.mp3", "0910-670-803"));
        assertTrue(CallRecordings.nameMatchesPhone("Call recording 0910670803_20261024_174233.m4a", "0910670803"));
        assertFalse(CallRecordings.nameMatchesPhone("0912345678_20261024174233.mp3", "0910670803"));
        assertFalse(CallRecordings.nameMatchesPhone("王先生_20261024174233.mp3", "0910670803"));
    }

    @Test
    public void parsesTimeFromNames() {
        long want = t(2026, 10, 24, 17, 42, 33);
        assertEquals(want, CallRecordings.parseTimeFromName("0910670803(0910670803)_20261024174233.mp3"));
        assertEquals(want, CallRecordings.parseTimeFromName("Call recording 0910670803_20261024_174233.m4a"));
        assertEquals(want, CallRecordings.parseTimeFromName("王先生 2026-10-24 17-42-33.m4a"));
        assertEquals(0, CallRecordings.parseTimeFromName("no-time.mp3"));
    }

    @Test
    public void selectPrefersPhoneThenClosestTime() {
        long at = t(2026, 10, 24, 17, 42, 0);
        List<CallRecordings.Rec> all = new ArrayList<>();
        all.add(rec("0910670803_20261023100000.mp3", t(2026, 10, 23, 10, 0, 0)));
        all.add(rec("0910670803_20261024174233.mp3", t(2026, 10, 24, 17, 42, 33)));
        all.add(rec("王先生_20261024174500.mp3", t(2026, 10, 24, 17, 45, 0)));   // 沒號碼，但時間接近
        all.add(rec("0911111111_20261024174200.mp3", t(2026, 10, 24, 17, 42, 0))); // 別人的號碼但時間相同 → 仍列入（時間相符）
        all.add(rec("其他_20261020090000.mp3", t(2026, 10, 20, 9, 0, 0)));         // 都不符
        List<CallRecordings.Rec> out = CallRecordings.select(all, "0910670803", at, 20);
        assertEquals(4, out.size());
        assertEquals("0910670803_20261024174233.mp3", out.get(0).name);
        assertEquals("0910670803_20261023100000.mp3", out.get(1).name);
        assertTrue(out.get(0).phoneMatch);
        assertFalse(out.get(2).phoneMatch);
    }

    private static CallRecordings.Rec rec(String name, long time) {
        CallRecordings.Rec r = new CallRecordings.Rec();
        r.name = name;
        r.uri = "file:///x/" + name;
        r.time = time;
        return r;
    }
}
