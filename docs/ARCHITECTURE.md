# ClickLounge Sales Dashboard — Design

This document covers Steps 1–4 of the brief: architecture, file structure, database
schema, user flows, commission logic, security and UI wireframes. Setup and deployment
are in the [README](../README.md); test results are in [TESTING.md](TESTING.md).

---

## 1. System architecture

```
 Phone / laptop browser
 ┌──────────────────────────────────────────────┐
 │ Index.html + CSS.html + JS.html               │  Single-page app (hash routes)
 │  - renders data only, no money maths           │
 │  - google.script.run.fn(token, ...)            │
 └───────────────────────┬──────────────────────┘
                         │ HTTPS (Google-hosted)
 ┌───────────────────────▼──────────────────────┐
 │ Google Apps Script web app (runs as OWNER)    │
 │  Code.gs      doGet, bootstrap, dashboards     │
 │  Users.gs     sessions, roles, access codes    │
 │  Schedules.gs monthly schedules + workflow     │
 │  Sales.gs     sales + shared-sale attribution  │
 │  Commission.gs  ONE calculation engine         │
 │  Reports.gs / Audit.gs / Config.gs / Setup.gs  │
 │  Database.gs  typed sheet access + LockService │
 └───────────────────────┬──────────────────────┘
                         │ SpreadsheetApp (owner's permission)
 ┌───────────────────────▼──────────────────────┐
 │ Google Sheet (private — never shared)          │
 │  Config · Users · MonthlySchedules ·           │
 │  CommissionTiers · BonusTiers · Packages ·     │
 │  Sales · SharedSales · CommissionCalculations ·│
 │  AuditLog                                      │
 └──────────────────────────────────────────────┘
```

Key decisions

| Decision | Why |
|---|---|
| Web app **executes as the owner** | Staff never get access to the spreadsheet; every read/write goes through permission-checked server functions. |
| **Every client-callable function takes a session token first** and calls `requireUser_` / `requireAdmin_` | Hiding buttons is not security; a staff member calling `listUsers()` from the browser console gets `FORBIDDEN`. |
| Private helpers end in `_` | Apps Script does not let `google.script.run` call them, so e.g. `calculateCommission_` cannot be invoked without the permission wrapper `getCommission`. |
| **Each schedule owns its tier rows** (`CommissionTiers.ScheduleID`) | Changing October's tiers physically cannot touch September's rows. |
| **Approved/Paid snapshot** in `CommissionCalculations.SnapshotJSON` | Finalized months are read from the snapshot, never recalculated, even if global rules change later. |
| Dates stored as ISO text on the wire | No timezone drift between browser, script and sheet. |
| `LockService` around every write | Two admins saving at once cannot interleave rows. |

---

## 2. File structure

```
clicklounge-sales-dashboard/
├── README.md                 Setup, deployment, operations
├── package.json              Optional clasp scripts (push / deploy)
├── .clasp.json.example       Copy to .clasp.json with your Script ID
├── docs/
│   ├── ARCHITECTURE.md       This file
│   └── TESTING.md            Test plan + results (Step 7)
├── src/                      ← the Apps Script project (clasp rootDir)
│   ├── appsscript.json       Manifest: V8, Asia/Manila, web app settings, scopes
│   ├── Code.gs               doGet, include_, bootstrap, dashboards, onOpen menu, trigger
│   ├── Database.gs           SHEET names, SCHEMA, typed read/write, withLock_
│   ├── Config.gs             Config sheet, admin emails, commission rules, settings
│   ├── Users.gs              Sessions, login/access codes, role checks, staff CRUD
│   ├── Schedules.gs          Schedules, tiers, duplication, status workflow, lock
│   ├── Sales.gs              Sales CRUD, attribution, shared sales, period locks
│   ├── Packages.gs           Package CRUD (disable, never delete)
│   ├── Commission.gs         calculateCommission_ + pure calculation functions
│   ├── Reports.gs            Reports + printable statements
│   ├── Audit.gs              Audit log writer + viewer
│   ├── Setup.gs              setupDatabase(), setupDemoData(), sample data
│   ├── Tests.gs              runCommissionTests() (safe on live data)
│   ├── Index.html            Page skeleton (includes CSS + JS)
│   ├── CSS.html              Styles (responsive, print)
│   └── JS.html               Frontend app
└── dev/                      Local testing only — not deployed
    ├── appsscript-mock.js    In-memory SpreadsheetApp, CacheService, Session, ...
    ├── tests.html            Runs Tests.gs + e2e-tests.js in a browser
    ├── e2e-tests.js          End-to-end tests of the real server code
    ├── server.html           Hosts the real .gs code for the preview
    └── preview.html          Full local preview of the app with demo data
```

