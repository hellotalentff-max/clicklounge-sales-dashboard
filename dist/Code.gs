// ClickLounge Sales Dashboard — bundled from src/ by tools/bundle.py. Edit src/, not this file.

// ===== Code.gs =====
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
        return { staffName: userName_(l.StaffID), since: timeLabel_(l.ClockIn), date: l.Date, onBreak: !!l.BreakStart };
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
    if (scheduleId) {
      current = mine.find(function (s) { return s.ScheduleID === scheduleId; });
      if (!current) throw appError_('Schedule not found.', 'NOT_FOUND');
    } else {
      current = mine.find(function (s) { return s.StartDate <= today && today <= s.EndDate; }) || mine[0] || null;
    }
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


// ===== Api.gs =====
/**
 * Api.gs
 * JSON-P endpoint so the frontend can be hosted outside Apps Script
 * (e.g. GitHub Pages), the same way the ClickLounge POS talks to its script.
 *
 * Request:  GET <web app URL>?d=<base64(JSON {fn, args})>&callback=<name>
 * Response: <name>({ success, data, message } | { success:false, error, code })
 *
 * Only the functions listed in apiFunctions_() can be called. Each of them
 * still checks the session token and role itself, exactly as with
 * google.script.run. Owner-only maintenance (setupDatabase, setupDemoData,
 * triggers) and private "_" helpers are never reachable from here.
 */

function apiFunctions_() {
  return {
    bootstrap: bootstrap, login: login, logout: logout, changeMyAccessCode: changeMyAccessCode,
    listUsers: listUsers, getAllStaff: getAllStaff, saveUser: saveUser, setUserAccessCode: setUserAccessCode,
    getSettings: getSettings, saveSettings: saveSettings,
    getCommissionRules: getCommissionRules, saveCommissionRules: saveCommissionRules,
    getAuditLog: getAuditLog, getCommission: getCommission,
    listSchedules: listSchedules, getSchedule: getSchedule, getScheduleTemplate: getScheduleTemplate,
    saveSchedule: saveSchedule, duplicateSchedule: duplicateSchedule, duplicateMonth: duplicateMonth,
    changeScheduleStatus: changeScheduleStatus, deleteSchedule: deleteSchedule, getMySchedules: getMySchedules,
    listSales: listSales, saveSale: saveSale, deleteSale: deleteSale,
    listPackages: listPackages, savePackage: savePackage,
    getReport: getReport, getStatement: getStatement,
    getAdminDashboard: getAdminDashboard, getMyDashboard: getMyDashboard,
    getMyTimeClock: getMyTimeClock, clockIn: clockIn, clockOut: clockOut, toggleBreak: toggleBreak,
    getTimeOverview: getTimeOverview, saveTimeLog: saveTimeLog, deleteTimeLog: deleteTimeLog
  };
}

/** Handles one JSON-P request (called from doGet when ?d= is present). */
function handleApiRequest_(e) {
  const p = (e && e.parameter) || {};
  const callback = String(p.callback || '');
  if (!/^[A-Za-z_$][\w$]{0,63}$/.test(callback)) {
    return ContentService.createTextOutput('/* invalid callback */').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  let response;
  try {
    const json = Utilities.newBlob(Utilities.base64Decode(String(p.d || ''))).getDataAsString('UTF-8');
    const req = JSON.parse(json);
    const fn = apiFunctions_()[req && req.fn];
    if (!fn || !Object.prototype.hasOwnProperty.call(apiFunctions_(), req.fn)) {
      response = fail_('Unknown action.', 'BAD_REQUEST');
    } else {
      response = fn.apply(null, Array.isArray(req.args) ? req.args : []);
    }
  } catch (err) {
    response = fail_('The request could not be read. Please reload the page and try again.', 'BAD_REQUEST');
  }
  // U+2028/2029 are valid in JSON but not in older JS string literals.
  const body = JSON.stringify(response).replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028').replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
  return ContentService.createTextOutput(callback + '(' + body + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
}


// ===== Utils.gs =====
/**
 * Utils.gs
 * Shared helpers: structured responses, friendly errors, input validation,
 * timezone-safe dates, money formatting, hashing and ID generation.
 *
 * Dates travel through the app as plain strings ("yyyy-MM-dd", "yyyy-MM")
 * so they never shift across timezones and can be compared as text.
 */

/* ------------------------------------------------------------------ */
/* Responses & errors                                                  */
/* ------------------------------------------------------------------ */

/** An error whose message is safe and friendly to show to the user. */
function appError_(message, code) {
  const err = new Error(message);
  err.isAppError = true;
  err.code = code || 'VALIDATION';
  return err;
}

function ok_(data, message) {
  return { success: true, data: data === undefined ? null : data, message: message || '' };
}

function fail_(error, code) {
  return { success: false, error: error, code: code || 'ERROR' };
}

/**
 * Wraps every client-callable function: resets per-execution caches and
 * guarantees a structured { success, data, message } / { success, error } reply.
 */
function api_(fn) {
  resetExecutionCaches_();
  try {
    const result = fn();
    if (result && typeof result === 'object' && typeof result.success === 'boolean') return result;
    return ok_(result);
  } catch (e) {
    if (e && e.isAppError) return fail_(e.message, e.code);
    console.error(e && e.stack ? e.stack : String(e));
    return fail_('Something went wrong on the server: ' + (e && e.message ? e.message : String(e)), 'SERVER');
  }
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function isBlank_(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * Validates a number. opts: { min, max, integer, optional, defaultValue }.
 * Accepts "₱1,234.50"-style strings.
 */
function num_(value, label, opts) {
  opts = opts || {};
  if (isBlank_(value)) {
    if (opts.defaultValue !== undefined) return opts.defaultValue;
    if (opts.optional) return null;
    throw appError_(label + ' is required.');
  }
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s₱$]/g, ''));
  if (!isFinite(n)) throw appError_(label + ' must be a number.');
  if (opts.min !== undefined && n < opts.min) {
    throw appError_(opts.min === 0 ? label + ' cannot be negative.' : label + ' must be at least ' + opts.min + '.');
  }
  if (opts.max !== undefined && n > opts.max) throw appError_(label + ' cannot be more than ' + opts.max + '.');
  if (opts.integer && Math.floor(n) !== n) throw appError_(label + ' must be a whole number.');
  return n;
}

/** Validates a string. opts: { required, maxLength, oneOf }. */
function str_(value, label, opts) {
  opts = opts || {};
  const s = value === null || value === undefined ? '' : String(value).trim();
  if (!s && opts.required) throw appError_(label + ' is required.');
  const max = opts.maxLength || 500;
  if (s.length > max) throw appError_(label + ' is too long (maximum ' + max + ' characters).');
  if (opts.oneOf && s && opts.oneOf.indexOf(s) === -1) {
    throw appError_(label + ' must be one of: ' + opts.oneOf.join(', ') + '.');
  }
  return s;
}

function email_(value, label) {
  const s = str_(value, label, { required: true, maxLength: 200 }).toLowerCase();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s)) throw appError_(label + ' is not a valid email address.');
  return s;
}

/** Validates a "yyyy-MM-dd" date string. opts: { optional }. */
function dateStr_(value, label, opts) {
  opts = opts || {};
  if (isBlank_(value)) {
    if (opts.optional) return '';
    throw appError_(label + ' is required.');
  }
  const s = String(value).trim().slice(0, 10);
  if (!isValidDateStr_(s)) throw appError_(label + ' must be a valid date (YYYY-MM-DD).');
  return s;
}

/** Validates a "yyyy-MM" month string. */
function monthStr_(value, label) {
  const s = str_(value, label, { required: true, maxLength: 7 });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw appError_(label + ' must be a valid month (YYYY-MM).');
  return s;
}

function toBool_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

/* ------------------------------------------------------------------ */
/* Numbers & money                                                     */
/* ------------------------------------------------------------------ */

/** Rounds to centavos without binary floating-point drift (1.005 -> 1.01). */
function round2_(n) {
  const v = Number(n);
  if (!isFinite(v) || Math.abs(v) < 0.000001) return 0;
  return Number(Math.round(Number(v + 'e2')) + 'e-2');
}

function sum_(list, fn) {
  return list.reduce(function (acc, item) { return acc + (Number(fn(item)) || 0); }, 0);
}

function currencySymbol_() {
  try {
    return getConfigValue_('CurrencySymbol', '₱');
  } catch (e) {
    return '₱';
  }
}

/** Formats money for audit messages and labels, e.g. ₱100,000 or ₱3,500.50. */
function money_(n) {
  const v = round2_(n);
  const parts = Math.abs(v).toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v < 0 ? '-' : '') + currencySymbol_() + parts[0] + (parts[1] === '00' ? '' : '.' + parts[1]);
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

var TZ_CACHE_ = null;

/** The studio timezone (the spreadsheet timezone, set from Config by setupDatabase). */
function tz_() {
  if (TZ_CACHE_) return TZ_CACHE_;
  let tz = '';
  try {
    tz = getSpreadsheet_().getSpreadsheetTimeZone();
  } catch (e) {
    tz = '';
  }
  TZ_CACHE_ = tz || Session.getScriptTimeZone() || 'Asia/Manila';
  return TZ_CACHE_;
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

function todayStr_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
}

function nowStr_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss');
}

function currentMonth_() {
  return todayStr_().slice(0, 7);
}

function isValidDateStr_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}

function firstDayOfMonth_(month) {
  return month + '-01';
}

function lastDayOfMonth_(month) {
  const p = month.split('-').map(Number);
  return month + '-' + pad2_(new Date(Date.UTC(p[0], p[1], 0)).getUTCDate());
}

/** addMonths_('2026-12', 1) === '2027-01' */
function addMonths_(month, n) {
  const p = month.split('-').map(Number);
  const idx = p[0] * 12 + (p[1] - 1) + n;
  return Math.floor(idx / 12) + '-' + pad2_((idx % 12) + 1);
}

const MONTH_NAMES_ = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function monthLabel_(month) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return String(month || '');
  const p = month.split('-').map(Number);
  return MONTH_NAMES_[p[1] - 1] + ' ' + p[0];
}

function dateLabel_(s) {
  if (!isValidDateStr_(s)) return String(s || '');
  const p = s.split('-').map(Number);
  return MONTH_NAMES_[p[1] - 1].slice(0, 3) + ' ' + p[2] + ', ' + p[0];
}

/* ------------------------------------------------------------------ */
/* IDs, hashing, misc                                                  */
/* ------------------------------------------------------------------ */

/** Short, unique, human-friendly IDs such as "SAL-3F9A1C2B7D". */
function newId_(prefix) {
  return prefix + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase();
}

function sha256Hex_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function clone_(o) {
  return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
}

/** Copies a sheet row object without internal fields. */
function publicRow_(row, omit) {
  if (!row) return null;
  const out = {};
  Object.keys(row).forEach(function (k) {
    if (k.charAt(0) === '_' || (omit && omit.indexOf(k) !== -1)) return;
    out[k] = row[k];
  });
  return out;
}

/** Truncates long values for the audit log. */
function truncate_(s, max) {
  s = s === null || s === undefined ? '' : String(s);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}


// ===== Database.gs =====
/**
 * Database.gs
 * Google Sheets access layer: schema, typed reads/writes, CRUD and locking.
 *
 * Each sheet is a table whose first row holds column headers. Rows are read
 * into plain objects keyed by header. Column types drive both the sheet
 * number formats (set by setupDatabase) and (de)serialization here.
 */

const SHEET = {
  CONFIG: 'Config',
  USERS: 'Users',
  SCHEDULES: 'MonthlySchedules',
  TIERS: 'CommissionTiers',
  BONUS: 'BonusTiers',
  PACKAGES: 'Packages',
  SALES: 'Sales',
  SHARED: 'SharedSales',
  CALCS: 'CommissionCalculations',
  AUDIT: 'AuditLog',
  TIME: 'TimeLogs'
};

/**
 * Column definitions: [header, type]. Types:
 * text | month | date | datetime | money | number | percent | bool | json
 * Columns beyond the original specification are appended at the end so the
 * specified column order is preserved.
 */
const SCHEMA = {
  Config: [['Key', 'text'], ['Value', 'text'], ['Description', 'text']],
  Users: [
    ['UserID', 'text'], ['Name', 'text'], ['Email', 'text'], ['Role', 'text'], ['Position', 'text'],
    ['Status', 'text'], ['BaseCompensationDefault', 'money'], ['CreatedDate', 'datetime'],
    ['AccessCodeHash', 'text'], ['AccessCodeSalt', 'text'], ['UpdatedAt', 'datetime']
  ],
  MonthlySchedules: [
    ['ScheduleID', 'text'], ['Month', 'month'], ['StartDate', 'date'], ['EndDate', 'date'],
    ['DateIssued', 'date'], ['StaffID', 'text'], ['Position', 'text'], ['PackageTarget', 'number'],
    ['SalesTarget', 'money'], ['AdditionalTarget', 'text'], ['BaseCompensation', 'money'],
    ['ExpectedHours', 'number'], ['CommissionStructure', 'text'], ['BonusStructure', 'text'],
    ['Status', 'text'], ['Notes', 'text'], ['CreatedAt', 'datetime'], ['UpdatedAt', 'datetime'],
    ['BaseType', 'text'], ['ActualHours', 'number'], ['HourlyRate', 'money'],
    ['SpecialIncentives', 'text'], ['DuplicatedFrom', 'text']
  ],
  CommissionTiers: [
    ['TierID', 'text'], ['ScheduleID', 'text'], ['MinSales', 'money'], ['MaxSales', 'money'],
    ['Rate', 'number'], ['CommissionType', 'text']
  ],
  BonusTiers: [
    ['BonusID', 'text'], ['ScheduleID', 'text'], ['MinPackages', 'number'], ['BonusAmount', 'money'],
    ['BonusType', 'text']
  ],
  Packages: [
    ['PackageID', 'text'], ['PackageName', 'text'], ['Price', 'money'], ['Active', 'bool'],
    ['CreatedAt', 'datetime'], ['Description', 'text'], ['UpdatedAt', 'datetime']
  ],
  Sales: [
    ['SaleID', 'text'], ['SaleDate', 'date'], ['ClientName', 'text'], ['ClientContact', 'text'],
    ['StaffID', 'text'], ['PackageID', 'text'], ['PackageName', 'text'], ['GrossPrice', 'money'],
    ['Discount', 'money'], ['FinalPaidAmount', 'money'], ['PaymentStatus', 'text'],
    ['BookingStatus', 'text'], ['Commissionable', 'text'], ['SharedSale', 'bool'], ['Notes', 'text'],
    ['CreatedAt', 'datetime'], ['UpdatedAt', 'datetime'], ['CreatedBy', 'text']
  ],
  SharedSales: [
    ['SharedSaleID', 'text'], ['SaleID', 'text'], ['StaffID', 'text'], ['Percentage', 'number'],
    ['CreditedAmount', 'money']
  ],
  CommissionCalculations: [
    ['CalculationID', 'text'], ['ScheduleID', 'text'], ['StaffID', 'text'], ['TotalSales', 'money'],
    ['PackageCount', 'number'], ['SalesTarget', 'money'], ['PackageTarget', 'number'],
    ['SalesProgress', 'percent'], ['PackageProgress', 'percent'], ['CommissionRate', 'number'],
    ['CommissionAmount', 'money'], ['BonusAmount', 'money'], ['BaseCompensation', 'money'],
    ['TotalEstimatedCompensation', 'money'], ['Status', 'text'], ['CalculatedAt', 'datetime'],
    ['SnapshotJSON', 'json'], ['ApprovedBy', 'text'], ['ApprovedAt', 'datetime'],
    ['PaidBy', 'text'], ['PaidAt', 'datetime']
  ],
  AuditLog: [
    ['LogID', 'text'], ['User', 'text'], ['Action', 'text'], ['RecordID', 'text'],
    ['PreviousValue', 'text'], ['NewValue', 'text'], ['Reason', 'text'], ['Timestamp', 'datetime']
  ],
  TimeLogs: [
    ['LogID', 'text'], ['StaffID', 'text'], ['Date', 'date'], ['ClockIn', 'datetime'], ['ClockOut', 'datetime'],
    ['BreakMinutes', 'number'], ['BreakStart', 'datetime'], ['Hours', 'number'], ['Source', 'text'],
    ['Notes', 'text'], ['CreatedAt', 'datetime'], ['UpdatedAt', 'datetime'], ['EditedBy', 'text']
  ]
};

/* Per-execution caches. Each google.script.run call is a fresh execution;
 * api_() also resets these so local test harnesses behave the same way. */
var SS_ = null;
var DB_CACHE_ = {};

function resetExecutionCaches_() {
  DB_CACHE_ = {};
  CONFIG_CACHE_ = null;
  TZ_CACHE_ = null;
}

function getSpreadsheet_() {
  if (SS_) return SS_;
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  SS_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!SS_) {
    throw appError_('Spreadsheet not found. Open the Google Sheet → Extensions → Apps Script and run setupDatabase().', 'SETUP');
  }
  return SS_;
}

function getSheet_(name) {
  const sh = getSpreadsheet_().getSheetByName(name);
  if (!sh) {
    throw appError_('The "' + name + '" sheet is missing. Ask the owner to run setupDatabase() from Apps Script.', 'SETUP');
  }
  return sh;
}

function columnTypes_(name) {
  const types = {};
  (SCHEMA[name] || []).forEach(function (c) { types[c[0]] = c[1]; });
  return types;
}

/** Converts a raw cell value into its app representation. */
function fromCell_(v, type) {
  switch (type) {
    case 'date':
      if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
      return v === '' || v === null ? '' : String(v).slice(0, 10);
    case 'datetime':
      if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd HH:mm:ss');
      return v === '' || v === null ? '' : String(v);
    case 'month':
      if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM');
      return v === null ? '' : String(v).trim();
    case 'money':
    case 'number':
    case 'percent': {
      if (v === '' || v === null || v === undefined) return null;
      const n = Number(v);
      return isFinite(n) ? n : null;
    }
    case 'bool':
      return toBool_(v);
    default:
      return v === null || v === undefined ? '' : String(v);
  }
}

