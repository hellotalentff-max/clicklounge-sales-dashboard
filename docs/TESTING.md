# Testing — Step 7

## How the tests were run

The Apps Script code in `src/` was run **unchanged** against an in-memory mock of the
Google services it uses (`dev/appsscript-mock.js`: SpreadsheetApp, CacheService,
LockService, PropertiesService, Session, Utilities). The mock follows real Sheets
behaviour where it matters (row/column ranges, `getDataRange`, row deletion, max rows),
but it is a stand-in: before going live, repeat the manual checks at the bottom of this
page in the real deployment.

- **Unit tests:** `src/Tests.gs → runCommissionTests()`. Pure calculations, safe to run
  on the live database from the Apps Script editor.
- **End-to-end tests:** `dev/e2e-tests.js`. Calls the same public functions the browser
  calls (`bootstrap`, `login`, `saveSale`, `saveSchedule`, `changeScheduleStatus`, …) with
  Admin and Staff sessions.

Run all of them at `http://localhost:8765/dev/tests.html` (see README → Local testing).

**Result: 86 / 86 passed.**

## Specification test cases (§38)

Default tiers: ₱0–69,999 = 0% · ₱70,000–99,999 = 3% · ₱100,000–149,999 = 5% ·
₱150,000–199,999 = 6% · ₱200,000+ = 7%. Bonuses: 20 = ₱1,000 · 25 = ₱2,000 ·
30 = ₱3,000 · 35 = ₱5,000 · 40+ = ₱7,000 (highest only).

| # | Input | Expected | Result |
|---|---|---|---|
| 1 | Sales ₱50,000 | 0% → ₱0 | ✅ 0%, ₱0 |
| 2 | Sales ₱80,000 | 3% → ₱2,400 | ✅ 3%, ₱2,400 |
| 3 | Sales ₱120,000 | 5% → ₱6,000 | ✅ 5%, ₱6,000 |
| 4 | Sales ₱175,000 | 6% → ₱10,500 | ✅ 6%, ₱10,500 |
| 5 | Sales ₱220,000 | 7% → ₱15,400 | ✅ 7%, ₱15,400 |
| 6 | 22 packages | ₱1,000 | ✅ ₱1,000 |
| 7 | 30 packages | ₱3,000 (not ₱6,000) | ✅ ₱3,000 |
| 8 | 40 packages | ₱7,000 | ✅ ₱7,000 |
| 9 | Shared ₱5,000, A 60% / B 40% | A ₱3,000, B ₱2,000 | ✅ unit and end-to-end (through `saveSale` + both staff sessions) |
| 10 | Paid month, later month's rules changed | Paid month unchanged | ✅ See below |

**Test 10 in detail (end-to-end):** Staff B's paid month (₱118,000 → ₱5,900 commission,
₱14,900 total) stayed identical after all of these:
1. The next month was duplicated and its 5% tier changed to 7%.
2. The global commissionable basis was switched to *All recorded sales*, every status
   rule was switched on, and shared package credit was set to *Full*.
3. The default template tiers were changed.

The paid month's own tier rows were also checked: still 0/3/5/6/7%. The new month has its
own rows (0/3/7/6/7%).

Additional checks that passed:
- **Boundaries:** ₱69,999.99 → 0%; ₱70,000 → 3%; ₱99,999.50 → 3%; ₱100,000 → 5%;
  ₱200,000 → 7%.
- **Other bonus cases:** 19 packages → ₱0; 45 → ₱7,000; cumulative option at 30 → ₱6,000.
- **Worked example (§10):** ₱120,000 sales, 22 packages, ₱8,000 base → ₱6,000 + ₱1,000 +
  ₱8,000 = **₱15,000**. Progress 120%, ₱20,000 above target, ₱0 remaining (never negative).
  Effective hourly rate ₱8,000 ÷ 90 h = ₱88.89.
- **Attribution (§8):** Staff A ₱55,000 and Staff B ₱45,000 are credited separately and
  never split 50/50.
- **Demo data vs. the brief's tables:** Staff A ₱92,000 / 18 pkgs → ₱2,760, ₱0 bonus,
  ₱10,760. Staff B ₱118,000 / 23 pkgs → ₱5,900, ₱1,000, ₱14,900. Staff dashboard
  ₱72,500 / 15 pkgs → 72.5%, ₱27,500 remaining, 5 packages remaining, ₱2,175 commission,
  ₱10,175 estimated total. All match.

## Calculation errors found in the brief

Running the examples through the engine exposed two inconsistencies in the specification
itself. Neither affects the app; the tier and bonus rules in the brief are applied
consistently.

1. **§3 "CURRENT COMMISSION ₱3,625" for ₱72,500 sales.** ₱3,625 is 5% of ₱72,500, but
   ₱72,500 falls in the ₱70,000–₱99,999 tier (3%), so the correct figure is **₱2,175**.
   §15 of the brief shows ₱2,175 for the same numbers, and that is what the app produces.
