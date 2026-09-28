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