/** Converts an app value into a cell value. Dates are written as ISO text,
 * which Sheets parses into real dates in the spreadsheet timezone. */
function toCell_(v, type) {
  switch (type) {
    case 'money':
    case 'number':
    case 'percent':
      return v === null || v === undefined || v === '' ? '' : Number(v);
    case 'bool':
      return toBool_(v);
    case 'json':
      return v === null || v === undefined ? '' : (typeof v === 'string' ? v : JSON.stringify(v));
    case 'date':
    case 'datetime':
      return v ? String(v) : '';
    default: {
      const s = v === null || v === undefined ? '' : String(v);
      // Neutralise spreadsheet formula injection from user-entered text.
      return /^[=+@]/.test(s) ? "'" + s : s;
    }
  }
}

/** Reads a whole sheet into { headers, rows } (cached for this execution). */
function readTable_(name) {
  if (DB_CACHE_[name]) return DB_CACHE_[name];
  const values = getSheet_(name).getDataRange().getValues();
  const headers = values.length ? values[0].map(String) : [];
  const types = columnTypes_(name);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i];
    if (raw.every(function (v) { return v === '' || v === null; })) continue;
    const obj = { _row: i + 1 };
    headers.forEach(function (h, c) {
      if (h) obj[h] = fromCell_(raw[c], types[h] || 'text');
    });
    rows.push(obj);
  }
  DB_CACHE_[name] = { headers: headers, rows: rows };
  return DB_CACHE_[name];
}

function rows_(name) {
  return readTable_(name).rows;
}

function invalidate_(name) {
  delete DB_CACHE_[name];
}

function findById_(name, keyField, id) {
  if (isBlank_(id)) return null;
  return rows_(name).find(function (r) { return r[keyField] === id; }) || null;
}

function rowToValues_(name, headers, obj) {
  const types = columnTypes_(name);
  return headers.map(function (h) { return toCell_(obj[h], types[h] || 'text'); });
}

/** Appends one or more records in a single write. */
function insertRows_(name, objs) {
  if (!objs || !objs.length) return;
  const sh = getSheet_(name);
  const headers = readTable_(name).headers;
  const data = objs.map(function (o) { return rowToValues_(name, headers, o); });
  const start = sh.getLastRow() + 1;
  const needed = start + data.length - 1;
  if (needed > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), needed - sh.getMaxRows() + 200);
  sh.getRange(start, 1, data.length, headers.length).setValues(data);
  invalidate_(name);
}

/** Updates a record by key. Returns { before, after }. */
function updateRow_(name, keyField, id, patch) {
  const table = readTable_(name);
  const row = table.rows.find(function (r) { return r[keyField] === id; });
  if (!row) throw appError_('Record not found (' + id + '). It may have been deleted.', 'NOT_FOUND');
  const before = publicRow_(row);
  const after = Object.assign({}, before, patch);
  getSheet_(name).getRange(row._row, 1, 1, table.headers.length)
    .setValues([rowToValues_(name, table.headers, after)]);
  invalidate_(name);
  return { before: before, after: after };
}

/** Deletes every record matching the predicate. Returns the deleted records. */
function deleteWhere_(name, predicate) {
  const matches = rows_(name).filter(predicate);
  if (!matches.length) return [];
  const sh = getSheet_(name);
  matches.slice().sort(function (a, b) { return b._row - a._row; })
    .forEach(function (r) { sh.deleteRow(r._row); });
  invalidate_(name);
  return matches.map(function (r) { return publicRow_(r); });
}

/**
 * Runs fn while holding the script lock so simultaneous users cannot
 * interleave writes. Caches are cleared once the lock is held so every
 * decision inside is made on fresh data.
 */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw appError_('The system is busy saving another change. Please try again in a moment.', 'BUSY');
  }
  try {
    DB_CACHE_ = {};
    CONFIG_CACHE_ = null;
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

function assertDatabaseReady_() {
  const ss = getSpreadsheet_();
  let missing = Object.keys(SCHEMA).filter(function (n) { return !ss.getSheetByName(n); });
  if (missing.length && ss.getSheetByName(SHEET.CONFIG)) {
    // Sheets added in a later version (e.g. TimeLogs) are created automatically,
    // so upgrading only needs new code — no need to re-run setupDatabase().
    withLock_(function () {
      missing.forEach(function (n) { if (!ss.getSheetByName(n)) ensureSheet_(ss, n, []); });
    });
    missing = Object.keys(SCHEMA).filter(function (n) { return !ss.getSheetByName(n); });
  }
  if (missing.length) {
    throw appError_('The database is not set up yet (missing: ' + missing.join(', ') +
      '). The owner must open the Google Sheet → Extensions → Apps Script and run setupDatabase().', 'SETUP');
  }
}


// ===== Config.gs =====
/**
 * Config.gs
 * Studio settings stored in the Config sheet (Key / Value / Description).
 * Nothing business-specific — admin emails, commission rules, templates —
 * is hard-coded; everything is read from this sheet at runtime.
 */

var CONFIG_CACHE_ = null;

/** Commissionable-sales basis options (Config: DefaultCommissionableStatus). */
const COMMISSION_BASIS = {
  PAID_ONLY: 'Paid sales only',
  CONFIRMED: 'Confirmed or completed bookings',
  COMPLETED: 'Completed sessions only',
  ALL: 'All recorded sales'
};

/** Status rules: whether sales with these statuses count toward commission. */
const STATUS_RULE_KEYS = {
  cancelled: 'Commissionable_Cancelled',
  refunded: 'Commissionable_Refunded',
  unpaid: 'Commissionable_Unpaid',
  complimentary: 'Commissionable_Complimentary',
  discounted: 'Commissionable_Discounted'
};

function configDefaults_() {
  return [
    ['AdminEmails', '', 'Comma-separated Google account emails that have Admin access.'],
    ['StudioName', 'ClickLounge Studio', 'Studio name shown in the app and on statements.'],
    ['Currency', 'PHP', 'ISO currency code.'],
    ['CurrencySymbol', '₱', 'Symbol used when displaying money.'],
    ['DefaultCommissionableStatus', 'PAID_ONLY', 'What counts as commissionable: PAID_ONLY, CONFIRMED, COMPLETED or ALL.'],
    ['Timezone', 'Asia/Manila', 'Studio timezone. Keep in sync with appsscript.json.'],
    ['AppVersion', APP_VERSION, 'Installed application version (updated by setupDatabase).'],
    ['Commissionable_Cancelled', 'FALSE', 'Count cancelled bookings toward commission?'],
    ['Commissionable_Refunded', 'FALSE', 'Count refunded sales toward commission?'],
    ['Commissionable_Unpaid', 'FALSE', 'Count unpaid sales toward commission?'],
    ['Commissionable_Complimentary', 'FALSE', 'Count complimentary sessions toward commission?'],
    ['Commissionable_Discounted', 'TRUE', 'Count discounted sales toward commission?'],
    ['SharedPackageCredit', 'FRACTIONAL', 'Shared sales: FRACTIONAL (each staff gets their % of a package) or FULL (each gets 1 package).'],
    ['TemplateSalesTarget', '100000', 'Default gross sales target for new schedules.'],
    ['TemplatePackageTarget', '20', 'Default package target for new schedules.'],
    ['TemplateBaseCompensation', '8000', 'Default base compensation for new schedules.'],
    ['TemplateExpectedHours', '90', 'Default expected hours for new schedules.'],
    ['TemplateCommissionStructure', 'TIERED_WHOLE', 'TIERED_WHOLE (reached tier rate applies to all sales) or TIERED_PROGRESSIVE.'],
    ['TemplateBonusStructure', 'HIGHEST', 'HIGHEST (highest applicable bonus only) or CUMULATIVE.']
  ];
}

function getConfig_() {
  if (CONFIG_CACHE_) return CONFIG_CACHE_;
  const map = {};
  rows_(SHEET.CONFIG).forEach(function (r) { if (r.Key) map[r.Key] = r.Value; });
  CONFIG_CACHE_ = map;
  return map;
}

function getConfigValue_(key, fallback) {
  const v = getConfig_()[key];
  return v === undefined || v === '' ? fallback : v;
}

function configBool_(key, fallback) {
  const v = getConfig_()[key];
  return v === undefined || v === '' ? fallback : toBool_(v);
}

/** Writes config keys (appending missing ones) and audits each change. */
function setConfigValues_(map, actor) {
  const existing = {};
  rows_(SHEET.CONFIG).forEach(function (r) { existing[r.Key] = r; });
  const toInsert = [];
  Object.keys(map).forEach(function (key) {
    const value = String(map[key]);
    const row = existing[key];
    if (row) {
      if (row.Value === value) return;
      updateRow_(SHEET.CONFIG, 'Key', key, { Value: value });
      if (actor) logAudit_(actor, 'Changed setting ' + key, 'Config:' + key, row.Value, value);
    } else {
      toInsert.push({ Key: key, Value: value, Description: '' });
      if (actor) logAudit_(actor, 'Added setting ' + key, 'Config:' + key, '', value);
    }
  });
  insertRows_(SHEET.CONFIG, toInsert);
  CONFIG_CACHE_ = null;
}

function adminEmails_() {
  return String(getConfigValue_('AdminEmails', ''))
    .split(/[,;\s]+/)
    .map(function (e) { return e.trim().toLowerCase(); })
    .filter(Boolean);
}

function isAdminEmail_(email) {
  return !!email && adminEmails_().indexOf(String(email).toLowerCase().trim()) !== -1;
}

/** The rules that decide which sales are commissionable. */
function getCommissionRules_() {
  const basis = String(getConfigValue_('DefaultCommissionableStatus', 'PAID_ONLY')).toUpperCase();
  const rules = {
    basis: COMMISSION_BASIS[basis] ? basis : 'PAID_ONLY',
    sharedPackageCredit: String(getConfigValue_('SharedPackageCredit', 'FRACTIONAL')).toUpperCase() === 'FULL' ? 'FULL' : 'FRACTIONAL'
  };
  Object.keys(STATUS_RULE_KEYS).forEach(function (k) {
    rules[k] = configBool_(STATUS_RULE_KEYS[k], k === 'discounted');
  });
  return rules;
}

/** Non-sensitive configuration sent to every signed-in browser. */
function publicConfig_() {
  const rules = getCommissionRules_();
  return {
    studioName: getConfigValue_('StudioName', 'ClickLounge Studio'),
    currency: getConfigValue_('Currency', 'PHP'),
    currencySymbol: getConfigValue_('CurrencySymbol', '₱'),
    timezone: tz_(),
    appVersion: getConfigValue_('AppVersion', APP_VERSION),
    today: todayStr_(),
    currentMonth: currentMonth_(),
    commissionBasis: rules.basis,
    commissionBasisLabel: COMMISSION_BASIS[rules.basis],
    paymentStatuses: PAYMENT_STATUSES,
    bookingStatuses: BOOKING_STATUSES,
    scheduleStatuses: Object.keys(SCHEDULE_STATUS).map(function (k) { return SCHEDULE_STATUS[k]; })
  };
}

/* ------------------------------------------------------------------ */
/* Client-callable: studio settings                                    */
/* ------------------------------------------------------------------ */

function getSettings(token) {
  return api_(function () {
    requireAdmin_(token);
    const cfg = getConfig_();
    return {
      StudioName: cfg.StudioName || '',
      AdminEmails: adminEmails_().join(', '),
      Currency: cfg.Currency || 'PHP',
      CurrencySymbol: cfg.CurrencySymbol || '₱',
      Timezone: cfg.Timezone || tz_(),
      AppVersion: cfg.AppVersion || APP_VERSION
    };
  });
}

function saveSettings(token, input) {
  return api_(function () {
    const admin = requireAdmin_(token);
    input = input || {};
    return withLock_(function () {
      const studioName = str_(input.StudioName, 'Studio name', { required: true, maxLength: 100 });
      const emails = String(input.AdminEmails || '').split(/[,;\s]+/).filter(Boolean)
        .map(function (e) { return email_(e, 'Admin email "' + e + '"'); });
      const unique = emails.filter(function (e, i) { return emails.indexOf(e) === i; });
      if (!unique.length) throw appError_('At least one Admin email is required.');
      if (unique.indexOf(admin.email.toLowerCase()) === -1) {
        throw appError_('You cannot remove your own email from the Admin list (' + admin.email + '). Ask another Admin to do it.');
      }
      const currency = str_(input.Currency, 'Currency', { required: true, maxLength: 3 }).toUpperCase();
      const symbol = str_(input.CurrencySymbol, 'Currency symbol', { required: true, maxLength: 5 });
      const timezone = str_(input.Timezone, 'Timezone', { required: true, maxLength: 60 });
      try {
        Utilities.formatDate(new Date(), timezone, 'yyyy');
      } catch (e) {
        throw appError_('"' + timezone + '" is not a valid timezone (example: Asia/Manila).');
      }

      setConfigValues_({
        StudioName: studioName,
        AdminEmails: unique.join(', '),
        Currency: currency,
        CurrencySymbol: symbol,
        Timezone: timezone
      }, admin);
      if (getSpreadsheet_().getSpreadsheetTimeZone() !== timezone) getSpreadsheet_().setSpreadsheetTimeZone(timezone);
      syncAdminUsers_(admin);
      return ok_(null, 'Settings saved.');
    });
  });
}

/* ------------------------------------------------------------------ */
/* Client-callable: commission rules & template                        */
/* ------------------------------------------------------------------ */

function getCommissionRules(token) {
  return api_(function () {
    requireAdmin_(token);
    return {
      rules: getCommissionRules_(),
      basisOptions: COMMISSION_BASIS,
      template: getScheduleTemplate_()
    };
  });
}

function saveCommissionRules(token, input) {
  return api_(function () {
    const admin = requireAdmin_(token);
    input = input || {};
    return withLock_(function () {
      const rules = input.rules || {};
      const basis = str_(rules.basis, 'Commissionable sales basis', { required: true, oneOf: Object.keys(COMMISSION_BASIS) });
      const sharedCredit = str_(rules.sharedPackageCredit || 'FRACTIONAL', 'Shared package credit', { oneOf: ['FRACTIONAL', 'FULL'] });
      const t = input.template || {};
      const tiers = validateCommissionTiers_(t.tiers);
      const bonusTiers = validateBonusTiers_(t.bonusTiers || []);
      const values = {
        DefaultCommissionableStatus: basis,
        SharedPackageCredit: sharedCredit,
        TemplateSalesTarget: num_(t.salesTarget, 'Default sales target', { min: 0 }),
        TemplatePackageTarget: num_(t.packageTarget, 'Default package target', { min: 0, integer: true }),
        TemplateBaseCompensation: num_(t.baseCompensation, 'Default base compensation', { min: 0 }),
        TemplateExpectedHours: num_(t.expectedHours, 'Default expected hours', { min: 0, defaultValue: 0 }),
        TemplateCommissionStructure: str_(t.commissionStructure || 'TIERED_WHOLE', 'Commission structure', { oneOf: COMMISSION_STRUCTURES }),
        TemplateBonusStructure: str_(t.bonusStructure || 'HIGHEST', 'Bonus structure', { oneOf: BONUS_STRUCTURES })
      };
      Object.keys(STATUS_RULE_KEYS).forEach(function (k) {
        values[STATUS_RULE_KEYS[k]] = toBool_(rules[k]) ? 'TRUE' : 'FALSE';
      });
      setConfigValues_(values, admin);
      replaceTiers_(TEMPLATE_ID, tiers, bonusTiers, admin, 'default template');
      return ok_(null, 'Commission rules saved. New schedules will start from this template.');
    });
  });
}


// ===== Audit.gs =====
/**
 * Audit.gs
 * Append-only audit trail of important actions (AuditLog sheet).
 */

function actorLabel_(actor) {
  if (!actor) return 'System';
  if (typeof actor === 'string') return actor;
  return actor.name + ' <' + actor.email + '>';
}

/**
 * Records one audit entry. Called inside withLock_ by every sensitive action.
 * previousValue/newValue may be strings or objects (stored as JSON).
 */
function logAudit_(actor, action, recordId, previousValue, newValue, reason) {
  const fmt = function (v) {
    if (v === null || v === undefined) return '';
    return truncate_(typeof v === 'string' ? v : JSON.stringify(v), 45000);
  };
  insertRows_(SHEET.AUDIT, [{
    LogID: newId_('LOG'),
    User: actorLabel_(actor),
    Action: truncate_(action, 1000),
    RecordID: recordId || '',
    PreviousValue: fmt(previousValue),
    NewValue: fmt(newValue),
    Reason: truncate_(reason || '', 2000),
    Timestamp: nowStr_()
  }]);
}

/**
 * Audits each changed field as a readable sentence, e.g.
 * "Changed sales target from ₱100,000 to ₱120,000 (Staff A, September 2026)".
 * fields: [[key, label, 'money'|'text'|'number']]
 */
function auditFieldChanges_(actor, recordId, before, after, fields, context) {
  fields.forEach(function (f) {
    const key = f[0], label = f[1], kind = f[2] || 'text';
    const a = before[key], b = after[key];
    const same = kind === 'text' ? String(a || '') === String(b || '') : Number(a || 0) === Number(b || 0) && isBlank_(a) === isBlank_(b);
    if (same) return;
    const show = function (v) {
      if (isBlank_(v)) return '(blank)';
      return kind === 'money' ? money_(v) : String(v);
    };
    logAudit_(actor, 'Changed ' + label + ' from ' + show(a) + ' to ' + show(b) + (context ? ' (' + context + ')' : ''),
      recordId, show(a), show(b));
  });
}

/* ------------------------------------------------------------------ */
/* Client-callable                                                     */
/* ------------------------------------------------------------------ */

function getAuditLog(token, filters) {
  return api_(function () {
    requireAdmin_(token);
    filters = filters || {};
    const q = String(filters.search || '').toLowerCase().trim();
    const limit = Math.min(Number(filters.limit) || 200, 1000);
    const rows = rows_(SHEET.AUDIT).slice().reverse().filter(function (r) {
      if (!q) return true;
      return [r.User, r.Action, r.RecordID, r.Reason, r.PreviousValue, r.NewValue]
        .join(' ').toLowerCase().indexOf(q) !== -1;
    });
    return {
      total: rows.length,
      entries: rows.slice(0, limit).map(function (r) {
        const out = publicRow_(r);
        out.PreviousValue = truncate_(out.PreviousValue, 600);
        out.NewValue = truncate_(out.NewValue, 600);
        return out;
      })
    };
  });
}


// ===== Users.gs =====
/**
 * Users.gs
 * User management, sessions and role checks.
 *
 * Identity, in order of preference:
 *  1. A session token issued by bootstrap()/login(), kept in CacheService.
 *  2. The signed-in Google account (Session.getActiveUser). Available for the
 *     owner and, on Google Workspace, for users in the same domain.
 *  3. Email + access code login. Needed for consumer @gmail.com accounts,
 *     because Google hides their email from a web app that runs as the owner.
 *
 * Admin rights come from Config → AdminEmails (never hard-coded).
 * Every client-callable function calls requireUser_ / requireAdmin_.
 */

const ROLES = ['Admin', 'Staff'];
const USER_STATUSES = ['Active', 'Inactive'];
const SESSION_PREFIX_ = 'sess_';
const SESSION_SECONDS_ = 6 * 60 * 60; // CacheService maximum
const MAX_LOGIN_ATTEMPTS_ = 5;

function getGoogleEmail_() {
  try {
    return String(Session.getActiveUser().getEmail() || '').toLowerCase().trim();
  } catch (e) {
    return '';
  }
}

function findUserByEmail_(email) {
  email = String(email || '').toLowerCase().trim();
  if (!email) return null;
  return rows_(SHEET.USERS).find(function (u) { return u.Email.toLowerCase() === email; }) || null;
}

function userName_(userId) {
  const u = findById_(SHEET.USERS, 'UserID', userId);
  return u ? u.Name : '(unknown staff)';
}

/** The minimal user object used for permission checks and sent to the browser. */
function buildSessionUser_(row) {
  const admin = isAdminEmail_(row.Email);
  return {
    userId: row.UserID,
    name: row.Name,
    email: row.Email,
    position: row.Position,
    role: admin ? 'Admin' : 'Staff',
    isAdmin: admin
  };
}

function sessionUserId_(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  return CacheService.getScriptCache().get(SESSION_PREFIX_ + token);
}

function createSession_(userId) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put(SESSION_PREFIX_ + token, userId, SESSION_SECONDS_);
  return token;
}

