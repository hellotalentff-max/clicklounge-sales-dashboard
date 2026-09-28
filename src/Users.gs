/**
 * Users.gs
 * User management, sessions and role checks.
 *
 * Identity, in order of preference:
 *  1. A session token issued by bootstrap()/login(), kept in CacheService.
 *  2. The signed-in Google account (Session.getActiveUser). Available for the
 *     owner and, on Google Workspace, for users in the same domain.
 *  3. Email + access code login. Needed for consumer @gmail.com accounts,
 *     because Google hides their email from a web app that runs as the owner.
 *
 * Admin rights come from Config → AdminEmails (never hard-coded).
 * Every client-callable function calls requireUser_ / requireAdmin_.
 */

const ROLES = ['Admin', 'Staff'];
const USER_STATUSES = ['Active', 'Inactive'];
const SESSION_PREFIX_ = 'sess_';
const SESSION_SECONDS_ = 6 * 60 * 60; // CacheService maximum
const MAX_LOGIN_ATTEMPTS_ = 5;

function getGoogleEmail_() {
  try {
    return String(Session.getActiveUser().getEmail() || '').toLowerCase().trim();
  } catch (e) {
    return '';
  }
}

function findUserByEmail_(email) {
  email = String(email || '').toLowerCase().trim();
  if (!email) return null;
  return rows_(SHEET.USERS).find(function (u) { return u.Email.toLowerCase() === email; }) || null;
}

function userName_(userId) {
  const u = findById_(SHEET.USERS, 'UserID', userId);
  return u ? u.Name : '(unknown staff)';
}

/** The minimal user object used for permission checks and sent to the browser. */
function buildSessionUser_(row) {
  const admin = isAdminEmail_(row.Email);
  return {
    userId: row.UserID,
    name: row.Name,
    email: row.Email,
    position: row.Position,
    role: admin ? 'Admin' : 'Staff',
    isAdmin: admin
  };
}

function sessionUserId_(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  return CacheService.getScriptCache().get(SESSION_PREFIX_ + token);
}

function createSession_(userId) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put(SESSION_PREFIX_ + token, userId, SESSION_SECONDS_);
  return token;
}

function resolveUserRow_(token) {
  const uid = sessionUserId_(token);
  if (uid) {
    const u = findById_(SHEET.USERS, 'UserID', uid);
    if (u) return u;
  }
  const email = getGoogleEmail_();
  return email ? findUserByEmail_(email) : null;
}

/** Returns the signed-in user or throws AUTH. */
function requireUser_(token) {
  const row = resolveUserRow_(token);
  if (!row) throw appError_('Please sign in to continue.', 'AUTH');
  if (row.Status !== 'Active') throw appError_('Your account is inactive. Please contact the Admin.', 'AUTH');
  return buildSessionUser_(row);
}

/** Returns the signed-in Admin or throws FORBIDDEN. */
function requireAdmin_(token) {
  const user = requireUser_(token);
  if (!user.isAdmin) throw appError_('You do not have permission to perform this action.', 'FORBIDDEN');
  return user;
}

/** Staff may only access their own records; Admin may access everyone's. */
function requireSelfOrAdmin_(user, staffId) {
  if (!user.isAdmin && user.userId !== staffId) {
    throw appError_('You do not have permission to view another staff member\'s information.', 'FORBIDDEN');
  }
}

/** Creates a Users row for an Admin email the first time they open the app. */
function provisionAdmin_(email) {
  return withLock_(function () {
    let row = findUserByEmail_(email);
    if (!row) {
      const now = nowStr_();
      row = {
        UserID: newId_('USR'), Name: email.split('@')[0], Email: email, Role: 'Admin', Position: 'Owner / Admin',
        Status: 'Active', BaseCompensationDefault: 0, CreatedDate: now, AccessCodeHash: '', AccessCodeSalt: '', UpdatedAt: now
      };
      insertRows_(SHEET.USERS, [row]);
      logAudit_('System', 'Created Admin user for ' + email + ' (listed in Config → AdminEmails)', row.UserID, '', email);
    }
    return row.Status === 'Active' ? buildSessionUser_(row) : null;
  });
}