2. **§3 "BONUS ₱1,000" with 15 / 20 packages sold.** The first bonus tier needs 20
   packages, so 15 packages earns **₱0**. §15 shows ₱0, matching the app.

The §14 table (Staff A ₱92,000 → ₱2,760 → ₱10,760; Staff B ₱118,000 → ₱5,900 + ₱1,000
→ ₱14,900) and the §10 / §26 examples are all correct.

## Security, validation and workflow tests (end-to-end)

| Area | Checks (all passing) |
|---|---|
| Setup | Creates all 10 sheets with correct headers. Idempotent. Seeds 5 packages, 5 tiers, 5 bonus tiers. Owner becomes Admin. |
| Sign-in | No Google identity → login screen. Wrong code rejected. Correct code → Staff session. Token survives reload. Garbage token → AUTH. Access codes stored as 64-char hashes. 5 failures → 15-minute lock. |
| Authorization (§23) | Staff get FORBIDDEN from `getAllStaff`, `listUsers`, another staff member's `getSchedule` / `getCommission` / `getStatement`, `saveSale`, `deleteSale`, `saveSchedule`, `changeScheduleStatus`, `saveCommissionRules`, `saveSettings`, `getAuditLog`, `getReport`. `listSales` with another staff member's ID still returns only the caller's own sales, and never other staff names. Owner-only `setupDemoData` refuses web-app visitors. |
| Validation (§28) | Rejects: overlapping tiers, rate > 100%, bonus package count 0 / 2.5 / duplicate, negative targets, duplicate staff+month schedule, negative package price, invalid package ID, negative amount, discount above price, shared split ≠ 100%, sale to inactive staff. |
| Workflow (§16) | Draft → Active → Pending Approval → Approved → Paid. Cannot mark Paid before approval. Ended Active schedules auto-move to Pending Approval. |
| Lock (§18) | Paid schedule cannot be edited. Sales inside a paid period cannot be added or deleted. Unlock requires a reason (≥ 5 chars) and logs user, time, reason and previous/new status. After re-approval, the old snapshot is `Superseded` and the new one `Paid`. |
| Audit (§19) | Logs "Changed sales target from ₱100,000 to ₱120,000 (Staff A, September 2026)" and tier changes 5% → 6% with before/after values. |
| Duplicate month (§17) | Copies every schedule as Draft. A second run creates nothing. |
| Reports (§25–26) | Totals equal the sum of rows. A paid month's statement comes from the snapshot (18 sales, 5 tiers, ₱10,760). |
| Settings | Cannot remove your own Admin email. |
| GitHub Pages API (`Api.gs`) | JSON-P round trip encoded exactly like the browser. Visitor without a session → login. Owner sets own code via the sheet-menu helper and signs in. Admin calls work with the token. Staff token still FORBIDDEN from admin calls. `setupDemoData`, `setupDatabase`, `installDailyTrigger`, `calculateCommission_`, `constructor`, `toString`, `__proto__` all refused. Unsafe callback names refused. Malformed request → friendly error. Accented names and ₱ survive the round trip. |

## UI checks (local preview, desktop 1360 px and phone 375 px)

- GitHub Pages build (`dev/pages-preview.html`): the generated `index.html` signs in with
  email + access code and loads the dashboard, and recording a sale updates it. Every call
  goes through the real JSON-P transport and `doGet()`, with no `google.script.run`.

- Admin dashboard KPIs, sortable staff table (no ranking labels), month switcher.
- Sales: record a shared sale 60/40 with a live ₱3,000 / ₱2,000 preview. An empty client
  name shows "Client name is required."
- Monthly Schedules: Approve → Mark Paid → Unlock (reason required) through the
  confirmation dialogs, with toasts.
- Schedule editor: changing the month moves the dates. An overlapping tier shows a friendly
  error. Saving with a 5.5% tier works.
- Staff on a phone: access-code login, dashboard cards stack 2-up, statement prints
  cleanly, tables become cards, and short tables stay as tables.
- No console errors.

## Manual checks before going live (real Google deployment)

These depend on Google's real services and could not be exercised locally:

1. Run `setupDatabase()` and confirm the ten tabs, the currency format on money columns,
   and that `ClientContact` keeps leading zeros (e.g. `09171234567`).
2. Set your access code (ClickLounge → Set my access code). Open the GitHub Pages link and
   sign in as the owner → Admin dashboard.
3. On a phone (Safari) in a private tab, open the GitHub Pages link and sign in with a staff
   email + access code → staff menu only.
4. Record a sale dated today and check that the date in the Sales sheet is correct
   (timezone).
5. Approve and Mark Paid a test schedule, then **Unlock for Correction**, and check the
   AuditLog rows.
6. Reports → **Export CSV** downloads a file, and **Print** gives a clean page.
7. Run **ClickLounge → Run commission tests** from the sheet menu → all pass.
