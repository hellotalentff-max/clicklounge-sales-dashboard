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