function resolveUserRow_(token) {
  const uid = sessionUserId_(token);
  if (uid) {
    const u = findById_(SHEET.USERS, 'UserID', uid);
    if (u) return u;
  }
  const email = getGoogleEmail_();
  return email ? findUserByEmail_(email) : null;
}

/** Returns the signed-in user or throws AUTH. */
function requireUser_(token) {
  const row = resolveUserRow_(token);
  if (!row) throw appError_('Please sign in to continue.', 'AUTH');
  if (row.Status !== 'Active') throw appError_('Your account is inactive. Please contact the Admin.', 'AUTH');
  return buildSessionUser_(row);
}

/** Returns the signed-in Admin or throws FORBIDDEN. */
function requireAdmin_(token) {
  const user = requireUser_(token);
  if (!user.isAdmin) throw appError_('You do not have permission to perform this action.', 'FORBIDDEN');
  return user;
}

/** Staff may only access their own records; Admin may access everyone's. */
function requireSelfOrAdmin_(user, staffId) {
  if (!user.isAdmin && user.userId !== staffId) {
    throw appError_('You do not have permission to view another staff member\'s information.', 'FORBIDDEN');
  }
}

/** Creates a Users row for an Admin email the first time they open the app. */
function provisionAdmin_(email) {
  return withLock_(function () {
    let row = findUserByEmail_(email);
    if (!row) {
      const now = nowStr_();
      row = {
        UserID: newId_('USR'), Name: email.split('@')[0], Email: email, Role: 'Admin', Position: 'Owner / Admin',
        Status: 'Active', BaseCompensationDefault: 0, CreatedDate: now, AccessCodeHash: '', AccessCodeSalt: '', UpdatedAt: now
      };
      insertRows_(SHEET.USERS, [row]);
      logAudit_('System', 'Created Admin user for ' + email + ' (listed in Config → AdminEmails)', row.UserID, '', email);
    }
    return row.Status === 'Active' ? buildSessionUser_(row) : null;
  });
}

/** Keeps Users.Role in sync with Config → AdminEmails and creates missing Admin users. */
function syncAdminUsers_(actor) {
  const admins = adminEmails_();
  const now = nowStr_();
  const toInsert = [];
  admins.forEach(function (email) {
    if (!findUserByEmail_(email)) {
      toInsert.push({
        UserID: newId_('USR'), Name: email.split('@')[0], Email: email, Role: 'Admin', Position: 'Admin',
        Status: 'Active', BaseCompensationDefault: 0, CreatedDate: now, AccessCodeHash: '', AccessCodeSalt: '', UpdatedAt: now
      });
    }
  });
  insertRows_(SHEET.USERS, toInsert);
  toInsert.forEach(function (u) { logAudit_(actor, 'Created Admin user ' + u.Email, u.UserID, '', u.Email); });
  rows_(SHEET.USERS).forEach(function (u) {
    const role = admins.indexOf(u.Email.toLowerCase()) !== -1 ? 'Admin' : 'Staff';
    if (u.Role !== role) updateRow_(SHEET.USERS, 'UserID', u.UserID, { Role: role, UpdatedAt: now });
  });
}

/** Salted, iterated SHA-256 hash for access codes (never stored in plain text). */
function hashAccessCode_(code, salt) {
  let h = salt + ':' + code;
  for (let i = 0; i < 300; i++) h = sha256Hex_(h + ':' + salt);
  return h;
}

function validateAccessCode_(code) {
  const s = String(code || '');
  if (s.length < 6) throw appError_('Access code must be at least 6 characters.');
  if (s.length > 64) throw appError_('Access code must be 64 characters or fewer.');
  return s;
}

function publicUser_(u) {
  const out = publicRow_(u, ['AccessCodeHash', 'AccessCodeSalt']);
  out.hasAccessCode = !!u.AccessCodeHash;
  out.Role = isAdminEmail_(u.Email) ? 'Admin' : 'Staff';
  return out;
}

/* ------------------------------------------------------------------ */
/* Client-callable: sign in / out                                      */
/* ------------------------------------------------------------------ */

function login(email, accessCode) {
  return api_(function () {
    assertDatabaseReady_();
    const cleanEmail = String(email || '').toLowerCase().trim();
    if (!cleanEmail || !accessCode) throw appError_('Enter your email and access code.');
    const cache = CacheService.getScriptCache();
    const attemptsKey = 'login_' + sha256Hex_(cleanEmail).slice(0, 32);
    const attempts = Number(cache.get(attemptsKey) || 0);
    if (attempts >= MAX_LOGIN_ATTEMPTS_) {
      throw appError_('Too many sign-in attempts. Please wait 15 minutes and try again.', 'AUTH_LOCKED');
    }
    const row = findUserByEmail_(cleanEmail);
    const valid = row && row.Status === 'Active' && row.AccessCodeHash &&
      hashAccessCode_(String(accessCode), row.AccessCodeSalt) === row.AccessCodeHash;
    if (!valid) {
      cache.put(attemptsKey, String(attempts + 1), 15 * 60);
      if (attempts + 1 >= MAX_LOGIN_ATTEMPTS_) {
        withLock_(function () {
          logAudit_('System', 'Sign-in locked for 15 minutes after repeated failed attempts', cleanEmail, '', '');
        });
      }
      throw appError_('Email or access code is incorrect.', 'AUTH_FAILED');
    }
    cache.remove(attemptsKey);
    return {
      token: createSession_(row.UserID),
      user: buildSessionUser_(row),
      config: publicConfig_()
    };
  });
}

function logout(token) {
  return api_(function () {
    if (token && typeof token === 'string') CacheService.getScriptCache().remove(SESSION_PREFIX_ + token);
    return ok_(null, 'Signed out.');
  });
}

function changeMyAccessCode(token, currentCode, newCode) {
  return api_(function () {
    const user = requireUser_(token);
    const code = validateAccessCode_(newCode);
    return withLock_(function () {
      const row = findById_(SHEET.USERS, 'UserID', user.userId);
      if (row.AccessCodeHash && hashAccessCode_(String(currentCode || ''), row.AccessCodeSalt) !== row.AccessCodeHash) {
        throw appError_('Your current access code is incorrect.');
      }
      const salt = Utilities.getUuid();
      updateRow_(SHEET.USERS, 'UserID', user.userId, {
        AccessCodeHash: hashAccessCode_(code, salt), AccessCodeSalt: salt, UpdatedAt: nowStr_()
      });
      logAudit_(user, 'Changed own access code', user.userId, '', '(hidden)');
      return ok_(null, 'Access code updated.');
    });
  });
}

/* ------------------------------------------------------------------ */
/* Client-callable: staff management (Admin only)                      */
/* ------------------------------------------------------------------ */

function listUsers(token) {
  return api_(function () {
    requireAdmin_(token);
    return rows_(SHEET.USERS).map(publicUser_).sort(function (a, b) { return a.Name.localeCompare(b.Name); });
  });
}

/** Alias kept for clarity with the specification. Admin only. */
function getAllStaff(token) {
  return listUsers(token);
}

function saveUser(token, input) {
  return api_(function () {
    const admin = requireAdmin_(token);
    input = input || {};
    return withLock_(function () {
      const existing = input.UserID ? findById_(SHEET.USERS, 'UserID', input.UserID) : null;
      if (input.UserID && !existing) throw appError_('Staff member not found.', 'NOT_FOUND');
      const name = str_(input.Name, 'Name', { required: true, maxLength: 100 });
      const email = email_(input.Email, 'Email');
      const clash = rows_(SHEET.USERS).find(function (u) {
        return u.Email.toLowerCase() === email && (!existing || u.UserID !== existing.UserID);
      });
      if (clash) throw appError_('Another user (' + clash.Name + ') already uses ' + email + '.');
      const role = str_(input.Role || 'Staff', 'Role', { oneOf: ROLES });
      const status = str_(input.Status || 'Active', 'Status', { oneOf: USER_STATUSES });
      const position = str_(input.Position, 'Position', { maxLength: 100 });
      const base = num_(input.BaseCompensationDefault, 'Default base compensation', { min: 0, defaultValue: 0 });
      if (existing && existing.UserID === admin.userId && (status !== 'Active' || role !== 'Admin' || email !== admin.email.toLowerCase())) {
        throw appError_('You cannot deactivate, rename the email of, or remove Admin access from your own account.');
      }

      const now = nowStr_();
      const record = { Name: name, Email: email, Role: role, Position: position, Status: status, BaseCompensationDefault: base, UpdatedAt: now };
      let userId;
      if (existing) {
        userId = existing.UserID;
        updateRow_(SHEET.USERS, 'UserID', userId, record);
        auditFieldChanges_(admin, userId, existing, record, [
          ['Name', 'name'], ['Email', 'email'], ['Role', 'role'], ['Position', 'position'], ['Status', 'status'],
          ['BaseCompensationDefault', 'default base compensation', 'money']
        ], name);
      } else {
        userId = newId_('USR');
        insertRows_(SHEET.USERS, [Object.assign({ UserID: userId, CreatedDate: now, AccessCodeHash: '', AccessCodeSalt: '' }, record)]);
        logAudit_(admin, 'Added ' + role + ' ' + name + ' (' + email + ')', userId, '', record);
      }

      // Admin rights live in Config → AdminEmails; keep it consistent with the Role chosen here.
      const oldEmail = existing ? existing.Email.toLowerCase() : null;
      const admins = adminEmails_().filter(function (e) { return e !== oldEmail && e !== email; });
      if (role === 'Admin' && status === 'Active') admins.push(email);
      if (!admins.length) throw appError_('At least one active Admin is required.');
      if (admins.join(', ') !== adminEmails_().join(', ')) setConfigValues_({ AdminEmails: admins.join(', ') }, admin);
      syncAdminUsers_(admin);

      return ok_({ userId: userId }, existing ? 'Staff member updated.' : 'Staff member added.');
    });
  });
}

function setUserAccessCode(token, userId, code) {
  return api_(function () {
    const admin = requireAdmin_(token);
    const clean = validateAccessCode_(code);
    return withLock_(function () {
      const row = findById_(SHEET.USERS, 'UserID', userId);
      if (!row) throw appError_('Staff member not found.', 'NOT_FOUND');
      const salt = Utilities.getUuid();
      updateRow_(SHEET.USERS, 'UserID', userId, {
        AccessCodeHash: hashAccessCode_(clean, salt), AccessCodeSalt: salt, UpdatedAt: nowStr_()
      });
      logAudit_(admin, 'Set access code for ' + row.Name, userId, row.AccessCodeHash ? '(previous code)' : '(none)', '(hidden)');
      return ok_(null, 'Access code set for ' + row.Name + '.');
    });
  });
}


// ===== Commission.gs =====
/**
 * Commission.gs
 * THE single source of truth for every money calculation in the app:
 * credited sales, commissionable rules, commission tiers, bonuses, base pay,
 * progress, and approved/paid snapshots. The browser only displays results.
 *
 * Pure functions (no sheet access) are marked "pure" so they can be unit
 * tested in isolation (see Tests.gs).
 */

/* ------------------------------------------------------------------ */
/* Sales attribution & commissionable rules (pure)                     */
/* ------------------------------------------------------------------ */

/**
 * pure — Decides whether a sale counts toward commission.
 *  1. Per-sale override: Commissionable = YES / NO wins.
 *  2. Status rules: a matching status that is switched OFF excludes the sale;
 *     a matching status switched ON includes it (overriding the basis).
 *     "Discounted" can only exclude.
 *  3. Otherwise the basis applies (default: PAID_ONLY).
 */
function isSaleCommissionable_(sale, rules) {
  const override = String(sale.Commissionable || 'AUTO').toUpperCase();
  if (override === 'YES') return true;
  if (override === 'NO') return false;

  const pay = sale.PaymentStatus;
  const book = sale.BookingStatus;
  const matched = [];
  if (book === 'Cancelled') matched.push('cancelled');
  if (pay === 'Refunded') matched.push('refunded');
  if (pay === 'Unpaid') matched.push('unpaid');
  if (pay === 'Complimentary') matched.push('complimentary');
  if (Number(sale.Discount) > 0 && !rules.discounted) return false;
  if (matched.some(function (k) { return !rules[k]; })) return false;
  if (matched.length) return true;

  switch (rules.basis) {
    case 'ALL': return true;
    case 'CONFIRMED': return book === 'Confirmed' || book === 'Completed';
    case 'COMPLETED': return book === 'Completed';
    default: return pay === 'Paid';
  }
}

/**
 * pure — Returns the sales credited to one staff member within a date range.
 * Single sales credit 100% to the assigned staff. Shared sales credit each
 * staff member their percentage of the final paid amount (e.g. 60% of ₱5,000
 * = ₱3,000). Sales are never split evenly by default.
 */
function creditSalesForStaff_(sales, sharedRows, staffId, startDate, endDate, rules) {
  const splitsBySale = {};
  sharedRows.forEach(function (r) {
    (splitsBySale[r.SaleID] = splitsBySale[r.SaleID] || []).push(r);
  });
  const out = [];
  sales.forEach(function (sale) {
    if (sale.SaleDate < startDate || sale.SaleDate > endDate) return;
    let pct;
    if (sale.SharedSale) {
      const split = (splitsBySale[sale.SaleID] || []).find(function (r) { return r.StaffID === staffId; });
      if (!split) return;
      pct = Number(split.Percentage) || 0;
    } else {
      if (sale.StaffID !== staffId) return;
      pct = 100;
    }
    const finalAmount = Number(sale.FinalPaidAmount) || 0;
    out.push({
      saleId: sale.SaleID,
      saleDate: sale.SaleDate,
      clientName: sale.ClientName,
      packageName: sale.PackageName,
      finalAmount: finalAmount,
      shared: !!sale.SharedSale,
      sharePercentage: pct,
      creditedAmount: round2_(finalAmount * pct / 100),
      packageCredit: sale.SharedSale && rules.sharedPackageCredit !== 'FULL' ? pct / 100 : 1,
      paymentStatus: sale.PaymentStatus,
      bookingStatus: sale.BookingStatus,
      commissionable: isSaleCommissionable_(sale, rules)
    });
  });
  return out.sort(function (a, b) { return a.saleDate < b.saleDate ? -1 : a.saleDate > b.saleDate ? 1 : 0; });
}

/* ------------------------------------------------------------------ */
/* Tiers, bonuses, progress (pure)                                     */
/* ------------------------------------------------------------------ */

function sortTiers_(tiers) {
  return tiers.map(function (t) {
    return {
      MinSales: Number(t.MinSales) || 0,
      MaxSales: isBlank_(t.MaxSales) ? null : Number(t.MaxSales),
      Rate: Number(t.Rate) || 0,
      CommissionType: t.CommissionType === 'FIXED' ? 'FIXED' : 'PERCENT'
    };
  }).sort(function (a, b) { return a.MinSales - b.MinSales; });
}

/**
 * pure — Exclusive upper bound of tier i. Maximums are inclusive to the peso:
 * a ₱69,999 maximum covers sales up to ₱69,999.99, so ₱70,000 moves up a tier.
 */
