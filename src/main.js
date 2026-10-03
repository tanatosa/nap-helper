'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, session, net } = require('electron');
const credentials = require('./credentials');
const { Store, safeName } = require('./store');
const { Portal, isWriteRequest, isNraUrl, HOME_URL, LISTING_URL } = require('./portal');
const statements = require('./statements');
const tax = require('./tax');
const exchanges = require('./exchanges');
const { parseDraftXml, decodeXml, fillCountriesFromXml } = require('./portaldraft');
const { parseDeclaration } = require('./parser');
const xslt = require('./xslt');
const napview = require('./napview');
const { loadRates } = require('./rates');
const { migrateLegacyProfile, defaultDataDir } = require('./legacy');

migrateLegacyProfile({ appData: app.getPath('appData'), appName: app.name, userData: app.getPath('userData') });

const PARTITION = 'persist:nra';
let win, view, portal, store, settings;
let pendingLogin = null; // last manual login seen in the portal view, kept in memory only
let autoSubmitUsed = false; // at most one automatic login per run, so a wrong password cannot lock the account
let syncing = false;

// ---- settings ---------------------------------------------------------------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { /* first run */ }
  return {
    dataDir: defaultDataDir(app.getPath('documents'), app.name),
    readOnly: true, // block requests that would file/modify anything on the portal
    autoSubmit: false, // press the login button automatically after filling it
    exchangeRules: {}, // venue code -> 'exempt' | 'taxable'; only the choices that differ from the defaults in exchanges.js
    exemptSymbols: [], // instruments always treated as exempt whatever the venue (user's own risk - not what the law says)
    taxableSymbols: [], // instruments always treated as taxable (ETC/ETN and other debt securities)
    etcTaxable: true, // treat instruments that look like an ETC/ETN as taxable
    ...s,
  };
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// Plain-text log next to the settings, so a failed download can be diagnosed afterwards.
const logFile = () => path.join(app.getPath('userData'), 'app.log');
function log(msg) {
  try {
    if (fs.existsSync(logFile()) && fs.statSync(logFile()).size > 1e6) fs.renameSync(logFile(), logFile() + '.1');
    fs.appendFileSync(logFile(), `${new Date().toISOString()} ${msg}
`);
  } catch { /* logging must never break the app */ }
}
process.on('uncaughtException', (e) => log(`uncaughtException: ${e.stack || e}`));
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${(e && e.stack) || e}`));

const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

// ---- windows ----------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 980, minHeight: 600,
    title: 'НАП – Декларация по чл. 50 от ЗДДФЛ · импорт от инвестиционни посредници · управление на декларации',
    icon: path.join(__dirname, '..', 'ui', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));

  const ses = session.fromPartition(PARTITION);
  // Read-only guard, see isWriteRequest().
  ses.webRequest.onBeforeRequest((details, cb) => {
    if (settings.readOnly && isWriteRequest(details.method, details.url)) {
      send('portal:blocked', { url: details.url, method: details.method });
      return cb({ cancel: true });
    }
    cb({});
  });

  view = new WebContentsView({
    webPreferences: { partition: PARTITION, preload: path.join(__dirname, 'portal-preload.js'), contextIsolation: true, sandbox: true },
  });
  win.contentView.addChildView(view);
  view.setVisible(false);
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isNraUrl(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 1100, height: 850 } };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  const nav = () => send('portal:url', view.webContents.getURL());
  view.webContents.on('did-navigate', nav);
  view.webContents.on('did-navigate-in-page', nav);
  portal = new Portal(view, ses);
  view.webContents.loadURL(HOME_URL);
}

// Qualified e-signature (КЕП) login: let the user pick the certificate.
app.on('select-client-certificate', (event, _wc, url, list, callback) => {
  event.preventDefault();
  if (list.length === 1) return callback(list[0]);
  const i = dialog.showMessageBoxSync(win, {
    type: 'question', title: 'Избор на сертификат', message: `Сертификат за вход в ${new URL(url).hostname}`,
    buttons: [...list.map((c) => `${c.subjectName} (${c.issuerName})`), 'Отказ'], cancelId: list.length,
  });
  if (i < list.length) callback(list[i]); else callback();
});

// ---- IPC: app UI ------------------------------------------------------------
const fromUi = (e) => e.sender === win.webContents;
function handle(ch, fn) {
  ipcMain.handle(ch, async (e, ...args) => {
    if (!fromUi(e)) throw new Error('forbidden');
    return fn(...args);
  });
}

function registerIpc() {
  handle('app:state', () => ({
    settings, credentials: credentials.status(), pendingLogin: pendingLogin ? { username: pendingLogin.username } : null,
    portalUrl: view.webContents.getURL(), listingUrl: LISTING_URL, version: app.getVersion(),
  }));

  handle('store:list', () => store.list());
  handle('store:get', (id) => {
    const dir = store.resolve(id);
    return { parsed: store.loadParsed(dir), files: fs.readdirSync(dir) };
  });
  handle('app:open-log', () => { if (!fs.existsSync(logFile())) log('log created'); return shell.openPath(logFile()); });
  handle('store:open', (id, what) => {
    const dir = id ? store.resolve(id) : store.dataDir;
    if (!what) return shell.openPath(dir);
    const file = path.join(dir, path.basename(what));
    if (!fs.existsSync(file)) throw new Error('Файлът липсва.');
    if (/\.html?$/i.test(file)) return openViewer(file);
    return shell.openPath(file);
  });
  handle('store:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Импорт на записана декларация', properties: ['openFile', 'multiSelections'], filters: [{ name: 'HTML', extensions: ['htm', 'html'] }] });
    const done = [], errors = [];
    for (const f of r.filePaths) { try { done.push(store.importHtml(f)); } catch (e) { errors.push(`${path.basename(f)}: ${e.message}`); } }
    return { done, errors };
  });

  handle('settings:choose-dir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Папка за декларациите', defaultPath: settings.dataDir, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return settings.dataDir;
    settings.dataDir = r.filePaths[0];
    saveSettings();
    store = new Store(settings.dataDir);
    return settings.dataDir;
  });
  handle('settings:set', (key, value) => {
    if (!['readOnly', 'autoSubmit'].includes(key)) throw new Error('unknown setting');
    settings[key] = !!value;
    saveSettings();
    return settings;
  });

  // The "Борси" page: which venues count as a regulated market (exempt sales) - see exchanges.js
  const knownSymbols = () => {
    const set = new Set();
    try { for (const d of store.listDrafts()) for (const i of d.imports || []) for (const t of i.statement.trades || []) if (t.category === 'Stocks' && t.symbol) set.add(t.symbol); } catch { /* suggestions only */ }
    return [...set].sort();
  };
  const rulesView = () => ({
    knownSymbols: knownSymbols(),
    catalogue: exchanges.CATALOGUE, statuses: exchanges.STATUS,
    exchangeRules: exchanges.cleanOverrides(settings.exchangeRules), taxableSymbols: settings.taxableSymbols || [], exemptSymbols: settings.exemptSymbols || [], etcTaxable: settings.etcTaxable !== false,
  });
  handle('rules:get', () => rulesView());
  handle('rules:set', (patch) => {
    if (patch.exchangeRules) settings.exchangeRules = exchanges.cleanOverrides(patch.exchangeRules);
    if (patch.taxableSymbols) settings.taxableSymbols = [...new Set(patch.taxableSymbols.map((x) => String(x).trim().toUpperCase()).filter((x) => /^[A-Z0-9 ._-]{1,24}$/.test(x)))];
    if (patch.exemptSymbols) settings.exemptSymbols = [...new Set(patch.exemptSymbols.map((x) => String(x).trim().toUpperCase()).filter((x) => /^[A-Z0-9 ._-]{1,24}$/.test(x)))];
    if (patch.etcTaxable != null) settings.etcTaxable = !!patch.etcTaxable;
    saveSettings();
    return rulesView();
  });

  handle('creds:save', (u, p) => { credentials.save(String(u).trim(), String(p)); pendingLogin = null; return credentials.status(); });
  handle('creds:clear', () => { credentials.clear(); return credentials.status(); });
  handle('creds:accept-pending', (accept) => {
    if (accept && pendingLogin) credentials.save(pendingLogin.username, pendingLogin.password, pendingLogin.pinType);
    pendingLogin = null;
    return credentials.status();
  });

  handle('portal:navigate', (target) => {
    const wc = view.webContents;
    if (target === 'back') return wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack();
    if (target === 'reload') return wc.reload();
    if (target === 'listing') return portal.openListing();
    return wc.loadURL(HOME_URL);
  });
  ipcMain.on('portal:bounds', (e, b) => {
    if (!fromUi(e)) return;
    view.setVisible(!!b);
    if (b) view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  });
  handle('portal:sync', async (opts) => {
    if (syncing) throw new Error('Изтеглянето вече е в ход.');
    syncing = true;
    try {
      log(`sync start (force=${!!(opts && opts.force)}) at ${view.webContents.getURL()}`);
      const report = await portal.sync(store, { force: !!(opts && opts.force), onProgress: (p) => send('sync:progress', p), log });
      log(`sync done: ${JSON.stringify({ ...report, errors: report.errors.length })}`);
      return { ok: true, report };
    } catch (e) {
      log(`sync failed: ${e.code || ''} ${e.message}${e.detail ? ' | ' + e.detail : ''} at ${view.webContents.getURL()}`);
      return { ok: false, code: e.code, message: e.message };
    } finally {
      syncing = false;
    }
  });

  handle('drafts:list', () => store.listDrafts());
  handle('drafts:from', (id, year) => store.draftFrom(id, Number(year)));
  // Draws the portal's draft the way the portal does (its own XSLT stylesheets applied to the XML)
  // in a hidden, script-free-of-Node page and reads the result with the declaration parser.
  // Returns null when that is not possible, so the caller can fall back to the plain XML reading.
  const renderPortalDraft = async (xml, year, warnings) => {
    let w;
    try {
      const parts = xslt.partsFromMenu(await portal.fetchMenu());
      if (!parts.length) { warnings.push('В менюто на портала не са намерени части на декларацията.'); return null; }
      w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await w.loadURL('about:blank');
      const cache = new Map();
      const fetchText = async (href) => { if (!cache.has(href)) cache.set(href, await portal.fetchStatic(href)); return cache.get(href); };
      let html = '';
      const form = [];
      for (const part of parts) {
        try {
          const sheet = await xslt.inlineIncludes(await fetchText(part.xslt), fetchText);
          const out = xslt.fixEntities(await w.webContents.executeJavaScript(xslt.renderScript(sheet, xml, { taxyear: String(year), editable: 'true' })));
          html += out;
          form.push({ key: part.key, title: part.title, caption: part.caption, status: part.status, html: out });
        } catch (e) {
          if (e.code === 'LOGIN_REQUIRED') throw e;
          warnings.push(`${part.key}: ${e.message}`);
        }
      }
      const parsed = parseDeclaration(`<html><body>${fillCountriesFromXml(html, xml)}</body></html>`);
      return parsed.fields.length ? { ...parsed, form } : null;
    } catch (e) {
      if (e.code === 'LOGIN_REQUIRED') throw e;
      warnings.push(`Формата не можа да се изгради от стилове на портала (${e.message}).`);
      return null;
    } finally {
      if (w && !w.isDestroyed()) w.destroy();
    }
  };
  // The country lists of the form are filled by the portal's own script (countryArr in scripts.js).
  const portalCountries = async () => {
    try {
      const js = await portal.fetchStatic('/static/isfw/scripts/scripts.js');
      const list = /countryArr\s*=\s*new Array\(([\s\S]*?)\);/.exec(js);
      const names = list ? [...list[1].matchAll(/'([^']*)'/g)].map((m) => m[1]) : [];
      if (names.length) return names;
    } catch (e) { log(`country list: ${e.message}`); }
    return [];
  };
  // Loads the draft that the portal keeps for the logged-in user (GET only). Replaces this year's
  // portal draft here but keeps the statements imported into it.
  handle('drafts:load-portal', async () => {
    try {
      const buf = await portal.fetchDraftXml();
      const parsed = parseDraftXml(decodeXml(buf));
      if (!parsed.taxYear) throw new Error('В черновата от портала не е намерена данъчна година.');
      store.savePortalDraftXml(parsed.taxYear, buf);
      const countries = await portalCountries();
      const rendered = await renderPortalDraft(decodeXml(buf), parsed.taxYear, parsed.warnings);
      if (rendered) {
        store.savePortalForm(parsed.taxYear, rendered.form, countries);
        parsed.fields = rendered.fields.map((f) => ({
          key: f.key, section: f.section, part: f.part, group: f.group, rowId: f.rowId, rowNo: f.rowNo, code: f.code, name: f.name,
          label: f.label, column: f.column, columnNo: f.columnNo, type: f.type, options: countries.length && /country/i.test(f.name || '') ? countries : f.options, previous: '', value: f.raw,
        }));
      } else parsed.warnings.push('Полетата са по имената на XML елементите (без етикети от формата).');
      const id = `${parsed.taxYear}-portal`;
      const old = store.listDrafts().find((x) => x.id === id) || {};
      const draft = store.saveDraft({ ...old, id, taxYear: parsed.taxYear, basedOn: 'портала на НАП', source: 'portal', basedOnSchema: parsed.schema,
        created: old.created || new Date().toISOString(), loadedAt: new Date().toISOString(), fields: parsed.fields });
      log(`portal draft loaded: ${parsed.taxYear}, ${parsed.fields.length} fields, ${parsed.warnings.length} warnings`);
      return { ok: true, draft, warnings: parsed.warnings };
    } catch (e) {
      log(`portal draft failed: ${e.code || ''} ${e.message}${e.detail ? ' | ' + e.detail : ''}`);
      return { ok: false, code: e.code, message: e.message };
    }
  });
  // "Like NAP" pages: written to a cache folder and shown in a sandboxed frame; the cache is cleared at start and exit.
  const viewDir = () => path.join(app.getPath('userData'), 'view-cache');
  const clearViews = () => fs.rmSync(viewDir(), { recursive: true, force: true });
  clearViews();
  app.on('will-quit', clearViews);
  const writeView = (name, html) => {
    fs.mkdirSync(viewDir(), { recursive: true });
    const file = path.join(viewDir(), `${safeName(name)}.html`);
    fs.writeFileSync(file, html, 'utf8');
    return `${pathToFileURL(file).href}?${Date.now()}`;
  };
  handle('napview:declaration', (id) => {
    const file = path.join(store.resolve(id), 'declaration.html');
    if (!fs.existsSync(file)) throw new Error('Липсва записаният HTML на декларацията.');
    return writeView(`declaration-${id}`, napview.declarationPage(fs.readFileSync(file, 'utf8')));
  });
  handle('napview:draft', (id) => {
    const d = draftById(id);
    const form = store.loadPortalForm(d.taxYear);
    if (!form) throw new Error('Изгледът „Като в НАП“ е наличен само за чернови, заредени от портала (бутон „Зареди чернова от НАП“).');
    return writeView(`draft-${id}`, napview.draftPage(form.parts, d.fields, { countries: form.countries, year: d.taxYear, title: `Чернова ${d.taxYear}` }));
  });
  handle('drafts:save', (d) => store.saveDraft(d));
  handle('drafts:delete', (id) => store.deleteDraft(id));
  // Statements from brokers and platforms (IBKR, Revolut, eToro, Iuvo). Everything is local, apart
  // from downloading the ECB reference rates. The draft keeps the parsed statements, and its
  // imported rows are always rebuilt from all of them, so adding or removing a file is repeatable.
  const draftById = (id) => {
    const d = store.listDrafts().find((x) => x.id === id);
    if (!d) throw new Error('Черновата не е намерена.');
    return d;
  };
  const rebuild = async (draft, options) => {
    const year = Number(draft.taxYear);
    draft.imports = draft.imports || [];
    draft.importOptions = { ...(draft.importOptions || {}), ...(options || {}) };
    if (!draft.previousHoldings) draft.previousHoldings = tax.previousHoldings(draft, year);
    const today = new Date().toISOString().slice(0, 10);
    const ends = draft.imports.map((i) => (i.statement.period ? i.statement.period.to : `${year}-12-31`)).sort();
    const last = ends.length ? ends[ends.length - 1] : `${year}-12-31`;
    const rates = await loadRates({ cacheFile: path.join(app.getPath('userData'), 'ecb-rates.json'), fetch: (u) => net.fetch(u), needDate: last < today ? last : today });
    const result = tax.compute(draft.imports.map((i) => i.statement), rates, year, draft.importOptions, draft.previousHoldings,
      { exchangeRules: settings.exchangeRules, taxableSymbols: settings.taxableSymbols, exemptSymbols: settings.exemptSymbols, etcTaxable: settings.etcTaxable });
    const outcome = tax.applyToDraft(draft, result);
    draft.importReport = draft.imports.length ? { updatedAt: new Date().toISOString(), ...result, ...outcome } : null;
    delete draft.ibkr; // report format of version 0.2.0
    return store.saveDraft(draft);
  };
  handle('imports:add', async (draftId, type, options) => {
    const draft = draftById(draftId);
    const r = await dialog.showOpenDialog(win, {
      title: 'Извлечения и отчети (IBKR, Revolut, eToro, Iuvo)', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Извлечения', extensions: ['csv', 'pdf'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    draft.imports = draft.imports || [];
    const errors = [], added = [];
    for (const file of r.filePaths) {
      try {
        const st = await statements.parseFile(file, type || 'auto');
        const stored = store.saveStatement(file, st);
        const entry = { id: st.id, type: st.type, label: st.label, name: path.basename(file), stored, importedAt: new Date().toISOString(), statement: st };
        const at = draft.imports.findIndex((i) => i.id === st.id);
        if (at >= 0) { draft.imports[at] = entry; added.push(`${entry.name} (заменя вече импортиран отчет със същото съдържание)`); }
        else { draft.imports.push(entry); added.push(entry.name); }
        log(`import: ${st.type} ${path.extname(file)} ${st.year}: ${st.dividends.length} dividends, ${st.interest.length} interest rows, ${st.positions.length} positions, ${st.warnings.length} warnings`);
      } catch (e) {
        log(`import failed (${path.extname(file)}): ${e.stack || e}`);
        errors.push({ file: path.basename(file), message: e.message });
      }
    }
    return { draft: added.length ? await rebuild(draft, options) : draft, added, errors };
  });
  handle('imports:remove', (draftId, importId) => {
    const draft = draftById(draftId);
    draft.imports = (draft.imports || []).filter((i) => i.id !== importId); // the stored copy of the file stays in the archive
    return rebuild(draft);
  });
  handle('imports:recompute', (draftId, options) => rebuild(draftById(draftId), options));
  handle('imports:open', (draftId, importId) => {
    const entry = (draftById(draftId).imports || []).find((i) => i.id === importId);
    const file = entry && path.join(store.dataDir, entry.stored);
    if (!file || !fs.existsSync(file)) throw new Error('Записаното копие на файла липсва.');
    return shell.openPath(file);
  });
  // Fills the form that the user has opened in the portal tab. Nothing is submitted:
  // sending a declaration is always a manual click by the user in the portal itself.
  handle('drafts:fill', (d) => portal.fillForm(d));

  // ---- IPC: portal page (login helper) --------------------------------------
  const fromPortalTop = (e) => e.sender === view.webContents && e.senderFrame === view.webContents.mainFrame && isNraUrl(e.senderFrame.url) && e.senderFrame.url.startsWith('https://');
  ipcMain.handle('portal:has-credentials', (e) => fromPortalTop(e) && !!credentials.load());
  ipcMain.handle('portal:credentials', (e) => {
    if (!fromPortalTop(e)) return null;
    const c = credentials.load();
    if (!c) return null;
    const autoSubmit = settings.autoSubmit && !autoSubmitUsed;
    if (autoSubmit) autoSubmitUsed = true;
    return { ...c, autoSubmit };
  });
  ipcMain.on('portal:login-attempt', (e, c) => {
    if (!fromPortalTop(e) || !c || !c.password) return;
    const saved = credentials.load();
    if (saved && saved.username === c.username && saved.password === c.password) return;
    pendingLogin = { username: String(c.username || ''), password: String(c.password), pinType: c.pinType ? String(c.pinType) : undefined };
    send('creds:pending', { username: pendingLogin.username });
  });
}

/** Show a saved page with scripting and network access switched off. */
function openViewer(file) {
  const ses = session.fromPartition('viewer');
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('file:') }));
  const w = new BrowserWindow({
    width: 1100, height: 900, autoHideMenuBar: true, title: path.basename(path.dirname(file)),
    webPreferences: { session: ses, javascript: false, sandbox: true, contextIsolation: true },
  });
  w.loadFile(file);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    settings = loadSettings();
    store = new Store(settings.dataDir);
    registerIpc();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
