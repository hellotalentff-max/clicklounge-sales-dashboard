/**
 * Time.gs
 * Staff time clock: clock in, breaks, clock out, and admin corrections.
 *
 * - Times always come from the server clock (studio timezone), never the
 *   phone, so they cannot be changed by the person clocking.
 * - Worked hours = (clock out − clock in) − break minutes, rounded to 0.01 h.
 * - Every worked hour counts toward the schedule's required (expected) hours.
 * - Entries are dated by their clock-in day; a shift past midnight belongs to
 *   the day it started.
 * - Entries inside an Approved/Paid schedule are locked, like sales.
 *
 * Datetimes are "yyyy-MM-dd HH:mm:ss" wall-clock strings in the studio
 * timezone; differences are computed on those wall-clock values.
 */

const OPEN_SHIFT_WARNING_HOURS = 14;

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** pure — "yyyy-MM-dd HH:mm[:ss]" → milliseconds on a wall-clock (UTC) scale, or null. */
function parseDateTime_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

/** pure — inverse of parseDateTime_. */
function formatDateTime_(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate()) + ' ' +
    pad2_(d.getUTCHours()) + ':' + pad2_(d.getUTCMinutes()) + ':' + pad2_(d.getUTCSeconds());
}

/** pure — worked hours for one entry (0 when not clocked out). */
function computeEntryHours_(clockIn, clockOut, breakMinutes) {
  const a = parseDateTime_(clockIn);
  const b = parseDateTime_(clockOut);
  if (a === null || b === null || b <= a) return 0;
  return round2_(Math.max(0, (b - a) / 3600000 - (Number(breakMinutes) || 0) / 60));
}

/** pure — completed hours for one staff member in a date range. */
function sumLoggedHours_(logs, staffId, startDate, endDate) {
  const own = logs.filter(function (l) {
    return l.StaffID === staffId && l.ClockOut && l.Date >= startDate && l.Date <= endDate;
  });
  return { hours: round2_(sum_(own, function (l) { return l.Hours; })), entries: own.length };
}

/** pure — "HH:mm" validation. */
function timeStr_(value, label, opts) {
  opts = opts || {};
  const s = String(value === null || value === undefined ? '' : value).trim();
  if (!s) {
    if (opts.optional) return '';
    throw appError_(label + ' is required.');
  }
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw appError_(label + ' must be a time like 09:00 or 17:30.');
  return pad2_(Number(m[1])) + ':' + m[2];
}

function timeLabel_(dt) {
  const ms = parseDateTime_(dt);
  if (ms === null) return '';
  const d = new Date(ms);
  const h = d.getUTCHours();
  return ((h + 11) % 12 + 1) + ':' + pad2_(d.getUTCMinutes()) + (h < 12 ? ' AM' : ' PM');
}

/* ------------------------------------------------------------------ */
/* Sheet-backed helpers                                                */
/* ------------------------------------------------------------------ */

function openEntry_(staffId) {
  const open = rows_(SHEET.TIME).filter(function (l) { return l.StaffID === staffId && !l.ClockOut; });
  return open.length ? open[open.length - 1] : null;
}

/** Hours of the currently open shift so far (excludes breaks). */
function openShiftHours_(entry, nowStr) {
  if (!entry) return 0;
  let breakMins = Number(entry.BreakMinutes) || 0;
  if (entry.BreakStart) breakMins += Math.max(0, (parseDateTime_(nowStr) - parseDateTime_(entry.BreakStart)) / 60000);
  return computeEntryHours_(entry.ClockIn, nowStr, breakMins);
}

/* ------------------------------------------------------------------ */
/* "Are you still working?" checks                                     */
/* ------------------------------------------------------------------ */

/** Check settings from Config (interval 0 = checks switched off). */
function timeCheckSettings_() {
  return {
    interval: Math.max(0, Number(getConfigValue_('TimeCheckIntervalMinutes', 30)) || 0),
    window: Math.max(1, Number(getConfigValue_('TimeCheckResponseMinutes', 15)) || 15)
  };
}