/** Keeps Users.Role in sync with Config → AdminEmails and creates missing Admin users. */
function syncAdminUsers_(actor) {
  const admins = adminEmails_();
  const now = nowStr_();
  const toInsert = [];
  admins.forEach(function (email) {
    if (!findUserByEmail_(email)) {
      toInsert.push({
        UserID: newId_('USR'), Name: email.split('@')[0], Email: email, Role: 'Admin', Position: 'Admin',
        Status: 'Active', BaseCompensationDefault: 0, CreatedDate: now, AccessCodeHash: '', AccessCodeSalt: '', UpdatedAt: now
      });
    }
  });
  insertRows_(SHEET.USERS, toInsert);
  toInsert.forEach(function (u) { logAudit_(actor, 'Created Admin user ' + u.Email, u.UserID, '', u.Email); });
  rows_(SHEET.USERS).forEach(function (u) {
    const role = admins.indexOf(u.Email.toLowerCase()) !== -1 ? 'Admin' : 'Staff';
    if (u.Role !== role) updateRow_(SHEET.USERS, 'UserID', u.UserID, { Role: role, UpdatedAt: now });
  });
}

/** Salted, iterated SHA-256 hash for access codes (never stored in plain text). */
function hashAccessCode_(code, salt) {
  let h = salt + ':' + code;
  for (let i = 0; i < 300; i++) h = sha256Hex_(h + ':' + salt);
  return h;
}

function validateAccessCode_(code) {
  const s = String(code || '');
  if (s.length < 6) throw appError_('Access code must be at least 6 characters.');
  if (s.length > 64) throw appError_('Access code must be 64 characters or fewer.');
  return s;
}

function publicUser_(u) {
  const out = publicRow_(u, ['AccessCodeHash', 'AccessCodeSalt']);
  out.hasAccessCode = !!u.AccessCodeHash;
  out.Role = isAdminEmail_(u.Email) ? 'Admin' : 'Staff';
  return out;
}

/* ------------------------------------------------------------------ */
/* Client-callable: sign in / out                                      */
/* ------------------------------------------------------------------ */

function login(email, accessCode) {
  return api_(function () {
    assertDatabaseReady_();
    const cleanEmail = String(email || '').toLowerCase().trim();
    if (!cleanEmail || !accessCode) throw appError_('Enter your email and access code.');
    const cache = CacheService.getScriptCache();
    const attemptsKey = 'login_' + sha256Hex_(cleanEmail).slice(0, 32);
    const attempts = Number(cache.get(attemptsKey) || 0);
    if (attempts >= MAX_LOGIN_ATTEMPTS_) {
      throw appError_('Too many sign-in attempts. Please wait 15 minutes and try again.', 'AUTH_LOCKED');
    }
    const row = findUserByEmail_(cleanEmail);
    const valid = row && row.Status === 'Active' && row.AccessCodeHash &&
      hashAccessCode_(String(accessCode), row.AccessCodeSalt) === row.AccessCodeHash;
    if (!valid) {
      cache.put(attemptsKey, String(attempts + 1), 15 * 60);
      if (attempts + 1 >= MAX_LOGIN_ATTEMPTS_) {
        withLock_(function () {
          logAudit_('System', 'Sign-in locked for 15 minutes after repeated failed attempts', cleanEmail, '', '');
        });
      }
      throw appError_('Email or access code is incorrect.', 'AUTH_FAILED');
    }
    cache.remove(attemptsKey);
    return {
      token: createSession_(row.UserID),
      user: buildSessionUser_(row),
      config: publicConfig_()
    };
  });
}

function logout(token) {
  return api_(function () {
    if (token && typeof token === 'string') CacheService.getScriptCache().remove(SESSION_PREFIX_ + token);
    return ok_(null, 'Signed out.');
  });
}

function changeMyAccessCode(token, currentCode, newCode) {
  return api_(function () {
    const user = requireUser_(token);
    const code = validateAccessCode_(newCode);
    return withLock_(function () {
      const row = findById_(SHEET.USERS, 'UserID', user.userId);
      if (row.AccessCodeHash && hashAccessCode_(String(currentCode || ''), row.AccessCodeSalt) !== row.AccessCodeHash) {
        throw appError_('Your current access code is incorrect.');
      }
      const salt = Utilities.getUuid();
      updateRow_(SHEET.USERS, 'UserID', user.userId, {
        AccessCodeHash: hashAccessCode_(code, salt), AccessCodeSalt: salt, UpdatedAt: nowStr_()
      });
      logAudit_(user, 'Changed own access code', user.userId, '', '(hidden)');
      return ok_(null, 'Access code updated.');
    });
  });
}

