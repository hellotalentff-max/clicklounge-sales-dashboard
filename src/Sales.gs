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