function tierUpperBound_(sorted, i) {
  let upper = sorted[i].MaxSales === null ? Infinity : sorted[i].MaxSales + 1;
  if (sorted[i + 1]) upper = Math.min(upper, sorted[i + 1].MinSales);
  return upper;
}

function tierLabel_(t, sorted, i) {
  const range = t.MaxSales === null ? money_(t.MinSales) + '+' : money_(t.MinSales) + '–' + money_(t.MaxSales);
  const rate = t.CommissionType === 'FIXED' ? money_(t.Rate) + ' fixed' : t.Rate + '%';
  return range + ' = ' + rate;
}

/**
 * pure — Commission for a sales amount.
 * TIERED_WHOLE (default): the rate of the tier reached applies to ALL sales
 *   (₱120,000 in the 5% tier → ₱6,000).
 * TIERED_PROGRESSIVE: each tier's rate applies only to the portion of sales
 *   inside that tier (like tax brackets). FIXED tiers add their amount once reached.
 */
function computeTierCommission_(tiers, sales, structure) {
  const sorted = sortTiers_(tiers || []);
  const result = { amount: 0, rate: 0, type: 'PERCENT', tierIndex: -1, label: 'No commission tier reached', nextTier: null };
  if (!sorted.length) return result;

  if (structure === 'TIERED_PROGRESSIVE') {
    let amount = 0;
    sorted.forEach(function (t, i) {
      if (sales < t.MinSales) return;
      result.tierIndex = i;
      if (t.CommissionType === 'FIXED') {
        amount += t.Rate;
      } else {
        const portion = Math.min(sales, tierUpperBound_(sorted, i)) - t.MinSales;
        amount += Math.max(0, portion) * t.Rate / 100;
      }
    });
    result.amount = round2_(amount);
    if (result.tierIndex >= 0) {
      const top = sorted[result.tierIndex];
      result.rate = top.Rate;
      result.type = top.CommissionType;
      result.label = 'Progressive — up to ' + tierLabel_(top, sorted, result.tierIndex);
    }
  } else {
    for (let i = sorted.length - 1; i >= 0; i--) {
      const t = sorted[i];
      if (sales >= t.MinSales && sales < tierUpperBound_(sorted, i)) {
        result.tierIndex = i;
        result.rate = t.Rate;
        result.type = t.CommissionType;
        result.amount = t.CommissionType === 'FIXED' ? round2_(t.Rate) : round2_(sales * t.Rate / 100);
        result.label = tierLabel_(t, sorted, i);
        break;
      }
    }
  }

  const next = sorted.find(function (t) { return t.MinSales > sales; });
  if (next) {
    result.nextTier = {
      minSales: next.MinSales,
      salesNeeded: round2_(next.MinSales - sales),
      rate: next.Rate,
      type: next.CommissionType
    };
  }
  return result;
}

/**
 * pure — Bonus for a package count.
 * HIGHEST (default): only the highest applicable bonus (30 packages → the
 *   30-package bonus, not 20 + 25 + 30). CUMULATIVE: all reached bonuses add up.
 */
function computeBonus_(bonusTiers, packages, mode) {
  const sorted = (bonusTiers || []).map(function (b) {
    return { MinPackages: Number(b.MinPackages) || 0, BonusAmount: Number(b.BonusAmount) || 0 };
  }).sort(function (a, b) { return a.MinPackages - b.MinPackages; });
  const reached = sorted.filter(function (b) { return packages >= b.MinPackages; });
  const result = { amount: 0, label: 'No bonus reached yet', nextBonus: null };
  if (reached.length) {
    if (mode === 'CUMULATIVE') {
      result.amount = round2_(sum_(reached, function (b) { return b.BonusAmount; }));
      result.label = reached.length + ' bonus tier(s) reached (cumulative)';
    } else {
      const top = reached[reached.length - 1];
      result.amount = round2_(top.BonusAmount);
      result.label = top.MinPackages + '+ packages = ' + money_(top.BonusAmount);
    }
  }
  const next = sorted.find(function (b) { return b.MinPackages > packages; });
  if (next) {
    result.nextBonus = {
      minPackages: next.MinPackages,
      packagesNeeded: round2_(next.MinPackages - packages),
      amount: next.BonusAmount
    };
  }
  return result;
}

/** pure — Percentage progress; null when there is no target. */
function progress_(actual, target) {
  if (!target || target <= 0) return null;
  return round2_(actual / target * 100);
}

/**
 * pure — Base compensation for the month (fixed or hourly).
 * Hourly base uses, in order: Actual hours typed on the schedule, hours
 * logged on the time clock, otherwise expected hours (as an estimate).
 */
function computeBase_(schedule, loggedHours) {
  const baseType = schedule.BaseType === 'HOURLY' ? 'HOURLY' : 'FIXED';
  const expected = Number(schedule.ExpectedHours) || 0;
  let amount;
  let hoursUsed = null;
  let hoursSource = null;
  if (baseType === 'HOURLY') {
    if (!isBlank_(schedule.ActualHours)) {
      hoursUsed = Number(schedule.ActualHours) || 0;
      hoursSource = 'ACTUAL';
    } else if (loggedHours > 0) {
      hoursUsed = loggedHours;
      hoursSource = 'TIME_CLOCK';
    } else {
      hoursUsed = expected;
      hoursSource = 'EXPECTED';
    }
    amount = round2_((Number(schedule.HourlyRate) || 0) * hoursUsed);
  } else {
    amount = round2_(Number(schedule.BaseCompensation) || 0);
  }
  return {
    amount: amount,
    type: baseType,
    hoursUsed: hoursUsed,
    hoursSource: hoursSource,
    // Effective hourly rate = Base compensation / Expected hours.
    effectiveHourlyRate: expected > 0 ? round2_(amount / expected) : null
  };
}

/**
 * pure — The full calculation for one schedule from already-loaded data.
 * Used by calculateCommission_ and by the unit tests.
 */
function computeCommission_(schedule, tiers, bonusTiers, credited, hours) {
  hours = hours || { hours: 0, entries: 0 };
  const counted = credited.filter(function (c) { return c.commissionable; });
  const sales = round2_(sum_(counted, function (c) { return c.creditedAmount; }));
  const packageCount = round2_(sum_(counted, function (c) { return c.packageCredit; }));
  const recordedSales = round2_(sum_(credited, function (c) { return c.creditedAmount; }));
  const salesTarget = Number(schedule.SalesTarget) || 0;
  const packageTarget = Number(schedule.PackageTarget) || 0;

  const tier = computeTierCommission_(tiers, sales, schedule.CommissionStructure);
  const bonus = computeBonus_(bonusTiers, packageCount, schedule.BonusStructure);
  const base = computeBase_(schedule, hours.hours);
  const expectedHours = isBlank_(schedule.ExpectedHours) ? null : Number(schedule.ExpectedHours);
  const finalized = LOCKED_STATUSES.indexOf(schedule.Status) !== -1;

  return {
    scheduleId: schedule.ScheduleID,
    staffId: schedule.StaffID,
    month: schedule.Month,
    startDate: schedule.StartDate,
    endDate: schedule.EndDate,
    sales: sales,
    packageCount: packageCount,
    saleCount: counted.length,
    averageSale: counted.length ? round2_(sales / counted.length) : 0,
    recordedSales: recordedSales,
    nonCommissionableSales: round2_(recordedSales - sales),
    salesTarget: salesTarget,
    packageTarget: packageTarget,
    salesProgress: progress_(sales, salesTarget),
    packageProgress: progress_(packageCount, packageTarget),
    // Remaining amounts never go negative; overshoot is reported separately.
    remainingSales: round2_(Math.max(0, salesTarget - sales)),
    amountAboveTarget: round2_(Math.max(0, sales - salesTarget)),
    targetReached: salesTarget > 0 && sales >= salesTarget,
    targetExceeded: salesTarget > 0 && sales > salesTarget,
    packagesRemaining: round2_(Math.max(0, packageTarget - packageCount)),
    commissionStructure: schedule.CommissionStructure || 'TIERED_WHOLE',
    commissionRate: tier.rate,
    commissionType: tier.type,
    commissionTier: tier.label,
    commissionTierIndex: tier.tierIndex,
    nextCommissionTier: tier.nextTier,
    commissionAmount: tier.amount,
    bonusStructure: schedule.BonusStructure || 'HIGHEST',
    bonusAmount: bonus.amount,
    bonusTier: bonus.label,
    nextBonus: bonus.nextBonus,
    baseCompensation: base.amount,
    baseType: base.type,
    baseHoursUsed: base.hoursUsed,
    baseHoursSource: base.hoursSource,
    // Time clock: every completed hour counts toward the required hours.
    expectedHours: expectedHours,
    loggedHours: hours.hours,
    timeEntries: hours.entries,
    hoursProgress: progress_(hours.hours, expectedHours),
    hoursRemaining: expectedHours === null ? null : round2_(Math.max(0, expectedHours - hours.hours)),
    effectiveHourlyRate: base.effectiveHourlyRate,
    totalCompensation: round2_(base.amount + tier.amount + bonus.amount),
    status: schedule.Status,
    isEstimate: !finalized,
    isSnapshot: false
  };
}

/* ------------------------------------------------------------------ */
/* Sheet-backed calculation                                            */
/* ------------------------------------------------------------------ */

/** Loads everything needed and computes a schedule's live figures. */
function computeLiveCommission_(schedule) {
  const rules = getCommissionRules_();
  const tiers = getTiers_(schedule.ScheduleID);
  const bonusTiers = getBonusTiers_(schedule.ScheduleID);
  const credited = creditSalesForStaff_(rows_(SHEET.SALES), rows_(SHEET.SHARED), schedule.StaffID,
    schedule.StartDate, schedule.EndDate, rules);
  const hours = sumLoggedHours_(rows_(SHEET.TIME), schedule.StaffID, schedule.StartDate, schedule.EndDate);
  const result = computeCommission_(schedule, tiers, bonusTiers, credited, hours);
  result.calculatedAt = nowStr_();
  return { result: result, tiers: tiers, bonusTiers: bonusTiers, credited: credited, rules: rules };
}

/** Latest Approved/Paid snapshot for a schedule, or null. */
function getActiveSnapshot_(scheduleId) {
  const rows = rows_(SHEET.CALCS).filter(function (r) {
    return r.ScheduleID === scheduleId && (r.Status === 'Approved' || r.Status === 'Paid');
  });
  return rows.length ? rows[rows.length - 1] : null;
}

function parseSnapshot_(row) {
  try {
    return JSON.parse(row.SnapshotJSON || '{}');
  } catch (e) {
    return {};
  }
}

/** Rebuilds the calculation result from a stored snapshot — never recalculated. */
function snapshotToResult_(row) {
  const snap = parseSnapshot_(row);
  const result = Object.assign({}, snap.result || {});
  result.status = row.Status;
  result.isEstimate = false;
  result.isSnapshot = true;
  result.calculationId = row.CalculationID;
  result.calculatedAt = row.CalculatedAt;
  result.approvedBy = row.ApprovedBy;
  result.approvedAt = row.ApprovedAt;
  result.paidBy = row.PaidBy;
  result.paidAt = row.PaidAt;
  return result;
}

/**
 * THE authoritative calculation: calculateCommission_(scheduleId, staffId).
 *
 * Returns { sales, packageCount, salesTarget, packageTarget, salesProgress,
 * packageProgress, commissionRate, commissionAmount, bonusAmount,
 * baseCompensation, totalCompensation, status, ... }.
 *
 * Approved/Paid schedules return their stored snapshot, so later rule changes
 * (e.g. October moving to 7%) can never alter a finalized month.
 *
 * The trailing underscore makes it private to the server: the browser cannot
 * call it directly and must go through getCommission(token, ...), which
 * checks permissions first.
 */
function calculateCommission_(scheduleId, staffId) {
  const schedule = findById_(SHEET.SCHEDULES, 'ScheduleID', scheduleId);
  if (!schedule) throw appError_('Schedule not found.', 'NOT_FOUND');
  if (staffId && schedule.StaffID !== staffId) {
    throw appError_('This schedule belongs to a different staff member.', 'FORBIDDEN');
  }
  if (LOCKED_STATUSES.indexOf(schedule.Status) !== -1) {
    const snap = getActiveSnapshot_(scheduleId);
    if (snap) return snapshotToResult_(snap);
  }
  return computeLiveCommission_(schedule).result;
}

/** Stores an approval snapshot of the live calculation (called by approve). */
function createSnapshot_(schedule, actor) {
  const live = computeLiveCommission_(schedule);
  const r = live.result;
  r.status = 'Approved';
  r.isEstimate = false;
  const now = nowStr_();
  const row = {
    CalculationID: newId_('CAL'),
    ScheduleID: schedule.ScheduleID,
    StaffID: schedule.StaffID,
    TotalSales: r.sales,
    PackageCount: r.packageCount,
    SalesTarget: r.salesTarget,
    PackageTarget: r.packageTarget,
    SalesProgress: r.salesProgress,
    PackageProgress: r.packageProgress,
    CommissionRate: r.commissionRate,
    CommissionAmount: r.commissionAmount,
    BonusAmount: r.bonusAmount,
    BaseCompensation: r.baseCompensation,
    TotalEstimatedCompensation: r.totalCompensation,
    Status: 'Approved',
    CalculatedAt: now,
    // Everything needed to reprint the statement exactly as approved.
    SnapshotJSON: JSON.stringify({
      version: 1,
      result: r,
      schedule: publicRow_(schedule),
      tiers: live.tiers.map(function (t) { return publicRow_(t); }),
      bonusTiers: live.bonusTiers.map(function (b) { return publicRow_(b); }),
      rules: live.rules,
      sales: live.credited
    }),
    ApprovedBy: actorLabel_(actor),
    ApprovedAt: now,
    PaidBy: '',
    PaidAt: ''
  };
  insertRows_(SHEET.CALCS, [row]);
  return row;
}

/* ------------------------------------------------------------------ */
/* Client-callable                                                     */
/* ------------------------------------------------------------------ */

/** Permission-checked access to calculateCommission_. */
function getCommission(token, scheduleId) {
  return api_(function () {
    const user = requireUser_(token);
    const schedule = findById_(SHEET.SCHEDULES, 'ScheduleID', scheduleId);
    if (!schedule) throw appError_('Schedule not found.', 'NOT_FOUND');
    requireSelfOrAdmin_(user, schedule.StaffID);
    return calculateCommission_(scheduleId, schedule.StaffID);
  });
}


// ===== Time.gs =====
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
  }
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

function clockIn(token, note) {
  return api_(function () {
    const user = requireUser_(token);
    return withLock_(function () {
      const open = openEntry_(user.userId);
      if (open) throw appError_('You are already clocked in since ' + timeLabel_(open.ClockIn) + ' (' + dateLabel_(open.Date) + ').');
      const now = nowStr_();
      insertRows_(SHEET.TIME, [{
        LogID: newId_('TIM'), StaffID: user.userId, Date: now.slice(0, 10), ClockIn: now, ClockOut: '',
        BreakMinutes: 0, BreakStart: '', Hours: null, Source: 'CLOCK',
        Notes: str_(note, 'Note', { maxLength: 300 }), CreatedAt: now, UpdatedAt: now, EditedBy: ''
      }]);
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
        updateRow_(SHEET.TIME, 'LogID', open.LogID, { BreakMinutes: (Number(open.BreakMinutes) || 0) + mins, BreakStart: '', UpdatedAt: now });
        message = 'Break ended (' + mins + ' min).';
      } else {
        updateRow_(SHEET.TIME, 'LogID', open.LogID, { BreakStart: now, UpdatedAt: now });
        message = 'Break started at ' + timeLabel_(now) + '.';
      }
      return ok_(timeClockState_(user.userId), message);
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
      updateRow_(SHEET.TIME, 'LogID', open.LogID, {
        ClockOut: now, BreakMinutes: breakMins, BreakStart: '', Hours: hours, UpdatedAt: now,
        Notes: [open.Notes, extra].filter(Boolean).join(' · ')
      });
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
      return {
        staffId: u.UserID, staffName: u.Name, expectedHours: expected, loggedHours: logged.hours, entries: logged.entries,
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

    return { month: month, monthLabel: monthLabel_(month), now: now, clockedIn: clockedIn, summary: summary, entries: entries };
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
      logAudit_(admin, 'Deleted time entry (' + userName_(l.StaffID) + ', ' + dateLabel_(l.Date) + ', ' +
        (l.Hours === null || l.Hours === '' ? 'open' : l.Hours + ' h') + ')', logId, publicRow_(l), '');
      return ok_(null, 'Time entry deleted.');
    });
  });
}


// ===== Schedules.gs =====
/**
 * Schedules.gs
 * Monthly Sales Target & Commission Schedules — the authoritative document
 * for each staff member's month. Every schedule owns its own copy of the
 * targets, commission tiers, bonus tiers, base compensation, dates and
 * incentives, so editing one month never changes another.
 *
 * Workflow: Draft → Active → Pending Approval → Approved → Paid.
 * Approved and Paid schedules are locked; "Unlock for Correction" (with a
 * recorded reason) is the only way back.
 */

const SCHEDULE_STATUS = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  PENDING: 'Pending Approval',
  APPROVED: 'Approved',
  PAID: 'Paid'
};
const LOCKED_STATUSES = ['Approved', 'Paid'];
const COMMISSION_STRUCTURES = ['TIERED_WHOLE', 'TIERED_PROGRESSIVE'];
const BONUS_STRUCTURES = ['HIGHEST', 'CUMULATIVE'];
const BASE_TYPES = ['FIXED', 'HOURLY'];
const TEMPLATE_ID = 'TEMPLATE';

