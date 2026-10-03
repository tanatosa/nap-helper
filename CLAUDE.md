# NAP Helper

Electron app (Windows) wrapping the Bulgarian NRA portal (portal.nra.bg) for a private person's annual tax
declaration (Декларация по чл. 50 от ЗДДФЛ). Focus: that declaration, imports from investment intermediaries
(IBKR, Revolut, eToro, Iuvo) and managing the declarations (login, download filed ones, load the portal's draft, parse,
display, archive locally). UI text is Bulgarian. App icon: `build/icon.svg` (source), `build/icon.ico` (installer),
`ui/icon.png` (window).
See `README.md` for the user-facing overview.

## Hard rules

- **Never submit anything to the portal**, including while testing. The app has no submit code path; do not add
  one. `Portal.fillForm` only sets field values. Only GET requests to view/download endpoints are allowed from
  app code.
- Keep the read-only guard (`isWriteRequest` in `src/portal.js`) on by default.
- Never submit the login form with made-up credentials (account lockout risk). Probing the live login page
  without submitting is fine.
- `samples/` (git-ignored) and the archive contain the user's real personal and tax data. Tracked files must
  hold synthetic data only: `test/fixtures/` is the real form layout with every value replaced. When a new
  year's layout needs a fixture, anonymise it the same way and check that no original value survives. Don't copy it into docs, commit
  messages, or external services; delete scratch copies after tests.
- The password must stay in the main process and the portal preload. Never expose it to `ui/`.

## Commands

- `npm test` — parser, listing, guard and statement-import tests against `test/fixtures/` (plain node, no Electron).
- `npx electron test/smoke-main.js <scratch dir>` — runs the real app on a throw-away profile with the fixture
  imported; prints UI checks and writes screenshots. Child `WebContentsView` is not in the window screenshot.
- `npm start` or `start.cmd` — run from source. `npm run dist` — portable exe in `dist/` (`NAP Helper <version>.exe`).
- The app was called "NAP Declarations" before; `productName` (= `userData` folder: settings, saved login, session, log)
  is now `NAP Helper`. `migrateLegacyProfile` in `src/main.js` copies the old `%APPDATA%\NAP Declarations` once (old one
  is left), and the archive in `Documents\NAP Declarations` keeps being used when it exists (`defaultDataDir`).
- After `npm install`, run `node node_modules/electron/install.js` (npm blocks Electron's postinstall here).
- No .NET SDK on this machine; Python 3.14 and Node 24 are available.

## Layout

- `src/main.js` — windows, settings, IPC, session guard. Portal lives in a `WebContentsView` on partition
  `persist:nra`; the UI sends its bounds via `portal:bounds`.
- `src/portal.js` — listing, downloads (`net.request`), `fillForm`, `isWriteRequest`. No Electron imports at
  module level, so it is unit-testable.
- `src/parser.js` — `parseDeclaration`, `parseListingHtml` (cheerio). Bump `PARSER_VERSION` when output changes
  so cached `parsed.json` files are regenerated.
- `src/store.js` — archive at `<dataDir>/<year>/<incoming no>/`, drafts in `<dataDir>/drafts/`.
- Statement import: `src/statements.js` detects the source and returns one normalised statement shape (documented
  at the top of `src/ibkr.js`) from `src/ibkr.js` (CSV + PDF), `src/revolut.js`, `src/etoro.js`, `src/iuvo.js` (PDF,
  via `src/pdftext.js` and `pdfjs-dist`). `src/tax.js` turns any number of statements into declaration figures
  (`compute`) and writes them into a draft (`applyToDraft`). `src/rates.js` — ECB reference rates, cached in
  `userData/ecb-rates.json`.
- `src/exchanges.js` — catalogue of venue codes with status (regulated / unclear / mtf / outside) and the default
  exempt-or-taxable verdict; the user's overrides live in `settings.json` (`exchangeRules`, `taxableSymbols`,
  `etcTaxable`) and are edited on the "Борси" tab, which also explains the law. `src/ibkr-confirm.js` reads the IBKR
  Trade Confirmation PDF (fills with their execution venue).
- `src/credentials.js` — DPAPI via `safeStorage`, file in `userData`.
- `src/xslt.js`, `src/portaldraft.js`, `src/napview.js` — the portal draft (`ajxGetXml`) is drawn with the portal's own XSLT (hidden window, `XSLTProcessor`), read by `parseDeclaration`, and shown in the "Като в НАП" view (sandboxed `file:` frame; page cache in `userData/view-cache`). The "Опростен" view is the app's own.
- `src/portal-preload.js` — login autofill and capture inside the portal page.
- `src/preload.js`, `ui/` — app UI (strict CSP, no innerHTML; build DOM with `h()`).

## Portal facts

- Listing page: `home.html#/goto:DEC2009.IPUBATDEC.listDocuments?ipservice_id=1094`; DataTable `#atdec`, JSON
  from `/pls/pub/!dec2009.ipubatdec.ajaxListDocuments` (fields `TAXYEAR, INNO, INNODATE, STATRES, DOCID,
  HASHTML, HASPDF, HASATTACHMENTS, FORMID, DECID, HASRESULT, EXPFILEID`).
