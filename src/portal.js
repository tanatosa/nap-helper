'use strict';
// Everything that talks to portal.nra.bg. All requests go through the same
// Electron session as the embedded browser, so they carry the user's login.

const { parseListingHtml } = require('./parser');

const ORIGIN = 'https://portal.nra.bg';
const BASE = ORIGIN + '/pls/pub/';
const HOME_URL = ORIGIN + '/home.html';
const LISTING_URL = HOME_URL + '#/goto:DEC2009.IPUBATDEC.listDocuments?ipservice_id=1094';

const STATUS_TEXT = {
  1: 'Изчаква обработка',
  11: 'Получен е резултат от обработката',
  2: 'Коригирана',
  12: 'Коригирана',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AuthError extends Error {
  constructor(msg) { super(msg || 'Необходим е вход в портала на НАП.'); this.code = 'LOGIN_REQUIRED'; }
}

const isNraUrl = (u) => {
  try { const h = new URL(u).hostname; return h === 'nra.bg' || h.endsWith('.nra.bg'); } catch { return false; }
};

/**
 * Requests that change data on the portal. In read-only mode these are
 * cancelled, so nothing can be filed by accident (or by this app) while
 * browsing. The portal's PL/SQL procedures are named <PACKAGE>.<procedure>;
 * anything that is not a GET to a read-style procedure in a declaration
 * package counts as a write.
 */
function isWriteRequest(method, url) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || !isNraUrl(url)) return false;
  let p;
  try { p = new URL(url).pathname; } catch { return false; }
  const m = p.match(/\/pls\/\w+\/!?([\w.]+)\.(\w+)$/);
  if (!m) return false;
  const [, pkg, proc] = m;
  if (/^login$/i.test(pkg)) return false;
  if (!/dec|doc|upload|sign|submit/i.test(pkg)) return false;
  return !/^(ajax|ajx)?(list|view|show|get|load|check|calc|valid|print|search|find|download)/i.test(proc);
}