/**
 * pure — Where an open shift stands with its still-working checks.
 * Checks fall due every `interval` minutes after the last confirmation (or
 * clock-in). A check not confirmed within `window` minutes is missed. Checks
 * pause during breaks; ending a break counts as a confirmation.
 *  status: off | paused | ok | due (answer now) | missed (overdue, not answered)
 */
function checkStatus_(entry, nowStr, interval, window) {
  const stored = Number(entry && entry.MissedChecks) || 0;
  const base = { status: 'off', pendingMissed: 0, missedTimes: [], totalMissed: stored,
    confirmed: Number(entry && entry.ConfirmedChecks) || 0, intervalMinutes: interval, windowMinutes: window };
  if (!entry || entry.ClockOut || !interval) return base;
  if (entry.BreakStart) return Object.assign(base, { status: 'paused' });
  const I = interval * 60000;
  const W = Math.min(window, interval) * 60000;
  const anchor = parseDateTime_(entry.LastConfirmedAt || entry.ClockIn);
  const now = parseDateTime_(nowStr);
  const n = Math.floor((now - anchor) / I); // checks that have fallen due
  if (n < 1) return Object.assign(base, { status: 'ok', nextCheckAt: formatDateTime_(anchor + I) });
  const lastDue = anchor + n * I;
  const inWindow = now < lastDue + W;
  const missed = inWindow ? n - 1 : n;
  const times = [];
  for (let k = 1; k <= missed; k++) times.push(formatDateTime_(anchor + k * I));
  return Object.assign(base, {
    status: inWindow ? 'due' : 'missed',
    dueAt: formatDateTime_(lastDue),
    deadline: formatDateTime_(lastDue + W),
    nextCheckAt: formatDateTime_(lastDue + I),
    pendingMissed: missed,
    missedTimes: times,
    totalMissed: stored + missed
  });
}

/**
 * Stores any missed checks on the entry before its anchor moves (confirm,
 * break, clock-out), so they stay visible to the Admin. Returns the patch.
 */
function settleChecks_(entry, nowStr) {
  const s = timeCheckSettings_();
  const c = checkStatus_(entry, nowStr, s.interval, s.window);
  if (!c.pendingMissed) return {};
  const detail = [entry.MissedDetail].concat(c.missedTimes.map(function (t) { return timeLabel_(t); })).filter(Boolean).join(', ');
  return { MissedChecks: c.totalMissed, MissedDetail: truncate_(detail, 1000) };
}

function publicTimeEntry_(l, nowStr) {
  const out = publicRow_(l);
  out.inLabel = timeLabel_(l.ClockIn);
  out.outLabel = l.ClockOut ? timeLabel_(l.ClockOut) : '';
  out.overnight = !!l.ClockOut && l.ClockOut.slice(0, 10) !== l.ClockIn.slice(0, 10);
  out.open = !l.ClockOut;
  out.onBreak = !!l.BreakStart;
  if (out.open) {
    out.hoursSoFar = openShiftHours_(l, nowStr);
    out.longOpen = out.hoursSoFar >= OPEN_SHIFT_WARNING_HOURS;
    const s = timeCheckSettings_();
    out.check = checkStatus_(l, nowStr, s.interval, s.window);
    if (out.check.pendingMissed) {
      out.MissedDetail = [l.MissedDetail].concat(out.check.missedTimes.map(function (t) { return timeLabel_(t); })).filter(Boolean).join(', ');
    }
  }
  out.missedChecks = out.open ? out.check.totalMissed : Number(l.MissedChecks) || 0;
  out.activities = entryActivities_(l, nowStr);
  out.confirmedChecks = Number(l.ConfirmedChecks) || 0;
  return out;
}

/** The schedule covering a date for a staff member (issued schedules only). */
function scheduleForDate_(staffId, date) {
  return rows_(SHEET.SCHEDULES).find(function (s) {
    return s.StaffID === staffId && s.Status !== SCHEDULE_STATUS.DRAFT && s.StartDate <= date && date <= s.EndDate;
  }) || null;
}