- Per document: `DEC2009.IPUBATDEC.viewDocument?pdoc_id=`, `download?ipsystem_id=5&ipendpoint_id=2&ipdoc_id=`,
  `DEC2009.IPUBATDEC.showResult?ipdoc_id=<EXPFILEID>`, `viewAttachments?ipform_id=&ipdec_id=`.
- The PDF endpoint sends `Content-Disposition` with a raw Cyrillic file name; `session.fetch` throws on it
  (uncaught, request never settles). Use `Portal.request` (`net.request`) for downloads. A cross-origin
  `Referer` gets a request blocked (`ERR_BLOCKED_BY_CLIENT`).
- Diagnostics: `%APPDATA%\NAP Helper\app.log`.
- Unauthenticated responses start with `REDIRECT` or contain „Нямате достъп до системата“.
- Login: `https://login-portal.nra.bg/auth/login`, tabs КЕП / ПИК (`a[href="#picTab"]`) / е-автентикация. ПИК
  form `#picForm`: `select[name=pinType]`, `#authInput` (username), `#passInput`, reCAPTCHA v3 token.
- Declaration HTML conventions the parser relies on: `span.value`, `span.checkbox` ("X"), `select` with
  `option[selected]`, `td.index` row codes (e.g. 4001), `th` headings (Приложение № N / Част …), `tr[id]`
  record rows (e.g. `A8D5:3`). Roman numerals mix Latin and Cyrillic lookalikes.

## Statement import

- A draft keeps the parsed statements in `draft.imports`; its imported rows are always rebuilt from all of them
  (`rebuild` in `src/main.js`), so adding, removing and recomputing are repeatable. Rows carry `source`/`file`,
  totals carry `sources` (amount per source), rows the user added by hand carry `manual` and survive a rebuild.
  A statement's `id` is a fingerprint of its content, so the same data in another file (IBKR CSV and PDF)
  replaces rather than doubles. Copies of the files go to `<dataDir>/<year>/statements/`.
- Conventions come from the user's own filed declarations and were checked against them: same-day ECB rate x
  1.95583 reproduces the declared leva amounts; one dividend row per payment with the ticker as payer; tax
  withheld abroad -> method 1 and tax due 0, none withheld -> method 3 and 5%; one holdings row per position
  dated with the latest purchase; for sales with a known purchase date the cost is converted at the purchase-date
  rate and the proceeds at the sale-date rate. Dividend method and holdings mode are options in the import panel.
- Rows dated after 31 December of the draft's tax year are left out; rows dated before it are kept with a warning.
- Country = issuer country from the ISIN prefix (the user has sometimes entered the listing country instead).
- IBKR sales: чл. 13, ал. 1, т. 3 ЗДДФЛ exempts deals "извършени на регулиран пазар и/или на пазар за растеж" (§ 1,
  т. 11 ДР, wording from 01.01.2026; „регулиран пазар“ = чл. 152 ЗПФИ, i.e. any venue licensed under MiFID II, via § 1,
  т. 65 ДР ЗДДФЛ -> § 1, т. 70 ДР ЗКПО). The place of the deal decides, so with an imported Trade Confirmation each sale
  is classified by the venues of its fills (a sale split over venues is split between Приложение 5 and 13 by quantity);
  without one the listing exchange is used and a warning says so. Venue verdicts come from `exchanges.js` plus the
  user's overrides: regulated EU/EEA markets exempt; "unclear" venues (gettex, Tradegate, Stuttgart, Frankfurt 2:
  partly MTF/open market) and MTFs taxable by default with a warning. ETC/ETN (name matches `DEBT_LIKE`, or symbol in
  `taxableSymbols`) are debt securities, not fund units, so always taxable. Taxable result: чл. 33, ал. 3-4 - gains
  and losses netted over the year, 10% costs deducted, 10% tax (чл. 48). Not done: ал. 4 weighted-average cost (IBKR's
  realised P/L is FIFO), currency trading (Forex rows are skipped by both IBKR readers).
- Sources: IBKR gives everything. Revolut trading P&L gives dividends and sells (the Sells table had no rows in
  the sample - its reader is written from the column headers only). Revolut Flexible Account / consolidated
  statements give money-market-fund interest (gross; in the 2023 fund statements the daily rows add up to slightly
  more than the printed "Total Earned Interest", cause unknown - the rows are used) and commodity sells. eToro
  gives dividends only (closed positions are not read - no sample rows). Iuvo gives yearly totals only.
- Not reproduced: the user's declared code-603 interest for 2024 is about 9% lower than the IBKR statement total;
  which rows they left out is unknown, so the report shows the breakdown by source and kind.
- The IBKR PDF is landscape with rotated text and two-lane pages; `pdfLedger` checks every currency block against
  its printed total. PDF readers take the output of `pdfPages()` (text items with positions), so they are tested
  with hand-written synthetic items; with real files in `samples/`, `npm test` also checks those locally.
- `pdfjs-dist` is an ES module and is unpacked from the asar (`asarUnpack` in `package.json`).

## Not yet verified against the live portal

PDF/result/attachment download (login, listing and declaration HTML download are confirmed working),
auto-submit of the login form, and `fillForm` against the editable declaration form (its
DOM has never been seen). Treat these as untested when changing them.

## Conventions

- The parser must stay year-agnostic: no per-year field maps; unknown layouts produce `warnings`, never throw.
- Always keep the original HTML alongside parsed output.
- Amounts are in leva up to tax year 2025 and euro from 2026.
