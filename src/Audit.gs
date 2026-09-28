/**
 * Audit.gs
 * Append-only audit trail of important actions (AuditLog sheet).
 */

function actorLabel_(actor) {
  if (!actor) return 'System';
  if (typeof actor === 'string') return actor;
  return actor.name + ' <' + actor.email + '>';
}

/**
 * Records one audit entry. Called inside withLock_ by every sensitive action.
 * previousValue/newValue may be strings or objects (stored as JSON).
 */
function logAudit_(actor, action, recordId, previousValue, newValue, reason) {
  const fmt = function (v) {
    if (v === null || v === undefined) return '';
    return truncate_(typeof v === 'string' ? v : JSON.stringify(v), 45000);
  };
  insertRows_(SHEET.AUDIT, [{
    LogID: newId_('LOG'),
    User: actorLabel_(actor),
    Action: truncate_(action, 1000),
    RecordID: recordId || '',
    PreviousValue: fmt(previousValue),
    NewValue: fmt(newValue),
    Reason: truncate_(reason || '', 2000),
    Timestamp: nowStr_()
  }]);
}

/**
 * Audits each changed field as a readable sentence, e.g.
 * "Changed sales target from ₱100,000 to ₱120,000 (Staff A, September 2026)".
 * fields: [[key, label, 'money'|'text'|'number']]
 */
function auditFieldChanges_(actor, recordId, before, after, fields, context) {
  fields.forEach(function (f) {
    const key = f[0], label = f[1], kind = f[2] || 'text';
    const a = before[key], b = after[key];
    const same = kind === 'text' ? String(a || '') === String(b || '') : Number(a || 0) === Number(b || 0) && isBlank_(a) === isBlank_(b);
    if (same) return;
    const show = function (v) {
      if (isBlank_(v)) return '(blank)';
      return kind === 'money' ? money_(v) : String(v);
    };
    logAudit_(actor, 'Changed ' + label + ' from ' + show(a) + ' to ' + show(b) + (context ? ' (' + context + ')' : ''),
      recordId, show(a), show(b));
  });
}

/* ------------------------------------------------------------------ */
/* Client-callable                                                     */
/* ------------------------------------------------------------------ */

function getAuditLog(token, filters) {
  return api_(function () {
    requireAdmin_(token);
    filters = filters || {};
    const q = String(filters.search || '').toLowerCase().trim();
    const limit = Math.min(Number(filters.limit) || 200, 1000);
    const rows = rows_(SHEET.AUDIT).slice().reverse().filter(function (r) {
      if (!q) return true;
      return [r.User, r.Action, r.RecordID, r.Reason, r.PreviousValue, r.NewValue]
        .join(' ').toLowerCase().indexOf(q) !== -1;
    });
    return {
      total: rows.length,
      entries: rows.slice(0, limit).map(function (r) {
        const out = publicRow_(r);
        out.PreviousValue = truncate_(out.PreviousValue, 600);
        out.NewValue = truncate_(out.NewValue, 600);
        return out;
      })
    };
  });
}
