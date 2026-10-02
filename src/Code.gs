/**
 * Code.gs
 * Web app entry point, bootstrap/session and dashboards.
 *
 * Convention: functions WITHOUT a trailing underscore are callable from the
 * browser via google.script.run. Each one takes the session token first and
 * verifies permissions on the server. Functions ending in "_" are private.
 */

const APP_VERSION = '1.0.0';

/**
 * Two entry points on one URL:
 *  - ?d=…&callback=… → JSON-P API for the GitHub Pages frontend (Api.gs)
 *  - no parameters   → the full app served by Apps Script itself
 */
function doGet(e) {
  if (e && e.parameter && e.parameter.d) return handleApiRequest_(e);
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('ClickLounge Sales Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Template include helper: <?!= include_('CSS'); ?> */
function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Spreadsheet menu for the owner (bound script). */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('ClickLounge')
    .addItem('1. Set up / repair database', 'setupDatabase')
    .addItem('2. Set my access code (for signing in)', 'setMyAccessCodeFromMenu')
    .addItem('3. Load demo data (Staff A & B)', 'setupDemoData')
    .addSeparator()
    .addItem('Run commission tests', 'runCommissionTestsFromMenu')
    .addItem('Install daily month-end check', 'installDailyTrigger')
    .addToUi();
}

/* ------------------------------------------------------------------ */
/* Client-callable: bootstrap                                          */
/* ------------------------------------------------------------------ */

/**
 * First call made by the browser. Resolves the user from the stored session
 * token or the Google account, and issues a session token.
 */
function bootstrap(token) {
  return api_(function () {
    assertDatabaseReady_();
    const config = publicConfig_();
    const googleEmail = getGoogleEmail_();
    let row = resolveUserRow_(token);
    let user = row && row.Status === 'Active' ? buildSessionUser_(row) : null;
    if (!user && googleEmail && isAdminEmail_(googleEmail) && !findUserByEmail_(googleEmail)) {
      user = provisionAdmin_(googleEmail);
    }
    if (!user) {
      return {
        needsLogin: true,
        config: config,
        googleEmail: googleEmail,
        message: row && row.Status !== 'Active' ? 'Your account is inactive. Please contact the Admin.' :
          googleEmail ? googleEmail + ' is not registered. Sign in with the email and access code from the Admin.' : ''
      };
    }
    const sessionToken = sessionUserId_(token) === user.userId ? token : createSession_(user.userId);
    return { user: user, token: sessionToken, config: config };
  });
}

/* ------------------------------------------------------------------ */
/* Client-callable: dashboards                                         */
/* ------------------------------------------------------------------ */

/** Admin dashboard: every schedule in the month with live/approved figures. */
function getAdminDashboard(token, month) {
  return api_(function () {
    requireAdmin_(token);
    autoAdvanceSchedules_();
    const m = month ? monthStr_(month, 'Month') : currentMonth_();
    const schedules = rows_(SHEET.SCHEDULES).filter(function (s) { return s.Month === m; });
    const rows = schedules.map(scheduleSummaryRow_);
    const withSchedule = schedules.map(function (s) { return s.StaffID; });
    const missing = rows_(SHEET.USERS).filter(function (u) {
      return u.Status === 'Active' && !isAdminEmail_(u.Email) && withSchedule.indexOf(u.UserID) === -1;
    }).map(function (u) { return { userId: u.UserID, name: u.Name }; });
    const counted = rows.filter(function (r) { return r.status !== SCHEDULE_STATUS.DRAFT; });
    const total = function (k) { return round2_(sum_(counted, function (r) { return r[k]; })); };
    const months = rows_(SHEET.SCHEDULES).map(function (s) { return s.Month; }).concat([currentMonth_()])
      .filter(function (x, i, all) { return x && all.indexOf(x) === i; }).sort().reverse();
    return {
      month: m,
      monthLabel: monthLabel_(m),
      months: months,
      rows: rows,
      staffWithoutSchedule: missing,
      pendingApproval: rows_(SHEET.SCHEDULES).filter(function (s) { return s.Status === SCHEDULE_STATUS.PENDING; }).length,
      clockedIn: rows_(SHEET.TIME).filter(function (l) { return !l.ClockOut; }).map(function (l) {
        const e = publicTimeEntry_(l, nowStr_());
        return { staffName: userName_(l.StaffID), since: timeLabel_(l.ClockIn), date: l.Date, onBreak: !!l.BreakStart, missedChecks: e.missedChecks, checkStatus: e.check.status };
      }),
      totals: {
        sales: total('sales'),
        salesTarget: total('salesTarget'),
        packageCount: total('packageCount'),
        commissionAmount: total('commissionAmount'),
        bonusAmount: total('bonusAmount'),
        baseCompensation: total('baseCompensation'),
        totalCompensation: total('totalCompensation')
      }
    };
  });
}

/**
 * Staff dashboard: the signed-in user's own schedule only. Defaults to the
 * schedule covering today, otherwise the most recent issued schedule.
 */
function getMyDashboard(token, scheduleId) {
  return api_(function () {
    const user = requireUser_(token);
    const mine = rows_(SHEET.SCHEDULES)
      .filter(function (s) { return s.StaffID === user.userId && s.Status !== SCHEDULE_STATUS.DRAFT; })
      .sort(function (a, b) { return a.StartDate < b.StartDate ? 1 : -1; });
    const today = todayStr_();
    let current = null;
    if (scheduleId) current = mine.find(function (s) { return s.ScheduleID === scheduleId; }) || null;
    // Unknown, someone else's, or not-yet-issued IDs fall back to the user's own current schedule.
    if (!current) current = mine.find(function (s) { return s.StartDate <= today && today <= s.EndDate; }) || mine[0] || null;
    return {
      schedules: mine.map(function (s) {
        return { scheduleId: s.ScheduleID, month: s.Month, label: monthLabel_(s.Month), status: s.Status };
      }),
      detail: current ? scheduleDetail_(current) : null
    };
  });
}

/* ------------------------------------------------------------------ */
/* Triggers                                                            */
/* ------------------------------------------------------------------ */

/** Daily: moves ended Active schedules to Pending Approval. */
function dailyMaintenance() {
  resetExecutionCaches_();
  const n = autoAdvanceSchedules_();
  console.log('dailyMaintenance: ' + n + ' schedule(s) moved to Pending Approval.');
}

function installDailyTrigger() {
  assertOwnerContext_();
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'dailyMaintenance'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyMaintenance').timeBased().everyDays(1).atHour(1).create();
  try {
    SpreadsheetApp.getUi().alert('Daily month-end check installed (runs around 1 AM).');
  } catch (e) {
    console.log('Daily trigger installed.');
  }
}
