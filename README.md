# ClickLounge Sales Dashboard

A web app for **ClickLounge Studio** that manages the **Monthly Sales Target &
Commission Schedule** for contractual Sales & Marketing staff.

- **Frontend:** HTML, CSS, JavaScript (single-page app, works on phones and desktops)
- **Backend:** Google Apps Script (`doGet()` + server functions via `google.script.run`)
- **Database:** a private Google Sheet
- **Hosting:** Google Apps Script web app — no paid services

Design details (architecture, schema, flows, wireframes, security) are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Test cases and results are in
[docs/TESTING.md](docs/TESTING.md).

---

## 1. What the app does

**Admin (studio owner / manager)**
- Creates a Monthly Sales Target & Commission Schedule per staff member per month:
  dates, package and sales targets, additional targets, special incentives, base
  compensation, expected/actual hours, commission tiers and bonus tiers.
- Duplicates a previous month (one schedule, or the whole month) and adjusts it.
- Records sales and attributes each one to a staff member, or shares it by percentage
  (e.g. 60% / 40%).
- Configures packages, commission tiers (percentage or fixed), bonus tiers (highest-only
  or cumulative) and which sales count as commissionable.
- Watches progress on a dashboard, approves commissions, marks them paid, prints
  statements, exports CSV reports and reviews the audit log.

**Staff**
- Sign in and see only their own target, sales, progress, packages, commission, bonus,
  base, estimated total, monthly schedule, statements and history.
- Cannot change targets, rates or sales, and cannot see other staff members' data —
  enforced on the server, not just by hiding buttons.

**Records stay accurate over time.** Each month owns its own copy of the rules. When a
month is approved, its figures, rules and sales are saved as a snapshot; Approved and
Paid months are locked and never recalculated with newer rules.

Nothing business-specific is hard-coded. The sample tiers (0% / 3% / 5% / 6% / 7%),
bonuses (₱1,000 … ₱7,000), ₱8,000 base, 90 hours and packages are only starting data.

---

## 2. Architecture

```
Browser (Index/CSS/JS.html) ──google.script.run(token, …)──► Apps Script (runs as owner)
                                                            └─► private Google Sheet
```

- Every client-callable server function checks the session and role first.
- All money maths is in one place: `calculateCommission_()` in `src/Commission.gs`.
- Writes are serialised with `LockService`.
- Important actions are written to the `AuditLog` sheet.

---

## 3. Google Sheets database

`setupDatabase()` creates these sheets (headers, frozen header row, currency/date
formats). Running it again never overwrites existing data; it only adds missing sheets,
columns and default settings.

| Sheet | Holds |
|---|---|
| Config | Admin emails, studio name, currency, timezone, commissionable rules, template defaults |
| Users | Staff and admins, default base pay, hashed access codes |
| MonthlySchedules | One row per staff member per month |
| CommissionTiers | Tier rows for each schedule (plus `TEMPLATE` defaults) |
| BonusTiers | Bonus rows for each schedule (plus `TEMPLATE` defaults) |
| Packages | Package names and prices (disabled, never deleted) |
| Sales | Every sale, with its attribution and statuses |
| SharedSales | Percentage splits for shared sales |
| CommissionCalculations | Approved/Paid snapshots (historical records) |
| AuditLog | Who did what, when, before/after values, reasons |

The full column-by-column schema is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#3-google-sheets-schema).

> Edit data in the app, not directly in the sheet. Direct edits skip validation and
> the audit log. The sheet is the source of truth and your backup.

---

## 4. Google Apps Script setup

