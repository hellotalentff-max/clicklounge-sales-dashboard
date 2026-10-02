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