/** Time entries inside an Approved/Paid schedule cannot be changed. */
function assertTimeUnlocked_(staffId, date) {
  const locked = rows_(SHEET.SCHEDULES).find(function (s) {
    return s.StaffID === staffId && isLocked_(s) && s.StartDate <= date && date <= s.EndDate;
  });
  if (locked) {
    throw appError_('This time entry falls in ' + userName_(staffId) + '\'s ' + monthLabel_(locked.Month) +
      ' schedule, which is ' + locked.Status + ' and locked. Unlock that schedule for correction first.', 'LOCKED');
  }
}

/** What a staff member sees on their Time Clock. */
function timeClockState_(staffId) {
  const now = nowStr_();
  const today = now.slice(0, 10);
  const open = openEntry_(staffId);
  const s = scheduleForDate_(staffId, today);
  const start = s ? s.StartDate : firstDayOfMonth_(today.slice(0, 7));
  const end = s ? s.EndDate : lastDayOfMonth_(today.slice(0, 7));
  const logged = sumLoggedHours_(rows_(SHEET.TIME), staffId, start, end);
  const expected = s && !isBlank_(s.ExpectedHours) ? Number(s.ExpectedHours) : null;
  const todayHours = round2_(sum_(rows_(SHEET.TIME).filter(function (l) {
    return l.StaffID === staffId && l.ClockOut && l.Date === today;
  }), function (l) { return l.Hours; }) + (open && open.Date === today ? openShiftHours_(open, now) : 0));
  return {
    now: now,
    open: open ? publicTimeEntry_(open, now) : null,
    todayHours: todayHours,
    period: {
      scheduleId: s ? s.ScheduleID : '',
      label: s ? monthLabel_(s.Month) : monthLabel_(today.slice(0, 7)),
      startDate: start,
      endDate: end,
      expectedHours: expected,
      loggedHours: logged.hours,
      entries: logged.entries,
      hoursProgress: progress_(logged.hours, expected),
      hoursRemaining: expected === null ? null : round2_(Math.max(0, expected - logged.hours))
    },
    entries: rows_(SHEET.TIME).filter(function (l) {
      return l.StaffID === staffId && l.Date >= start && l.Date <= end;
    }).map(function (l) { return publicTimeEntry_(l, now); })
      .sort(function (a, b) { return a.ClockIn < b.ClockIn ? 1 : -1; })
  };
}

/* ------------------------------------------------------------------ */
/* Client-callable: staff clock                                        */
/* ------------------------------------------------------------------ */

function getMyTimeClock(token) {
  return api_(function () {
    const user = requireUser_(token);
    return timeClockState_(user.userId);
  });
}

function clockIn(token, note, activity) {
  return api_(function () {
    const user = requireUser_(token);
    return withLock_(function () {
      const open = openEntry_(user.userId);
      if (open) throw appError_('You are already clocked in since ' + timeLabel_(open.ClockIn) + ' (' + dateLabel_(open.Date) + ').');
      const act = isBlank_(activity) ? '' : validateActivity_(activity);
      const now = nowStr_();
      const entry = {
        LogID: newId_('TIM'), StaffID: user.userId, Date: now.slice(0, 10), ClockIn: now, ClockOut: '',
        BreakMinutes: 0, BreakStart: '', Hours: null, Source: 'CLOCK',
        Notes: act ? '' : str_(note, 'Note', { maxLength: 300 }), CreatedAt: now, UpdatedAt: now, EditedBy: ''
      };
      insertRows_(SHEET.TIME, [entry]);
      if (act) recordActivity_(entry, act, note, 'CLOCK_IN', now);
      return ok_(timeClockState_(user.userId), 'Clocked in at ' + timeLabel_(now) + '.');
    });
  });
}