Additional files beyond the brief's list (`Config.gs`, `Packages.gs`, `Reports.gs`,
`Setup.gs`, `Tests.gs`) keep each concern small; Apps Script loads all `.gs` files into
one global scope, so the split is organisational only.

---

## 3. Google Sheets schema

All sheets are created by `setupDatabase()`. Row 1 is the header row (frozen, black).
Columns marked ➕ are additions to the brief's list; they are appended **after** the
specified columns so the specified order is preserved.

### Config
| Key | Example value | Purpose |
|---|---|---|
| AdminEmails | `owner@gmail.com, manager@gmail.com` | Admin access (never hard-coded) |
| StudioName | ClickLounge Studio | |
| Currency / CurrencySymbol | PHP / ₱ | |
| DefaultCommissionableStatus | PAID_ONLY | PAID_ONLY · CONFIRMED · COMPLETED · ALL |
| Timezone | Asia/Manila | Also applied to the spreadsheet |
| AppVersion | 1.0.0 | |
| Commissionable_Cancelled / _Refunded / _Unpaid / _Complimentary / _Discounted | FALSE/FALSE/FALSE/FALSE/TRUE | Per-status rules |
| SharedPackageCredit | FRACTIONAL | FRACTIONAL (60% → 0.6 pkg) or FULL |
| Template* | 100000, 20, 8000, 90, TIERED_WHOLE, HIGHEST | Defaults for new schedules |

### Users
`UserID · Name · Email · Role · Position · Status · BaseCompensationDefault · CreatedDate` ·
➕`AccessCodeHash · AccessCodeSalt · UpdatedAt`

Role is kept in sync with Config → AdminEmails, which is authoritative.
Access codes are stored as salted, iterated SHA-256 hashes.

### MonthlySchedules
`ScheduleID · Month (yyyy-MM, text) · StartDate · EndDate · DateIssued · StaffID · Position ·
PackageTarget · SalesTarget · AdditionalTarget · BaseCompensation · ExpectedHours ·
CommissionStructure · BonusStructure · Status · Notes · CreatedAt · UpdatedAt` ·
➕`BaseType (FIXED|HOURLY) · ActualHours · HourlyRate · SpecialIncentives · DuplicatedFrom`

- `CommissionStructure`: `TIERED_WHOLE` (default — the reached tier's rate applies to all
  sales) or `TIERED_PROGRESSIVE` (bracket style).
- `BonusStructure`: `HIGHEST` (default) or `CUMULATIVE`.
- `Status`: Draft · Active · Pending Approval · Approved · Paid.

### CommissionTiers
`TierID · ScheduleID · MinSales · MaxSales (blank = no max) · Rate · CommissionType (PERCENT|FIXED)`

For FIXED tiers, `Rate` holds the fixed peso amount. `ScheduleID = TEMPLATE` rows are the
default template used to pre-fill new schedules.

### BonusTiers
`BonusID · ScheduleID · MinPackages · BonusAmount · BonusType (FIXED)`

### Packages
`PackageID · PackageName · Price · Active · CreatedAt` · ➕`Description · UpdatedAt`

