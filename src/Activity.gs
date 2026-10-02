/**
 * Activity.gs
 * "What are you working on?" — activity check-ins during a shift.
 *
 * Staff choose an activity (from Settings → Activities) when they clock in, at
 * each "Are you still working?" check, or any time with "Switch activity".
 * Each choice starts a segment that lasts until the next choice or clock-out.
 *
 * Hours per activity are the segment's share of the shift's WORKED hours: wall
 * time is scaled so breaks are taken out proportionally and the activity hours
 * always add up to the hours worked. Time before the first choice in a shift is
 * shown as "Not specified".
 */

const UNSPECIFIED_ACTIVITY = 'Not specified';

function defaultActivities_() {
  return ['Client follow-ups', 'Inquiries & bookings', 'Social media posting', 'Content creation',
    'Studio shoot support', 'Admin work', 'Meeting / training', 'Other'];
}

/** The studio's activity list (Config → ActivityOptions, one per line). */
function activityOptions_() {
  const raw = String(getConfigValue_('ActivityOptions', '') || '');
  const list = raw.split(/\r?\n|;/).map(function (s) { return s.trim(); }).filter(Boolean);
  return list.length ? list : defaultActivities_();
}

function validateActivity_(activity) {
  const a = str_(activity, 'Activity', { required: true, maxLength: 60 });
  if (activityOptions_().indexOf(a) === -1) throw appError_('Please choose an activity from the list.');
  return a;
}

/** Writes one activity check-in for an open shift. Must run inside withLock_. */
function recordActivity_(entry, activity, note, source, nowStr) {
  insertRows_(SHEET.ACTIVITY, [{
    ActivityID: newId_('ACT'), TimeLogID: entry.LogID, StaffID: entry.StaffID, Date: entry.Date,
    LoggedAt: nowStr, Activity: activity, Note: str_(note, 'Note', { maxLength: 300 }), Source: source
  }]);
}

/**
 * pure — Splits a shift into activity segments.
 * entry: TimeLogs row; logs: its ActivityLogs rows; worked: hours worked so far.
 */
function activitySegments_(entry, logs, worked, nowStr) {
  const start = parseDateTime_(entry.ClockIn);
  const result = { segments: [], totals: [], current: null };
  if (start === null) return result;
  // An open shift that started this very second still has a current activity.
  const end = Math.max(start, parseDateTime_(entry.ClockOut || nowStr) || start);
  const wallHours = (end - start) / 3600000;
  const scale = wallHours > 0 ? (Number(worked) || 0) / wallHours : 0;

  const points = logs.map(function (l) {
    return { t: Math.min(Math.max(parseDateTime_(l.LoggedAt), start), end), activity: l.Activity, note: l.Note || '', at: l.LoggedAt };
  }).sort(function (a, b) { return a.t - b.t; });
  if (!points.length || points[0].t > start) points.unshift({ t: start, activity: UNSPECIFIED_ACTIVITY, note: '', at: entry.ClockIn });

  const byActivity = {};
  points.forEach(function (p, i) {
    const to = i + 1 < points.length ? points[i + 1].t : end;
    if (to <= p.t && i + 1 < points.length && points[i + 1].t === p.t) return; // replaced at the same moment
    const hours = round2_(Math.max(0, (to - p.t) / 3600000) * scale);
    result.segments.push({
      activity: p.activity, note: p.note, from: formatDateTime_(p.t), to: formatDateTime_(to),
      fromLabel: timeLabel_(formatDateTime_(p.t)), toLabel: entry.ClockOut || i + 1 < points.length ? timeLabel_(formatDateTime_(to)) : 'now',
      hours: hours
    });
    byActivity[p.activity] = round2_((byActivity[p.activity] || 0) + hours);
  });
  result.totals = Object.keys(byActivity).map(function (a) { return { activity: a, hours: byActivity[a] }; })
    .filter(function (x) { return x.hours > 0; })
    .sort(function (a, b) { return b.hours - a.hours; });
  const last = result.segments[result.segments.length - 1];
  if (!entry.ClockOut && last && last.activity !== UNSPECIFIED_ACTIVITY) {
    result.current = { activity: last.activity, note: last.note, since: last.fromLabel };
  }
  return result;
}

/** Activity breakdown for a time entry (sheet-backed). */
function entryActivities_(entry, nowStr) {
  const logs = rows_(SHEET.ACTIVITY).filter(function (a) { return a.TimeLogID === entry.LogID; });
  const worked = entry.ClockOut ? Number(entry.Hours) || 0 : openShiftHours_(entry, nowStr);
  return activitySegments_(entry, logs, worked, nowStr);
}

/** pure — Adds activity totals together (for monthly summaries). */
function mergeActivityTotals_(lists) {
  const sum = {};
  lists.forEach(function (list) {
    list.forEach(function (x) { sum[x.activity] = round2_((sum[x.activity] || 0) + x.hours); });
  });
  return Object.keys(sum).map(function (a) { return { activity: a, hours: sum[a] }; })
    .sort(function (a, b) { return b.hours - a.hours; });
}

/* ------------------------------------------------------------------ */
/* Client-callable                                                     */
/* ------------------------------------------------------------------ */

/** "Switch activity" while clocked in. */
function logActivity(token, activity, note) {
  return api_(function () {
    const user = requireUser_(token);
    const a = validateActivity_(activity);
    return withLock_(function () {
      const open = openEntry_(user.userId);
      if (!open) throw appError_('Clock in first, then choose what you are working on.');
      recordActivity_(open, a, note, 'SWITCH', nowStr_());
      return ok_(timeClockState_(user.userId), 'Now working on: ' + a + '.');
    });
  });
}