/** Starts a break, or ends the current one. */
function toggleBreak(token) {
  return api_(function () {
    const user = requireUser_(token);
    return withLock_(function () {
      const open = openEntry_(user.userId);
      if (!open) throw appError_('You are not clocked in.');
      const now = nowStr_();
      let message;
      if (open.BreakStart) {
        const mins = Math.max(0, Math.round((parseDateTime_(now) - parseDateTime_(open.BreakStart)) / 60000));
        updateRow_(SHEET.TIME, 'LogID', open.LogID, { BreakMinutes: (Number(open.BreakMinutes) || 0) + mins, BreakStart: '', LastConfirmedAt: now, UpdatedAt: now });
        message = 'Break ended (' + mins + ' min).';
      } else {
        updateRow_(SHEET.TIME, 'LogID', open.LogID, Object.assign(settleChecks_(open, now), { BreakStart: now, UpdatedAt: now }));
        message = 'Break started at ' + timeLabel_(now) + '.';
      }
      return ok_(timeClockState_(user.userId), message);
    });
  });
}

/** "Yes, I'm still working" — records the confirmation (late answers still count as missed). */
function confirmStillWorking(token, activity, note) {
  return api_(function () {
    const user = requireUser_(token);
    return withLock_(function () {
      const open = openEntry_(user.userId);
      if (!open) throw appError_('You are not clocked in.');
      const act = isBlank_(activity) ? '' : validateActivity_(activity);
      const now = nowStr_();
      if (act) recordActivity_(open, act, note, 'CHECK', now);
      const patch = Object.assign(settleChecks_(open, now), {
        LastConfirmedAt: now, ConfirmedChecks: (Number(open.ConfirmedChecks) || 0) + 1, UpdatedAt: now
      });
      updateRow_(SHEET.TIME, 'LogID', open.LogID, patch);
      return ok_(timeClockState_(user.userId), patch.MissedChecks ? 'Thanks — confirmed. The missed check was noted for the Admin.' : 'Thanks — confirmed.');
    });
  });
}

function clockOut(token, note) {
  return api_(function () {
    const user = requireUser_(token);
    return withLock_(function () {
      const open = openEntry_(user.userId);
      if (!open) throw appError_('You are not clocked in.');
      const now = nowStr_();
      let breakMins = Number(open.BreakMinutes) || 0;
      if (open.BreakStart) breakMins += Math.max(0, Math.round((parseDateTime_(now) - parseDateTime_(open.BreakStart)) / 60000));
      const hours = computeEntryHours_(open.ClockIn, now, breakMins);
      const extra = str_(note, 'Note', { maxLength: 300 });
      updateRow_(SHEET.TIME, 'LogID', open.LogID, Object.assign(open.BreakStart ? {} : settleChecks_(open, now), {
        ClockOut: now, BreakMinutes: breakMins, BreakStart: '', Hours: hours, UpdatedAt: now,
        Notes: [open.Notes, extra].filter(Boolean).join(' · ')
      }));
      return ok_(timeClockState_(user.userId), 'Clocked out at ' + timeLabel_(now) + ' — ' + hours + ' h worked.');
    });
  });
}

/* ------------------------------------------------------------------ */
/* Client-callable: admin                                              */
/* ------------------------------------------------------------------ */