### Sales
`SaleID · SaleDate · ClientName · ClientContact · StaffID · PackageID · PackageName ·
GrossPrice · Discount · FinalPaidAmount · PaymentStatus · BookingStatus · Commissionable ·
SharedSale · Notes · CreatedAt` · ➕`UpdatedAt · CreatedBy`

- `PackageName`/`GrossPrice` are copied at the time of sale, so later price changes do not
  rewrite history.
- `Commissionable` stores the per-sale override: `AUTO` (follow rules), `YES`, `NO`.
  The effective yes/no is evaluated at calculation time so rule changes apply to open months.
- For shared sales `StaffID` holds the first staff member; the split lives in SharedSales.
- PaymentStatus: Paid · Partially Paid · Unpaid · Refunded · Complimentary.
  BookingStatus: Pending · Confirmed · Completed · Cancelled.

### SharedSales
`SharedSaleID · SaleID · StaffID · Percentage · CreditedAmount`

### CommissionCalculations (approval snapshots)
`CalculationID · ScheduleID · StaffID · TotalSales · PackageCount · SalesTarget ·
PackageTarget · SalesProgress · PackageProgress · CommissionRate · CommissionAmount ·
BonusAmount · BaseCompensation · TotalEstimatedCompensation · Status · CalculatedAt` ·
➕`SnapshotJSON · ApprovedBy · ApprovedAt · PaidBy · PaidAt`

`Status`: Approved → Paid, or Superseded after “Unlock for Correction”. `SnapshotJSON`
contains the full result, the schedule, its tiers and bonus tiers, the commissionable
rules and every credited sale — enough to reprint the statement exactly.

### AuditLog
`LogID · User · Action · RecordID · PreviousValue · NewValue · Reason · Timestamp`

Example actions:
- `Changed sales target from ₱100,000 to ₱120,000 (Staff A, September 2026)`
- `Changed commission tiers (Staff A, September 2026)` — previous/new tier lists
- `Approved commission (Staff B, August 2026): sales ₱118,000, commission ₱5,900, …`
- `Marked commission as Paid (…)` · `Unlocked for correction (…)` with the reason

---

## 4. User flows

### Sign-in flow
```
open web app ─► bootstrap(storedToken)
                 ├─ token valid ───────────────► app (role from AdminEmails)
                 ├─ Google email known & registered ─► new token ─► app
                 ├─ Google email in AdminEmails, no Users row ─► auto-create Admin ─► app
                 └─ otherwise ─► login screen: email + access code ─► login() ─► token ─► app
```

### Admin monthly cycle
```
Staff page: add staff (+ access code)
      │
Monthly Schedules: "Duplicate previous month"  (or New schedule from template)
      │   edit dates / targets / tiers / bonuses / incentives   → Draft
      ▼
Activate ─► Active (staff can see it)
      │   Sales page: record each sale, attributed to one staff or shared by %
      ▼
Month ends ─► Pending Approval (automatic on dashboard load / daily trigger, or "Close month")
      │   review sales, fix mistakes
      ▼
Approve ─► snapshot saved ─► Approved (locked)
      ▼
Mark Paid ─► Paid (locked, historical record)
      │
      └─ mistake found? "Unlock for Correction" + reason ─► Pending Approval
         (old snapshot kept as Superseded; audit log records who/when/why)
```

### Staff flow
```
sign in ─► My Dashboard (current month: target, sales, progress, packages,
           commission, bonus, base, estimated total, next milestones)
        ├─ My Sales            own credited sales only (own share of shared sales)
        ├─ My Monthly Schedule targets + this month's tiers and bonuses
        ├─ My Commission       printable statement
        └─ History             previous months (final figures once approved)
```

---

## 5. Commission calculation logic

All maths lives in `src/Commission.gs`. The authoritative entry point is
`calculateCommission_(scheduleId, staffId)`:

