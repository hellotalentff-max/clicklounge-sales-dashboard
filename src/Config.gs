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
    ['TemplateBonusStructure', 'HIGHEST', 'HIGHEST (highest applicable bonus only) or CUMULATIVE.'],
    ['TimeCheckIntervalMinutes', '30', 'Ask clocked-in staff "Are you still working?" every N minutes (0 = off).'],
    ['TimeCheckResponseMinutes', '15', 'Minutes staff have to answer before the check is flagged as missed.']
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
    timeCheckMinutes: timeCheckSettings_().interval,
    timeCheckResponseMinutes: timeCheckSettings_().window,
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
      TimeCheckIntervalMinutes: timeCheckSettings_().interval,
      TimeCheckResponseMinutes: timeCheckSettings_().window,
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

      const checkEvery = num_(input.TimeCheckIntervalMinutes, 'Still-working check interval', { min: 0, max: 720, integer: true, defaultValue: 30 });
      const checkAnswer = num_(input.TimeCheckResponseMinutes, 'Time to answer the check', { min: 1, max: 120, integer: true, defaultValue: 15 });
      if (checkEvery > 0 && checkEvery < 5) throw appError_('The still-working check interval must be 0 (off) or at least 5 minutes.');
      if (checkEvery > 0 && checkAnswer >= checkEvery) throw appError_('The time to answer must be shorter than the check interval.');

      setConfigValues_({
        TimeCheckIntervalMinutes: checkEvery,
        TimeCheckResponseMinutes: checkAnswer,
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