/** Allowed status transitions (see changeScheduleStatus). */
const STATUS_ACTIONS_ = {
  activate: { from: ['Draft'], to: 'Active', name: 'activate', verb: 'Activated schedule' },
  revertToDraft: { from: ['Active'], to: 'Draft', name: 'move back to Draft', verb: 'Moved schedule back to Draft' },
  close: { from: ['Active'], to: 'Pending Approval', name: 'close the month', verb: 'Closed month for approval' },
  reopen: { from: ['Pending Approval'], to: 'Active', name: 'reopen', verb: 'Reopened schedule' },
  approve: { from: ['Active', 'Pending Approval'], to: 'Approved', name: 'approve', verb: 'Approved commission' },
  markPaid: { from: ['Approved'], to: 'Paid', name: 'mark as Paid', verb: 'Marked commission as Paid' },
  unlock: { from: ['Approved', 'Paid'], to: 'Pending Approval', name: 'unlock', verb: 'Unlocked for correction', requiresReason: true }
};

function isLocked_(schedule) {
  return LOCKED_STATUSES.indexOf(schedule.Status) !== -1;
}

function getTiers_(scheduleId) {
  return rows_(SHEET.TIERS).filter(function (t) { return t.ScheduleID === scheduleId; })
    .sort(function (a, b) { return (a.MinSales || 0) - (b.MinSales || 0); });
}

function getBonusTiers_(scheduleId) {
  return rows_(SHEET.BONUS).filter(function (b) { return b.ScheduleID === scheduleId; })
    .sort(function (a, b) { return (a.MinPackages || 0) - (b.MinPackages || 0); });
}

function tiersSummary_(tiers) {
  return sortTiers_(tiers).map(function (t, i, all) { return tierLabel_(t, all, i); }).join('; ');
}

function bonusSummary_(bonusTiers) {
  return bonusTiers.map(function (b) { return b.MinPackages + ' pkgs = ' + money_(b.BonusAmount); }).join('; ');
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/** Validates commission tiers: valid numbers, sensible rates, no overlaps. */
function validateCommissionTiers_(tiers) {
  if (!Array.isArray(tiers) || !tiers.length) throw appError_('Add at least one commission tier.');
  const clean = tiers.map(function (t, i) {
    const label = 'Commission tier ' + (i + 1);
    const type = str_(t.CommissionType || 'PERCENT', label + ' type', { oneOf: ['PERCENT', 'FIXED'] });
    const min = num_(t.MinSales, label + ' minimum sales', { min: 0 });
    const max = num_(t.MaxSales, label + ' maximum sales', { min: 0, optional: true });
    if (max !== null && max < min) throw appError_(label + ': maximum sales must be greater than or equal to the minimum.');
    const rate = type === 'PERCENT'
      ? num_(t.Rate, label + ' commission %', { min: 0, max: 100 })
      : num_(t.Rate, label + ' fixed commission amount', { min: 0 });
    return { MinSales: min, MaxSales: max, Rate: rate, CommissionType: type };
  }).sort(function (a, b) { return a.MinSales - b.MinSales; });

  for (let i = 1; i < clean.length; i++) {
    const prev = clean[i - 1], cur = clean[i];
    if (prev.MaxSales === null || prev.MaxSales >= cur.MinSales) {
      throw appError_('Commission tiers overlap: the tier starting at ' + money_(prev.MinSales) +
        (prev.MaxSales === null ? ' has no maximum' : ' ends at ' + money_(prev.MaxSales)) +
        ', but the next tier starts at ' + money_(cur.MinSales) + '. Adjust the ranges so they do not overlap.');
    }
  }
  return clean;
}

/** Validates bonus tiers: whole positive package counts, no duplicates. */
function validateBonusTiers_(bonusTiers) {
  if (!Array.isArray(bonusTiers)) throw appError_('Bonus tiers are invalid.');
  const clean = bonusTiers.map(function (b, i) {
    const label = 'Bonus tier ' + (i + 1);
    return {
      MinPackages: num_(b.MinPackages, label + ' package requirement', { min: 1, integer: true }),
      BonusAmount: num_(b.BonusAmount, label + ' bonus amount', { min: 0 }),
      BonusType: 'FIXED'
    };
  }).sort(function (a, b) { return a.MinPackages - b.MinPackages; });
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].MinPackages === clean[i - 1].MinPackages) {
      throw appError_('Two bonus tiers both require ' + clean[i].MinPackages + ' packages. Each tier needs a different package count.');
    }
  }
  return clean;
}

function normalizeSchedule_(input, existing) {
  const s = {};
  s.Month = monthStr_(input.Month, 'Month');
  s.StartDate = dateStr_(input.StartDate || firstDayOfMonth_(s.Month), 'Target start date');
  s.EndDate = dateStr_(input.EndDate || lastDayOfMonth_(s.Month), 'Target end date');
  if (s.EndDate < s.StartDate) throw appError_('Target end date must be on or after the start date.');
  s.DateIssued = dateStr_(input.DateIssued || todayStr_(), 'Date issued');

  s.StaffID = str_(input.StaffID, 'Staff member', { required: true });
  const staff = findById_(SHEET.USERS, 'UserID', s.StaffID);
  if (!staff) throw appError_('Please choose a valid staff member.');
  const staffChanged = !existing || existing.StaffID !== s.StaffID;
  if (staffChanged && staff.Status !== 'Active') throw appError_(staff.Name + ' is inactive. Reactivate them before creating a schedule.');

  s.Position = str_(isBlank_(input.Position) ? staff.Position : input.Position, 'Position', { maxLength: 100 });
  s.PackageTarget = num_(input.PackageTarget, 'Package target', { min: 0, integer: true });
  s.SalesTarget = num_(input.SalesTarget, 'Gross sales target', { min: 0 });
  s.AdditionalTarget = str_(input.AdditionalTarget, 'Additional performance target', { maxLength: 1000 });
  s.SpecialIncentives = str_(input.SpecialIncentives, 'Special incentives', { maxLength: 1000 });
  s.BaseType = str_(input.BaseType || 'FIXED', 'Base compensation type', { oneOf: BASE_TYPES });
  s.BaseCompensation = num_(input.BaseCompensation, 'Base compensation', { min: 0, defaultValue: 0 });
  s.ExpectedHours = num_(input.ExpectedHours, 'Expected hours', { min: 0, optional: true });
  s.ActualHours = num_(input.ActualHours, 'Actual hours', { min: 0, optional: true });
  s.HourlyRate = num_(input.HourlyRate, 'Hourly rate', { min: 0, optional: true });
  if (s.BaseType === 'HOURLY' && s.HourlyRate === null) throw appError_('Enter an hourly rate for hourly base compensation.');
  s.CommissionStructure = str_(input.CommissionStructure || 'TIERED_WHOLE', 'Commission structure', { oneOf: COMMISSION_STRUCTURES });
  s.BonusStructure = str_(input.BonusStructure || 'HIGHEST', 'Bonus structure', { oneOf: BONUS_STRUCTURES });
  s.Notes = str_(input.Notes, 'Notes', { maxLength: 2000 });
  return s;
}

/**
 * Prevents a second schedule for the same staff/month (unless the Admin
 * explicitly allows it) and any date overlap between a staff member's
 * schedules — overlapping periods would count the same sales twice.
 */
function checkScheduleConflicts_(s, excludeId, allowDuplicate) {
  const staffName = userName_(s.StaffID);
  const others = rows_(SHEET.SCHEDULES).filter(function (r) {
    return r.ScheduleID !== excludeId && r.StaffID === s.StaffID;
  });
  if (!allowDuplicate && others.some(function (r) { return r.Month === s.Month; })) {
    throw appError_(staffName + ' already has a schedule for ' + monthLabel_(s.Month) +
      '. Edit that schedule instead, or tick "Allow a second schedule for this month".', 'DUPLICATE');
  }
  const overlap = others.find(function (r) { return r.StartDate <= s.EndDate && s.StartDate <= r.EndDate; });
  if (overlap) {
    throw appError_('These dates overlap ' + staffName + '\'s ' + monthLabel_(overlap.Month) + ' schedule (' +
      dateLabel_(overlap.StartDate) + ' – ' + dateLabel_(overlap.EndDate) + '). Sales would be counted twice.', 'OVERLAP');
  }
}

/** Replaces the tier rows of a schedule (or the template) and audits the change. */
function replaceTiers_(scheduleId, tiers, bonusTiers, actor, context) {
  const oldTiers = getTiers_(scheduleId);
  const oldBonus = getBonusTiers_(scheduleId);
  const tiersChanged = tiersSummary_(oldTiers) !== tiersSummary_(tiers);
  const bonusChanged = bonusSummary_(oldBonus) !== bonusSummary_(bonusTiers);
  if (tiersChanged) {
    deleteWhere_(SHEET.TIERS, function (t) { return t.ScheduleID === scheduleId; });
    insertRows_(SHEET.TIERS, tiers.map(function (t) {
      return { TierID: newId_('TIR'), ScheduleID: scheduleId, MinSales: t.MinSales, MaxSales: t.MaxSales, Rate: t.Rate, CommissionType: t.CommissionType };
    }));
    if (actor && oldTiers.length) {
      logAudit_(actor, 'Changed commission tiers (' + context + ')', scheduleId, tiersSummary_(oldTiers), tiersSummary_(tiers));
    }
  }
  if (bonusChanged) {
    deleteWhere_(SHEET.BONUS, function (b) { return b.ScheduleID === scheduleId; });
    insertRows_(SHEET.BONUS, bonusTiers.map(function (b) {
      return { BonusID: newId_('BON'), ScheduleID: scheduleId, MinPackages: b.MinPackages, BonusAmount: b.BonusAmount, BonusType: b.BonusType || 'FIXED' };
    }));
    if (actor && oldBonus.length) {
      logAudit_(actor, 'Changed bonus tiers (' + context + ')', scheduleId, bonusSummary_(oldBonus), bonusSummary_(bonusTiers));
    }
  }
}

function scheduleContext_(s) {
  return userName_(s.StaffID) + ', ' + monthLabel_(s.Month);
}

const SCHEDULE_AUDIT_FIELDS_ = [
  ['Month', 'month'], ['StartDate', 'target start date'], ['EndDate', 'target end date'], ['DateIssued', 'date issued'],
  ['StaffID', 'staff'], ['Position', 'position'], ['PackageTarget', 'package target', 'number'],
  ['SalesTarget', 'sales target', 'money'], ['AdditionalTarget', 'additional target'],
  ['BaseType', 'base compensation type'], ['BaseCompensation', 'base compensation', 'money'],
  ['ExpectedHours', 'expected hours', 'number'], ['ActualHours', 'actual hours', 'number'],
  ['HourlyRate', 'hourly rate', 'money'], ['CommissionStructure', 'commission structure'],
  ['BonusStructure', 'bonus structure'], ['SpecialIncentives', 'special incentives'], ['Notes', 'notes']
];

/* ------------------------------------------------------------------ */
/* Internal operations (also used by setup/demo)                       */
/* ------------------------------------------------------------------ */

function getScheduleTemplate_() {
  return {
    salesTarget: Number(getConfigValue_('TemplateSalesTarget', 0)),
    packageTarget: Number(getConfigValue_('TemplatePackageTarget', 0)),
    baseCompensation: Number(getConfigValue_('TemplateBaseCompensation', 0)),
    expectedHours: Number(getConfigValue_('TemplateExpectedHours', 0)),
    commissionStructure: getConfigValue_('TemplateCommissionStructure', 'TIERED_WHOLE'),
    bonusStructure: getConfigValue_('TemplateBonusStructure', 'HIGHEST'),
    tiers: getTiers_(TEMPLATE_ID).map(function (t) { return publicRow_(t); }),
    bonusTiers: getBonusTiers_(TEMPLATE_ID).map(function (b) { return publicRow_(b); })
  };
}

/** Creates or updates a schedule. Must be called inside withLock_. */
function saveSchedule_(actor, input, tiersInput, bonusInput, allowDuplicate) {
  const id = input.ScheduleID || '';
  const existing = id ? findById_(SHEET.SCHEDULES, 'ScheduleID', id) : null;
  if (id && !existing) throw appError_('Schedule not found.', 'NOT_FOUND');
  if (existing && isLocked_(existing)) {
    throw appError_('This schedule is ' + existing.Status + ' and locked. Use "Unlock for Correction" before editing.', 'LOCKED');
  }
  const s = normalizeSchedule_(input, existing);
  const tiers = validateCommissionTiers_(tiersInput);
  const bonusTiers = validateBonusTiers_(bonusInput || []);
  checkScheduleConflicts_(s, id, allowDuplicate);
  const now = nowStr_();

  if (existing) {
    s.UpdatedAt = now;
    updateRow_(SHEET.SCHEDULES, 'ScheduleID', id, s);
    const readable = function (row) {
      return Object.assign({}, row, { StaffID: userName_(row.StaffID) });
    };
    auditFieldChanges_(actor, id, readable(existing), readable(s), SCHEDULE_AUDIT_FIELDS_, scheduleContext_(s));
    replaceTiers_(id, tiers, bonusTiers, actor, scheduleContext_(s));
    return id;
  }

  const newId = newId_('SCH');
  const status = input.Status === SCHEDULE_STATUS.ACTIVE ? SCHEDULE_STATUS.ACTIVE : SCHEDULE_STATUS.DRAFT;
  insertRows_(SHEET.SCHEDULES, [Object.assign(s, {
    ScheduleID: newId, Status: status, CreatedAt: now, UpdatedAt: now, DuplicatedFrom: input.DuplicatedFrom || ''
  })]);
  replaceTiers_(newId, tiers, bonusTiers, null, '');
  logAudit_(actor, 'Created ' + status + ' schedule (' + scheduleContext_(s) + '): target ' + money_(s.SalesTarget) +
    ', ' + s.PackageTarget + ' packages, base ' + money_(s.BaseCompensation), newId, '',
    { tiers: tiersSummary_(tiers), bonus: bonusSummary_(bonusTiers) });
  return newId;
}

/** Copies a schedule (targets, tiers, bonuses, incentives) into another month as a Draft. */
function duplicateSchedule_(actor, sourceId, targetMonth, allowDuplicate) {
  const src = findById_(SHEET.SCHEDULES, 'ScheduleID', sourceId);
  if (!src) throw appError_('Schedule to duplicate was not found.', 'NOT_FOUND');
  const month = targetMonth ? monthStr_(targetMonth, 'New month') : addMonths_(src.Month, 1);
  const input = Object.assign({}, publicRow_(src), {
    ScheduleID: '',
    Month: month,
    StartDate: firstDayOfMonth_(month),
    EndDate: lastDayOfMonth_(month),
    DateIssued: todayStr_(),
    ActualHours: null,
    Status: SCHEDULE_STATUS.DRAFT,
    DuplicatedFrom: src.ScheduleID
  });
  const newId = saveSchedule_(actor, input, getTiers_(src.ScheduleID), getBonusTiers_(src.ScheduleID), allowDuplicate);
  logAudit_(actor, 'Duplicated schedule ' + scheduleContext_(src) + ' into ' + monthLabel_(month), newId, src.ScheduleID, newId);
  return newId;
}

/** Applies a workflow action. Approve stores a snapshot; unlock supersedes it. */
function changeScheduleStatus_(actor, scheduleId, action, reason) {
  const def = STATUS_ACTIONS_[action];
  if (!def) throw appError_('Unknown action.');
  const s = findById_(SHEET.SCHEDULES, 'ScheduleID', scheduleId);
  if (!s) throw appError_('Schedule not found.', 'NOT_FOUND');
  if (def.from.indexOf(s.Status) === -1) {
    throw appError_('Cannot ' + def.name + ' — the schedule is currently ' + s.Status + '.', 'INVALID_STATUS');
  }
  const cleanReason = str_(reason, 'Reason', { maxLength: 1000 });
  if (def.requiresReason && cleanReason.length < 5) throw appError_('Please enter a reason (at least 5 characters).');

  const now = nowStr_();
  let detail = '';
  if (action === 'approve') {
    const snap = createSnapshot_(s, actor);
    detail = ': sales ' + money_(snap.TotalSales) + ', commission ' + money_(snap.CommissionAmount) +
      ', bonus ' + money_(snap.BonusAmount) + ', total ' + money_(snap.TotalEstimatedCompensation);
  } else if (action === 'markPaid') {
    const snap = getActiveSnapshot_(scheduleId);
    if (!snap) throw appError_('No approved calculation found. Approve the schedule first.');
    updateRow_(SHEET.CALCS, 'CalculationID', snap.CalculationID, { Status: 'Paid', PaidBy: actorLabel_(actor), PaidAt: now });
    detail = ': total ' + money_(snap.TotalEstimatedCompensation);
  } else if (action === 'unlock') {
    const snap = getActiveSnapshot_(scheduleId);
    if (snap) updateRow_(SHEET.CALCS, 'CalculationID', snap.CalculationID, { Status: 'Superseded' });
  }

  updateRow_(SHEET.SCHEDULES, 'ScheduleID', scheduleId, { Status: def.to, UpdatedAt: now });
  logAudit_(actor, def.verb + ' (' + scheduleContext_(s) + ')' + detail, scheduleId, s.Status, def.to, cleanReason);
  return def.to;
}

/** Active schedules whose period has ended move to Pending Approval. */
function autoAdvanceSchedules_() {
  const today = todayStr_();
  const due = rows_(SHEET.SCHEDULES).filter(function (s) {
    return s.Status === SCHEDULE_STATUS.ACTIVE && s.EndDate < today;
  });
  if (!due.length) return 0;
  return withLock_(function () {
    let n = 0;
    rows_(SHEET.SCHEDULES).forEach(function (s) {
      if (s.Status === SCHEDULE_STATUS.ACTIVE && s.EndDate < today) {
        updateRow_(SHEET.SCHEDULES, 'ScheduleID', s.ScheduleID, { Status: SCHEDULE_STATUS.PENDING, UpdatedAt: nowStr_() });
        logAudit_('System', 'Month ended — moved to Pending Approval (' + scheduleContext_(s) + ')', s.ScheduleID, 'Active', 'Pending Approval');
        n++;
      }
    });
    return n;
  });
}