```
if schedule.Status is Approved or Paid and a snapshot exists:
    return snapshot                       ← historical months never recalculate
schedule   = that month's row
tiers      = CommissionTiers where ScheduleID = schedule   (its own copy)
bonusTiers = BonusTiers      where ScheduleID = schedule
credited   = for each sale dated StartDate..EndDate:
               single sale credited to this staff → 100% of FinalPaidAmount
               shared sale with this staff        → Percentage% of FinalPaidAmount
               packageCredit = 1 (or share% if SharedPackageCredit = FRACTIONAL)
               commissionable = isSaleCommissionable_(sale, rules)
sales      = Σ credited amount of commissionable sales
packages   = Σ package credit of commissionable sales

commission:
  TIERED_WHOLE        tier = highest tier with MinSales ≤ sales < MaxSales+1
                      PERCENT → sales × rate%   |  FIXED → amount
  TIERED_PROGRESSIVE  Σ over reached tiers of (portion of sales inside tier × rate%)
bonus:
  HIGHEST             amount of the highest tier with MinPackages ≤ packages
  CUMULATIVE          Σ of all reached tiers
base:     FIXED → BaseCompensation  |  HOURLY → HourlyRate × (ActualHours or ExpectedHours)
effective hourly rate = base ÷ ExpectedHours
progress  = sales ÷ target × 100 ;  remaining = max(0, target − sales)
above     = max(0, sales − target) → "Target exceeded"
total     = base + commission + bonus
```

Commissionable rules (`isSaleCommissionable_`):
1. Per-sale override `YES`/`NO` wins.
2. Status rules: a sale whose status (Cancelled, Refunded, Unpaid, Complimentary, or with a
   discount) is switched **off** is excluded; a status switched **on** is included even if
   it does not match the basis.
3. Otherwise the basis applies: Paid only (default) · Confirmed/Completed · Completed · All.

Tier maximums are inclusive to the peso: `₱70,000–₱99,999` covers ₱99,999.99, and
₱100,000 moves to the next tier. Overlapping tiers are rejected when saving.

---

## 6. Security approach

| Threat | Control |
|---|---|
| Staff reads another staff member's data | `requireSelfOrAdmin_` on every schedule/statement/commission call; `listSales` ignores the staff filter for non-admins and returns only the caller's credited sales. |
| Staff calls admin functions from the console | Every write and every admin read calls `requireAdmin_` server-side. |
| Direct spreadsheet access | Sheet is never shared; the web app runs as the owner. |
| Bypassing permission wrappers | Business logic lives in `_`-suffixed functions that `google.script.run` cannot call. |
| Owner-only maintenance (`setupDatabase`, `setupDemoData`, triggers) called by visitors | `assertOwnerContext_()` refuses unless the caller is the owner or an Admin with a visible Google identity. |
| Password guessing | Access codes ≥ 6 chars, salted + iterated SHA-256, 5 failed attempts → 15-minute lock (logged). |
| Session theft / expiry | Random 64-hex-char tokens in CacheService, 6-hour lifetime, removed on sign-out. |
| Admin lock-out | You cannot remove your own admin email, deactivate yourself, or leave zero admins. |
| Concurrent edits | `LockService` script lock around every write; data re-read after acquiring it. |
| Formula injection into the sheet | Text starting with `=`, `+`, `@` is stored as literal text. CSV export neutralises formulas too. |
| XSS | All user text is HTML-escaped (`esc()`) before rendering. |
| Tampering with finalized months | Approved/Paid schedules and any sale inside their period are locked; unlocking requires a reason and is audited. |

---

## 7. UI wireframes

