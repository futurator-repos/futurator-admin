// Pipeline v1 — Story 6.2. Time-shifted batch scheduler.
//
// Pure decision module: given a job's `priority` and the current time,
// decide whether the daemon should pick it up or skip-for-now. The
// daemon's polling loop calls `shouldPickUp(job, now)` — a `false` answer
// keeps the job PENDING and re-evaluates next tick.
//
// Windows are configured via env vars per Story 6.2. Times are interpreted
// in the user's timezone (Story 6.5 sets it on the user row); v1 uses
// UTC if no timezone is provided.

const NIGHTLY_START = process.env.NIGHTLY_BATCH_WINDOW_START || '02:00';
const NIGHTLY_END = process.env.NIGHTLY_BATCH_WINDOW_END || '06:00';
const WEEKEND_START = process.env.WEEKEND_BATCH_WINDOW_START || 'Saturday 00:00';
const WEEKEND_END = process.env.WEEKEND_BATCH_WINDOW_END || 'Sunday 23:59';

function parseHHMM(spec) {
  // spec like "02:00" or "Saturday 00:00".
  const m = /(\d{1,2}):(\d{2})$/.exec(spec || '');
  if (!m) return { hour: 0, minute: 0 };
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function parseDayName(spec) {
  const m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)/i.exec(spec || '');
  if (!m) return null;
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return days.indexOf(m[1].toLowerCase().slice(0, 3));
}

export function isInNightlyWindow(date = new Date()) {
  const h = date.getUTCHours();
  const m = date.getUTCMinutes();
  const start = parseHHMM(NIGHTLY_START);
  const end = parseHHMM(NIGHTLY_END);
  const cur = h * 60 + m;
  const s = start.hour * 60 + start.minute;
  const e = end.hour * 60 + end.minute;
  // window may wrap past midnight; v1 default (02:00–06:00) doesn't wrap.
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

export function isInWeekendWindow(date = new Date()) {
  const dow = date.getUTCDay(); // 0 Sun ... 6 Sat
  const startDay = parseDayName(WEEKEND_START);
  const endDay = parseDayName(WEEKEND_END);
  if (startDay == null || endDay == null) return dow === 0 || dow === 6;
  if (startDay <= endDay) return dow >= startDay && dow <= endDay;
  return dow >= startDay || dow <= endDay;
}

/**
 * Decide whether the daemon should pick up a job right now.
 *   - priority='now' (default): always
 *   - priority='nightly': only inside the nightly window
 *   - priority='weekend': only inside the weekend window
 */
export function shouldPickUp(job, now = new Date()) {
  const p = job?.priority || 'now';
  if (p === 'now') return true;
  if (p === 'nightly') return isInNightlyWindow(now);
  if (p === 'weekend') return isInWeekendWindow(now);
  return true;
}
