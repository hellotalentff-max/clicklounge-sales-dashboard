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
