/**
 * Api.gs
 * JSON-P endpoint so the frontend can be hosted outside Apps Script
 * (e.g. GitHub Pages), the same way the ClickLounge POS talks to its script.
 *
 * Request:  GET <web app URL>?d=<base64(JSON {fn, args})>&callback=<name>
 * Response: <name>({ success, data, message } | { success:false, error, code })
 *
 * Only the functions listed in apiFunctions_() can be called. Each of them
 * still checks the session token and role itself, exactly as with
 * google.script.run. Owner-only maintenance (setupDatabase, setupDemoData,
 * triggers) and private "_" helpers are never reachable from here.
 */

function apiFunctions_() {
  return {
    bootstrap: bootstrap, login: login, logout: logout, changeMyAccessCode: changeMyAccessCode,
    listUsers: listUsers, getAllStaff: getAllStaff, saveUser: saveUser, setUserAccessCode: setUserAccessCode,
    getSettings: getSettings, saveSettings: saveSettings,
    getCommissionRules: getCommissionRules, saveCommissionRules: saveCommissionRules,
    getAuditLog: getAuditLog, getCommission: getCommission,
    listSchedules: listSchedules, getSchedule: getSchedule, getScheduleTemplate: getScheduleTemplate,
    saveSchedule: saveSchedule, duplicateSchedule: duplicateSchedule, duplicateMonth: duplicateMonth,
    changeScheduleStatus: changeScheduleStatus, deleteSchedule: deleteSchedule, getMySchedules: getMySchedules,
    listSales: listSales, saveSale: saveSale, deleteSale: deleteSale,
    listPackages: listPackages, savePackage: savePackage,
    getReport: getReport, getStatement: getStatement,
    getAdminDashboard: getAdminDashboard, getMyDashboard: getMyDashboard
  };
}

/** Handles one JSON-P request (called from doGet when ?d= is present). */
function handleApiRequest_(e) {
  const p = (e && e.parameter) || {};
  const callback = String(p.callback || '');
  if (!/^[A-Za-z_$][\w$]{0,63}$/.test(callback)) {
    return ContentService.createTextOutput('/* invalid callback */').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  let response;
  try {
    const json = Utilities.newBlob(Utilities.base64Decode(String(p.d || ''))).getDataAsString('UTF-8');
    const req = JSON.parse(json);
    const fn = apiFunctions_()[req && req.fn];
    if (!fn || !Object.prototype.hasOwnProperty.call(apiFunctions_(), req.fn)) {
      response = fail_('Unknown action.', 'BAD_REQUEST');
    } else {
      response = fn.apply(null, Array.isArray(req.args) ? req.args : []);
    }
  } catch (err) {
    response = fail_('The request could not be read. Please reload the page and try again.', 'BAD_REQUEST');
  }
  // U+2028/2029 are valid in JSON but not in older JS string literals.
  const body = JSON.stringify(response).replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028').replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
  return ContentService.createTextOutput(callback + '(' + body + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
}