/** Schedule + staff + tiers + calculation, as shown on detail pages. */
function scheduleDetail_(s) {
  const calc = calculateCommission_(s.ScheduleID, s.StaffID);
  let tiers = getTiers_(s.ScheduleID).map(function (t) { return publicRow_(t); });
  let bonusTiers = getBonusTiers_(s.ScheduleID).map(function (b) { return publicRow_(b); });
  if (calc.isSnapshot) {
    // Show exactly the rules that were approved.
    const snapRow = getActiveSnapshot_(s.ScheduleID);
    const snap = parseSnapshot_(snapRow);
    tiers = snap.tiers || tiers;
    bonusTiers = snap.bonusTiers || bonusTiers;
  }
  const staff = findById_(SHEET.USERS, 'UserID', s.StaffID);
  return {
    schedule: publicRow_(s),
    staffName: staff ? staff.Name : '(unknown)',
    staffEmail: staff ? staff.Email : '',
    tiers: tiers,
    bonusTiers: bonusTiers,
    calc: calc,
    locked: isLocked_(s)
  };
}

function scheduleSummaryRow_(s) {
  const calc = calculateCommission_(s.ScheduleID, s.StaffID);
  return {
    scheduleId: s.ScheduleID,
    month: s.Month,
    monthLabel: monthLabel_(s.Month),
    startDate: s.StartDate,
    endDate: s.EndDate,
    staffId: s.StaffID,
    staffName: userName_(s.StaffID),
    position: s.Position,
    status: s.Status,
    locked: isLocked_(s),
    salesTarget: calc.salesTarget,
    packageTarget: calc.packageTarget,
    sales: calc.sales,
    packageCount: calc.packageCount,
    salesProgress: calc.salesProgress,
    packageProgress: calc.packageProgress,
    commissionAmount: calc.commissionAmount,
    bonusAmount: calc.bonusAmount,
    baseCompensation: calc.baseCompensation,
    totalCompensation: calc.totalCompensation,
    saleCount: calc.saleCount,
    averageSale: calc.averageSale,
    expectedHours: calc.expectedHours === undefined ? null : calc.expectedHours,
    loggedHours: calc.loggedHours === undefined ? null : calc.loggedHours,
    hoursProgress: calc.hoursProgress === undefined ? null : calc.hoursProgress,
    isEstimate: calc.isEstimate
  };
}

/* ------------------------------------------------------------------ */
/* Client-callable                                                     */
/* ------------------------------------------------------------------ */

function listSchedules(token, filters) {
  return api_(function () {
    requireAdmin_(token);
    filters = filters || {};
    const rows = rows_(SHEET.SCHEDULES).filter(function (s) {
      return (!filters.month || s.Month === filters.month) &&
        (!filters.staffId || s.StaffID === filters.staffId) &&
        (!filters.status || s.Status === filters.status);
    }).map(scheduleSummaryRow_);
    rows.sort(function (a, b) {
      return a.month !== b.month ? (a.month < b.month ? 1 : -1) : a.staffName.localeCompare(b.staffName);
    });
    const months = rows_(SHEET.SCHEDULES).map(function (s) { return s.Month; })
      .filter(function (m, i, all) { return m && all.indexOf(m) === i; }).sort().reverse();
    return { schedules: rows, months: months };
  });
}

function getSchedule(token, scheduleId) {
  return api_(function () {
    const user = requireUser_(token);
    const s = findById_(SHEET.SCHEDULES, 'ScheduleID', scheduleId);
    if (!s) throw appError_('Schedule not found.', 'NOT_FOUND');
    requireSelfOrAdmin_(user, s.StaffID);
    if (!user.isAdmin && s.Status === SCHEDULE_STATUS.DRAFT) throw appError_('This schedule has not been issued yet.', 'NOT_FOUND');
    return scheduleDetail_(s);
  });
}

/** Starting values for a new schedule form (from the Commission Rules template). */
function getScheduleTemplate(token) {
  return api_(function () {
    requireAdmin_(token);
    return getScheduleTemplate_();
  });
}

/** payload: { schedule, tiers, bonusTiers, allowDuplicate } */
function saveSchedule(token, payload) {
  return api_(function () {
    const admin = requireAdmin_(token);
    payload = payload || {};
    return withLock_(function () {
      const id = saveSchedule_(admin, payload.schedule || {}, payload.tiers, payload.bonusTiers, !!payload.allowDuplicate);
      return ok_({ scheduleId: id }, 'Schedule saved successfully.');
    });
  });
}

function duplicateSchedule(token, scheduleId, targetMonth, allowDuplicate) {
  return api_(function () {
    const admin = requireAdmin_(token);
    return withLock_(function () {
      const id = duplicateSchedule_(admin, scheduleId, targetMonth, !!allowDuplicate);
      return ok_({ scheduleId: id }, 'Schedule duplicated as a Draft. Review the dates, targets and tiers, then activate it.');
    });
  });
}

/** "Duplicate Previous Month": copies every schedule of fromMonth into toMonth. */
function duplicateMonth(token, fromMonth, toMonth) {
  return api_(function () {
    const admin = requireAdmin_(token);
    const from = monthStr_(fromMonth, 'Month to copy from');
    const to = monthStr_(toMonth, 'Month to copy to');
    if (from === to) throw appError_('Choose two different months.');
    return withLock_(function () {
      const created = [];
      const skipped = [];
      const sources = rows_(SHEET.SCHEDULES).filter(function (s) { return s.Month === from; });
      if (!sources.length) throw appError_('There are no schedules in ' + monthLabel_(from) + ' to copy.');
      sources.forEach(function (s) {
        const staff = findById_(SHEET.USERS, 'UserID', s.StaffID);
        const name = staff ? staff.Name : s.StaffID;
        if (!staff || staff.Status !== 'Active') { skipped.push(name + ' (inactive)'); return; }
        if (rows_(SHEET.SCHEDULES).some(function (x) { return x.StaffID === s.StaffID && x.Month === to; })) {
          skipped.push(name + ' (already has ' + monthLabel_(to) + ')');
          return;
        }
        duplicateSchedule_(admin, s.ScheduleID, to, false);
        created.push(name);
      });
      return ok_({ created: created, skipped: skipped },
        created.length + ' schedule(s) created as Drafts for ' + monthLabel_(to) + '.' +
        (skipped.length ? ' Skipped: ' + skipped.join(', ') + '.' : ''));
    });
  });
}

/** action: activate | revertToDraft | close | reopen | approve | markPaid | unlock */
function changeScheduleStatus(token, scheduleId, action, reason) {
  return api_(function () {
    const admin = requireAdmin_(token);
    return withLock_(function () {
      const status = changeScheduleStatus_(admin, scheduleId, action, reason);
      const messages = {
        approve: 'Commission approved and saved as a historical record.',
        markPaid: 'Marked as Paid. This month is now locked.',
        unlock: 'Unlocked for correction. The change was recorded in the Audit Log.'
      };
      return ok_({ status: status }, messages[action] || 'Status updated to ' + status + '.');
    });
  });
}

function deleteSchedule(token, scheduleId) {
  return api_(function () {
    const admin = requireAdmin_(token);
    return withLock_(function () {
      const s = findById_(SHEET.SCHEDULES, 'ScheduleID', scheduleId);
      if (!s) throw appError_('Schedule not found.', 'NOT_FOUND');
      if (isLocked_(s)) throw appError_('Approved or Paid schedules cannot be deleted. Unlock it for correction first.', 'LOCKED');
      deleteWhere_(SHEET.SCHEDULES, function (r) { return r.ScheduleID === scheduleId; });
      deleteWhere_(SHEET.TIERS, function (r) { return r.ScheduleID === scheduleId; });
      deleteWhere_(SHEET.BONUS, function (r) { return r.ScheduleID === scheduleId; });
      logAudit_(admin, 'Deleted schedule (' + scheduleContext_(s) + ')', scheduleId, publicRow_(s), '');
      return ok_(null, 'Schedule deleted.');
    });
  });
}

/** Staff: their own schedules (history). Admin may pass a staffId. */
function getMySchedules(token, staffId) {
  return api_(function () {
    const user = requireUser_(token);
    const id = user.isAdmin && staffId ? staffId : user.userId;
    return rows_(SHEET.SCHEDULES)
      .filter(function (s) { return s.StaffID === id && s.Status !== SCHEDULE_STATUS.DRAFT; })
      .map(scheduleSummaryRow_)
      .sort(function (a, b) { return a.startDate < b.startDate ? 1 : -1; });
  });
}


// ===== Sales.gs =====
/**
 * Sales.gs
 * Sales entry, editing, deletion and attribution.
 *
 * Every sale is attributed to a specific staff member. A shared sale is
 * split by explicit percentages (e.g. 60% / 40%) stored in SharedSales;
 * commission is always computed from each person's credited amount.
 */

const PAYMENT_STATUSES = ['Paid', 'Partially Paid', 'Unpaid', 'Refunded', 'Complimentary'];
const BOOKING_STATUSES = ['Pending', 'Confirmed', 'Completed', 'Cancelled'];
const COMMISSIONABLE_OVERRIDES = ['AUTO', 'YES', 'NO'];

function splitsForSale_(saleId) {
  return rows_(SHEET.SHARED).filter(function (r) { return r.SaleID === saleId; });
}

/** Staff credited on a sale (1 for single sales, 2+ for shared). */
function creditedStaffIds_(sale) {
  if (!sale) return [];
  if (sale.SharedSale) return splitsForSale_(sale.SaleID).map(function (r) { return r.StaffID; });
  return [sale.StaffID];
}

/**
 * Blocks changes to sales that fall inside an Approved/Paid schedule of any
 * credited staff member — finalized months must stay exactly as approved.
 */
function assertSalePeriodUnlocked_(staffIds, saleDate) {
  const locked = rows_(SHEET.SCHEDULES).find(function (s) {
    return staffIds.indexOf(s.StaffID) !== -1 && isLocked_(s) && s.StartDate <= saleDate && saleDate <= s.EndDate;
  });
  if (locked) {
    throw appError_('This sale falls in ' + userName_(locked.StaffID) + '\'s ' + monthLabel_(locked.Month) +
      ' schedule, which is ' + locked.Status + ' and locked. Unlock that schedule for correction first.', 'LOCKED');
  }
}

function normalizeSale_(input, existing) {
  const sale = {};
  sale.SaleDate = dateStr_(input.SaleDate, 'Sale date');
  sale.ClientName = str_(input.ClientName, 'Client name', { required: true, maxLength: 150 });
  sale.ClientContact = str_(input.ClientContact, 'Client contact', { maxLength: 150 });

  sale.PackageID = str_(input.PackageID, 'Package', { required: true });
  const pkg = findById_(SHEET.PACKAGES, 'PackageID', sale.PackageID);
  if (!pkg) throw appError_('Please choose a valid package.');
  if (!pkg.Active && (!existing || existing.PackageID !== sale.PackageID)) {
    throw appError_('The package "' + pkg.PackageName + '" is disabled. Choose an active package.');
  }
  sale.PackageName = existing && existing.PackageID === sale.PackageID ? existing.PackageName : pkg.PackageName;

  sale.GrossPrice = num_(isBlank_(input.GrossPrice) ? pkg.Price : input.GrossPrice, 'Package price', { min: 0 });
  sale.Discount = num_(input.Discount, 'Discount', { min: 0, defaultValue: 0 });
  if (sale.Discount > sale.GrossPrice) throw appError_('Discount cannot be more than the package price.');
  sale.FinalPaidAmount = num_(isBlank_(input.FinalPaidAmount) ? round2_(sale.GrossPrice - sale.Discount) : input.FinalPaidAmount,
    'Final paid amount', { min: 0 });

  sale.PaymentStatus = str_(input.PaymentStatus || 'Paid', 'Payment status', { oneOf: PAYMENT_STATUSES });
  sale.BookingStatus = str_(input.BookingStatus || 'Confirmed', 'Booking status', { oneOf: BOOKING_STATUSES });
  sale.Commissionable = str_(String(input.Commissionable || 'AUTO').toUpperCase(), 'Commissionable', { oneOf: COMMISSIONABLE_OVERRIDES });
  sale.Notes = str_(input.Notes, 'Notes', { maxLength: 1000 });
  return sale;
}

/** Validates attribution and returns [{ StaffID, Percentage }] summing to 100. */
function normalizeSplits_(input, existing) {
  const shared = toBool_(input.SharedSale);
  let splits;
  if (shared) {
    splits = (input.Splits || []).map(function (s, i) {
      return {
        StaffID: str_(s.StaffID, 'Staff for share ' + (i + 1), { required: true }),
        Percentage: num_(s.Percentage, 'Percentage for share ' + (i + 1), { min: 0.01, max: 100 })
      };
    });
    if (splits.length < 2) throw appError_('A shared sale needs at least two staff members.');
    const ids = splits.map(function (s) { return s.StaffID; });
    if (ids.some(function (id, i) { return ids.indexOf(id) !== i; })) throw appError_('Each staff member can appear only once in a shared sale.');
    const total = round2_(sum_(splits, function (s) { return s.Percentage; }));
    if (Math.abs(total - 100) > 0.01) throw appError_('Shared percentages must add up to 100% (currently ' + total + '%).');
  } else {
    splits = [{ StaffID: str_(input.StaffID, 'Staff member', { required: true }), Percentage: 100 }];
  }
  const previouslyCredited = creditedStaffIds_(existing);
  splits.forEach(function (s) {
    const staff = findById_(SHEET.USERS, 'UserID', s.StaffID);
    if (!staff) throw appError_('Please choose a valid staff member.');
    if (staff.Status !== 'Active' && previouslyCredited.indexOf(s.StaffID) === -1) {
      throw appError_(staff.Name + ' is inactive. Sales cannot be assigned to inactive staff.');
    }
  });
  return { shared: shared, splits: splits };
}

function attributionLabel_(sale) {
  if (!sale.SharedSale) return userName_(sale.StaffID);
  return splitsForSale_(sale.SaleID).map(function (r) { return userName_(r.StaffID) + ' ' + r.Percentage + '%'; }).join(' / ');
}

/* ------------------------------------------------------------------ */
/* Client-callable                                                     */
/* ------------------------------------------------------------------ */

/**
 * Admin: all sales (optionally filtered). Staff: only sales credited to them,
 * showing their own share — never other staff members' details.
 * filters: { month, from, to, staffId, scheduleId }
 */
function listSales(token, filters) {
  return api_(function () {
    const user = requireUser_(token);
    filters = filters || {};
    let from = filters.from || '';
    let to = filters.to || '';
    let staffId = filters.staffId || '';
    if (filters.scheduleId) {
      const s = findById_(SHEET.SCHEDULES, 'ScheduleID', filters.scheduleId);
      if (!s) throw appError_('Schedule not found.', 'NOT_FOUND');
      requireSelfOrAdmin_(user, s.StaffID);
      from = s.StartDate;
      to = s.EndDate;
      staffId = s.StaffID;
    } else if (filters.month) {
      const m = monthStr_(filters.month, 'Month');
      from = firstDayOfMonth_(m);
      to = lastDayOfMonth_(m);
    }
    from = from ? dateStr_(from, 'From date') : '0000-01-01';
    to = to ? dateStr_(to, 'To date') : '9999-12-31';
    const rules = getCommissionRules_();

    if (!user.isAdmin) {
      // Staff are always restricted to themselves, whatever filter was sent.
      return {
        isAdmin: false,
        sales: creditSalesForStaff_(rows_(SHEET.SALES), rows_(SHEET.SHARED), user.userId, from, to, rules).reverse()
      };
    }

    const sales = rows_(SHEET.SALES).filter(function (s) {
      if (s.SaleDate < from || s.SaleDate > to) return false;
      return !staffId || creditedStaffIds_(s).indexOf(staffId) !== -1;
    }).map(function (s) {
      const out = publicRow_(s);
      out.splits = s.SharedSale ? splitsForSale_(s.SaleID).map(function (r) { return publicRow_(r); }) : [];
      out.attribution = attributionLabel_(s);
      out.isCommissionable = isSaleCommissionable_(s, rules);
      return out;
    }).sort(function (a, b) {
      return a.SaleDate !== b.SaleDate ? (a.SaleDate < b.SaleDate ? 1 : -1) : (a.CreatedAt < b.CreatedAt ? 1 : -1);
    });
    return {
      isAdmin: true,
      sales: sales,
      totals: {
        count: sales.length,
        final: round2_(sum_(sales, function (s) { return s.FinalPaidAmount; })),
        commissionable: round2_(sum_(sales.filter(function (s) { return s.isCommissionable; }), function (s) { return s.FinalPaidAmount; }))
      }
    };
  });
}

