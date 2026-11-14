// Shared timing maths — used by the main process (engine) and by both renderers.
// Everything is derived from absolute wall-clock times, so nothing drifts.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TimeCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const pad = (n) => String(n).padStart(2, '0');

  function remainingMs(s, now) {
    switch (s.status) {
      case 'running': return s.endsAt - now;
      case 'finished': return 0;
      default: return s.remainingMs; // idle, paused
    }
  }

  // Seconds as the audience sees them: counting down rounds up (so 00:00 lands exactly
  // at zero), counting past zero rounds down.
  function displaySeconds(ms) {
    return ms >= 0 ? Math.ceil(ms / 1000) : -Math.floor(-ms / 1000);
  }

  // 'normal' | 'warn' | 'danger' | 'over'
  function stage(ms, totalMs, t) {
    const sec = displaySeconds(ms);
    if (sec < 0) return 'over';
    if (sec === 0) return 'danger';
    const limit = (v) => (t.unit === 'percent' ? (totalMs / 1000) * (v / 100) : v);
    if (sec <= limit(t.dangerAt)) return 'danger';
    if (sec <= limit(t.warnAt)) return 'warn';
    return 'normal';
  }

  // format: 'auto' (hours only if the timer is an hour or more), 'hms', 'ms' (minutes can exceed 59)
  function formatTimer(ms, totalMs, format) {
    const sec = displaySeconds(ms);
    const over = sec < 0;
    const abs = Math.abs(sec);
    const showHours = format === 'hms' || (format !== 'ms' && (totalMs >= 3600000 || abs >= 3600));
    let str;
    if (showHours) {
      str = `${Math.floor(abs / 3600)}:${pad(Math.floor((abs % 3600) / 60))}:${pad(abs % 60)}`;
    } else {
      str = `${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    }
    return (over ? '+' : '') + str;
  }

  function formatClock(now, opts) {
    const d = new Date(now);
    let h = d.getHours();
    let suffix = '';
    if (!opts.clock24h) {
      suffix = h >= 12 ? ' PM' : ' AM';
      h = h % 12 || 12;
    }
    const hh = opts.clock24h ? pad(h) : String(h);
    return hh + ':' + pad(d.getMinutes()) + (opts.clockSeconds ? ':' + pad(d.getSeconds()) : '') + suffix;
  }

  // "16:40" / "16:40:30" -> {h,m,s} or null
  function parseHM(str) {
    const m = /^\s*(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*$/.exec(str || '');
    if (!m) return null;
    const h = +m[1], mi = +m[2], s = +(m[3] || 0);
    if (h > 23 || mi > 59 || s > 59) return null;
    return { h, m: mi, s };
  }

  // "20" -> 20 min, "20:00" -> 20 min, "1:30:00" -> 1h30, "90s" -> 90 s. Returns ms or null.
  function parseDuration(str) {
    str = String(str || '').trim().toLowerCase();
    if (!str) return null;
    let m;
    if ((m = /^(\d+(?:\.\d+)?)\s*s$/.exec(str))) return Math.round(+m[1] * 1000);
    if ((m = /^(\d+(?:\.\d+)?)\s*(m|min|mins)?$/.exec(str))) return Math.round(+m[1] * 60000);
    if ((m = /^(\d+)\s*h(?:\s*(\d+)\s*m?)?$/.exec(str))) return (+m[1] * 3600 + +(m[2] || 0) * 60) * 1000;
    const parts = str.split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
    const n = parts.map(Number);
    const sec = parts.length === 3 ? n[0] * 3600 + n[1] * 60 + n[2] : n[0] * 60 + n[1];
    return sec * 1000;
  }

  function formatDuration(ms) {
    const sec = Math.round(ms / 1000);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  // Length of a "16:40"–"16:55" span in ms (end before start = runs past midnight).
  // Only the length is used: the real time of day never starts or stops anything.
  function spanMs(startStr, endStr) {
    const s = parseHM(startStr), e = parseHM(endStr);
    if (!s || !e) return null;
    let d = (e.h * 3600 + e.m * 60 + e.s - (s.h * 3600 + s.m * 60 + s.s)) * 1000;
    if (d <= 0) d += 86400000;
    return d;
  }

  function itemLengthMs(it) {
    return it.type === 'time' ? spanMs(it.start, it.end) || 0 : it.durationMs || 0;
  }

  // "16:40" as an epoch time on whichever day puts it nearest to `now`.
  function nearestClock(str, now) {
    const p = parseHM(str);
    if (!p) return null;
    const d = new Date(now);
    d.setHours(p.h, p.m, p.s, 0);
    let t = d.getTime();
    if (t - now > 43200000) t -= 86400000;
    else if (now - t > 43200000) t += 86400000;
    return t;
  }

  // Running-order schedule, for the operator only. Nothing here ever starts anything.
  //  expected[i]: when cue i should now start, projected from the live timer
  //  planned[i]:  when it was meant to start. Time-of-day cues anchor the plan with their
  //               From time and the cues around them follow on by length (null = no plan).
  //  offsetMs:    + late / − early, measured at the next upcoming cue that has a plan.
  function schedule(items, st, now, lastCueId) {
    const n = items.length;
    const len = items.map(itemLengthMs);
    const planned = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (items[i].type === 'time') planned[i] = nearestClock(items[i].start, now);
      else if (i > 0 && planned[i - 1] != null) planned[i] = planned[i - 1] + len[i - 1];
    }
    for (let i = n - 2; i >= 0; i--) if (planned[i] == null && planned[i + 1] != null) planned[i] = planned[i + 1] - len[i];

    const liveIdx = st.cueId ? items.findIndex((x) => x.id === st.cueId) : -1;
    const rem = remainingMs(st, now);
    const liveEnd = !st.source ? now : st.status === 'running' ? Math.max(now, st.endsAt) : now + Math.max(0, rem);
    let from = 0;
    if (liveIdx >= 0) from = liveIdx + 1;
    else if (lastCueId) from = items.findIndex((x) => x.id === lastCueId) + 1; // a quick timer is filling in mid-show
    const expected = new Array(n).fill(null);
    let t = liveEnd;
    for (let i = from; i < n; i++) {
      expected[i] = t;
      t += len[i];
    }
    let offsetMs = null;
    for (let i = from; i < n; i++) if (planned[i] != null) { offsetMs = expected[i] - planned[i]; break; }
    if (offsetMs == null && liveIdx >= 0 && planned[liveIdx] != null) offsetMs = liveEnd - (planned[liveIdx] + len[liveIdx]);
    return { expected, planned, liveIdx, liveEnd, from, showEnd: t, offsetMs, hasPlan: planned.some((v) => v != null) };
  }

  return { schedule, itemLengthMs, nearestClock, remainingMs, displaySeconds, stage, formatTimer, formatClock, parseHM, parseDuration, formatDuration, spanMs, pad };
});