### 4.1 Create the spreadsheet
1. Go to [sheets.google.com](https://sheets.google.com) with the studio's Google account.
   That account becomes the **owner** and the first Admin.
2. Create a blank spreadsheet and name it, for example, **ClickLounge Sales Database**.
3. **Do not share it.** Staff never need access to the sheet.

### 4.2 Open Apps Script and add the files
1. In the sheet: **Extensions → Apps Script**.
2. Delete the default contents of `Code.gs`.
3. Create one file per item in `src/` with the **same name** and paste in its contents:
   - Script files (**+ → Script**): `Code`, `Database`, `Config`, `Users`, `Schedules`,
     `Sales`, `Packages`, `Commission`, `Reports`, `Audit`, `Setup`, `Tests`, `Utils`
     (Apps Script adds `.gs` itself).
   - HTML files (**+ → HTML**): `Index`, `CSS`, `JS`.
4. Show the manifest: **Project Settings (⚙) → tick "Show appsscript.json manifest file
   in editor"**. Replace its contents with `src/appsscript.json`.
5. Save (⌘S / Ctrl+S).

Or use `clasp` instead of copy-pasting — see [section 5](#5-github-setup).

### 4.3 Run `setupDatabase()`
1. In the editor, pick **`setupDatabase`** in the function dropdown and click **Run**.
2. Approve the permissions prompt (you may need **Advanced → Go to project (unsafe)**,
   because this is your own unverified script). It asks for:
   - *See, edit, create and delete your spreadsheets*: the database.
   - *See your primary email address*: to recognise who opens the app.
   - *Manage triggers*: the optional daily month-end check.
   - *Display content in Google apps*: the **ClickLounge** menu in the sheet.
3. When it finishes, the sheet has all ten tabs, sample packages, sample tiers, and your
   email in **Config → AdminEmails**.
4. Reload the spreadsheet. A **ClickLounge** menu appears with:
   *Set up / repair database*, *Load demo data*, *Run commission tests*,
   *Install daily month-end check*.
5. Optional: **ClickLounge → Install daily month-end check** moves ended Active schedules
   to Pending Approval every night. The dashboard also does this when an Admin opens it.

### 4.4 Demo data (optional)
**ClickLounge → Load demo data** (or run `setupDemoData`) adds:
- **Staff A** and **Staff B** (`staff.a@example.com`, `staff.b@example.com`), base ₱8,000, 90 h.
- **Last month, Paid:** Staff A ₱92,000 / 18 packages → ₱2,760 commission, ₱10,760 total.
  Staff B ₱118,000 / 23 packages → ₱5,900 + ₱1,000 bonus, ₱14,900 total.
- **This month, Active:** Staff A ₱72,500 / 15 packages → ₱2,175 (estimate ₱10,175);
  Staff B ₱44,200 / 8 packages; plus an unpaid 60/40 shared sale and a cancelled sale.
  These two are not counted, which shows the commissionable rules at work.

Delete or deactivate the demo staff before going live (Staff page → Status: Inactive).

---

## 5. GitHub setup

```bash
cd clicklounge-sales-dashboard
git add .
git commit -m "ClickLounge Sales Dashboard v1.0.0"
```

```bash
gh repo create clicklounge-sales-dashboard --private --source=. --push
```

Keep the repository **private**. It contains no passwords or data, but there is no reason
to publish studio internals.

### Syncing code with `clasp` (optional, recommended)
```bash
npm install
```
```bash
npx clasp login
```
1. Enable the Apps Script API at <https://script.google.com/home/usersettings>.
2. In the Apps Script editor: **Project Settings → Script ID**, copy it.
3. `cp .clasp.json.example .clasp.json`, then paste the Script ID into it. `.clasp.json`
   is git-ignored.
4. Push the code from `src/`:
```bash
npx clasp push
```
Workflow: edit locally → commit to GitHub → `clasp push` → create a new deployment
version (section 6).

---

## 6. Deployment

1. In the Apps Script editor: **Deploy → New deployment**.
2. **Select type** (⚙) → **Web app**.
3. Description: `v1.0.0`.
4. **Execute as: Me** (the owner's account). Required: this lets the app read the private
   sheet without sharing it.
5. **Who has access:** pick one (details below). For most studios using personal Gmail
   accounts: **Anyone with a Google account**.
6. **Deploy** → copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`)
   and share it with staff. Bookmark it or use *Add to Home Screen* on phones.

To update later, open **Deploy → Manage deployments → ✎ Edit → Version: New version →
Deploy**. The URL stays the same.

### Who has access — security implications

| Option | Who can open the URL | How users are identified | Recommendation |
|---|---|---|---|
| **Only myself** | Owner only | Google account | Testing only. |
| **Anyone within *your-domain.com*** (Google Workspace) | Signed-in users of your Workspace domain | Automatically by Google email — no access codes needed | **Best** if everyone has a studio Workspace account. |
| **Anyone with a Google account** | Anyone signed in to any Google account | Owner: automatically. Everyone else: email + **access code** (Google does not reveal personal Gmail addresses to a web app running as its owner) | **Recommended for personal Gmail accounts.** Google sign-in is required before the page loads, which adds a layer before the access code. |
| **Anyone** | Anyone with the link, no Google sign-in | Email + access code only | Avoid. It works, but the access code is the only barrier. |

Whichever you choose:
- The spreadsheet stays private. The app reads it with the owner's permission, and users
  only receive what their role allows.
- Every server function checks the user's role, so even a staff member who opens the
  browser console cannot read other staff data or change rules.
- **Never choose "Execute as: User accessing the web app".** Every staff member would then
  need edit access to the sheet, and could open it and see everyone's pay.

---

## 7. How to create the spreadsheet
See [4.1](#41-create-the-spreadsheet). In short: create a blank Google Sheet with the owner
account, open **Extensions → Apps Script**, add the files, run `setupDatabase()`.
Sheets are created automatically.

## 8. How to configure Admin emails
- In the app: **Settings → Admin emails** (comma-separated), or
- In the sheet: **Config → AdminEmails** value, e.g. `owner@gmail.com, manager@gmail.com`.

Anyone on that list has full Admin access. Setting someone's **Role** to Admin on the Staff
page adds them to the list automatically. You cannot remove your own email, so the studio
cannot lock itself out.

## 9. How to create the first Admin
Running `setupDatabase()` makes the account that runs it the first Admin (it writes that
email into **Config → AdminEmails** and creates the Users row). Open the web app URL with
that same Google account and the Admin dashboard loads.

To add a second Admin: Staff → Add staff → Role **Admin**, and set an access code if they
use a personal Gmail account.

## 10. How staff login works
1. Admin adds the staff member on the **Staff** page (name, email, position, default base).
2. Admin clicks **Access code**, sets a code of at least 6 characters, and gives it to the
   staff member in person or by private message.
3. The staff member opens the web app URL, signs in to Google if asked, then enters their
   **email + access code**. Workspace users on the same domain skip this step.
4. The session lasts 6 hours on that device. They can change their code under
   **Change access code** in the menu.
5. Five wrong attempts lock that email for 15 minutes, and the lock is logged.
6. To remove access, set the staff member's **Status → Inactive**. Their history is kept.

**Test staff login:** use the demo, or add yourself a second test account. Open the URL in a
private window, sign in to Google with the test account, and enter its email + access code.
You should see only **My Dashboard, My Sales, My Monthly Schedule, My Commission, History**.

**Test Admin login:** open the URL with the owner account. You should see the full Admin
menu (Dashboard … Settings) without entering a code.

## 11. How to create monthly schedules
1. **Monthly Schedules → New schedule**. The form is pre-filled from **Commission Rules →
   Default template**.
2. Choose the staff member and month. Dates default to the whole month and can be edited.
3. Set targets, additional target, special incentives, base compensation, and hours
   (the effective hourly rate is shown).
4. Edit the commission tiers (add, delete, min, max, percentage or fixed) and bonus tiers
   (package count, amount, highest-only or cumulative).
5. Save. The schedule is a **Draft**, which staff cannot see yet. Click **Activate** to publish it.

Rules enforced: no overlapping tiers, rates 0–100%, whole package counts ≥ 1, no
duplicate package counts, and no negative numbers. Only one schedule per staff member
per month, unless you tick *Allow a second schedule*, and dates may never overlap.

## 12. How commission calculation works
For each schedule, the server:
1. Collects sales dated within the schedule's start and end dates that are credited to
   the staff member (100% for single sales, their percentage of shared sales).
2. Keeps only **commissionable** sales (default: **Paid sales only**; configurable on
   **Commission Rules**, per status, and per sale).
3. Picks the tier the sales total falls into. By default that tier's rate applies to all
   sales: ₱120,000 in the 5% tier = ₱6,000.
4. Picks the bonus by packages sold (default: highest applicable only; 30 packages →
   ₱3,000, not 1,000 + 2,000 + 3,000).
5. Adds base compensation: **Total = Base + Commission + Bonus**.
   Example: ₱120,000 sales, 22 packages, ₱8,000 base → ₱6,000 + ₱1,000 + ₱8,000 = **₱15,000**.

Until a month is approved, all amounts are labelled **Estimated**. On **Approve**, the
result is stored as a snapshot. From then on that month always shows the snapshot.

## 13. How to create a new month
1. **Monthly Schedules → Duplicate previous month**. Pick *Copy from* (e.g. September) and
   *Into* (e.g. October).
2. Every staff member who had a schedule gets a **Draft** copy with the same targets,
   tiers, bonuses, base and incentives. Dates are set to the new month.
3. Open each Draft, change what is different this month (targets, rates, bonuses,
   incentives), save, then **Activate**.
4. At month end: check sales → **Approve** → pay staff → **Mark Paid**.
5. If you find a mistake later: **Unlock for Correction**, enter a reason, fix it, and
   approve again. The previous snapshot is kept as *Superseded*, and the audit log records
   who unlocked it, when, and why.

## 14. How to back up the database
- **Monthly (recommended, after marking Paid):** in the sheet, **File → Make a copy** →
  name it `ClickLounge Sales Backup YYYY-MM`. Keep the copy private.
- **Offline copy:** **File → Download → Microsoft Excel (.xlsx)**.
- **Undo mistakes:** **File → Version history → See version history** restores earlier
  versions.
- **Code:** GitHub holds the code. The sheet holds the data. Back up both.

To restore: make a copy of the backup, open **Extensions → Apps Script** in the copy (the
script is copied too), run `setupDatabase()` once, and deploy a new web app from it.

---

## Local testing (developers)

The `dev/` folder runs the **real** server code against an in-memory mock of the Google
services, so you can test without deploying:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

- <http://localhost:8765/dev/tests.html>: 78 automated tests (commission unit tests +
  end-to-end tests of security, validation, workflow, locking and history).
- <http://localhost:8765/dev/preview.html>: the full app with demo data, signed in as Admin.
- <http://localhost:8765/dev/preview.html?as=none>: the access-code login screen. Try
  `staff.a@example.com` / `alpha-2026`.

In Apps Script itself, run `runCommissionTests` (or **ClickLounge → Run commission
tests**). It uses no sheet data and is safe on the live database.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "The database is not set up yet" | Run `setupDatabase()` from the Apps Script editor. |
| Staff sees "Please sign in" every time | Normal for personal Gmail accounts. They use email + access code. Sessions last 6 hours. |
| Admin sees the login screen | The Google account you are signed in with is not in Config → AdminEmails, or the browser is using a different Google account. Try a private window. |
| Changes to the code don't appear | Create a new deployment **version** (Deploy → Manage deployments → Edit → New version). |
| "This schedule is Paid and locked" | Intended behaviour. Use **Unlock for Correction** with a reason. |
| Dates look a day off | Make Config → Timezone, the spreadsheet timezone and `appsscript.json` all `Asia/Manila`. |