function decodeBody(buf, contentType) {
  let cs = (/charset=([\w-]+)/i.exec(contentType || '') || [])[1];
  if (!cs) cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1')) || [])[1];
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

class Portal {
  /** @param view WebContentsView showing the portal  @param ses its session */
  constructor(view, ses) {
    this.view = view;
    this.ses = ses;
  }

  get wc() { return this.view.webContents; }

  async openListing() {
    const same = this.wc.getURL() === LISTING_URL;
    await this.wc.loadURL(LISTING_URL).catch(() => {});
    if (same) this.wc.reload();
  }

  /** Wait until the documents table is on screen; throws AuthError otherwise. */
  async waitForListing(timeoutMs = 25000) {
    const until = Date.now() + timeoutMs;
    let st = {};
    while (Date.now() < until) {
      st = await this.wc.executeJavaScript(`({
        table: !!document.querySelector('#atdec'),
        rows: document.querySelectorAll('#atdec tbody tr').length,
        loading: !!document.querySelector('#atdec .dataTables_empty') && /Зареждане|Loading/i.test(document.querySelector('#atdec').innerText),
        login: !!document.querySelector('input[type=password]'),
      })`, true).catch(() => ({}));
      if (st.table && st.rows && !st.loading) return;
      await sleep(500);
    }
    if (!st.table) throw new AuthError();
  }

  /** All rows of "Подадени данни за Декларация по чл.50 от ЗДДФЛ". */
  async fetchListing() {
    await this.openListing();
    await this.waitForListing();
    // Preferred: ask the portal's own DataTable endpoint for every row.
    const res = await this.wc.executeJavaScript(`(async () => {
      const out = {};
      try {
        const dt = window.jQuery('#atdec').DataTable();
        const params = Object.assign({}, dt.ajax.params(), { start: 0, length: -1 });
        out.json = await new Promise((ok, fail) => window.jQuery.ajax({ url: dt.ajax.url(), data: params, dataType: 'text' })
          .done(ok).fail((x) => fail(new Error('HTTP ' + x.status))));
      } catch (e) {
        out.error = String(e);
        try { // fallback: show every row and read the rendered table
          const dt = window.jQuery('#atdec').DataTable();
          dt.page.len(-1).draw();
          await new Promise((r) => setTimeout(r, 3000));
        } catch (e2) { out.error += ' / ' + e2; }
      }
      out.html = document.querySelector('#atdec').outerHTML;
      return out;
    })()`, true);

    if (res.json) {
      if (/^REDIRECT/.test(res.json)) throw new AuthError();
      try {
        const data = JSON.parse(res.json).data;
        if (Array.isArray(data)) {
          return data.map((r) => ({ ...r, STATUSTEXT: STATUS_TEXT[r.STATRES] || `Статус ${r.STATRES}` }));
        }
      } catch { /* fall back to the rendered table */ }
    }
    const rows = parseListingHtml(res.html || '');
    if (!rows.length) throw new Error('Списъкът с декларации не можа да бъде прочетен' + (res.error ? `: ${res.error}` : '.'));
    return rows;
  }

  /**
   * GET through the portal session. Uses net.request rather than session.fetch:
   * the PDF endpoint sends a Content-Disposition with a raw Cyrillic file name,
   * which fetch()'s Headers object rejects (and the request then never settles).
   */
  request(url) {
    return new Promise((resolve, reject) => {
      const { net } = require('electron');
      let finalUrl = url;
      const req = net.request({ url, session: this.ses, useSessionCookies: true, redirect: 'follow' });
      if (url.startsWith(ORIGIN + '/')) req.setHeader('Referer', HOME_URL); // a cross-origin referrer gets the request blocked
      const timer = setTimeout(() => { req.abort(); reject(new Error('няма отговор от портала (60 s)')); }, 60000);
      req.on('redirect', (_status, _method, redirectUrl) => { finalUrl = redirectUrl; });
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          const header = (n) => { const v = res.headers[n]; return Array.isArray(v) ? v[0] : v || ''; };
          resolve({ status: res.statusCode, url: finalUrl, type: header('content-type'), buf: Buffer.concat(chunks) });
        });
        res.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.end();
    });
  }

  async get(pathOrUrl) {
    const url = new URL(pathOrUrl, BASE).toString();
    const r = await this.request(url);
    const { buf, type } = r;
    const head = buf.subarray(0, 400).toString('utf8');
    // what came back, for the log: enough to tell a login page from a real document
    const detail = `HTTP ${r.status} ${type || 'no content-type'} ${buf.length} B, final URL ${r.url}, starts: ${JSON.stringify(head.slice(0, 160))}`;
    if (/^\s*REDIRECT/.test(head) || /Нямате достъп до системата/.test(head) || /\/auth\/login/.test(r.url)) {
      const e = new AuthError();
      e.detail = detail;
      throw e;
    }
    if (r.status < 200 || r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.detail = detail; throw e; }
    return { buf, type, detail };
  }

  /** The draft the portal keeps for the logged-in user, as raw XML (GET only). */
  async fetchDraftXml() {
    const r = await this.get('DEC2009.IPUBATDEC.ajxGetXml');
    const head = r.buf.subarray(0, 300).toString('latin1');
    if (!/<\?xml|<dec\d+/.test(head)) {
      const e = new Error('Порталът не върна XML на чернова. Отворете черновата на декларацията в раздел „Портал на НАП“ и опитайте пак. '
        + 'От съображения за сигурност в тази версия на софтуера това изисква ръчно действие от потребителя.');
      e.detail = r.detail;
      throw e;
    }
    return r.buf;
  }

  /** The parts of the draft form and their stylesheets, from the portal's left menu (GET only). */
  async fetchMenu() {
    return this.getHtml('DEC2009.IPUBATDEC.leftmenu');
  }

  /** A static stylesheet of the portal (no login needed). `href` may name the old inetdec.nra.bg host. */
  async fetchStatic(href) {
    const u = new URL(href, ORIGIN + '/');
    const r = await this.get(ORIGIN + u.pathname + u.search);
    return decodeBody(r.buf, r.type);
  }

  async getHtml(p) {
    const r = await this.get(p);
    return decodeBody(r.buf, r.type);
  }

  /**
   * Download everything belonging to the listed declarations into the store.
   * Read-only: only GET requests to view/download endpoints are made.
   */
  async sync(store, { force = false, onProgress = () => {}, log = () => {} } = {}) {
    onProgress({ stage: 'listing', text: 'Четене на списъка с декларации…' });
    const rows = await this.fetchListing();
    log(`listing: ${rows.length} rows`);
    const report = { total: rows.length, downloaded: 0, skipped: 0, errors: [] };
    let i = 0;
    for (const row of rows) {
      i++;
      const label = `${row.TAXYEAR} · ${row.INNO}`;
      onProgress({ stage: 'doc', index: i, total: rows.length, text: `(${i}/${rows.length}) ${label}` });
      store.write(row, 'listing.json', JSON.stringify(row, null, 2));
      let got = false;
      const step = async (name, cond, fn) => {
        if (!cond || (!force && store.has(row, name))) return;
        try { await fn(); got = true; } catch (e) {
          log(`${label}: ${name}: ${e.message}${e.detail ? ' | ' + e.detail : ''}`);
          // Only the declaration itself decides whether the session is gone; a refused
          // PDF/result must not stop the remaining declarations from being downloaded.
          if (e.code === 'LOGIN_REQUIRED' && name === 'declaration.html') throw e;
          report.errors.push(`${label}: ${name}: ${e.code === 'LOGIN_REQUIRED' ? 'порталът отказа достъп' : e.message}`);
        }
      };

      await step('declaration.html', Number(row.HASHTML) !== 0 && row.DOCID, async () => {
        const html = await this.getHtml(`DEC2009.IPUBATDEC.viewDocument?pdoc_id=${encodeURIComponent(row.DOCID)}`);
        store.write(row, 'declaration.html', html);
        store.parse(store.dirFor(row));
      });
      await step('declaration.pdf', Number(row.HASPDF) !== 0 && row.DOCID, async () => {
        const r = await this.get(`download?ipsystem_id=5&ipendpoint_id=2&ipdoc_id=${encodeURIComponent(row.DOCID)}`);
        if (r.buf.subarray(0, 5).toString('latin1') !== '%PDF-') { const e = new Error('полученият файл не е PDF'); e.detail = r.detail; throw e; }
        store.write(row, 'declaration.pdf', r.buf);
      });
      await step('result.html', Number(row.HASRESULT) !== 0 && row.EXPFILEID, async () => {
        const r = await this.get(`DEC2009.IPUBATDEC.showResult?ipdoc_id=${encodeURIComponent(row.EXPFILEID)}`);
        if (r.buf.subarray(0, 5).toString('latin1') === '%PDF-') store.write(row, 'result.pdf', r.buf);
        // result.html is always written so that the "already downloaded" check stays simple
        store.write(row, 'result.html', r.buf.subarray(0, 5).toString('latin1') === '%PDF-'
          ? '<p>Резултатът е записан като result.pdf</p>' : decodeBody(r.buf, r.type));
      });
      await step('attachments.html', Number(row.HASATTACHMENTS) !== 0 && row.FORMID, async () => {
        const html = await this.getHtml(`DEC2009.IPUBATDEC.viewAttachments?ipform_id=${encodeURIComponent(row.FORMID)}&ipdec_id=${encodeURIComponent(row.DECID)}`);
        store.write(row, 'attachments.html', html);
      });
      if (got) report.downloaded++; else report.skipped++;
      await sleep(250); // be gentle with the portal
    }
    return report;
  }

  /**
   * Fill the declaration form currently open in the portal view from a draft.
   * It only sets field values - it never presses a button and never submits.
   */
  async fillForm(draft) {
    // rowIdx: position of the field among the controls of its record row
    const perRow = new Map();
    const fields = draft.fields.map((f) => {
      if (!f.rowId) return f;
      const n = perRow.get(f.rowId) || 0;
      perRow.set(f.rowId, n + 1);
      return { ...f, rowIdx: n };
    }).filter((f) => f.value !== '' && f.value != null && f.value !== false);
    return this.wc.executeJavaScript(`(() => {
      const fields = ${JSON.stringify(fields)};
      const report = { filled: 0, missing: [] };
      const editable = (el) => el && !el.disabled && !el.readOnly && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
      const set = (el, f) => {
        if (el.type === 'checkbox' || el.type === 'radio') {
          const want = f.value === true || f.value === 'X';
          if (el.checked !== want) el.click();
        } else {
          const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(f.value));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      };
      const controls = (root) => [...root.querySelectorAll('input:not([type=hidden]):not([type=button]):not([type=submit]), select, textarea')];
      for (const f of fields) {
        let el = null;
        if (f.name) el = document.getElementsByName(f.name)[0];
        if (!el && f.code) {
          const cell = [...document.querySelectorAll('td.index')].find((td) => td.textContent.trim() === f.code);
          if (cell) el = controls(cell.parentElement)[0];
        }
        if (!el && f.rowId) {
          const tr = document.getElementById(f.rowId);
          if (tr) el = controls(tr)[f.rowIdx] || null;
        }
        if (editable(el)) { set(el, f); report.filled++; }
        else report.missing.push((f.code ? f.code + ' ' : '') + f.label.slice(0, 80));
      }
      return report;
    })()`, true);
  }
}

module.exports = { Portal, AuthError, isWriteRequest, isNraUrl, ORIGIN, BASE, HOME_URL, LISTING_URL };