/** Admin overview for a month: who is in now, hours vs required, all entries. */
function getTimeOverview(token, filters) {
  return api_(function () {
    requireAdmin_(token);
    filters = filters || {};
    const month = filters.month ? monthStr_(filters.month, 'Month') : currentMonth_();
    const from = firstDayOfMonth_(month);
    const to = lastDayOfMonth_(month);
    const now = nowStr_();
    const logs = rows_(SHEET.TIME);
    const users = rows_(SHEET.USERS);

    const clockedIn = logs.filter(function (l) { return !l.ClockOut; }).map(function (l) {
      return Object.assign(publicTimeEntry_(l, now), { staffName: userName_(l.StaffID) });
    });

    // Required hours come from the month's schedules; worked hours from the log.
    const summary = users.filter(function (u) {
      return u.Status === 'Active' || logs.some(function (l) { return l.StaffID === u.UserID && l.Date >= from && l.Date <= to; });
    }).map(function (u) {
      const scheds = rows_(SHEET.SCHEDULES).filter(function (s) {
        return s.StaffID === u.UserID && s.Month === month && s.Status !== SCHEDULE_STATUS.DRAFT;
      });
      const expected = scheds.length ? round2_(sum_(scheds, function (s) { return s.ExpectedHours; })) : null;
      const logged = sumLoggedHours_(logs, u.UserID, from, to);
      const missedChecks = sum_(logs.filter(function (l) { return l.StaffID === u.UserID && l.Date >= from && l.Date <= to; }),
        function (l) { return publicTimeEntry_(l, now).missedChecks; });
      return {
        staffId: u.UserID, staffName: u.Name, expectedHours: expected, loggedHours: logged.hours, entries: logged.entries, missedChecks: missedChecks,
        hoursProgress: progress_(logged.hours, expected),
        hoursRemaining: expected === null ? null : round2_(Math.max(0, expected - logged.hours)),
        clockedIn: clockedIn.some(function (c) { return c.StaffID === u.UserID; })
      };
    }).filter(function (r) { return r.expectedHours !== null || r.entries > 0 || r.clockedIn; })
      .sort(function (a, b) { return a.staffName.localeCompare(b.staffName); });

    const entries = logs.filter(function (l) {
      return l.Date >= from && l.Date <= to && (!filters.staffId || l.StaffID === filters.staffId);
    }).map(function (l) {
      const s = rows_(SHEET.SCHEDULES).find(function (x) {
        return x.StaffID === l.StaffID && isLocked_(x) && x.StartDate <= l.Date && l.Date <= x.EndDate;
      });
      return Object.assign(publicTimeEntry_(l, now), { staffName: userName_(l.StaffID), locked: !!s });
    }).sort(function (a, b) { return a.ClockIn < b.ClockIn ? 1 : -1; });

    // Hours per activity this month, per staff member and for the whole studio.
    const monthEntries = logs.filter(function (l) { return l.Date >= from && l.Date <= to && (!filters.staffId || l.StaffID === filters.staffId); });
    const perStaff = {};
    monthEntries.forEach(function (l) {
      (perStaff[l.StaffID] = perStaff[l.StaffID] || []).push(entryActivities_(l, now).totals);
    });
    const activityByStaff = Object.keys(perStaff).map(function (id) {
      return { staffId: id, staffName: userName_(id), totals: mergeActivityTotals_(perStaff[id]) };
    }).sort(function (a, b) { return a.staffName.localeCompare(b.staffName); });
    const activityTotals = mergeActivityTotals_(activityByStaff.map(function (s) { return s.totals; }));

    return { month: month, monthLabel: monthLabel_(month), now: now, clockedIn: clockedIn, summary: summary, entries: entries,
      activityByStaff: activityByStaff, activityTotals: activityTotals };
  });
}

/**
 * Adds or corrects a time entry. input: { LogID?, StaffID, Date, InTime "HH:mm",
 * OutTime "HH:mm" (blank = still clocked in), BreakMinutes, Notes }.
 * An out time earlier than the in time means the shift ended the next day.
 */
