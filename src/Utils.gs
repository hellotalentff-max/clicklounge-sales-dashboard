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
