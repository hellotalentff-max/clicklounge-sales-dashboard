/*
 * End-to-end tests: exercise the real server functions (src/*.gs) against the
 * in-memory Apps Script mock, through the same public API the browser uses.
 * Loaded into the same evaluation as the server files (see tests.html).
 */
function runE2E() {
  const R = [];
  const t = (name, fn) => {
    try {
      const detail = fn();
      R.push({ name, pass: true, detail: detail === undefined ? '' : String(detail) });
    } catch (e) {
      R.push({ name, pass: false, detail: e && e.message ? e.message : String(e) });
    }
  };
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error((label ? label + ': ' : '') + 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    }
  };
  const ok = (res) => {
    if (!res || !res.success) throw new Error('API error: ' + (res && res.error));
    return res.data;
  };
  const err = (res, code) => {
    if (res.success) throw new Error('Expected an error but the call succeeded');
    if (code && res.code !== code) throw new Error('Expected code ' + code + ', got ' + res.code + ': ' + res.error);
    return res.error;
  };
  const pick = (o, keys) => keys.reduce((a, k) => (a[k] = o[k], a), {});
  const M = window.__mock;

  M.reset();
  M.setActiveEmail(M.OWNER_EMAIL);

  // ---------- Phase 1: database + auth ----------
  t('setupDatabase() creates every sheet with headers', () => {
    setupDatabase();
    Object.keys(SCHEMA).forEach((n) => {
      const sh = M.ss.getSheetByName(n);
      if (!sh) throw new Error('missing ' + n);
      eq(sh.getRange(1, 1, 1, SCHEMA[n].length).getValues()[0], SCHEMA[n].map((c) => c[0]), n + ' headers');
    });
    eq(!!M.ss.getSheetByName('Sheet1'), false, 'blank Sheet1 removed');
  });
  t('setupDatabase() seeds 5 packages, 5 tiers, 5 bonus tiers, owner as Admin', () => {
    resetExecutionCaches_();
    eq(rows_(SHEET.PACKAGES).length, 5, 'packages');
    eq(getTiers_(TEMPLATE_ID).map((x) => x.Rate), [0, 3, 5, 6, 7], 'tiers');
    eq(getBonusTiers_(TEMPLATE_ID).map((x) => x.BonusAmount), [1000, 2000, 3000, 5000, 7000], 'bonus');
    eq(adminEmails_(), [M.OWNER_EMAIL], 'AdminEmails');
    eq(rows_(SHEET.USERS).length, 1, 'users');
  });
  t('setupDatabase() is safe to re-run (no duplicates, data kept)', () => {
    // Every sheet except AuditLog (which records "Ran setupDatabase()") keeps its row count.
    const count = () => Object.keys(SCHEMA).filter((n) => n !== 'AuditLog').map((n) => n + ':' + M.ss.getSheetByName(n).getLastRow());
    const before = count();
    setupDatabase();
    eq(count(), before);
  });

  let admin;
  t('Owner opens the app → Admin session (Google identity)', () => {
    const d = ok(bootstrap(null));
    eq(d.user.isAdmin, true);
    admin = d.token;
    return 'token issued';
  });

  t('setupDemoData() loads Staff A / Staff B', () => { setupDemoData(); });
  resetExecutionCaches_();
  const A = findUserByEmail_('staff.a@example.com');
  const B = findUserByEmail_('staff.b@example.com');
  const month = currentMonth_();
  const last = addMonths_(month, -1);
  const sched = (staff, m) => rows_(SHEET.SCHEDULES).find((s) => s.StaffID === staff.UserID && s.Month === m);
  const aLast = sched(A, last).ScheduleID, bLast = sched(B, last).ScheduleID;
  const aNow = sched(A, month).ScheduleID, bNow = sched(B, month).ScheduleID;

  // ---------- Demo numbers match the specification tables ----------
  const KEYS = ['sales', 'packageCount', 'commissionAmount', 'bonusAmount', 'totalCompensation', 'status'];
  t('Last month Staff A: ₱92,000, 18 pkgs, ₱2,760, ₱0, ₱10,760, Paid', () => {
    eq(pick(ok(getCommission(admin, aLast)), KEYS), { sales: 92000, packageCount: 18, commissionAmount: 2760, bonusAmount: 0, totalCompensation: 10760, status: 'Paid' });
  });
  t('Last month Staff B: ₱118,000, 23 pkgs, ₱5,900, ₱1,000, ₱14,900, Paid', () => {
    eq(pick(ok(getCommission(admin, bLast)), KEYS), { sales: 118000, packageCount: 23, commissionAmount: 5900, bonusAmount: 1000, totalCompensation: 14900, status: 'Paid' });
  });
  t('This month Staff A (§15): ₱72,500, 72.5%, 15 pkgs, 5 remaining, ₱27,500 remaining, ₱2,175, est. ₱10,175', () => {
    const c = ok(getCommission(admin, aNow));
    eq(pick(c, ['sales', 'salesProgress', 'packageCount', 'packagesRemaining', 'remainingSales', 'commissionAmount', 'bonusAmount', 'baseCompensation', 'totalCompensation', 'isEstimate']),
      { sales: 72500, salesProgress: 72.5, packageCount: 15, packagesRemaining: 5, remainingSales: 27500, commissionAmount: 2175, bonusAmount: 0, baseCompensation: 8000, totalCompensation: 10175, isEstimate: true });
    return 'unpaid shared sale & cancelled sale correctly excluded (non-commissionable ₱' + c.nonCommissionableSales + ')';
  });
  t('Admin dashboard: sales attributed per staff, never split evenly', () => {
    const d = ok(getAdminDashboard(admin, last));
    eq(d.rows.map((r) => [r.staffName, r.sales]).sort(), [['Staff A', 92000], ['Staff B', 118000]]);
    eq(d.totals.sales, 210000);
  });

  // ---------- Staff login (consumer Gmail: no Google identity) ----------
  M.setActiveEmail('');
  let staffA, staffB;
  t('No Google identity → login screen', () => eq(ok(bootstrap(null)).needsLogin, true));
  t('Admin sets access codes (hashed, never stored in plain text)', () => {
    ok(setUserAccessCode(admin, A.UserID, 'alpha-2026'));
    ok(setUserAccessCode(admin, B.UserID, 'bravo-2026'));
    resetExecutionCaches_();
    const row = findById_(SHEET.USERS, 'UserID', A.UserID);
    if (row.AccessCodeHash.indexOf('alpha') !== -1 || row.AccessCodeHash.length !== 64) throw new Error('bad hash');
  });
  t('Wrong access code is rejected', () => err(login('staff.a@example.com', 'wrong-code'), 'AUTH_FAILED'));
  t('Correct access code → Staff session (not Admin)', () => {
    const d = ok(login('Staff.A@example.com', 'alpha-2026'));
    eq(d.user.isAdmin, false);
    staffA = d.token;
    staffB = ok(login('staff.b@example.com', 'bravo-2026')).token;
  });
  t('Session token survives a page reload (bootstrap with token)', () => eq(ok(bootstrap(staffA)).user.name, 'Staff A'));
  t('Garbage token → AUTH error', () => err(listSales('not-a-real-token', {}), 'AUTH'));

  // ---------- §23 Security: server-side authorization ----------
  t('Staff cannot call getAllStaff / listUsers', () => { err(getAllStaff(staffA), 'FORBIDDEN'); err(listUsers(staffA), 'FORBIDDEN'); });
  t('Staff cannot open another staff member\'s schedule', () => err(getSchedule(staffA, bNow), 'FORBIDDEN'));
  t('Staff cannot calculate another staff member\'s commission', () => err(getCommission(staffA, bNow), 'FORBIDDEN'));
  t('Staff cannot open another staff member\'s statement', () => err(getStatement(staffA, bLast), 'FORBIDDEN'));
  t('Staff cannot list another staff member\'s sales (filter ignored)', () => {
    const d = ok(listSales(staffA, { staffId: B.UserID, month: month }));
    eq(d.isAdmin, false);
    const ids = d.sales.map((s) => s.saleId);
    const own = creditSalesForStaff_(rows_(SHEET.SALES), rows_(SHEET.SHARED), A.UserID, firstDayOfMonth_(month), lastDayOfMonth_(month), getCommissionRules_()).map((s) => s.saleId);
    eq(ids.sort(), own.sort());
    if (JSON.stringify(d).indexOf('Staff B') !== -1) throw new Error('leaked Staff B name');
  });
  t('Staff cannot record, edit or delete sales', () => { err(saveSale(staffA, {}), 'FORBIDDEN'); err(deleteSale(staffA, 'x'), 'FORBIDDEN'); });
  t('Staff cannot change targets, tiers, statuses, rules, settings or read the audit log', () => {
    err(saveSchedule(staffA, { schedule: { ScheduleID: aNow } }), 'FORBIDDEN');
    err(changeScheduleStatus(staffA, aNow, 'approve'), 'FORBIDDEN');
    err(saveCommissionRules(staffA, {}), 'FORBIDDEN');
    err(saveSettings(staffA, {}), 'FORBIDDEN');
    err(getAuditLog(staffA, {}), 'FORBIDDEN');
    err(getReport(staffA, {}), 'FORBIDDEN');
  });
  t('Owner-only maintenance functions refuse web-app visitors', () => {
    let threw = false;
    try { setupDemoData(); } catch (e) { threw = true; }
    eq(threw, true);
  });
  t('Staff sees own dashboard only', () => {
    const d = ok(getMyDashboard(staffA));
    eq(d.detail.staffName, 'Staff A');
    eq(d.schedules.length, 2);
  });

  // ---------- Test 9: shared sale ----------
  const pkg5000 = rows_(SHEET.PACKAGES).find((p) => p.Price === 5000);
  t('Test 9: shared ₱5,000 sale, 60% / 40% → Staff A ₱3,000, Staff B ₱2,000', () => {
    const beforeB = ok(getCommission(admin, bNow)).sales;
    const id = ok(saveSale(admin, {
      SaleDate: month + '-02', ClientName: 'Shared Client', PackageID: pkg5000.PackageID, PaymentStatus: 'Paid', BookingStatus: 'Completed',
      SharedSale: true, Splits: [{ StaffID: A.UserID, Percentage: 60 }, { StaffID: B.UserID, Percentage: 40 }]
    })).saleId;
    const a = ok(listSales(staffA, { month })).sales.find((s) => s.saleId === id);
    const b = ok(listSales(staffB, { month })).sales.find((s) => s.saleId === id);
    eq([a.creditedAmount, a.sharePercentage, b.creditedAmount, b.sharePercentage], [3000, 60, 2000, 40]);
    eq(ok(getCommission(admin, bNow)).sales - beforeB, 2000, 'Staff B commission base');
    return 'packages credited 0.6 / 0.4 (FRACTIONAL setting)';
  });

  // ---------- §28 Validation ----------
  const baseSchedule = { Month: addMonths_(month, 6), StaffID: A.UserID, PackageTarget: 20, SalesTarget: 100000, BaseCompensation: 8000, ExpectedHours: 90 };
  const tiers = sampleCommissionTiers_();
  t('Rejects overlapping commission tiers', () => {
    const bad = tiers.map((x) => Object.assign({}, x));
    bad[1].MaxSales = 120000;
    return err(saveSchedule(admin, { schedule: baseSchedule, tiers: bad, bonusTiers: [] }));
  });
  t('Rejects invalid commission rate (> 100%)', () => {
    const bad = tiers.map((x) => Object.assign({}, x));
    bad[4].Rate = 150;
    return err(saveSchedule(admin, { schedule: baseSchedule, tiers: bad, bonusTiers: [] }));
  });
  t('Rejects bonus tiers with invalid package counts', () => {
    err(saveSchedule(admin, { schedule: baseSchedule, tiers, bonusTiers: [{ MinPackages: 0, BonusAmount: 100 }] }));
    err(saveSchedule(admin, { schedule: baseSchedule, tiers, bonusTiers: [{ MinPackages: 2.5, BonusAmount: 100 }] }));
    return err(saveSchedule(admin, { schedule: baseSchedule, tiers, bonusTiers: [{ MinPackages: 20, BonusAmount: 1 }, { MinPackages: 20, BonusAmount: 2 }] }));
  });
  t('Rejects negative targets', () => err(saveSchedule(admin, { schedule: Object.assign({}, baseSchedule, { SalesTarget: -5 }), tiers, bonusTiers: [] })));
  t('Rejects duplicate schedule for same staff/month', () => err(duplicateSchedule(admin, aNow, month), 'DUPLICATE'));
  t('Rejects negative package price', () => err(savePackage(admin, { PackageName: 'Bad', Price: -100 })));
  t('Rejects sale with invalid package ID', () => err(saveSale(admin, { SaleDate: month + '-03', ClientName: 'X', PackageID: 'PKG-NOPE', StaffID: A.UserID })));
  t('Rejects negative sale amount / discount above price', () => {
    err(saveSale(admin, { SaleDate: month + '-03', ClientName: 'X', PackageID: pkg5000.PackageID, StaffID: A.UserID, FinalPaidAmount: -1 }));
    return err(saveSale(admin, { SaleDate: month + '-03', ClientName: 'X', PackageID: pkg5000.PackageID, StaffID: A.UserID, Discount: 6000 }));
  });
  t('Rejects shared percentages that do not add up to 100', () => err(saveSale(admin, {
    SaleDate: month + '-03', ClientName: 'X', PackageID: pkg5000.PackageID, SharedSale: true,
    Splits: [{ StaffID: A.UserID, Percentage: 60 }, { StaffID: B.UserID, Percentage: 30 }]
  })));
  t('Rejects sales assigned to inactive staff', () => {
    const c = ok(saveUser(admin, { Name: 'Staff C', Email: 'staff.c@example.com', Role: 'Staff', Status: 'Inactive' })).userId;
    return err(saveSale(admin, { SaleDate: month + '-03', ClientName: 'X', PackageID: pkg5000.PackageID, StaffID: c }));
  });

  // ---------- §16/§18 Workflow & lock ----------
  t('Paid schedule cannot be edited normally', () => {
    const d = ok(getSchedule(admin, bLast));
    return err(saveSchedule(admin, { schedule: Object.assign({}, d.schedule, { SalesTarget: 1 }), tiers: d.tiers, bonusTiers: d.bonusTiers }), 'LOCKED');
  });
  t('Sales inside a Paid month cannot be added, edited or deleted', () => {
    err(saveSale(admin, { SaleDate: last + '-10', ClientName: 'Late', PackageID: pkg5000.PackageID, StaffID: B.UserID }), 'LOCKED');
    const paidSale = rows_(SHEET.SALES).find((s) => s.StaffID === B.UserID && s.SaleDate.slice(0, 7) === last);
    return err(deleteSale(admin, paidSale.SaleID), 'LOCKED');
  });
  t('Cannot mark Paid before Approval', () => err(changeScheduleStatus(admin, aNow, 'markPaid'), 'INVALID_STATUS'));

  // ---------- Test 10: historical months never change ----------
  t('Test 10: next month duplicated & changed to 7% → paid month unchanged', () => {
    const before = ok(getCommission(admin, bLast));
    const nextMonth = addMonths_(month, 1);
    const newId = ok(duplicateSchedule(admin, bNow, nextMonth)).scheduleId;
    const d = ok(getSchedule(admin, newId));
    eq(d.schedule.Status, 'Draft');
    const newTiers = d.tiers.map((x) => Object.assign({}, x, { Rate: x.Rate === 5 ? 7 : x.Rate }));
    ok(saveSchedule(admin, { schedule: d.schedule, tiers: newTiers, bonusTiers: d.bonusTiers }));
    ok(saveCommissionRules(admin, {
      rules: { basis: 'ALL', sharedPackageCredit: 'FULL', cancelled: true, refunded: true, unpaid: true, complimentary: true, discounted: true },
      template: { tiers: newTiers, bonusTiers: d.bonusTiers, salesTarget: 1, packageTarget: 1, baseCompensation: 1, expectedHours: 1 }
    }));
    const after = ok(getCommission(admin, bLast));
    eq(pick(after, KEYS), pick(before, KEYS));
    eq(getTiers_(bLast).map((x) => x.Rate), [0, 3, 5, 6, 7], 'paid month tier rows untouched');
    const dup = ok(getSchedule(admin, newId));
    eq(dup.tiers.map((x) => x.Rate), [0, 3, 7, 6, 7], 'new month has its own tiers');
    // restore default rules for the rest of the suite
    ok(saveCommissionRules(admin, {
      rules: { basis: 'PAID_ONLY', sharedPackageCredit: 'FRACTIONAL', cancelled: false, refunded: false, unpaid: false, complimentary: false, discounted: true },
      template: { tiers, bonusTiers: sampleBonusTiers_(), salesTarget: 100000, packageTarget: 20, baseCompensation: 8000, expectedHours: 90 }
    }));
    return 'paid month still ' + money_(after.commissionAmount) + ' commission, ' + money_(after.totalCompensation) + ' total';
  });
  t('Unlock for Correction requires a reason', () => err(changeScheduleStatus(admin, bLast, 'unlock', '')));
  t('Unlock records who, when and why; edits allowed again; re-approval keeps history', () => {
    ok(changeScheduleStatus(admin, bLast, 'unlock', 'Client refund processed late'));
    const log = ok(getAuditLog(admin, { search: 'Unlocked for correction' })).entries[0];
    eq([log.Reason, log.PreviousValue, log.NewValue, !!log.User, !!log.Timestamp], ['Client refund processed late', 'Paid', 'Pending Approval', true, true]);
    const d = ok(getSchedule(admin, bLast));
    eq(d.schedule.Status, 'Pending Approval');
    ok(saveSchedule(admin, { schedule: Object.assign({}, d.schedule, { Notes: 'Corrected' }), tiers: d.tiers, bonusTiers: d.bonusTiers }));
    ok(changeScheduleStatus(admin, bLast, 'approve'));
    ok(changeScheduleStatus(admin, bLast, 'markPaid'));
    const calcs = rows_(SHEET.CALCS).filter((c) => c.ScheduleID === bLast).map((c) => c.Status);
    eq(calcs, ['Superseded', 'Paid']);
  });
  t('Full workflow Draft → Active → Pending Approval → Approved → Paid', () => {
    const id = ok(saveSchedule(admin, { schedule: baseSchedule, tiers, bonusTiers: sampleBonusTiers_() })).scheduleId;
    ['activate', 'close', 'approve', 'markPaid'].forEach((a) => ok(changeScheduleStatus(admin, id, a)));
    eq(ok(getSchedule(admin, id)).schedule.Status, 'Paid');
    ok(changeScheduleStatus(admin, id, 'unlock', 'cleanup for tests'));
    ok(deleteSchedule(admin, id));
  });
  t('Ended Active schedules auto-move to Pending Approval', () => {
    const old = addMonths_(month, -4);
    const id = ok(saveSchedule(admin, { schedule: Object.assign({}, baseSchedule, { Month: old, Status: 'Active' }), tiers, bonusTiers: [] })).scheduleId;
    ok(getAdminDashboard(admin, month));
    eq(ok(getSchedule(admin, id)).schedule.Status, 'Pending Approval');
  });

  // ---------- Audit, duplicate month, reports ----------
  t('Audit log: "Changed sales target from ₱100,000 to ₱120,000"', () => {
    const d = ok(getSchedule(admin, aNow));
    ok(saveSchedule(admin, { schedule: Object.assign({}, d.schedule, { SalesTarget: 120000 }), tiers: d.tiers, bonusTiers: d.bonusTiers }));
    const e = ok(getAuditLog(admin, { search: 'sales target' })).entries[0];
    if (e.Action.indexOf('Changed sales target from ₱100,000 to ₱120,000') !== 0) throw new Error(e.Action);
    ok(saveSchedule(admin, { schedule: Object.assign({}, d.schedule, { SalesTarget: 100000 }), tiers: d.tiers, bonusTiers: d.bonusTiers }));
    return e.Action;
  });
  t('Audit log: tier change "5% → 6%" recorded', () => {
    const d = ok(getSchedule(admin, aNow));
    const changed = d.tiers.map((x) => Object.assign({}, x, { Rate: x.Rate === 5 ? 6 : x.Rate }));
    ok(saveSchedule(admin, { schedule: d.schedule, tiers: changed, bonusTiers: d.bonusTiers }));
    const e = ok(getAuditLog(admin, { search: 'Changed commission tiers' })).entries[0];
    ok(saveSchedule(admin, { schedule: d.schedule, tiers: d.tiers, bonusTiers: d.bonusTiers }));
    if (e.PreviousValue.indexOf('5%') === -1 || e.NewValue.indexOf('6%') === -1) throw new Error(JSON.stringify(e));
  });
  t('Duplicate Previous Month copies every schedule as Draft', () => {
    const target = addMonths_(month, 3);
    const d = ok(duplicateMonth(admin, month, target));
    eq(d.created.sort(), ['Staff A', 'Staff B']);
    const again = ok(duplicateMonth(admin, month, target));
    eq(again.created.length, 0);
  });
  t('Report totals equal the sum of rows; CSV-ready rows', () => {
    const r = ok(getReport(admin, { month: last }));
    eq(r.rows.length, 2);
    eq(r.totals.totalCompensation, r.rows.reduce((a, x) => a + x.totalCompensation, 0));
    eq(r.totals.sales, 210000);
  });
  t('Statement for paid month uses the snapshot (sales + tiers)', () => {
    const s = ok(getStatement(admin, aLast));
    eq([s.calc.isSnapshot, s.sales.length, s.tiers.length, s.calc.totalCompensation], [true, 18, 5, 10760]);
  });
  t('Target exceeded: remaining ₱0, above-target amount shown', () => {
    const c = ok(getCommission(admin, bLast));
    eq([c.remainingSales, c.amountAboveTarget, c.targetExceeded, c.salesProgress], [0, 18000, true, 118]);
  });
  t('Settings: cannot remove your own Admin email', () => err(saveSettings(admin, {
    StudioName: 'ClickLounge Studio', AdminEmails: 'someone@else.com', Currency: 'PHP', CurrencySymbol: '₱', Timezone: 'Asia/Manila'
  })));
  t('Login locks after 5 failed attempts', () => {
    for (let i = 0; i < 5; i++) login('staff.b@example.com', 'bad-' + i);
    return err(login('staff.b@example.com', 'bravo-2026'), 'AUTH_LOCKED');
  });

  // ---------- GitHub Pages JSON-P API (Api.gs) ----------
  // Encodes exactly like the browser (JS.html → jsonp()).
  const apiRaw = (payload, callback) => {
    const d = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    return doGet({ parameter: { d: d, callback: callback || 'cb_1' } });
  };
  const apiCall = (fn, args) => {
    const out = apiRaw({ fn: fn, args: args });
    const text = out.getContent();
    if (out.getMimeType() !== 'JAVASCRIPT' || text.indexOf('cb_1(') !== 0) throw new Error('Bad JSON-P response: ' + text.slice(0, 80));
    return JSON.parse(text.slice(5, -2));
  };
  M.setActiveEmail(''); // GitHub Pages: Google never identifies the visitor
  let pagesAdmin;
  t('API: visitor without a session gets the login screen', () => eq(ok(apiCall('bootstrap', [null])).needsLogin, true));
  t('API: owner sets own access code (sheet menu helper) and signs in', () => {
    setAccessCodeForEmail_(M.OWNER_EMAIL, 'owner-code-2026', 'Owner');
    const d = ok(apiCall('login', [M.OWNER_EMAIL, 'owner-code-2026']));
    eq(d.user.isAdmin, true);
    pagesAdmin = d.token;
  });
  t('API: admin call works with the token', () => eq(ok(apiCall('listUsers', [pagesAdmin])).length > 2, true));
  t('API: staff token is still FORBIDDEN from admin functions', () => {
    const tok = ok(apiCall('login', ['staff.a@example.com', 'alpha-2026'])).token;
    err(apiCall('listUsers', [tok]), 'FORBIDDEN');
    eq(ok(apiCall('getMyDashboard', [tok, ''])).detail.staffName, 'Staff A');
  });
  t('API: owner-only and private functions cannot be called', () => {
    ['setupDemoData', 'setupDatabase', 'calculateCommission_', 'constructor', 'toString', '__proto__', 'installDailyTrigger']
      .forEach((fn) => err(apiCall(fn, [pagesAdmin]), 'BAD_REQUEST'));
  });
  t('API: unsafe callback names are refused', () => {
    const text = apiRaw({ fn: 'bootstrap', args: [null] }, 'alert(1)//').getContent();
    eq(text.indexOf('alert'), -1);
  });
  t('API: malformed request → friendly error', () => {
    const text = doGet({ parameter: { d: '%%%not-base64', callback: 'cb_1' } }).getContent();
    eq(JSON.parse(text.slice(5, -2)).code, 'BAD_REQUEST');
  });
  t('API: accented names and ₱ survive the round trip', () => {
    const name = 'Niño Ñuñez — ₱ “Prestige”';
    const id = ok(apiCall('saveSale', [pagesAdmin, { SaleDate: month + '-05', ClientName: name, PackageID: pkg5000.PackageID, StaffID: A.UserID }])).saleId;
    const s = ok(apiCall('listSales', [pagesAdmin, { month: month }])).sales.find((x) => x.SaleID === id);
    eq(s.ClientName, name);
  });

  // ---------- Time clock (Time.gs) ----------
  // A dedicated staff member with an Active schedule covering the last 40 days,
  // so these tests work on any calendar date (including the 1st of a month).
  const near = (a, b, tol) => { if (Math.abs(a - b) > (tol || 0.02)) throw new Error('expected ~' + b + ', got ' + a); };
  const day = (n) => formatDateTime_(parseDateTime_(nowStr_()) - n * 86400000).slice(0, 10);
  const T = ok(saveUser(pagesAdmin, { Name: 'Staff T', Email: 'staff.t@example.com', Role: 'Staff', Status: 'Active', Position: 'Sales' })).userId;
  ok(setUserAccessCode(pagesAdmin, T, 'tango-2026'));
  const tSched = ok(saveSchedule(pagesAdmin, {
    schedule: { Month: addMonths_(month, 12), StartDate: day(40), EndDate: day(-20), StaffID: T, PackageTarget: 20, SalesTarget: 100000, BaseCompensation: 8000, ExpectedHours: 90, Status: 'Active' },
    tiers: tiers, bonusTiers: []
  })).scheduleId;
  const staffTok = ok(apiCall('login', ['staff.t@example.com', 'tango-2026'])).token;
  t('Upgrade: a missing TimeLogs sheet is created automatically on sign-in', () => {
    M.ss.deleteSheet(M.ss.getSheetByName('TimeLogs'));
    ok(bootstrap(staffTok));
    eq(!!M.ss.getSheetByName('TimeLogs'), true);
  });
  t('Staff clocks in (via the Pages API); a second clock-in is refused', () => {
    const d = ok(apiCall('clockIn', [staffTok, 'Opening shift']));
    eq([!!d.open, d.open.Source, d.open.Notes, d.period.expectedHours], [true, 'CLOCK', 'Opening shift', 90]);
    return err(clockIn(staffTok));
  });
  t('Break start / end', () => {
    eq(ok(toggleBreak(staffTok)).open.onBreak, true);
    eq(ok(toggleBreak(staffTok)).open.onBreak, false);
  });
  t('Clock out records worked hours = time − breaks (3 h shift, 30 min break → 2.5 h)', () => {
    resetExecutionCaches_();
    const open = openEntry_(T);
    const start = formatDateTime_(parseDateTime_(nowStr_()) - 3 * 3600000);
    updateRow_(SHEET.TIME, 'LogID', open.LogID, { ClockIn: start, Date: start.slice(0, 10), BreakMinutes: 30 });
    const d = ok(clockOut(staffTok, 'done'));
    const entry = d.entries.find((e) => e.LogID === open.LogID);
    near(entry.Hours, 2.5);
    eq(d.open, null);
    return entry.Hours + ' h';
  });
  t('Clock out when not clocked in is refused', () => err(clockOut(staffTok)));
  t('Staff cannot add, edit, delete or list everyone\'s time', () => {
    err(saveTimeLog(staffTok, {}), 'FORBIDDEN');
    err(deleteTimeLog(staffTok, 'x'), 'FORBIDDEN');
    err(getTimeOverview(staffTok, {}), 'FORBIDDEN');
  });
  t('Admin adds a manual entry 09:00–17:30, 60 min break → 7.5 h', () => {
    const id = ok(saveTimeLog(pagesAdmin, { StaffID: T, Date: day(2), InTime: '09:00', OutTime: '17:30', BreakMinutes: 60, Notes: 'Forgot to clock' })).logId;
    eq(findById_(SHEET.TIME, 'LogID', id).Hours, 7.5);
  });
  t('Overnight entry 22:00–02:00 → 4 h, dated by its start day', () => {
    const id = ok(saveTimeLog(pagesAdmin, { StaffID: T, Date: day(4), InTime: '22:00', OutTime: '02:00' })).logId;
    const r = findById_(SHEET.TIME, 'LogID', id);
    eq([r.Hours, r.Date, r.ClockOut.slice(0, 10)], [4, day(4), day(3)]);
  });
  t('Overlapping entries are refused', () => err(saveTimeLog(pagesAdmin, { StaffID: T, Date: day(2), InTime: '12:00', OutTime: '13:00' })));
  t('Future times are refused', () => err(saveTimeLog(pagesAdmin, { StaffID: T, Date: day(-2), InTime: '09:00', OutTime: '10:00' })));
  t('Break longer than shift / bad time format are refused', () => {
    err(saveTimeLog(pagesAdmin, { StaffID: T, Date: day(6), InTime: '09:00', OutTime: '10:00', BreakMinutes: 90 }));
    return err(saveTimeLog(pagesAdmin, { StaffID: T, Date: day(6), InTime: '9am', OutTime: '10:00' }));
  });
  t('Time inside a Paid month is locked', () => err(saveTimeLog(pagesAdmin, { StaffID: A.UserID, Date: last + '-10', InTime: '09:00', OutTime: '17:00' }), 'LOCKED'));
  t('Correcting an entry is audited with before/after', () => {
    const entry = rows_(SHEET.TIME).find((l) => l.StaffID === T && l.Date === day(2));
    ok(saveTimeLog(pagesAdmin, { LogID: entry.LogID, StaffID: T, Date: day(2), InTime: '09:00', OutTime: '18:00', BreakMinutes: 60 }));
    const log = ok(getAuditLog(pagesAdmin, { search: 'Corrected time entry' })).entries[0];
    if (log.PreviousValue.indexOf('7.5 h') === -1 || log.NewValue.indexOf('8 h') === -1) throw new Error(log.PreviousValue + ' → ' + log.NewValue);
  });
  t('Schedule counts all worked hours vs required 90 h (2.5 + 8 + 4 = 14.5 h)', () => {
    const c = ok(getCommission(pagesAdmin, tSched));
    near(c.loggedHours, 14.5);
    eq([c.expectedHours, c.timeEntries], [90, 3]);
    near(c.hoursRemaining, 75.5);
    return c.loggedHours + ' / 90 h (' + c.hoursProgress + '%)';
  });
  t('Admin time overview: clocked-in now, hours vs required, entries', () => {
    ok(clockIn(staffTok));
    const o = ok(getTimeOverview(pagesAdmin, { month: day(2).slice(0, 7) }));
    eq(o.clockedIn.map((c) => c.staffName), ['Staff T']);
    eq(o.entries.some((e) => e.staffName === 'Staff T'), true);
    eq(ok(getAdminDashboard(pagesAdmin, month)).clockedIn.length, 1);
    eq(ok(getMyTimeClock(staffTok)).open !== null, true);
    ok(clockOut(staffTok));
  });
  t('Deleting an entry is audited', () => {
    const entry = rows_(SHEET.TIME).find((l) => l.StaffID === T && l.Date === day(4));
    ok(deleteTimeLog(pagesAdmin, entry.LogID));
    eq(!!findById_(SHEET.TIME, 'LogID', entry.LogID), false);
    eq(ok(getAuditLog(pagesAdmin, { search: 'Deleted time entry' })).entries.length, 1);
  });

  return R;
}