/** Creates or updates a sale. Input uses Sales column names plus SharedSale + Splits. */
function saveSale(token, input) {
  return api_(function () {
    const admin = requireAdmin_(token);
    input = input || {};
    return withLock_(function () {
      const existing = input.SaleID ? findById_(SHEET.SALES, 'SaleID', input.SaleID) : null;
      if (input.SaleID && !existing) throw appError_('Sale not found. It may have been deleted.', 'NOT_FOUND');
      const sale = normalizeSale_(input, existing);
      const attribution = normalizeSplits_(input, existing);
      const newStaff = attribution.splits.map(function (s) { return s.StaffID; });

      // Both the old and the new version of the sale must be outside locked months.
      if (existing) assertSalePeriodUnlocked_(creditedStaffIds_(existing), existing.SaleDate);
      assertSalePeriodUnlocked_(newStaff, sale.SaleDate);

      const now = nowStr_();
      sale.StaffID = attribution.splits[0].StaffID;
      sale.SharedSale = attribution.shared;
      sale.UpdatedAt = now;
      let saleId;
      if (existing) {
        saleId = existing.SaleID;
        const beforeLabel = attributionLabel_(existing);
        updateRow_(SHEET.SALES, 'SaleID', saleId, sale);
        deleteWhere_(SHEET.SHARED, function (r) { return r.SaleID === saleId; });
        auditFieldChanges_(admin, saleId, existing, sale, [
          ['SaleDate', 'sale date'], ['ClientName', 'client name'], ['PackageName', 'package'],
          ['GrossPrice', 'package price', 'money'], ['Discount', 'discount', 'money'],
          ['FinalPaidAmount', 'final paid amount', 'money'], ['PaymentStatus', 'payment status'],
          ['BookingStatus', 'booking status'], ['Commissionable', 'commissionable setting']
        ], 'sale ' + saleId + ', ' + sale.ClientName);
        sale.SaleID = saleId;
        if (attribution.shared) writeSplits_(saleId, attribution.splits, sale.FinalPaidAmount);
        const afterLabel = attributionLabel_(sale);
        if (beforeLabel !== afterLabel) {
          logAudit_(admin, 'Changed sale attribution from ' + beforeLabel + ' to ' + afterLabel + ' (sale ' + saleId + ')', saleId, beforeLabel, afterLabel);
        }
      } else {
        saleId = newId_('SAL');
        sale.SaleID = saleId;
        sale.CreatedAt = now;
        sale.CreatedBy = admin.email;
        insertRows_(SHEET.SALES, [sale]);
        if (attribution.shared) writeSplits_(saleId, attribution.splits, sale.FinalPaidAmount);
        logAudit_(admin, 'Recorded sale ' + money_(sale.FinalPaidAmount) + ' (' + sale.PackageName + ', ' + sale.ClientName +
          ') for ' + attributionLabel_(sale), saleId, '', publicRow_(sale));
      }
      return ok_({ saleId: saleId }, existing ? 'Sale updated.' : 'Sale saved.');
    });
  });
}

function writeSplits_(saleId, splits, finalAmount) {
  insertRows_(SHEET.SHARED, splits.map(function (s) {
    return {
      SharedSaleID: newId_('SHR'),
      SaleID: saleId,
      StaffID: s.StaffID,
      Percentage: s.Percentage,
      CreditedAmount: round2_(finalAmount * s.Percentage / 100)
    };
  }));
}

function deleteSale(token, saleId) {
  return api_(function () {
    const admin = requireAdmin_(token);
    return withLock_(function () {
      const sale = findById_(SHEET.SALES, 'SaleID', saleId);
      if (!sale) throw appError_('Sale not found. It may already have been deleted.', 'NOT_FOUND');
      assertSalePeriodUnlocked_(creditedStaffIds_(sale), sale.SaleDate);
      const label = attributionLabel_(sale);
      deleteWhere_(SHEET.SHARED, function (r) { return r.SaleID === saleId; });
      deleteWhere_(SHEET.SALES, function (r) { return r.SaleID === saleId; });
      logAudit_(admin, 'Deleted sale ' + money_(sale.FinalPaidAmount) + ' (' + sale.ClientName + ', ' + sale.SaleDate + ') credited to ' + label,
        saleId, publicRow_(sale), '');
      return ok_(null, 'Sale deleted.');
    });
  });
}


// ===== Packages.gs =====
/**
 * Packages.gs
 * Configurable studio packages. Packages are disabled, never deleted, so old
 * sales keep a valid reference; each sale also stores the package name and
 * price at the time of sale.
 */

function listPackages(token, includeInactive) {
  return api_(function () {
    requireAdmin_(token);
    return rows_(SHEET.PACKAGES)
      .filter(function (p) { return includeInactive || p.Active; })
      .map(function (p) { return publicRow_(p); })
      .sort(function (a, b) { return (a.Price || 0) - (b.Price || 0) || a.PackageName.localeCompare(b.PackageName); });
  });
}

function savePackage(token, input) {
  return api_(function () {
    const admin = requireAdmin_(token);
    input = input || {};
    return withLock_(function () {
      const existing = input.PackageID ? findById_(SHEET.PACKAGES, 'PackageID', input.PackageID) : null;
      if (input.PackageID && !existing) throw appError_('Package not found.', 'NOT_FOUND');
      const name = str_(input.PackageName, 'Package name', { required: true, maxLength: 100 });
      const clash = rows_(SHEET.PACKAGES).find(function (p) {
        return p.PackageName.toLowerCase() === name.toLowerCase() && (!existing || p.PackageID !== existing.PackageID);
      });
      if (clash) throw appError_('A package named "' + name + '" already exists.');
      const record = {
        PackageName: name,
        Price: num_(input.Price, 'Package price', { min: 0 }),
        Active: input.Active === undefined ? true : toBool_(input.Active),
        Description: str_(input.Description, 'Description', { maxLength: 500 }),
        UpdatedAt: nowStr_()
      };
      let id;
      if (existing) {
        id = existing.PackageID;
        updateRow_(SHEET.PACKAGES, 'PackageID', id, record);
        auditFieldChanges_(admin, id, Object.assign({}, existing, { Active: existing.Active ? 'Active' : 'Disabled' }),
          Object.assign({}, record, { Active: record.Active ? 'Active' : 'Disabled' }),
          [['PackageName', 'package name'], ['Price', 'package price', 'money'], ['Active', 'package status'], ['Description', 'description']],
          name);
      } else {
        id = newId_('PKG');
        insertRows_(SHEET.PACKAGES, [Object.assign({ PackageID: id, CreatedAt: record.UpdatedAt }, record)]);
        logAudit_(admin, 'Added package ' + name + ' at ' + money_(record.Price), id, '', record);
      }
      return ok_({ packageId: id }, existing ? 'Package updated.' : 'Package added.');
    });
  });
}


// ===== Reports.gs =====
/**
 * Reports.gs
 * Admin reports and printable monthly commission statements. All figures come
 * from calculateCommission_ — no calculation logic lives here.
 */

/** filters: { month, staffId, from, to } — from/to match schedules whose period overlaps the range. */
function getReport(token, filters) {
  return api_(function () {
    requireAdmin_(token);
    filters = filters || {};
    const month = filters.month ? monthStr_(filters.month, 'Month') : '';
    const from = filters.from ? dateStr_(filters.from, 'From date') : '';
    const to = filters.to ? dateStr_(filters.to, 'To date') : '';
    if (from && to && to < from) throw appError_('The "to" date must be on or after the "from" date.');

    const rows = rows_(SHEET.SCHEDULES).filter(function (s) {
      if (s.Status === SCHEDULE_STATUS.DRAFT) return false;
      if (month && s.Month !== month) return false;
      if (filters.staffId && s.StaffID !== filters.staffId) return false;
      if (from && s.EndDate < from) return false;
      if (to && s.StartDate > to) return false;
      return true;
    }).map(scheduleSummaryRow_).sort(function (a, b) {
      return a.month !== b.month ? (a.month < b.month ? 1 : -1) : a.staffName.localeCompare(b.staffName);
    });

    const total = function (k) { return round2_(sum_(rows, function (r) { return r[k]; })); };
    const saleCount = sum_(rows, function (r) { return r.saleCount; });
    const salesTotal = total('sales');
    const targetTotal = total('salesTarget');
    return {
      filters: { month: month, staffId: filters.staffId || '', from: from, to: to },
      studioName: getConfigValue_('StudioName', 'ClickLounge Studio'),
      generatedAt: nowStr_(),
      rows: rows,
      totals: {
        sales: salesTotal,
        packageCount: total('packageCount'),
        commissionAmount: total('commissionAmount'),
        bonusAmount: total('bonusAmount'),
        baseCompensation: total('baseCompensation'),
        totalCompensation: total('totalCompensation'),
        saleCount: saleCount,
        averageSale: saleCount ? round2_(salesTotal / saleCount) : 0,
        salesTarget: targetTotal,
        salesProgress: progress_(salesTotal, targetTotal)
      }
    };
  });
}

/** Printable statement for one schedule. Staff may only open their own. */
function getStatement(token, scheduleId) {
  return api_(function () {
    const user = requireUser_(token);
    const s = findById_(SHEET.SCHEDULES, 'ScheduleID', scheduleId);
    if (!s) throw appError_('Schedule not found.', 'NOT_FOUND');
    requireSelfOrAdmin_(user, s.StaffID);
    if (!user.isAdmin && s.Status === SCHEDULE_STATUS.DRAFT) throw appError_('This schedule has not been issued yet.', 'NOT_FOUND');

    const detail = scheduleDetail_(s);
    let sales;
    let rules;
    if (detail.calc.isSnapshot) {
      const snap = parseSnapshot_(getActiveSnapshot_(scheduleId));
      sales = snap.sales || [];
      rules = snap.rules || getCommissionRules_();
    } else {
      rules = getCommissionRules_();
      sales = creditSalesForStaff_(rows_(SHEET.SALES), rows_(SHEET.SHARED), s.StaffID, s.StartDate, s.EndDate, rules);
    }
    return Object.assign(detail, {
      studioName: getConfigValue_('StudioName', 'ClickLounge Studio'),
      periodLabel: dateLabel_(s.StartDate) + ' – ' + dateLabel_(s.EndDate),
      monthLabel: monthLabel_(s.Month),
      commissionBasisLabel: COMMISSION_BASIS[rules.basis] || '',
      sales: sales,
      generatedAt: nowStr_()
    });
  });
}


// ===== Setup.gs =====
/**
 * Setup.gs
 * setupDatabase(): creates/repairs every sheet without touching existing data.
 * setupDemoData(): optional Staff A / Staff B demo with a paid and an active month.
 *
 * All values below are SAMPLE/DEFAULT data only. After setup they live in the
 * sheets and are edited from the app (Commission Rules, Packages, Schedules).
 */

function samplePackages_() {
  return [
    ['₱3,500 Package', 3500], ['₱3,800 Package', 3800], ['₱5,000 Package', 5000],
    ['₱5,800 Package', 5800], ['₱6,800 Package', 6800]
  ];
}

function sampleCommissionTiers_() {
  return [
    { MinSales: 0, MaxSales: 69999, Rate: 0, CommissionType: 'PERCENT' },
    { MinSales: 70000, MaxSales: 99999, Rate: 3, CommissionType: 'PERCENT' },
    { MinSales: 100000, MaxSales: 149999, Rate: 5, CommissionType: 'PERCENT' },
    { MinSales: 150000, MaxSales: 199999, Rate: 6, CommissionType: 'PERCENT' },
    { MinSales: 200000, MaxSales: null, Rate: 7, CommissionType: 'PERCENT' }
  ];
}

function sampleBonusTiers_() {
  return [
    { MinPackages: 20, BonusAmount: 1000, BonusType: 'FIXED' },
    { MinPackages: 25, BonusAmount: 2000, BonusType: 'FIXED' },
    { MinPackages: 30, BonusAmount: 3000, BonusType: 'FIXED' },
    { MinPackages: 35, BonusAmount: 5000, BonusType: 'FIXED' },
    { MinPackages: 40, BonusAmount: 7000, BonusType: 'FIXED' }
  ];
}

/**
 * Owner-only guard for maintenance functions. They are public (the sheet menu
 * needs them) so this stops web-app visitors calling them via google.script.run.
 */
function assertOwnerContext_() {
  const active = getGoogleEmail_();
  let owner = '';
  try {
    owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  } catch (e) {
    owner = '';
  }
  let admin = false;
  try {
    admin = isAdminEmail_(active);
  } catch (e) {
    admin = false;
  }
  if (!active || (active !== owner && !admin)) {
    throw new Error('Only the spreadsheet owner can run this, from the Google Sheet menu or the Apps Script editor.');
  }
}

/** Creates the database. Safe to run again: never overwrites existing data. */
function setupDatabase() {
  assertOwnerContext_();
  resetExecutionCaches_();
  const props = PropertiesService.getScriptProperties();
  let ss = null;
  try {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  } catch (e) {
    ss = null;
  }
  if (!ss) {
    const id = props.getProperty('SPREADSHEET_ID');
    if (!id) throw new Error('Open Apps Script from your Google Sheet (Extensions → Apps Script), or set the SPREADSHEET_ID script property.');
    ss = SpreadsheetApp.openById(id);
  }
  props.setProperty('SPREADSHEET_ID', ss.getId());
  SS_ = ss;

  const log = [];
  withLock_(function () {
    Object.keys(SCHEMA).forEach(function (name) { ensureSheet_(ss, name, log); });
    removeBlankDefaultSheet_(ss, log);
    seedConfig_(log);
    const tz = getConfigValue_('Timezone', 'Asia/Manila');
    if (ss.getSpreadsheetTimeZone() !== tz) {
      ss.setSpreadsheetTimeZone(tz);
      log.push('Spreadsheet timezone set to ' + tz);
    }
    TZ_CACHE_ = null;
    seedFirstAdmin_(log);
    seedPackages_(log);
    seedTemplateTiers_(log);
    logAudit_('System', 'Ran setupDatabase()', 'Setup', '', log.join(' | '));
  });
  const summary = 'Database ready.\n\n' + (log.length ? log.join('\n') : 'Everything was already set up.') +
    '\n\nNext: reload this spreadsheet, then use ClickLounge → "Set my access code" so you can sign in from GitHub Pages.';
  console.log(summary);
  try {
    SpreadsheetApp.getUi().alert(summary);
  } catch (e) {
    // Not running from the spreadsheet UI.
  }
  return log;
}

function ensureSheet_(ss, name, log) {
  const cols = SCHEMA[name];
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols.map(function (c) { return c[0]; })]);
    log.push('Created sheet "' + name + '"');
  } else {
    const lastCol = Math.max(sh.getLastColumn(), 1);
    const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    if (headers.every(function (h) { return !h; })) {
      sh.getRange(1, 1, 1, cols.length).setValues([cols.map(function (c) { return c[0]; })]);
      log.push('Added headers to "' + name + '"');
    } else {
      // Safe migration: append any missing columns, never remove or reorder.
      const missing = cols.filter(function (c) { return headers.indexOf(c[0]) === -1; });
      if (missing.length) {
        sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing.map(function (c) { return c[0]; })]);
        log.push('Added column(s) ' + missing.map(function (c) { return c[0]; }).join(', ') + ' to "' + name + '"');
      }
    }
  }
  formatSheet_(sh, name);
  invalidate_(name);
}

function formatSheet_(sh, name) {
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, lastCol).setFontWeight('bold').setBackground('#111111').setFontColor('#ffffff');
  const rows = Math.max(sh.getMaxRows() - 1, 1);
  const types = columnTypes_(name);
  const formats = {
    money: '[$₱]#,##0.00',
    date: 'yyyy-mm-dd',
    datetime: 'yyyy-mm-dd hh:mm:ss',
    percent: '0.00"%"',
    number: '#,##0.##',
    text: '@',
    month: '@',
    json: '@'
  };
  headers.forEach(function (h, i) {
    const f = formats[types[h]];
    if (f) sh.getRange(2, i + 1, rows, 1).setNumberFormat(f);
  });
}

function removeBlankDefaultSheet_(ss, log) {
  ['Sheet1', 'Sheet 1'].forEach(function (n) {
    const sh = ss.getSheetByName(n);
    if (sh && sh.getLastRow() === 0 && ss.getSheets().length > 1) {
      ss.deleteSheet(sh);
      log.push('Removed empty "' + n + '"');
    }
  });
}

function seedConfig_(log) {
  const existing = {};
  rows_(SHEET.CONFIG).forEach(function (r) { existing[r.Key] = r; });
  const toInsert = configDefaults_().filter(function (d) { return !existing[d[0]]; })
    .map(function (d) { return { Key: d[0], Value: d[1], Description: d[2] }; });
  insertRows_(SHEET.CONFIG, toInsert);
  if (toInsert.length) log.push('Added ' + toInsert.length + ' Config setting(s)');
  if (existing.AppVersion && existing.AppVersion.Value !== APP_VERSION) {
    updateRow_(SHEET.CONFIG, 'Key', 'AppVersion', { Value: APP_VERSION });
    log.push('AppVersion updated to ' + APP_VERSION);
  }
  CONFIG_CACHE_ = null;
}

/** The person running setup becomes the first Admin if no Admin exists yet. */
function seedFirstAdmin_(log) {
  if (!adminEmails_().length) {
    const email = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
    if (email) {
      updateRow_(SHEET.CONFIG, 'Key', 'AdminEmails', { Value: email });
      CONFIG_CACHE_ = null;
      log.push('First Admin: ' + email + ' (edit Config → AdminEmails to change)');
    }
  }
  const before = rows_(SHEET.USERS).length;
  syncAdminUsers_('System');
  const added = rows_(SHEET.USERS).length - before;
  if (added) log.push('Created ' + added + ' Admin user row(s)');
}

function seedPackages_(log) {
  if (rows_(SHEET.PACKAGES).length) return;
  const now = nowStr_();
  insertRows_(SHEET.PACKAGES, samplePackages_().map(function (p) {
    return { PackageID: newId_('PKG'), PackageName: p[0], Price: p[1], Active: true, CreatedAt: now, Description: 'Sample package', UpdatedAt: now };
  }));
  log.push('Added 5 sample packages');
}

function seedTemplateTiers_(log) {
  const hasTiers = getTiers_(TEMPLATE_ID).length > 0;
  const hasBonus = getBonusTiers_(TEMPLATE_ID).length > 0;
  if (hasTiers && hasBonus) return;
  replaceTiers_(TEMPLATE_ID,
    hasTiers ? getTiers_(TEMPLATE_ID) : sampleCommissionTiers_(),
    hasBonus ? getBonusTiers_(TEMPLATE_ID) : sampleBonusTiers_(), null, '');
  log.push('Added sample commission and bonus tiers (default template)');
}

/**
 * Sheet menu: lets the owner set their own access code. Needed when the app is
 * opened from GitHub Pages, where Google sign-in cannot identify anyone.
 */