function saveTimeLog(token, input) {
  return api_(function () {
    const admin = requireAdmin_(token);
    input = input || {};
    return withLock_(function () {
      const existing = input.LogID ? findById_(SHEET.TIME, 'LogID', input.LogID) : null;
      if (input.LogID && !existing) throw appError_('Time entry not found. It may have been deleted.', 'NOT_FOUND');
      const staffId = str_(input.StaffID, 'Staff member', { required: true });
      const staff = findById_(SHEET.USERS, 'UserID', staffId);
      if (!staff) throw appError_('Please choose a valid staff member.');
      if (staff.Status !== 'Active' && (!existing || existing.StaffID !== staffId)) {
        throw appError_(staff.Name + ' is inactive. Time cannot be added for inactive staff.');
      }
      const date = dateStr_(input.Date, 'Date');
      const inTime = timeStr_(input.InTime, 'Clock-in time');
      const outTime = timeStr_(input.OutTime, 'Clock-out time', { optional: true });
      const breakMins = num_(input.BreakMinutes, 'Break minutes', { min: 0, max: 1440, integer: true, defaultValue: 0 });
      const notes = str_(input.Notes, 'Notes', { maxLength: 500 });

      const clockInStr = date + ' ' + inTime + ':00';
      let clockOutStr = '';
      if (outTime) {
        let outMs = parseDateTime_(date + ' ' + outTime + ':00');
        if (outMs <= parseDateTime_(clockInStr)) outMs += 24 * 3600000; // ended after midnight
        clockOutStr = formatDateTime_(outMs);
        if (clockOutStr > nowStr_()) throw appError_('The clock-out time is in the future.');
      }
      if (clockInStr > nowStr_()) throw appError_('The clock-in time is in the future.');
      const hours = outTime ? computeEntryHours_(clockInStr, clockOutStr, breakMins) : null;
      if (outTime && hours <= 0) throw appError_('The break is longer than the shift.');
      if (outTime && hours > 24) throw appError_('A single entry cannot be longer than 24 hours.');

      // No overlapping shifts for the same person, and only one open shift.
      const startMs = parseDateTime_(clockInStr);
      const endMs = outTime ? parseDateTime_(clockOutStr) : Infinity;
      const clash = rows_(SHEET.TIME).find(function (l) {
        if (l.StaffID !== staffId || (existing && l.LogID === existing.LogID)) return false;
        const a = parseDateTime_(l.ClockIn);
        const b = l.ClockOut ? parseDateTime_(l.ClockOut) : Infinity;
        return a < endMs && startMs < b;
      });
      if (clash) {
        throw appError_('This overlaps another entry for ' + staff.Name + ' (' + dateLabel_(clash.Date) + ', ' +
          timeLabel_(clash.ClockIn) + ' – ' + (clash.ClockOut ? timeLabel_(clash.ClockOut) : 'still clocked in') + ').');
      }
      if (existing) assertTimeUnlocked_(existing.StaffID, existing.Date);
      assertTimeUnlocked_(staffId, date);

      const now = nowStr_();
      const record = {
        StaffID: staffId, Date: date, ClockIn: clockInStr, ClockOut: clockOutStr, BreakMinutes: breakMins,
        BreakStart: outTime ? '' : (existing ? existing.BreakStart : ''), Hours: hours, Notes: notes, UpdatedAt: now, EditedBy: admin.email
      };
      const describe = function (r) {
        return userName_(r.StaffID) + ' ' + r.Date + ' ' + timeLabel_(r.ClockIn) + ' – ' +
          (r.ClockOut ? timeLabel_(r.ClockOut) : 'open') + ', break ' + (r.BreakMinutes || 0) + ' min = ' + (r.Hours === null ? '—' : r.Hours + ' h');
      };
      let logId;
      if (existing) {
        logId = existing.LogID;
        updateRow_(SHEET.TIME, 'LogID', logId, record);
        logAudit_(admin, 'Corrected time entry (' + userName_(staffId) + ', ' + dateLabel_(date) + ')', logId,
          describe(existing), describe(record), notes);
      } else {
        logId = newId_('TIM');
        insertRows_(SHEET.TIME, [Object.assign({ LogID: logId, Source: 'MANUAL', CreatedAt: now }, record)]);
        logAudit_(admin, 'Added time entry (' + userName_(staffId) + ', ' + dateLabel_(date) + ')', logId, '', describe(record), notes);
      }
      return ok_({ logId: logId }, existing ? 'Time entry updated.' : 'Time entry added.');
    });
  });
}

function deleteTimeLog(token, logId) {
  return api_(function () {
    const admin = requireAdmin_(token);
    return withLock_(function () {
      const l = findById_(SHEET.TIME, 'LogID', logId);
      if (!l) throw appError_('Time entry not found. It may already have been deleted.', 'NOT_FOUND');
      assertTimeUnlocked_(l.StaffID, l.Date);
      deleteWhere_(SHEET.TIME, function (r) { return r.LogID === logId; });
      deleteWhere_(SHEET.ACTIVITY, function (r) { return r.TimeLogID === logId; });
      logAudit_(admin, 'Deleted time entry (' + userName_(l.StaffID) + ', ' + dateLabel_(l.Date) + ', ' +
        (l.Hours === null || l.Hours === '' ? 'open' : l.Hours + ' h') + ')', logId, publicRow_(l), '');
      return ok_(null, 'Time entry deleted.');
    });
  });
}
