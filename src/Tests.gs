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

  // "Are you still working?" checks: every 30 min, 15 min to answer.
  const shift = { ClockIn: '2026-10-02 09:00:00', ClockOut: '', MissedChecks: 0 };
  const cs = function (now, e) { const c = checkStatus_(e || shift, now, 30, 15); return [c.status, c.pendingMissed]; };
  check('Check: 09:20 → nothing due yet', cs('2026-10-02 09:20:00'), ['ok', 0]);
  check('Check: 09:35 → "still working?" due (answer by 09:45)', cs('2026-10-02 09:35:00'), ['due', 0]);
  check('Check: 09:50 unanswered → 1 missed', cs('2026-10-02 09:50:00'), ['missed', 1]);
  check('Check: 10:05 → next check due, 1 missed so far', cs('2026-10-02 10:05:00'), ['due', 1]);
  check('Check: confirmed at 10:05 → next due 10:35', checkStatus_(Object.assign({}, shift, { LastConfirmedAt: '2026-10-02 10:05:00' }), '2026-10-02 10:20:00', 30, 15).nextCheckAt, '2026-10-02 10:35:00');
  check('Check: paused during a break', cs('2026-10-02 11:00:00', Object.assign({}, shift, { BreakStart: '2026-10-02 10:40:00' })), ['paused', 0]);
  check('Check: interval 0 switches checks off', checkStatus_(shift, '2026-10-02 12:00:00', 0, 15).status, 'off');

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
