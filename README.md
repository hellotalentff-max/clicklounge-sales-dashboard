# ClickLounge Sales Dashboard

A web app for **ClickLounge Studio** that manages the **Monthly Sales Target &
Commission Schedule** for contractual Sales & Marketing staff.

- **Frontend:** HTML, CSS, JavaScript (single-page app, works on phones and desktops)
- **Backend:** Google Apps Script (`doGet()` + permission-checked server functions)
- **Database:** a private Google Sheet
- **Hosting:** **GitHub Pages** (the pages, like the ClickLounge POS). The Apps Script web
  app is the API. The same Apps Script URL can also serve the app directly. No paid services.

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
GitHub Pages (index.html + config.js) ──JSON-P: fn + token──► Apps Script /exec (runs as owner)
                                                              └─► private Google Sheet
Apps Script URL opened directly ──────google.script.run──────► same server functions
```

- The GitHub Pages site talks to Apps Script the same way the POS does (JSON-P), which
  works on every browser, including Safari on iPhone and iPad.

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
**Easiest: paste the 3 bundled files from `dist/`.**
1. In the sheet: **Extensions → Apps Script**.
2. Replace everything in `Code.gs` with [dist/Code.gs](dist/Code.gs) and save.
3. **＋ → HTML**, name it `Index`, and paste in [dist/Index.html](dist/Index.html). Save.
4. **⚙ Project Settings → tick "Show appsscript.json manifest file in editor"**. Then
   replace `appsscript.json` with [dist/appsscript.json](dist/appsscript.json) and save.

`dist/` is generated from `src/` by `python3 tools/bundle.py`. Rebuild it after any code change.

**Alternative: one file per source file.**
1. In the sheet: **Extensions → Apps Script**.
2. Delete the default contents of `Code.gs`.
3. Create one file per item in `src/` with the **same name** and paste in its contents:
   - Script files (**+ → Script**): `Code`, `Api`, `Database`, `Config`, `Users`, `Schedules`,
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
   *Set up / repair database*, *Set my access code*, *Load demo data*,
   *Run commission tests*, *Install daily month-end check*.
5. **ClickLounge → Set my access code.** On GitHub Pages everyone, including you, signs in
   with email + access code. This sets yours.
6. Optional: **ClickLounge → Install daily month-end check** moves ended Active schedules
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

The code lives at `github.com/hellotalentff-max/clicklounge-sales-dashboard`. Use
**GitHub Desktop**: **File → Add Local Repository → clicklounge-sales-dashboard**, then
**Commit** and **Push origin** after each change.

What is in the repository:

| Path | What |
|---|---|
| `src/` | Source code (edit here) |
| `dist/` | Paste-ready Apps Script files (generated) |
| `index.html`, `config.js`, `.nojekyll` | The GitHub Pages site (`index.html` is generated; `config.js` holds the API URL) |
| `tools/bundle.py` | Regenerates `dist/` and `index.html` from `src/` |
| `dev/`, `docs/` | Local tests/preview and documentation |

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

Two parts: the **Apps Script web app** (the API + database access) and the **GitHub
Pages site** (what staff open).

### 6.1 Deploy the Apps Script web app
1. In the Apps Script editor: **Deploy → New deployment**.
2. **Select type** (⚙) → **Web app**.
3. Description: `v1.0.0`.
4. **Execute as: Me** (the owner's account). Required: this lets the app read the private
   sheet without sharing it.
5. **Who has access: Anyone.** Required for GitHub Pages (see below for why).
6. **Deploy** → copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).

To update later, open **Deploy → Manage deployments → ✎ Edit → Version: New version →
Deploy**. The URL stays the same, so `config.js` does not need to change.

### 6.2 Publish on GitHub Pages
1. Paste the Web app URL into [`config.js`](config.js):
   ```js
   window.CL_API_URL = 'https://script.google.com/macros/s/AKfy…/exec';
   ```
   Commit and push it (GitHub Desktop → Commit → Push origin).
2. Free GitHub accounts can only publish Pages from **public** repositories. On GitHub:
   **Settings → General → Danger Zone → Change visibility → Public**. Your POS repository
   works the same way. The code contains no passwords, pay or client data; all of that
   stays in the private Sheet.
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch:
   `main`, folder `/ (root)` → Save.**
4. After about a minute the site is live at
   **`https://hellotalentff-max.github.io/clicklounge-sales-dashboard/`**. That is the link
   for staff (Add to Home Screen on phones).

Workflow after a code change: edit `src/` → `python3 tools/bundle.py` → paste
`dist/Code.gs` into Apps Script and deploy a new version if the server changed → commit
and push (the Pages site updates itself).

### Who has access — security implications

| Option | Works with GitHub Pages? | Notes |
|---|---|---|
| **Anyone** | **Yes (required)** | The API URL answers any request, but every function except sign-in needs a valid session token, and every admin function checks the role. Sign-in needs email + access code; 5 wrong tries lock that email for 15 minutes. |
| Anyone with a Google account | No | Requests from github.io don't reliably carry the Google login (Safari blocks it), so calls fail. Use only if staff open the Apps Script URL directly instead of GitHub Pages. |
| Anyone within *your-domain.com* | No | Workspace only, with the same limitation. |
| Only myself | No | Testing only. |

