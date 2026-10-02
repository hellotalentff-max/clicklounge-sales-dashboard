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
  TIME: 'TimeLogs',
  ACTIVITY: 'ActivityLogs'
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
    ['Notes', 'text'], ['CreatedAt', 'datetime'], ['UpdatedAt', 'datetime'], ['EditedBy', 'text'],
    ['LastConfirmedAt', 'datetime'], ['ConfirmedChecks', 'number'], ['MissedChecks', 'number'], ['MissedDetail', 'text']
  ],
  ActivityLogs: [
    ['ActivityID', 'text'], ['TimeLogID', 'text'], ['StaffID', 'text'], ['Date', 'date'], ['LoggedAt', 'datetime'],
    ['Activity', 'text'], ['Note', 'text'], ['Source', 'text']
  ]
};

/** Bump when SCHEMA or Config defaults change: existing databases upgrade themselves on next sign-in. */
const SCHEMA_VERSION = '4';

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
  const props = PropertiesService.getScriptProperties();
  let missing = Object.keys(SCHEMA).filter(function (n) { return !ss.getSheetByName(n); });
  if ((missing.length || props.getProperty('SCHEMA_VERSION') !== SCHEMA_VERSION) && ss.getSheetByName(SHEET.CONFIG)) {
    // New sheets, new columns and new settings from a later version are added
    // automatically (existing data is never touched), so upgrading only needs
    // new code — no need to re-run setupDatabase().
    withLock_(function () {
      Object.keys(SCHEMA).forEach(function (n) { ensureSheet_(ss, n, []); });
      seedConfig_([]);
      props.setProperty('SCHEMA_VERSION', SCHEMA_VERSION);
    });
    missing = Object.keys(SCHEMA).filter(function (n) { return !ss.getSheetByName(n); });
  }
  if (missing.length) {
    throw appError_('The database is not set up yet (missing: ' + missing.join(', ') +
      '). The owner must open the Google Sheet → Extensions → Apps Script and run setupDatabase().', 'SETUP');
  }
}