### Admin dashboard (desktop)
```
┌──────────────┬───────────────────────────────────────────────────────────────┐
│ ClickLounge  │ DASHBOARD                               [September 2026 ▾] [+ Record sale] │
│ ──────────── │ September 2026                                                  │
│ ▣ Dashboard  │ ┌ Studio sales ┐┌ Combined target ┐┌ Packages ┐┌ Commission ┐ │
│ ▤ Sales      │ │ ₱116,700      ││ ₱200,000 ▓▓▓░░  ││ 23        ││ ₱2,175     │ │
│ ☺ Staff      │ └──────────────┘└─────────────────┘└──────────┘└────────────┘ │
│ ▦ Schedules  │ ┌ Bonus ┐┌ Base ┐┌■■■■■■ TOTAL COMPENSATION ₱18,175 ■■■■■■■■■┐ │
│ % Rules      │ └───────┘└──────┘└──────────────────────────────────────────┘ │
│ ▢ Packages   │ Staff performance                                              │
│ ▥ Reports    │ STAFF▲  SALES   TARGET  PROGRESS  PKGS  COMM.  BONUS TOTAL STATUS │
│ ⛨ Audit Log  │ Staff A ₱72,500 ₱100,000 72.5%▓▓░ 15/20 ₱2,175 ₱0 ₱10,175 Active │
│ ⚙ Settings   │ Staff B ₱44,200 ₱100,000 44.2%▓░░  8/20     ₱0 ₱0  ₱8,000 Active │
│ owner·ADMIN  │ (sortable by any column; no ranking labels)                    │
└──────────────┴───────────────────────────────────────────────────────────────┘
```

### Staff dashboard (phone)
```
┌─────────────────────────┐
│ ☰  ClickLounge          │
│ SEPTEMBER 2026          │
│ Hi, Staff A             │
│ [September 2026 ▾]      │
│ ⚠ Estimated amounts…    │
│ ┌──────────┐┌─────────┐ │
│ │MY TARGET ││MY SALES │ │
│ │₱100,000  ││₱72,500  │ │
│ └──────────┘└─────────┘ │
│ ┌──────────┐┌─────────┐ │
│ │PROGRESS  ││REMAINING│ │
│ │72.5% ▓▓░ ││₱27,500  │ │
│ └──────────┘└─────────┘ │
│ ┌──────────┐┌─────────┐ │
│ │PACKAGES  ││COMMISSN │ │
│ │15 / 20   ││₱2,175   │ │
│ └──────────┘└─────────┘ │
│ ┌──────────┐┌─────────┐ │
│ │BONUS ₱0  ││BASE     │ │
│ └──────────┘│₱8,000   │ │
│ ┌■■■■■■■■■■■■■■■■■■■■┐ │
│ │ESTIMATED TOTAL      │ │
│ │₱10,175              │ │
│ └■■■■■■■■■■■■■■■■■■■■┘ │
│ → ₱27,500 more for 5%   │
│ → 5 more pkgs for ₱1,000│
└─────────────────────────┘
```

### Schedule editor
```
Basic information   [Staff ▾] [Position] [Month ▾] [Start] [End] [Issued] [Start as ▾]
Sales target        [Package target] [Gross sales target] [Additional target] [Incentives]
Base compensation   [Fixed/Hourly ▾] [Base] [Expected h] [Actual h] [Hourly rate] (Effective ₱/h)
Commission tiers    [How tiers apply ▾]
                    [Min] [Max] [Percent/Fixed ▾] [Rate]  🗑   … [+ Add tier]
Bonus tiers         [Highest only / Cumulative ▾]
                    [Packages ≥] [Bonus amount]  🗑        … [+ Add bonus tier]
Notes               [ … ]   ☐ Allow a second schedule this month
                                                   [Cancel] [Save schedule]
```

On phones every data table turns into stacked cards (label left, value right), and short
two-column tables (tiers, statement summary) stay as tables.

---

## 8. Deployment process (summary)

1. Create the Google Sheet → Extensions → Apps Script.
2. Add the files from `src/` (or `clasp push`).
3. Run `setupDatabase()` → authorize → you become the first Admin.
4. Optional: `setupDemoData()`.
5. Deploy → New deployment → Web app → Execute as **Me** → Who has access (see README).
6. Add staff, set access codes, create schedules.

Full step-by-step instructions, including the security implications of each access
option, are in the README.