/* ------------------------------------------------------------------ */
/* Client-callable: staff management (Admin only)                      */
/* ------------------------------------------------------------------ */

function listUsers(token) {
  return api_(function () {
    requireAdmin_(token);
    return rows_(SHEET.USERS).map(publicUser_).sort(function (a, b) { return a.Name.localeCompare(b.Name); });
  });
}

/** Alias kept for clarity with the specification. Admin only. */
function getAllStaff(token) {
  return listUsers(token);
}

function saveUser(token, input) {
  return api_(function () {
    const admin = requireAdmin_(token);
    input = input || {};
    return withLock_(function () {
      const existing = input.UserID ? findById_(SHEET.USERS, 'UserID', input.UserID) : null;
      if (input.UserID && !existing) throw appError_('Staff member not found.', 'NOT_FOUND');
      const name = str_(input.Name, 'Name', { required: true, maxLength: 100 });
      const email = email_(input.Email, 'Email');
      const clash = rows_(SHEET.USERS).find(function (u) {
        return u.Email.toLowerCase() === email && (!existing || u.UserID !== existing.UserID);
      });
      if (clash) throw appError_('Another user (' + clash.Name + ') already uses ' + email + '.');
      const role = str_(input.Role || 'Staff', 'Role', { oneOf: ROLES });
      const status = str_(input.Status || 'Active', 'Status', { oneOf: USER_STATUSES });
      const position = str_(input.Position, 'Position', { maxLength: 100 });
      const base = num_(input.BaseCompensationDefault, 'Default base compensation', { min: 0, defaultValue: 0 });
      if (existing && existing.UserID === admin.userId && (status !== 'Active' || role !== 'Admin' || email !== admin.email.toLowerCase())) {
        throw appError_('You cannot deactivate, rename the email of, or remove Admin access from your own account.');
      }

      const now = nowStr_();
      const record = { Name: name, Email: email, Role: role, Position: position, Status: status, BaseCompensationDefault: base, UpdatedAt: now };
      let userId;
      if (existing) {
        userId = existing.UserID;
        updateRow_(SHEET.USERS, 'UserID', userId, record);
        auditFieldChanges_(admin, userId, existing, record, [
          ['Name', 'name'], ['Email', 'email'], ['Role', 'role'], ['Position', 'position'], ['Status', 'status'],
          ['BaseCompensationDefault', 'default base compensation', 'money']
        ], name);
      } else {
        userId = newId_('USR');
        insertRows_(SHEET.USERS, [Object.assign({ UserID: userId, CreatedDate: now, AccessCodeHash: '', AccessCodeSalt: '' }, record)]);
        logAudit_(admin, 'Added ' + role + ' ' + name + ' (' + email + ')', userId, '', record);
      }

      // Admin rights live in Config → AdminEmails; keep it consistent with the Role chosen here.
      const oldEmail = existing ? existing.Email.toLowerCase() : null;
      const admins = adminEmails_().filter(function (e) { return e !== oldEmail && e !== email; });
      if (role === 'Admin' && status === 'Active') admins.push(email);
      if (!admins.length) throw appError_('At least one active Admin is required.');
      if (admins.join(', ') !== adminEmails_().join(', ')) setConfigValues_({ AdminEmails: admins.join(', ') }, admin);
      syncAdminUsers_(admin);

      return ok_({ userId: userId }, existing ? 'Staff member updated.' : 'Staff member added.');
    });
  });
}

function setUserAccessCode(token, userId, code) {
  return api_(function () {
    const admin = requireAdmin_(token);
    const clean = validateAccessCode_(code);
    return withLock_(function () {
      const row = findById_(SHEET.USERS, 'UserID', userId);
      if (!row) throw appError_('Staff member not found.', 'NOT_FOUND');
      const salt = Utilities.getUuid();
      updateRow_(SHEET.USERS, 'UserID', userId, {
        AccessCodeHash: hashAccessCode_(clean, salt), AccessCodeSalt: salt, UpdatedAt: nowStr_()
      });
      logAudit_(admin, 'Set access code for ' + row.Name, userId, row.AccessCodeHash ? '(previous code)' : '(none)', '(hidden)');
      return ok_(null, 'Access code set for ' + row.Name + '.');
    });
  });
}