function setMyAccessCodeFromMenu() {
  assertOwnerContext_();
  resetExecutionCaches_();
  const ui = SpreadsheetApp.getUi();
  const email = getGoogleEmail_();
  const res = ui.prompt('Set your access code',
    'You will sign in to the Sales Dashboard with:\n' + email + '\n\nEnter a new access code (at least 6 characters). ' +
    'Make sure nobody is looking at your screen.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  try {
    setAccessCodeForEmail_(email, res.getResponseText(), actorLabel_({ name: 'Owner', email: email }));
    ui.alert('Access code saved.\n\nSign in to the Sales Dashboard with ' + email + ' and this code.');
  } catch (e) {
    ui.alert(e.message);
  }
}

/** Sets an access code by email (used by the owner menu). */
function setAccessCodeForEmail_(email, code, actor) {
  const clean = validateAccessCode_(code);
  return withLock_(function () {
    let row = findUserByEmail_(email);
    if (!row && isAdminEmail_(email)) {
      syncAdminUsers_('System');
      row = findUserByEmail_(email);
    }
    if (!row) throw appError_(email + ' is not a user yet. Run "Set up / repair database" first.');
    const salt = Utilities.getUuid();
    updateRow_(SHEET.USERS, 'UserID', row.UserID, {
      AccessCodeHash: hashAccessCode_(clean, salt), AccessCodeSalt: salt, UpdatedAt: nowStr_()
    });
    logAudit_(actor, 'Set own access code from the spreadsheet menu', row.UserID, '', '(hidden)');
  });
}

/* ------------------------------------------------------------------ */
/* Demo data                                                           */
/* ------------------------------------------------------------------ */

/**
 * Adds Staff A and Staff B with:
 *  - last month: approved AND paid (Staff A ₱92,000 / 18 pkgs, Staff B ₱118,000 / 23 pkgs)
 *  - this month: active (Staff A ₱72,500 / 15 pkgs, Staff B ₱44,200 / 8 pkgs, plus an
 *    unpaid shared sale and a cancelled sale to show the commissionable rules).
 * Runs once; does nothing if the demo staff already exist.
 */
function setupDemoData() {
  assertOwnerContext_();
  resetExecutionCaches_();
  if (!getSpreadsheet_().getSheetByName(SHEET.CONFIG)) setupDatabase();
  resetExecutionCaches_();
  const actor = 'System (demo setup)';
  const result = withLock_(function () {
    if (findUserByEmail_('staff.a@example.com')) return 'Demo data already exists — nothing changed.';
    const now = nowStr_();
    const staffA = { UserID: newId_('USR'), Name: 'Staff A', Email: 'staff.a@example.com', Role: 'Staff', Position: 'Sales & Marketing Associate', Status: 'Active', BaseCompensationDefault: 8000, CreatedDate: now, AccessCodeHash: '', AccessCodeSalt: '', UpdatedAt: now };
    const staffB = Object.assign({}, staffA, { UserID: newId_('USR'), Name: 'Staff B', Email: 'staff.b@example.com' });
    insertRows_(SHEET.USERS, [staffA, staffB]);

    const tpl = getScheduleTemplate_();
    const thisMonth = currentMonth_();
    const lastMonth = addMonths_(thisMonth, -1);
    const makeSchedule = function (staff, month, status) {
      return saveSchedule_(actor, {
        Month: month, StaffID: staff.UserID, Position: staff.Position, Status: status,
        PackageTarget: 20, SalesTarget: 100000, BaseCompensation: 8000, ExpectedHours: 90,
        AdditionalTarget: 'At least 5 Prestige packages', CommissionStructure: 'TIERED_WHOLE', BonusStructure: 'HIGHEST',
        Notes: 'Demo schedule — edit freely.'
      }, tpl.tiers, tpl.bonusTiers, false);
    };
    const pkgs = rows_(SHEET.PACKAGES).filter(function (p) { return p.Active; });
    const pkgByPrice = function (price) {
      return pkgs.find(function (p) { return Number(p.Price) === price; }) || pkgs[0];
    };
    const today = todayStr_();
    const sales = [];
    let n = 0;
    const addSales = function (staff, month, priceCounts, maxDate) {
      const lastDay = Number(lastDayOfMonth_(month).slice(8));
      const maxDay = maxDate && maxDate.slice(0, 7) === month ? Math.max(1, Number(maxDate.slice(8))) : lastDay;
      let i = 0;
      priceCounts.forEach(function (pc) {
        for (let k = 0; k < pc[1]; k++) {
          const pkg = pkgByPrice(pc[0]);
          n++;
          sales.push({
            SaleID: newId_('SAL'), SaleDate: month + '-' + pad2_(1 + (i++ * 3) % maxDay), ClientName: 'Demo Client ' + n,
            ClientContact: '0917' + String(1000000 + n), StaffID: staff.UserID, PackageID: pkg.PackageID,
            PackageName: pkg.PackageName, GrossPrice: pkg.Price, Discount: 0, FinalPaidAmount: pkg.Price,
            PaymentStatus: 'Paid', BookingStatus: 'Completed', Commissionable: 'AUTO', SharedSale: false,
            Notes: '', CreatedAt: now, UpdatedAt: now, CreatedBy: actor
          });
        }
      });
    };
    // Last month (will be approved + paid).
    const aLast = makeSchedule(staffA, lastMonth, 'Active');
    const bLast = makeSchedule(staffB, lastMonth, 'Active');
    addSales(staffA, lastMonth, [[5000, 8], [5800, 7], [3800, 3]]);                  // ₱92,000 / 18
    addSales(staffB, lastMonth, [[5000, 13], [5800, 6], [6800, 1], [3800, 3]]);      // ₱118,000 / 23
    // This month (active).
    makeSchedule(staffA, thisMonth, 'Active');
    makeSchedule(staffB, thisMonth, 'Active');
    addSales(staffA, thisMonth, [[5000, 5], [3500, 5], [6800, 1], [5800, 4]], today); // ₱72,500 / 15
    addSales(staffB, thisMonth, [[5000, 4], [5800, 3], [6800, 1]], today);            // ₱44,200 / 8
    insertRows_(SHEET.SALES, sales);

    // A cancelled booking (not commissionable by default).
    const cancelPkg = pkgByPrice(5000);
    const cancelled = Object.assign({}, sales[sales.length - 1], {
      SaleID: newId_('SAL'), ClientName: 'Demo Client (cancelled)', PackageID: cancelPkg.PackageID, PackageName: cancelPkg.PackageName,
      GrossPrice: 5000, FinalPaidAmount: 5000, PaymentStatus: 'Refunded', BookingStatus: 'Cancelled'
    });
    // A shared sale, 60% / 40%, still unpaid (counts once paid).
    const shared = Object.assign({}, cancelled, {
      SaleID: newId_('SAL'), ClientName: 'Demo Client (shared)', PaymentStatus: 'Unpaid', BookingStatus: 'Confirmed',
      SharedSale: true, StaffID: staffA.UserID, Notes: 'Shared 60/40 — mark as Paid to see it counted.'
    });
    insertRows_(SHEET.SALES, [cancelled, shared]);
    writeSplits_(shared.SaleID, [{ StaffID: staffA.UserID, Percentage: 60 }, { StaffID: staffB.UserID, Percentage: 40 }], 5000);

    changeScheduleStatus_(actor, aLast, 'approve', 'Demo approval');
    changeScheduleStatus_(actor, bLast, 'approve', 'Demo approval');
    changeScheduleStatus_(actor, aLast, 'markPaid', 'Demo payment');
    changeScheduleStatus_(actor, bLast, 'markPaid', 'Demo payment');
    logAudit_(actor, 'Loaded demo data (Staff A, Staff B, ' + monthLabel_(lastMonth) + ' paid, ' + monthLabel_(thisMonth) + ' active)', 'Demo', '', '');
    return 'Demo data loaded: Staff A and Staff B, ' + monthLabel_(lastMonth) + ' (Paid) and ' + monthLabel_(thisMonth) + ' (Active).\n\n' +
      'Demo staff use example.com emails. To test staff login, edit a demo staff email to a real account and set an access code on the Staff page.';
  });
  console.log(result);
  try {
    SpreadsheetApp.getUi().alert(result);
  } catch (e) {
    // Not running from the spreadsheet UI.
  }
  return result;
}


// ===== Tests.gs =====
/**
 * Tests.gs
 * Commission calculation tests (specification §38). They use the pure
 * functions in Commission.gs and never touch the spreadsheet, so they are
 * safe to run on the live database.
 *
 * Run from the Apps Script editor: select runCommissionTests → Run, then
 * open the Execution log. Or use the sheet menu ClickLounge → Run commission tests.
 */

function runCommissionTests() {
  const results = [];
  const check = function (name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name: name, pass: pass, actual: actual, expected: expected });
  };
  const tiers = sampleCommissionTiers_();
  const bonus = sampleBonusTiers_();
  const commission = function (sales) {
    const r = computeTierCommission_(tiers, sales, 'TIERED_WHOLE');
    return { rate: r.rate, amount: r.amount };
  };

  // Tests 1–5: commission tier selection (rate applies to all sales).
  check('Test 1: ₱50,000 → 0%', commission(50000), { rate: 0, amount: 0 });
  check('Test 2: ₱80,000 → 3%', commission(80000), { rate: 3, amount: 2400 });
  check('Test 3: ₱120,000 → 5%', commission(120000), { rate: 5, amount: 6000 });
  check('Test 4: ₱175,000 → 6%', commission(175000), { rate: 6, amount: 10500 });
  check('Test 5: ₱220,000 → 7%', commission(220000), { rate: 7, amount: 15400 });

  // Tier boundaries (maximums are inclusive to the peso).
  check('Boundary: ₱69,999.99 → 0%', commission(69999.99).rate, 0);
  check('Boundary: ₱70,000 → 3%', commission(70000).rate, 3);
  check('Boundary: ₱99,999.50 → 3%', commission(99999.5).rate, 3);
  check('Boundary: ₱100,000 → 5%', commission(100000).rate, 5);
  check('Boundary: ₱200,000 → 7%', commission(200000).rate, 7);

  // Tests 6–8: highest applicable bonus only.
  check('Test 6: 22 packages → ₱1,000', computeBonus_(bonus, 22, 'HIGHEST').amount, 1000);
  check('Test 7: 30 packages → ₱3,000 (not 1,000+2,000+3,000)', computeBonus_(bonus, 30, 'HIGHEST').amount, 3000);
  check('Test 8: 40 packages → ₱7,000', computeBonus_(bonus, 40, 'HIGHEST').amount, 7000);
  check('Bonus: 19 packages → ₱0', computeBonus_(bonus, 19, 'HIGHEST').amount, 0);
  check('Bonus: 45 packages → ₱7,000', computeBonus_(bonus, 45, 'HIGHEST').amount, 7000);
  check('Bonus (cumulative option): 30 packages → ₱6,000', computeBonus_(bonus, 30, 'CUMULATIVE').amount, 6000);

  // Test 9: shared sale credited by percentage.
  const rules = { basis: 'PAID_ONLY', sharedPackageCredit: 'FRACTIONAL', cancelled: false, refunded: false, unpaid: false, complimentary: false, discounted: true };
  const sale = { SaleID: 'S1', SaleDate: '2026-09-10', StaffID: 'A', SharedSale: true, FinalPaidAmount: 5000, PaymentStatus: 'Paid', BookingStatus: 'Completed', Discount: 0 };
  const splits = [{ SaleID: 'S1', StaffID: 'A', Percentage: 60 }, { SaleID: 'S1', StaffID: 'B', Percentage: 40 }];
  const creditA = creditSalesForStaff_([sale], splits, 'A', '2026-09-01', '2026-09-30', rules);
  const creditB = creditSalesForStaff_([sale], splits, 'B', '2026-09-01', '2026-09-30', rules);
  check('Test 9: shared ₱5,000 → Staff A ₱3,000', creditA[0].creditedAmount, 3000);
  check('Test 9: shared ₱5,000 → Staff B ₱2,000', creditB[0].creditedAmount, 2000);

  // Attribution: sales are never split evenly by default.
  const single = [
    { SaleID: 'X1', SaleDate: '2026-09-05', StaffID: 'A', SharedSale: false, FinalPaidAmount: 55000, PaymentStatus: 'Paid', BookingStatus: 'Completed', Discount: 0 },
    { SaleID: 'X2', SaleDate: '2026-09-06', StaffID: 'B', SharedSale: false, FinalPaidAmount: 45000, PaymentStatus: 'Paid', BookingStatus: 'Completed', Discount: 0 }
  ];
  check('Attribution: Staff A credited ₱55,000 only', sum_(creditSalesForStaff_(single, [], 'A', '2026-09-01', '2026-09-30', rules), function (c) { return c.creditedAmount; }), 55000);

  // Commissionable rules.
  check('Rules: unpaid sale excluded by default', isSaleCommissionable_({ PaymentStatus: 'Unpaid', BookingStatus: 'Confirmed', Discount: 0 }, rules), false);
  check('Rules: cancelled excluded by default', isSaleCommissionable_({ PaymentStatus: 'Paid', BookingStatus: 'Cancelled', Discount: 0 }, rules), false);
  check('Rules: per-sale override YES wins', isSaleCommissionable_({ PaymentStatus: 'Unpaid', BookingStatus: 'Pending', Discount: 0, Commissionable: 'YES' }, rules), true);

  // §10 worked example: ₱120,000, 22 packages, base ₱8,000 → ₱15,000.
  const schedule = { ScheduleID: 'SEP', StaffID: 'A', Month: '2026-09', SalesTarget: 100000, PackageTarget: 20, BaseCompensation: 8000, ExpectedHours: 90, CommissionStructure: 'TIERED_WHOLE', BonusStructure: 'HIGHEST', Status: 'Active' };
  const credited = [];
  for (let i = 0; i < 22; i++) credited.push({ creditedAmount: 120000 / 22, packageCredit: 1, commissionable: true });
  const full = computeCommission_(schedule, tiers, bonus, credited);
  check('Worked example: total ₱15,000', { sales: full.sales, commission: full.commissionAmount, bonus: full.bonusAmount, base: full.baseCompensation, total: full.totalCompensation },
    { sales: 120000, commission: 6000, bonus: 1000, base: 8000, total: 15000 });
  check('Progress: 120% and ₱20,000 above target, ₱0 remaining', { p: full.salesProgress, above: full.amountAboveTarget, remaining: full.remainingSales }, { p: 120, above: 20000, remaining: 0 });
  check('Effective hourly rate: ₱8,000 / 90h', full.effectiveHourlyRate, 88.89);

  // Test 10 (logic level): a stored snapshot is returned as-is, whatever the current rules.
  const septSnapshotRow = { CalculationID: 'C1', Status: 'Paid', SnapshotJSON: JSON.stringify({ result: full }) };
  const octoberTiers = tiers.map(function (t) { return Object.assign({}, t, { Rate: t.Rate === 5 ? 7 : t.Rate }); });
  const octoberLive = computeCommission_(Object.assign({}, schedule, { ScheduleID: 'OCT' }), octoberTiers, bonus, credited);
  check('Test 10: October at 7% recalculates to ₱8,400', octoberLive.commissionAmount, 8400);
  check('Test 10: paid September snapshot still ₱6,000', snapshotToResult_(septSnapshotRow).commissionAmount, 6000);

  // Time clock: worked hours and hourly base.
  check('Time: 09:00–17:30 with 60 min break = 7.5 h', computeEntryHours_('2026-09-10 09:00:00', '2026-09-10 17:30:00', 60), 7.5);
  check('Time: overnight 22:00–02:00 = 4 h', computeEntryHours_('2026-09-10 22:00:00', '2026-09-11 02:00:00', 0), 4);
  check('Time: not clocked out = 0 h', computeEntryHours_('2026-09-10 09:00:00', '', 0), 0);
  check('Time: all worked hours count toward required hours', sumLoggedHours_([
    { StaffID: 'A', Date: '2026-09-02', ClockOut: 'x', Hours: 8 },
    { StaffID: 'A', Date: '2026-09-03', ClockOut: 'x', Hours: 10.5 },
    { StaffID: 'A', Date: '2026-09-04', ClockOut: '', Hours: null },
    { StaffID: 'B', Date: '2026-09-03', ClockOut: 'x', Hours: 7 },
    { StaffID: 'A', Date: '2026-10-01', ClockOut: 'x', Hours: 6 }
  ], 'A', '2026-09-01', '2026-09-30'), { hours: 18.5, entries: 2 });
  check('Hourly base uses time-clock hours when Actual hours is blank',
    computeBase_({ BaseType: 'HOURLY', HourlyRate: 100, ExpectedHours: 90 }, 50).amount, 5000);
  check('Hourly base prefers Actual hours typed on the schedule',
    computeBase_({ BaseType: 'HOURLY', HourlyRate: 100, ExpectedHours: 90, ActualHours: 60 }, 50).amount, 6000);
  check('Fixed base is not affected by hours', computeBase_({ BaseType: 'FIXED', BaseCompensation: 8000, ExpectedHours: 90 }, 12).amount, 8000);

  const failed = results.filter(function (r) { return !r.pass; });
  results.forEach(function (r) {
    console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.pass ? '' : '  → expected ' + JSON.stringify(r.expected) + ', got ' + JSON.stringify(r.actual)));
  });
  console.log(results.length - failed.length + ' / ' + results.length + ' commission tests passed.');
  return { passed: results.length - failed.length, failed: failed.length, results: results };
}

function runCommissionTestsFromMenu() {
  assertOwnerContext_();
  const r = runCommissionTests();
  const lines = r.results.map(function (x) { return (x.pass ? '✓ ' : '✗ ') + x.name; });
  try {
    SpreadsheetApp.getUi().alert(r.passed + ' / ' + (r.passed + r.failed) + ' tests passed\n\n' + lines.join('\n'));
  } catch (e) {
    // Not running from the spreadsheet UI.
  }
  return r;
}