Whichever you choose:
- **The spreadsheet stays private.** The app reads it with the owner's permission, and
  users only receive what their role allows.
- **Access codes are the key.** Give each person their own code privately, use at least
  8 characters for admins, and set departed staff to **Inactive**.
- **Sessions are per device.** The session is stored in the browser for 6 hours. Pages on
  `hellotalentff-max.github.io`, including your POS, share that browser storage, so only
  publish your own trusted code there.
- **Never choose "Execute as: User accessing the web app".** Every staff member would then
  need access to the sheet and could see everyone's pay.

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
email into **Config → AdminEmails** and creates the Users row). Then, in the spreadsheet,
use **ClickLounge → Set my access code**, open the GitHub Pages link, and sign in with
that email and code.

To add a second Admin: Staff → Add staff → Role **Admin**, and set an access code if they
use a personal Gmail account.

## 10. How staff login works
1. Admin adds the staff member on the **Staff** page (name, email, position, default base).
2. Admin clicks **Access code**, sets a code of at least 6 characters, and gives it to the
   staff member in person or by private message.
3. The staff member opens the GitHub Pages link and enters their **email + access code**.
4. The session lasts 6 hours on that device. They can change their code under
   **Change access code** in the menu.
5. Five wrong attempts lock that email for 15 minutes, and the lock is logged.
6. To remove access, set the staff member's **Status → Inactive**. Their history is kept.

**Test staff login:** add a staff member with a real email you control, set their access
code, then open the GitHub Pages link in a private window and sign in with it. You should
see only **My Dashboard, My Sales, My Monthly Schedule, My Commission, History**.

**Test Admin login:** sign in with the owner email and the code set from the spreadsheet
menu. You should see the full Admin menu (Dashboard … Settings).

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

## Time clock (required hours)

**Staff:** **Time Clock** (also shown at the top of My Dashboard) → **Clock in**, **Start
/ End break**, **Clock out**. An optional note can be added. Times are stamped by the server
in the studio timezone, so they can't be changed from the phone.

**Admin:** **Time** shows who is clocked in now, **hours worked vs required** per staff
member for the month, and every entry. **Add time entry** / **Edit** / **Delete** fix
mistakes (e.g. a forgotten clock-out). An out time earlier than the in time means the shift
ended the next day. Every correction is recorded in the Audit Log.

How it counts:
- **Required hours** = the **Expected hours** on each staff member's monthly schedule.
- **Worked hours** = clock-out − clock-in − breaks. **All worked hours count.**
- A shift belongs to the day it started. Open shifts count once clocked out.
- Hours appear on the Admin dashboard, the schedule page, the staff dashboard and the
  statement. For **hourly** base pay, the app uses Actual hours if typed on the schedule,
  otherwise the time-clock hours.
- Entries inside an **Approved/Paid** month are locked, like sales.
- Shifts open for more than 14 hours are flagged as a possible forgotten clock-out.

Data lives in the **TimeLogs** sheet, which is created automatically the first time the
updated app is opened (no need to re-run setup).

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

- <http://localhost:8765/dev/tests.html>: 86 automated tests (commission unit tests +
  end-to-end tests of security, validation, workflow, locking, history and the Pages API).
- <http://localhost:8765/dev/pages-preview.html>: the **GitHub Pages build** (`index.html`)
  with demo data, going through the real JSON-P API. Sign in as `owner@clicklounge.test` /
  `owner-2026` (Admin) or `staff.a@example.com` / `alpha-2026` (Staff).
- <http://localhost:8765/dev/preview.html>: the Apps Script-hosted version, already signed
  in as Admin (`?as=none` shows the access-code login).

In Apps Script itself, run `runCommissionTests` (or **ClickLounge → Run commission
tests**). It uses no sheet data and is safe on the live database.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "The database is not set up yet" | Run `setupDatabase()` from the Apps Script editor. |
| "This page is not connected to the server yet" | `config.js` has no URL. Paste the Apps Script `/exec` URL and push. |
| "Could not reach the server" on GitHub Pages | Check the Apps Script deployment's **Who has access** is **Anyone**, and that `config.js` holds the `/exec` URL (not `/dev`). |
| Owner sees the login screen on GitHub Pages | Expected. Use ClickLounge → Set my access code in the sheet, then sign in. |
| Staff must sign in again | Sessions last 6 hours per device. |
| Server changes don't appear | Paste the new `dist/Code.gs`, then create a new deployment **version** (Deploy → Manage deployments → Edit → New version). |
| Page changes don't appear | Run `python3 tools/bundle.py`, commit and push; GitHub Pages updates within a minute or two. |
| "This schedule is Paid and locked" | Intended behaviour. Use **Unlock for Correction** with a reason. |
| Dates look a day off | Make Config → Timezone, the spreadsheet timezone and `appsscript.json` all `Asia/Manila`. |
