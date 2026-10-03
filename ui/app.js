'use strict';
/* global nap */

const $ = (sel, root = document) => root.querySelector(sel);

/** Tiny DOM builder; text always goes in as text, never as HTML. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const money = (n) => (n == null ? '—' : Number(n).toLocaleString('bg-BG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
// Amounts are in leva up to tax year 2025 and in euro from 2026 on.
const currency = (year) => (Number(year) >= 2026 ? '€' : 'лв.');

let state, items = [], currentId = null, currentDraft = null;

// Two ways to look at a declaration or draft: the simple one built by this app, and one that
// looks like the portal itself (a sandboxed frame, see src/napview.js).
let viewMode = 'nap';
try { if (localStorage.getItem('nap-view') === 'simple') viewMode = 'simple'; } catch { /* storage unavailable */ }
let napFrame = null, napEdit = null; // the frame of an open draft and what to do with its edits
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (napFrame && napEdit && ev.source === napFrame.contentWindow && m && (m.napEdit || m.napRows)) napEdit(m);
});
function viewSwitch(onChange) {
  const sw = h('div', { class: 'actions seg' }, h('span', { class: 'hint' }, 'Изглед:'));
  const paint = () => { for (const b of sw.querySelectorAll('button')) b.className = b.getAttribute('data-mode') === viewMode ? 'primary' : ''; };
  for (const [mode, text] of [['simple', '📋 Опростен'], ['nap', '🏛️ Като в НАП']]) {
    sw.append(h('button', { 'data-mode': mode, onclick: () => { viewMode = mode; try { localStorage.setItem('nap-view', mode); } catch { /* ignore */ } paint(); onChange(); } }, text));
  }
  paint();
  return sw;
}

function setStatus(text) { $('#status').textContent = text || ''; }

function banner(id, text, buttons) {
  const old = document.getElementById('banner-' + id);
  if (old) old.remove();
  if (!text) return syncPortalBounds();
  const el = h('div', { class: 'banner', id: 'banner-' + id }, h('span', {}, text),
    (buttons || []).map(([label, fn]) => h('button', { onclick: fn }, label)),
    h('button', { onclick: () => banner(id) }, '✕'));
  $('#banners').append(el);
  syncPortalBounds();
}

// ---- tabs -------------------------------------------------------------------
function showTab(name) {
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('active', s.id === 'tab-' + name);
  syncPortalBounds();
  if (name === 'drafts') renderDrafts();
  if (name === 'settings') renderSettings();
  if (name === 'exchanges') renderExchanges();
}
function syncPortalBounds() {
  const host = $('#portal-host');
  if (!$('#tab-portal').classList.contains('active')) return nap.portalBounds(null);
  const r = host.getBoundingClientRect();
  nap.portalBounds({ x: r.x, y: r.y, width: r.width, height: r.height });
}
window.addEventListener('resize', syncPortalBounds);

// ---- archive ----------------------------------------------------------------
async function refreshList() {
  items = await nap.list();
  const list = $('#list');
  list.replaceChildren();
  if (!items.length) list.append(h('p', { class: 'empty' }, 'Няма изтеглени декларации.'));
  let year = null;
  for (const it of items) {
    if (it.taxYear !== year) { year = it.taxYear; list.append(h('div', { class: 'year' }, `ДАНЪЧНА ГОДИНА ${year}`)); }
    const corrected = it.statusCode === '2' || it.statusCode === '12' || /Коригирана/.test(it.status);
    const s = it.summary || {};
    const amount = s.overpaid ? `надвнесен ${money(s.overpaid)}` : s.taxDueAfterDiscount != null ? `за довнасяне ${money(s.taxDueAfterDiscount)}` : '';
    list.append(h('div', { class: 'item' + (it.id === currentId ? ' active' : ''), onclick: () => showDeclaration(it.id) },
      h('div', { class: 'l1' }, h('span', {}, it.inno), h('span', { class: 'tag ' + (corrected ? 'warn' : 'ok') }, corrected ? 'коригирана' : 'актуална')),
      h('div', { class: 'l2' }, [it.date, amount && `${amount} ${currency(it.taxYear)}`].filter(Boolean).join(' · ')),
      it.warnings && it.warnings.length ? h('div', { class: 'l2' }, '⚠ ' + it.warnings[0]) : null));
  }
}

function fieldRow(f) {
  const blank = f.raw === '' || f.value === false;
  const val = f.type === 'checkbox' ? (f.value ? '☑ Да' : '☐') : f.type === 'number' ? money(f.value) : (f.text ? `${f.raw} – ${f.text}` : f.raw);
  return h('tr', { class: blank ? 'blank' : '', 'data-blank': blank ? '1' : null },
    h('td', { class: 'code' }, [f.rowNo, f.code && `[${f.code}]`].filter(Boolean).join(' ')),
    h('td', {}, f.label, f.column ? h('div', { class: 'prev' }, f.column) : null),
    h('td', { class: 'val' + (f.type === 'number' ? ' num' : '') }, blank && f.type !== 'checkbox' ? '—' : val));
}

function recordTable(t) {
  return h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, '№'), t.rows.some((r) => r.kind) ? h('th', {}, 'Вид') : null, t.columns.map((c) => h('th', { title: c }, c.length > 60 ? c.slice(0, 58) + '…' : c)))),
    h('tbody', {}, t.rows.map((r) => h('tr', {}, h('td', { class: 'code' }, r.rowNo || ''), t.rows.some((x) => x.kind) ? h('td', {}, r.kind || '') : null,
      t.columns.map((c) => { const v = r.cells[c] || ''; return h('td', { class: /^-?\d+\.\d{2}$/.test(v) ? 'num' : '' }, /^-?\d+\.\d{2}$/.test(v) ? money(v) : v); }))))));
}

async function showDeclaration(id) {
  currentId = id;
  const it = items.find((x) => x.id === id);
  const { parsed, files } = await nap.get(id);
  for (const el of document.querySelectorAll('#list .item')) el.classList.remove('active');
  refreshList();
  const d = $('#detail');
  d.replaceChildren();
  if (!it) return;
  const cur = currency(it.taxYear);
  const s = (parsed && parsed.summary) || {};
  const has = (f) => files.includes(f);
  const open = (f) => () => nap.open(id, f).catch((e) => alert(e.message));

  d.append(
    h('h1', {}, `${(parsed && parsed.meta.title) || it.form || 'Декларация'} за ${it.taxYear} г.`),
    h('div', { class: 'sub' }, [`Вх. № ${it.inno}`, it.date, it.signer, it.status].filter(Boolean).join(' · ')),
    h('div', { class: 'actions' },
      h('button', { disabled: !has('declaration.html'), onclick: open('declaration.html') }, 'Оригинал (HTML)'),
      h('button', { disabled: !has('declaration.pdf'), onclick: open('declaration.pdf') }, 'PDF'),
      h('button', { disabled: !has('result.html') && !has('result.pdf'), onclick: open(has('result.pdf') ? 'result.pdf' : 'result.html') }, 'Резултат от обработка'),
      has('attachments.html') ? h('button', { onclick: open('attachments.html') }, 'Прикачени документи') : null,
      h('button', { onclick: () => nap.open(id) }, 'Отвори папката'),
      h('button', { class: 'primary', disabled: !parsed, onclick: () => newDraft(id, it.taxYear) }, 'Нова чернова…')));

  if (!parsed) { d.append(h('div', { class: 'warnbox' }, 'Липсва съдържание за тази декларация – изтеглете отново от портала.')); return; }
  for (const w of parsed.warnings) d.append(h('div', { class: 'warnbox' }, w));

  const tiles = [['Обща годишна данъчна основа', s.taxBase], ['Данък върху основата', s.tax], ['Приспаднати данъци', s.taxWithheld],
    ['Дължим данък', s.taxDue], ['Отстъпка', s.discount], ['За довнасяне', s.taxDueAfterDiscount], ['Надвнесен данък', s.overpaid]].filter(([, v]) => v != null);
  const simple = h('div', {});
  if (tiles.length) simple.append(h('div', { class: 'tiles' }, tiles.map(([k, v]) => h('div', { class: 'tile' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, `${money(v)} ${cur}`)))));

  const filter = h('input', { type: 'search', placeholder: 'Търсене в полетата…' });
  const all = h('input', { type: 'checkbox' });
  simple.append(h('div', { class: 'actions' }, filter, h('label', {}, all, ' покажи и празните полета'),
    h('span', { class: 'hint' }, `${parsed.filled} попълнени от ${parsed.fields.length} полета`)));

  const body = h('div', {});
  simple.append(body);
  const host = h('div', {});
  const showMode = async () => {
    host.replaceChildren();
    if (viewMode !== 'nap') { host.append(simple); return; }
    try { host.append(h('iframe', { class: 'napframe', sandbox: '', src: await nap.napViewDeclaration(id) })); } catch (e) { host.append(h('div', { class: 'warnbox' }, cleanError(e))); }
  };
  d.append(viewSwitch(showMode), host);
  showMode();
  const render = () => {
    body.replaceChildren();
    const q = filter.value.trim().toLowerCase();
    let lastSection = null;
    for (const sec of parsed.sections) {
      const fields = sec.fields.filter((f) => (all.checked || !(f.raw === '' || f.value === false))
        && (!q || `${f.label} ${f.column || ''} ${f.code || ''} ${f.raw}`.toLowerCase().includes(q)));
      const tables = q ? sec.tables.filter((t) => JSON.stringify(t).toLowerCase().includes(q)) : sec.tables;
      if (!fields.length && !tables.length) continue;
      if (sec.section !== lastSection) { body.append(h('h2', {}, sec.section)); lastSection = sec.section; }
      if (sec.part) body.append(h('h3', {}, sec.part));
      tables.forEach((t) => body.append(recordTable(t)));
      if (fields.length) body.append(h('table', {}, h('tbody', {}, fields.map(fieldRow))));
    }
    if (!body.children.length) body.append(h('p', { class: 'empty' }, 'Няма съвпадения.'));
  };
  filter.addEventListener('input', render);
  all.addEventListener('change', render);
  render();
  d.scrollTop = 0;
}

// ---- sync -------------------------------------------------------------------
async function doSync(force) {
  const btn = $('#sync');
  btn.disabled = true;
  banner('sync');
  setStatus('Свързване с портала…');
  const r = await nap.sync({ force }).catch((e) => ({ ok: false, message: e.message }));
  btn.disabled = false;
  if (r.ok) {
    const rep = r.report;
    setStatus(`Готово: ${rep.total} декларации, ${rep.downloaded} обновени, ${rep.skipped} без промяна`);
    if (rep.errors.length) banner('sync', `Грешки при изтегляне (${rep.errors.length}): ${rep.errors.slice(0, 3).join('; ')}`, [['Дневник', () => nap.openLog()]]);
    await refreshList();
    if (!currentId && items.length) showDeclaration(items[0].id);
  } else if (r.code === 'LOGIN_REQUIRED') {
    setStatus('Необходим е вход');
    showTab('portal');
    banner('sync', 'Влезте в портала на НАП (с ПИК или КЕП) и натиснете „Изтегли от портала“ отново.', [['Опитай пак', () => doSync(force)]]);
  } else {
    setStatus('Грешка при изтегляне');
    banner('sync', r.message || 'Неуспешно изтегляне.', [['Дневник', () => nap.openLog()]]);
  }
}

// ---- drafts -----------------------------------------------------------------
async function newDraft(id, baseYear) {
  const year = Number(baseYear) + 1;
  const d = await nap.draftFrom(id, year);
  currentDraft = d;
  showTab('drafts');
}

async function loadPortalDraft() {
  banner('portal-draft');
  setStatus('Зареждане на черновата от НАП…');
  const r = await nap.loadPortalDraft();
  if (!r.ok) {
    setStatus('Грешка при зареждане');
    banner('portal-draft', r.code === 'LOGIN_REQUIRED' ? 'Влезте в портала на НАП (раздел „Портал на НАП“) и опитайте пак.' : r.message, [['Дневник', () => nap.openLog()]]);
    return;
  }
  currentDraft = r.draft;
  setStatus(`Черновата за ${r.draft.taxYear} г. е заредена от НАП`);
  if (r.warnings.length) banner('portal-draft', r.warnings.join(' '));
  renderDrafts();
}

async function renderDrafts() {
  const drafts = await nap.drafts();
  const list = $('#draft-list');
  list.replaceChildren(h('div', { class: 'aside-actions' }, h('button', { class: 'primary', title: 'Взема черновата, запазена в портала (изисква вход в портала)', onclick: loadPortalDraft }, 'Зареди чернова от НАП')));
  if (!drafts.length) list.append(h('p', { class: 'empty' }, 'Няма чернови.'));
  for (const d of drafts) {
    list.append(h('div', { class: 'item' + (currentDraft && currentDraft.id === d.id ? ' active' : ''), onclick: () => { currentDraft = d; renderDrafts(); } },
      h('div', { class: 'l1' }, h('span', {}, `Чернова за ${d.taxYear} г.${d.source === 'portal' ? ' (НАП)' : ''}`), h('span', { class: 'tag' }, 'неподадена')),
      h('div', { class: 'l2' }, `по ${d.basedOn} · ${new Date(d.updated).toLocaleString('bg-BG')}`)));
  }
  const el = $('#draft-detail');
  const d = currentDraft && drafts.find((x) => x.id === currentDraft.id);
  if (!d) return;
  currentDraft = d;
  el.replaceChildren();
  const yearInput = h('input', { type: 'number', value: d.taxYear, min: 2000, max: 2100 });
  const body = h('div', {});
  const bodyHost = h('div', {}, body);
  const save = async () => { d.taxYear = Number(yearInput.value) || d.taxYear; currentDraft = await nap.saveDraft(d); setStatus('Черновата е записана'); };

  el.append(
    h('h1', {}, `Чернова за данъчна година ${d.taxYear}`),
    h('div', { class: 'sub' }, d.source === 'portal' ? `Заредена от портала на НАП на ${new Date(d.loadedAt).toLocaleString('bg-BG')}. Формата е изградена със стиловете на портала.` : `Създадена по декларация ${d.basedOn}. Сумите от предходната година са показани за справка и не се пренасят.`),
    h('div', { class: 'warnbox' }, 'Приложението не подава декларации. „Попълни в портала“ само нанася стойностите във формата, отворена в раздел „Портал на НАП“ – '
      + 'проверката и подаването се извършват ръчно от Вас. Формата за новата година може да се различава; непознатите полета се изброяват след попълването.'),
    h('div', { class: 'actions' }, h('label', {}, 'Данъчна година ', yearInput),
      h('button', { class: 'primary', onclick: async () => { await save(); renderDrafts(); } }, 'Запиши'),
      h('button', { onclick: async () => {
        await save();
        showTab('portal');
        const r = await nap.fillDraft(d).catch((e) => ({ error: e.message }));
        banner('fill', r.error ? `Попълването не успя: ${r.error}` : `Попълнени полета: ${r.filled}. Ненамерени във формата: ${r.missing.length}${r.missing.length ? ' (' + r.missing.slice(0, 4).join('; ') + '…)' : ''}. Нищо не е подадено.`);
      } }, 'Попълни в портала'),
      h('button', { class: 'danger', onclick: async () => { if (confirm('Изтриване на черновата?')) { await nap.deleteDraft(d.id); currentDraft = null; el.replaceChildren(); renderDrafts(); } } }, 'Изтрий')),
    importPanel(d, save),
    importReport(d.importReport) || '',
    viewSwitch(() => showMode()),
    bodyHost);

  // a value that came from a statement and was then changed by hand is flagged, so it is not mistaken for imported data
  const touch = (f) => { if (f.source || f.sources) f.edited = true; };
  const editor = (f, inCell) => {
    if (f.type === 'checkbox') return h('input', { type: 'checkbox', checked: f.value === true || f.value === 'X', onchange: (e) => { f.value = e.target.checked ? 'X' : ''; if (/^dec50_part3_issetapp/.test(f.name || '')) rerender(); } });
    if (f.type === 'select' && f.options && f.options.length) {
      return h('select', { onchange: (e) => { f.value = e.target.value; touch(f); } }, ['', ...f.options].map((o) => h('option', { value: o, selected: o === f.value }, o)));
    }
    // in a table cell there is no room for a "previous" line, so last year's value is the placeholder
    return h('input', { type: 'text', value: f.value || '', class: f.type === 'number' ? 'num' : '', placeholder: inCell && f.previous ? f.previous : '',
      title: inCell && f.previous ? `предходна: ${f.previous}` : '', inputMode: f.type === 'number' ? 'decimal' : 'text', oninput: (e) => { f.value = e.target.value.trim(); touch(f); } });
  };
  // Record rows (tr[id] in the form, e.g. A8D5:3) are edited as a table, like in the archive view.
  const tableOf = (f) => (f.rowId && f.rowId.includes(':') ? f.rowId.split(':')[0] : null);
  const colOf = (f) => f.column || f.label || f.columnNo || '';
  const kindOf = (f) => (f.label && f.label !== f.column ? f.label : '');
  const bump = (text, re) => String(text || '').replace(re, (m, a, n, b) => a + (Number(n) + 1) + (b || ''));

  // redrawing empties the form for a moment, which would scroll the page to the top: put the position back
  const rerender = () => { const y = el.scrollTop; render(); el.scrollTop = y; };

  const addRow = (tid) => {
    const rows = [...new Set(d.fields.filter((f) => tableOf(f) === tid).map((f) => f.rowId))];
    const lastId = rows[rows.length - 1];
    const src = d.fields.filter((f) => f.rowId === lastId);
    const newId = bump(lastId, /^(.*:)(\d+)()$/);
    const copy = src.map((f) => ({
      ...f, rowId: newId,
      rowNo: bump(f.rowNo, /^(.*?)(\d+)()$/),
      name: f.name ? bump(f.name, /(enum\[)(\d+)(\])/) : f.name,
      key: String(f.key || '').replace(lastId, newId).replace(/(enum\[)(\d+)(\])/, (m, a, n, b) => a + (Number(n) + 1) + b),
      previous: '', value: '', added: true, manual: true, source: undefined, file: undefined, edited: undefined,
    }));
    d.fields.splice(d.fields.indexOf(src[src.length - 1]) + 1, 0, ...copy);
    rerender();
  };
  const clearRow = (rowId) => {
    const row = d.fields.filter((f) => f.rowId === rowId);
    if (row[0].added) d.fields = d.fields.filter((f) => f.rowId !== rowId); // rows added here are removed outright
    else row.forEach((f) => { f.value = ''; f.previous = ''; });
    rerender();
  };

  const draftTable = (tid, fields) => {
    const columns = [...new Set(fields.map(colOf))];
    const rowIds = [...new Set(fields.map((f) => f.rowId))];
    const shown = rowIds; // the simple view shows everything, empty rows and fields included
    const anyKind = fields.some(kindOf);
    const anySource = fields.some((f) => f.source);
    return [h('div', { class: 'scroll' }, h('table', { class: 'records' },
      h('thead', {}, h('tr', {}, h('th', {}, '№'), anySource ? h('th', {}, 'Източник') : null, anyKind ? h('th', {}, 'Вид') : null,
        columns.map((c) => h('th', { title: c }, c.length > 60 ? c.slice(0, 58) + '…' : c)), h('th', {}, ''))),
      h('tbody', {}, shown.map((id) => {
        const row = fields.filter((f) => f.rowId === id);
        const badge = row[0].source ? sourceBadge(row[0].source, row[0].file, row.some((f) => f.edited)) : h('span', { class: 'src src-manual', title: 'Въведено ръчно' }, 'ръчно');
        return h('tr', {}, h('td', { class: 'code' }, row[0].rowNo || id), anySource ? h('td', { class: 'code' }, badge) : null, anyKind ? h('td', {}, kindOf(row[0])) : null,
          columns.map((c) => { const f = row.find((x) => colOf(x) === c); return h('td', {}, f ? editor(f, true) : ''); }),
          h('td', { class: 'code' }, h('button', { title: 'Изчисти реда', onclick: () => clearRow(id) }, '✕')));
      })))),
    h('div', { class: 'actions' }, h('button', { onclick: () => addRow(tid) }, '+ Добави ред'))];
  };

  // "Част III – Приложения към декларацията" decides which appendices belong to the declaration:
  // an appendix that is not ticked there is locked in the portal, so it is not shown here either.
  const ticked = (f) => f.value === true || f.value === 'X';
  const gates = d.fields.map((f) => [/^dec50_part3_issetapp(\d+)$/.exec(f.name || ''), f]).filter(([m]) => m);
  const locked = (f) => gates.some(([m, g]) => !ticked(g) && (/^\d{1,2}$/.test(m[1])
    ? new RegExp(`^Приложение\\s*№\\s*${m[1]}(?!\\d)`).test(f.section || '') : (f.section || '').includes(m[1])));

  const render = () => {
    body.replaceChildren();
    let last = '';
    let tbody = null;
    const done = new Set();
    for (const f of d.fields) {
      if (locked(f)) continue;
      const tid = tableOf(f);
      if (tid && done.has(tid)) continue;
      const fields = tid ? d.fields.filter((x) => tableOf(x) === tid) : null;
      if (tid) done.add(tid);
      const head = [f.section, f.part].filter(Boolean).join(' › ');
      if (head !== last) { last = head; tbody = null; body.append(h('h3', {}, head)); }
      if (tid) { body.append(...draftTable(tid, fields)); tbody = null; continue; }
      if (!tbody) { tbody = h('tbody', {}); body.append(h('table', {}, tbody)); }
      tbody.append(h('tr', {},
        h('td', { class: 'code' }, [f.rowNo, f.code && `[${f.code}]`].filter(Boolean).join(' ')),
        h('td', {}, f.label, f.column ? h('div', { class: 'prev' }, f.column) : null),
        h('td', { class: 'val' }, editor(f),
          f.sources ? h('div', { class: 'prev' }, Object.entries(f.sources).map(([k, v]) => h('span', { class: 'part' }, sourceBadge(k), ' ' + money(v))), f.edited ? '· променено ръчно' : '') : null,
          f.previous && f.type !== 'checkbox' ? h('div', { class: 'prev' }, `предходна: ${f.previous}`) : null)));
    }
  };

  napEdit = (m) => { // an edit made in the "like NAP" frame
    if (m.napRows) { // a row added or removed with the buttons of a table block (A8D1, ...)
      const rows = [...new Set(d.fields.filter((x) => tableOf(x) === m.block).map((x) => x.rowId))];
      if (m.napRows === 'add') addRow(m.block);
      else if (m.napRows === 'remove') d.fields = d.fields.filter((x) => x.rowId !== rows[rows.length - 1]);
      else d.fields.filter((x) => x.rowId === rows[rows.length - 1]).forEach((x) => { x.value = ''; x.previous = ''; });
      return;
    }
    const f = d.fields.find((x) => x.name === m.name);
    if (f) { f.value = m.type === 'checkbox' ? (m.checked ? 'X' : '') : m.value; touch(f); }
  };
  const showMode = async () => {
    bodyHost.replaceChildren();
    napFrame = null;
    if (viewMode !== 'nap' || d.source !== 'portal') { // only drafts loaded from the portal have its form
      if (viewMode === 'nap') bodyHost.append(h('p', { class: 'hint' }, 'Изгледът „Като в НАП“ е наличен за чернови, заредени от портала (бутон „Зареди чернова от НАП“).'));
      bodyHost.append(body); render(); return;
    }
    try {
      await save();
      napFrame = h('iframe', { class: 'napframe', sandbox: 'allow-scripts', src: await nap.napViewDraft(d.id) });
      bodyHost.append(napFrame);
    } catch (e) { bodyHost.append(h('div', { class: 'warnbox' }, cleanError(e))); }
  };
  showMode();
}

// ---- statement import ---------------------------------------------------------
const SOURCE_NAMES = { auto: 'Автоматично разпознаване', ibkr: 'Interactive Brokers (CSV, PDF)', ibkrconfirm: 'Interactive Brokers – Trade Confirmation (PDF, борси на изпълнение)', revolut: 'Revolut (PDF)', etoro: 'eToro (PDF)', iuvo: 'Iuvo (PDF)' };

function sourceBadge(label, file, edited) {
  const first = String(label).split(' + ')[0].toLowerCase();
  return h('span', { class: `src src-${first.replace(/[^a-z]/g, '')}`, title: [file, edited ? 'променено ръчно след импорта' : ''].filter(Boolean).join(' – ') }, label + (edited ? ' ✎' : ''));
}

const cleanError = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const bg = (iso) => (iso ? iso.split('-').reverse().join('.') : '—');

function importPanel(d, save) {
  const opts = d.importOptions || {};
  const type = h('select', {}, Object.entries(SOURCE_NAMES).map(([k, v]) => h('option', { value: k }, v)));
  const method = h('select', {},
    h('option', { value: 'withheld' }, 'удържан данък → метод 1; без данък → метод 3 и 5%'),
    h('option', { value: 'credit' }, 'обикновен данъчен кредит (метод 3, колони 10–12)'),
    h('option', { value: 'none' }, 'без метод и дължим данък (въвеждам ръчно)'));
  const mode = h('select', {},
    h('option', { value: 'positions' }, 'по един ред за позиция (дата на последната покупка)'),
    h('option', { value: 'lots' }, 'по един ред за всяка покупка'));
  method.value = opts.dividendMethod === 'asBefore' ? 'withheld' : (opts.dividendMethod || 'withheld');
  mode.value = opts.holdingsMode || 'positions';
  const options = () => ({ dividendMethod: method.value, holdingsMode: mode.value });

  const help = h('div', { class: 'help', hidden: true },
    h('p', {}, 'Определя как се попълват колони 5 и 10–12 в Приложение 8, Част III за всеки дивидент. Във всички случаи колона 6 е брутният размер, а колона 9 – данъкът, удържан в чужбина.'),
    h('dl', {},
      h('dt', {}, 'Удържан данък → метод 1; без данък → метод 3 и 5%'),
      h('dd', {}, 'Ако в чужбина е удържан данък, редът е с код на метод 1 и дължим данък 0 (колони 10–12 са 0). Ако не е удържан, редът е с метод 3 и дължим данък 5% от брутния размер.'),
      h('dt', {}, 'Обикновен данъчен кредит'),
      h('dd', {}, 'Всички редове са с метод 3. Колона 10 (допустим кредит) = 5% от брутния размер; колона 11 (признат кредит) = по-малкото от платения в чужбина данък и колона 10; колона 12 (дължим) = колона 10 − колона 11. При удържани под 5% в чужбина остава разлика за довнасяне.'),
      h('dt', {}, 'Без метод и дължим данък'),
      h('dd', {}, 'Попълват се само платец, държава, код 8141, брутен размер и платен в чужбина данък. Метода и колони 10–12 въвеждате сами за всеки ред.')),
    h('p', {}, 'Кой метод е приложим зависи от спогодбата за избягване на двойното данъчно облагане със съответната държава – приложението не го определя вместо Вас.'));
  const helpBtn = h('button', { class: 'round', title: 'Какво означават опциите?', onclick: () => { help.hidden = !help.hidden; } }, '?');

  const run = async (label, fn) => {
    const edited = d.fields.some((f) => f.edited);
    if (edited && !confirm('Има импортирани стойности, променени на ръка. Преизчисляването ще ги замени с данните от извлеченията. Продължаване?')) return;
    setStatus(label);
    try {
      await save();
      const r = await fn();
      if (!r) { setStatus(''); return; }
      currentDraft = r.draft || r;
      const errors = r.errors || [];
      setStatus(r.added ? `Импортирани файлове: ${r.added.length}${errors.length ? `, неуспешни: ${errors.length}` : ''}` : 'Черновата е преизчислена');
      banner('import', errors.length ? `Не са импортирани: ${errors.map((e) => `${e.file} – ${e.message}`).join('; ')}` : null);
      await renderDrafts();
    } catch (e) {
      setStatus('Импортът не успя');
      alert(cleanError(e));
    }
  };

  const imports = d.imports || [];
  const counts = (i) => {
    const s = ((d.importReport && d.importReport.sources) || []).find((x) => x.id === i.id);
    if (!s) return '';
    const c = s.counts;
    return [c.dividends && `${c.dividends} дивидента`, c.holdings && `${c.holdings} реда акции`, c.interest && `лихви ${money(c.interest)} ${d.importReport.unit}`, c.sales && `${c.sales} продажби`, c.fills && `${c.fills} изпълнения с борса`].filter(Boolean).join(', ') || 'няма данни за данъчната година';
  };
  const list = imports.length ? h('div', { class: 'scroll' }, h('table', { class: 'imports' },
    h('thead', {}, h('tr', {}, ['Източник', 'Файл', 'Период', 'Съдържание', ''].map((x) => h('th', {}, x)))),
    h('tbody', {}, imports.map((i) => h('tr', {},
      h('td', { class: 'code' }, sourceBadge(i.label)),
      h('td', {}, i.name, i.statement.kind ? h('div', { class: 'prev' }, i.statement.kind) : null),
      h('td', { class: 'code' }, i.statement.period ? `${bg(i.statement.period.from)} – ${bg(i.statement.period.to)}` : '—'),
      h('td', {}, counts(i)),
      h('td', { class: 'code' },
        h('button', { title: 'Отваря записаното копие на файла', onclick: () => nap.openImport(d.id, i.id).catch((e) => alert(cleanError(e))) }, 'Отвори'), ' ',
        h('button', { class: 'danger', title: 'Премахва данните от този файл от черновата', onclick: () => run('Премахване…', () => nap.removeImport(d.id, i.id)) }, 'Премахни'))))))) : null;

  return h('details', { class: 'panel', open: true },
    h('summary', {}, `Импорт от извлечения${imports.length ? ` (${imports.length})` : ''}`),
    h('div', { class: 'hint' }, 'Поддържат се Interactive Brokers, Revolut, eToro и Iuvo. Може да изберете няколко файла наведнъж, и от различни източници. '
      + 'Попълват се Приложение 8 (акции към 31 декември и дивиденти), Приложение 6 (лихви, код 603) и Приложение 5 (код 508); всеки ред носи етикет с източника си. '
      + 'Копие на всеки файл се записва в папката на съответната година (подпапка statements).'),
    list,
    h('div', { class: 'field' }, h('label', {}, 'Вид на файловете'), type),
    h('div', { class: 'field' }, h('label', {}, 'Дивиденти'), method, helpBtn),
    help,
    h('div', { class: 'field' }, h('label', {}, 'Акции към 31.12'), mode),
    h('div', { class: 'field' }, h('label', {}, ''),
      h('button', { class: 'primary', onclick: () => run('Четене на файловете…', () => nap.addImports(d.id, type.value, options())) }, 'Добави файлове…'),
      imports.length ? h('button', { title: 'Прилага избраните опции към вече импортираните файлове', onclick: () => run('Преизчисляване…', () => nap.recomputeImports(d.id, options())) }, 'Преизчисли с тези опции') : null));
}

function importReport(r) {
  if (!r) return null;
  const n = (v) => (v == null ? '—' : money(v));
  const table = (heads, rows) => h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, heads.map((x) => h('th', { class: x.startsWith('>') ? 'num' : '' }, x.replace(/^>/, ''))))),
    h('tbody', {}, rows.map((cells) => h('tr', {}, cells.map((c, i) => h('td', { class: heads[i].startsWith('>') ? 'num' : '' }, c)))))));
  const b = (x) => sourceBadge(x.source, x.file);
  const s5 = r.sales.app5, s13 = r.sales.app13;
  const warn = (w) => { const m = w.match(/^\[([^\]]+)\] (.*)$/); return m ? h('li', {}, sourceBadge(m[1]), ' ', m[2]) : h('li', {}, w); };
  return h('details', { class: 'panel report', open: true },
    h('summary', {}, `Отчет от импорта (${r.sources.length} файла, ${new Date(r.updatedAt).toLocaleString('bg-BG')})${r.warnings.length ? ` – ${r.warnings.length} за проверка` : ''}`),
    r.applied.length ? h('div', {}, h('h3', {}, 'Попълнено в черновата'), h('ul', {}, r.applied.map((x) => h('li', {}, x)))) : null,
    r.skipped.length ? h('div', {}, h('h3', {}, 'Не е попълнено'), h('ul', {}, r.skipped.map((x) => h('li', {}, x)))) : null,
    r.warnings.length ? h('div', { class: 'warnbox' }, h('strong', {}, 'За проверка'), h('ul', {}, r.warnings.map(warn))) : null,
    r.dividends.length ? h('div', {}, h('h3', {}, `Дивиденти (${r.dividends.length})${r.dividendTaxDue != null ? ` – дължим данък ${money(r.dividendTaxDue)} ${r.unit}` : ''}`),
      table(['Източник', 'Платец', 'Държава', 'Дата', '>Сума', 'Валута', '>Данък в чужбина', `>Брутно, ${r.unit}`, `>Данък в чужбина, ${r.unit}`, 'Метод', `>Дължим, ${r.unit}`],
        r.dividends.map((x) => [b(x), x.symbol, x.country, bg(x.date), n(x.amount), x.currency, n(x.taxAbroad), n(x.gross), n(x.tax), x.method || '—', n(x.due)]))) : null,
    r.holdings.length ? h('div', {}, h('h3', {}, `Акции към 31 декември (${r.holdings.length})`),
      table(['Източник', 'Символ', 'Държава', '>Брой', 'Дата', '>Цена на придобиване', 'Валута', `>В ${r.unit}`, ''],
        r.holdings.map((x) => [b(x), x.symbol, x.country, String(x.quantity), bg(x.date), n(x.price), x.currency, n(x.local), x.fromPrevious ? 'дата от предходната декларация' : '']))) : null,
    r.interest.rows.length ? h('div', {}, h('h3', {}, `Лихви – общо ${money(r.interest.total)} ${r.unit}`),
      table(['Източник', 'Вид', `>Сума, ${r.unit}`], [...r.interest.rows.map((x) => [b(x), x.kind, n(x.amount)]),
        ...(r.interest.taxAbroad ? [['', 'Удържан данък върху лихви (не е приспаднат)', n(r.interest.taxAbroad)]] : [])])) : null,
    r.sales.rows.length ? h('div', {}, h('h3', {}, 'Продажби'),
      table(['Приложение', '>Сделки', `>Продажна цена, ${r.unit}`, `>Цена на придобиване, ${r.unit}`, `>Печалби, ${r.unit}`, `>Загуби, ${r.unit}`],
        [['5 (код 508, облагаеми)', String(s5.count), n(s5.sale), n(s5.cost), n(s5.gains), n(s5.losses)], ['13 (необлагаеми, регулиран пазар ЕС/ЕИП)', String(s13.count), n(s13.sale), n(s13.cost), n(s13.gains), n(s13.losses)]]),
      table(['Източник', 'Символ', 'Придобито', 'Продадено', 'Вид', 'Борса', 'Прил.', `>Продажна цена, ${r.unit}`, `>Цена на придобиване, ${r.unit}`, `>Резултат, ${r.unit}`],
        r.sales.rows.map((x) => [b(x), x.symbol, bg(x.acquired), bg(x.date), x.category, x.exchange ? x.exchange + (x.exchangeBasis === 'venue' ? '' : ' (листинг)') : '—', String(x.app), n(x.sale), n(x.cost), n(x.result)]))) : null,
    r.other.length ? h('div', {}, h('h3', {}, 'Други доходи и корпоративни действия (не са нанесени)'),
      table(['Източник', 'Дата', 'Описание', `>Сума, ${r.unit}`], r.other.map((x) => [b(x), bg(x.date), x.description, n(x.amount)]))) : null,
    r.fees.length ? h('div', {}, h('h3', {}, 'Такси (не са приспаднати)'),
      table(['Източник', 'Описание', `>Сума, ${r.unit}`], r.fees.map((x) => [b(x), x.description, n(x.amount)]))) : null);
}

// ---- exchanges --------------------------------------------------------------
async function renderExchanges(keepScroll) {
  const el = $('#exchanges');
  const top = keepScroll ? el.scrollTop : 0;
  const r = await nap.getRules();
  const rules = { ...r.exchangeRules };
  const save = async (patch) => { Object.assign(r, await nap.setRules(patch)); setStatus('Настройките за борсите са записани'); };
  const quote = (cite, text) => h('blockquote', {}, text, h('cite', {}, cite));
  const word = (exempt) => (exempt ? 'необлагаема' : 'облагаема');

  const chooser = (code, defaultExempt) => {
    const paint = () => {
      const v = rules[code] || (defaultExempt == null ? '' : defaultExempt ? 'exempt' : 'taxable');
      sel.className = `verdict ${v || 'none'}${rules[code] ? '' : ' default'}`;
    };
    const sel = h('select', { onchange: async (e) => {
      if (e.target.value) rules[code] = e.target.value; else delete rules[code];
      paint();
      await save({ exchangeRules: rules });
    } },
      h('option', { value: '' }, defaultExempt == null ? 'не е зададена' : `по подразбиране: ${word(defaultExempt)}`),
      h('option', { value: 'exempt' }, 'необлагаема – Приложение 13'),
      h('option', { value: 'taxable' }, 'облагаема – Приложение 5'));
    sel.value = rules[code] || '';
    paint();
    return sel;
  };
  const rowOf = (e) => h('tr', { class: e.status === 'unclear' ? 'attention' : '' },
    h('td', { class: 'code' }, e.code),
    h('td', {}, h('strong', {}, e.name), h('div', { class: 'hint' }, e.country)),
    h('td', {}, e.note),
    h('td', {}, h('span', { class: `tag ${e.status === 'unclear' ? 'warn' : e.status === 'regulated' ? 'ok' : ''}` }, (e.status === 'unclear' ? '⚠ ' : '') + r.statuses[e.status].label)),
    h('td', {}, chooser(e.code, r.statuses[e.status].exempt)));
  const group = (status, title, intro) => {
    const list = r.catalogue.filter((e) => e.status === status);
    return h('div', {}, h('h3', {}, `${title} (${list.length})`), h('div', { class: 'hint' }, intro),
      h('div', { class: 'scroll' }, h('table', { class: 'exchanges' },
        h('thead', {}, h('tr', {}, ['Код на IBKR', 'Борса', 'Описание', 'Статус', 'Продажба на акции и ETF'].map((x) => h('th', {}, x)))),
        h('tbody', {}, list.map(rowOf)))));
  };

  const known = new Set(r.catalogue.map((e) => e.code));
  const custom = Object.keys(rules).filter((c) => !known.has(c));
  const newCode = h('input', { type: 'text', placeholder: 'код, напр. AQEUDE', size: 14 });
  const newRule = h('select', {}, h('option', { value: 'taxable' }, 'облагаема – Приложение 5'), h('option', { value: 'exempt' }, 'необлагаема – Приложение 13'));
  // multi-select of symbols: chips with a remove button, a text box with suggestions from the imported statements
  const picker = (key, initial, placeholder) => {
    let list = [...initial];
    const chips = h('div', { class: 'chips' });
    const dl = h('datalist', { id: `dl-${key}` });
    const input = h('input', { type: 'text', list: `dl-${key}`, placeholder, size: 18 });
    const persist = async () => { await save({ [key]: list }); };
    const draw = () => {
      chips.replaceChildren(...list.map((x) => h('span', { class: 'chip' }, x,
        h('button', { title: 'Премахни', onclick: async () => { list = list.filter((y) => y !== x); draw(); await persist(); } }, '×'))));
      dl.replaceChildren(...(r.knownSymbols || []).filter((x) => !list.includes(x)).map((x) => h('option', { value: x })));
    };
    const add = async () => {
      const added = input.value.split(/[^A-Za-z0-9._-]+/).map((x) => x.trim().toUpperCase()).filter((x) => x && !list.includes(x));
      input.value = '';
      if (!added.length) return;
      list = [...list, ...added]; draw(); await persist();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } });
    input.addEventListener('change', add);
    draw();
    return h('div', { class: 'picker' }, chips, h('div', { class: 'field' }, input, dl, h('button', { onclick: add }, 'Добави')));
  };
  const exemptPicker = picker('exemptSymbols', r.exemptSymbols || [], 'символ, напр. VWCE');
  const taxablePicker = picker('taxableSymbols', r.taxableSymbols || [], 'символ, напр. XSLR');

  el.replaceChildren(
    h('h1', {}, 'Борси и облагане на продажби на акции и ETF'),
    h('div', { class: 'sub' }, 'Определя в кое приложение влиза всяка продажба: Приложение 13 (необлагаема) или Приложение 5, код 508 (облагаема, 10% върху печалбата след 10% разходи).'),

    h('details', { class: 'panel law', open: true },
      h('summary', {}, 'Какво казва законът'),
      h('p', {}, 'Продажбата на акции и дялове на фондове е необлагаема само ако е „извършена на регулиран пазар“ (или, от 2026 г., на „пазар за растеж“). Определящо е мястото на сделката, а не къде е листнато книжото. Ето верижката от текстове (ЗДДФЛ в редакцията, в сила от 01.01.2026 г.; за по-ранни години проверете редакцията към датата на продажбата):'),
      quote('чл. 13, ал. 1, т. 3 ЗДДФЛ', '„Не са облагаеми: … 3. доходите от разпореждане с финансови инструменти по смисъла на § 1, т. 11 от допълнителните разпоредби;“'),
      quote('§ 1, т. 11, б. „а“ ДР на ЗДДФЛ', '„„Разпореждане с финансови инструменти“ за целите на чл. 13, ал. 1, т. 3 са сделките: а) с дялове и акции на колективни инвестиционни схеми и на национални инвестиционни фондове, акции, права и държавни ценни книжа, извършени на регулиран пазар и/или на пазар за растеж; …“'),
      quote('§ 1, т. 65 ДР на ЗДДФЛ → § 1, т. 70 ДР на ЗКПО', '„„Регулиран пазар“ е този по смисъла на чл. 152, ал. 1 и 2 от Закона за пазарите на финансови инструменти.“'),
      quote('чл. 152, ал. 2 ЗПФИ', '„Регулиран пазар е и всяка многостранна система, която е лицензирана и функционира като регулиран пазар в съответствие с изискванията на Директива 2014/65/ЕС.“'),
      h('p', {}, 'Така „регулиран пазар“ е всяка борса с лиценз за такъв по европейската директива (MiFID II) – във всяка държава членка, а чрез ЕИП и в Норвегия, Исландия и Лихтенщайн. ЗДДФЛ не изброява борси. Многостранните системи за търговия (МСТ) не са регулирани пазари; от 2026 г. изключение правят само тези от тях, които са лицензирани като „пазар за растеж“.'),
      h('p', {}, 'Облагаемите продажби са по чл. 33, ал. 3 и 4: печалбите и загубите по всяка сделка за годината се сумират, а сборът се намалява с 10% нормативно признати разходи; при различни цени на придобиване на книжа от един вид и издател се ползва средно претеглената цена. Данъкът е 10% (чл. 48, ал. 1).'),

      h('h3', {}, 'Защо не винаги е ясно кое е облагаемо'),
      h('ul', {},
        h('li', {}, 'Законът гледа къде е изпълнена сделката, а отчетът на IBKR (Activity Statement) показва само борсата на листване. Борсата на изпълнение се вижда в „Trade Confirmation“ – импортирайте го към черновата, за да се ползва тя.'),
        h('li', {}, 'IBKR насочва една поръчка към няколко места (напр. част на gettex, част на Xetra, част в dark pool) и тогава продажбата се разделя между Приложение 13 и 5.'),
        h('li', {}, 'Немските борси (Tradegate, gettex, Щутгарт, Франкфурт) работят едновременно с регулиран пазар и с Open Market (Freiverkehr), който е МСТ. Един и същ код може да означава и двете – зависи в кой сегмент са допуснати конкретните книжа.'),
        h('li', {}, 'Няма официален списък на „регулираните пазари“ в закона. Регистърът на ESMA (MiFID II) е най-близкото до такъв, но не е посочен в ЗДДФЛ.'),
        h('li', {}, 'ETC и ETN (напр. злато, сребро, жито) са дългови ценни книжа, а не дялове на фонд или акции – по буквата на § 1, т. 11 не попадат в освобождаването, макар IBKR да ги нарича „ETF“.'),
        h('li', {}, 'За момента няма становище на НАП, което да решава тези случаи. Затова неясните борси са облагаеми по подразбиране (по-безопасният избор) и са отбелязани с ⚠.')),
      h('p', { class: 'hint' }, 'Това не е правна консултация. При значителни суми проверете избора с данъчен консултант или със запитване до НАП.')),

    h('h2', {}, 'Инструменти'),
    h('div', { class: 'field' }, h('label', {}, h('input', { type: 'checkbox', checked: r.etcTaxable, onchange: async (e) => { await save({ etcTaxable: e.target.checked }); } }),
      ' Третирай ETC/ETN като облагаеми (разпознават се по името, напр. „… PHYSICAL SILVER ETC“)')),
    h('div', { class: 'field' }, h('label', {}, 'Винаги облагаеми символи')), taxablePicker,
    h('div', { class: 'hint' }, 'IBKR не винаги отбелязва ETC в името (напр. „WT WHEAT“) – добавете такива символи ръчно.'),
    h('div', { class: 'warnbox exempt-box' },
      h('strong', {}, '⚠ Винаги необлагаеми символи – не отговаря на закона'),
      h('p', {}, 'Продажбите на тези инструменти отиват в Приложение 13 (необлагаеми) независимо от борсата, на която са изпълнени, и от вида на книжата. Законът не работи така: необлагаемостта зависи от мястото на сделката (регулиран пазар) и от вида на инструмента. Използвайте тази настройка само ако сте напълно сигурни, че продажбите са необлагаеми – иначе рискувате да декларирате по-малък данък. Ако символът е и в списъка „Винаги облагаеми“, той остава облагаем.'),
      h('div', { class: 'field' }, h('label', {}, 'Винаги необлагаеми символи')), exemptPicker),

    h('h2', {}, 'Борси'),
    h('div', { class: 'actions' }, h('button', { class: 'danger', onclick: async () => {
      if (!confirm('Връщане на всички настройки в този раздел към първоначалните: ръчните избори за борси, списъците със символи и опцията за ETC/ETN?')) return;
      await save({ exchangeRules: {}, taxableSymbols: [], exemptSymbols: [], etcTaxable: true });
      renderExchanges(true);
    } }, 'Върни всичко по подразбиране')),
    h('div', { class: 'hint' }, 'Промените се прилагат при следващото преизчисляване на чернова („Преизчисли с тези опции“ или добавяне на файл). Редовете с ⚠ изискват Вашето внимание.'),
    group('unclear', '⚠ Не е ясно', 'Сегментът на конкретните книжа решава. Задайте „необлагаема“ само ако сте проверили, че книжата са допуснати до регулиран пазар и сделката е изпълнена там.'),
    group('regulated', 'Регулирани пазари в ЕС/ЕИП', 'Продажбите са необлагаеми (Приложение 13, само за отчитане).'),
    group('mtf', 'Не са регулирани пазари (МСТ, dark pool)', 'Облагаеми – освен ако системата е лицензирана като „пазар за растеж“ (тогава сменете избора ръчно).'),
    group('outside', 'Извън ЕС/ЕИП', 'Облагаеми (Приложение 5, код 508).'),

    h('h3', {}, `Други кодове (${custom.length})`),
    h('div', { class: 'hint' }, 'Код, който го няма в списъка, се третира като облагаем и в отчета от импорта се появява предупреждение. Тук може да зададете правило за него.'),
    custom.length ? h('table', { class: 'exchanges' }, h('tbody', {}, custom.map((c) => h('tr', {},
      h('td', { class: 'code' }, c), h('td', {}, chooser(c, null)),
      h('td', {}, h('button', { onclick: async () => { delete rules[c]; await save({ exchangeRules: rules }); renderExchanges(true); } }, 'Премахни')))))) : '',
    h('div', { class: 'field' }, newCode, newRule,
      h('button', { onclick: async () => {
        const code = newCode.value.trim().toUpperCase();
        if (!/^[A-Z0-9._-]{1,16}$/.test(code)) { alert('Невалиден код.'); return; }
        rules[code] = newRule.value;
        await save({ exchangeRules: rules });
        renderExchanges(true);
      } }, 'Добави')));
  el.scrollTop = top;
}

// ---- settings ---------------------------------------------------------------
async function renderSettings() {
  state = await nap.state();
  const el = $('#settings');
  const c = state.credentials;
  const user = h('input', { type: 'text', placeholder: 'ЕГН / потребител', autocomplete: 'off' });
  const pass = h('input', { type: 'password', placeholder: 'ПИК / парола', autocomplete: 'new-password' });
  const toggle = (key, label, hint) => h('div', {},
    h('div', { class: 'field' }, h('label', {}, h('input', { type: 'checkbox', checked: state.settings[key], onchange: async (e) => { await nap.setSetting(key, e.target.checked); await refreshState(); } }), ' ' + label)),
    h('div', { class: 'hint' }, hint));

  el.replaceChildren(
    h('h2', {}, 'Данни за вход'),
    h('div', { class: 'hint' }, c.available
      ? 'Данните се криптират с Windows DPAPI (обвързани с текущия Windows потребител) и се използват единствено за попълване на формата за вход в portal.nra.bg.'
      : 'Системното криптиране не е достъпно – данните за вход не могат да бъдат записани.'),
    h('div', { class: 'field' }, h('label', {}, 'Състояние'), h('strong', {}, c.saved ? `Записани (${c.username})` : 'Няма записани данни'),
      c.saved ? h('button', { class: 'danger', onclick: async () => { await nap.clearCredentials(); renderSettings(); } }, 'Изтрий') : null),
    h('div', { class: 'field' }, h('label', {}, c.saved ? 'Замяна' : 'Нови данни'), user, pass,
      h('button', { class: 'primary', disabled: !c.available, onclick: async () => {
        try { await nap.saveCredentials(user.value, pass.value); renderSettings(); setStatus('Данните за вход са записани'); } catch (e) { alert(e.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); }
      } }, 'Запиши')),
    toggle('autoSubmit', 'Автоматично натискане на бутона за вход', 'Изпълнява се най-много веднъж на стартиране, за да не се заключи достъпът при грешна парола. Без тази опция формата само се попълва.'),

    h('h2', {}, 'Защита от подаване'),
    toggle('readOnly', 'Режим „само четене“', 'Блокира заявките към портала, които записват или подават документи. Изключете го само когато сами подавате декларация през раздел „Портал на НАП“.'),

    h('h2', {}, 'Локален архив'),
    h('div', { class: 'field' }, h('label', {}, 'Папка'), h('code', {}, state.settings.dataDir),
      h('button', { onclick: async () => { await nap.chooseDataDir(); await refreshList(); renderSettings(); } }, 'Промени…'),
      h('button', { onclick: () => nap.open(null) }, 'Отвори')),
    h('div', { class: 'field' }, h('label', {}, 'Изтегляне'),
      h('button', { onclick: () => doSync(true) }, 'Изтегли всичко наново'),
      h('button', { onclick: async () => {
        const r = await nap.importHtml();
        if (r.errors.length) alert(r.errors.join('\n'));
        await refreshList();
        if (r.done.length) { showTab('archive'); showDeclaration(r.done[0]); }
      } }, 'Импорт на записан HTML файл…')),
    h('div', { class: 'hint' }, 'За всяка декларация се пазят оригиналният HTML, PDF файлът, резултатът от обработката и разчетените данни (parsed.json).'));
}

async function refreshState() {
  state = await nap.state();
  const b = $('#ro-badge');
  b.textContent = state.settings.readOnly ? 'само четене' : 'подаването е разрешено';
  b.classList.toggle('off', !state.settings.readOnly);
  $('#portal-url').textContent = state.portalUrl;
  if (state.pendingLogin) offerSave(state.pendingLogin);
}

function offerSave(p) {
  banner('creds', `Да се запомнят ли данните за вход${p.username ? ` за ${p.username}` : ''}? Ще бъдат криптирани с Windows DPAPI.`, [
    ['Запомни', async () => { await nap.acceptPendingLogin(true); banner('creds'); setStatus('Данните за вход са записани'); }],
    ['Не', async () => { await nap.acceptPendingLogin(false); banner('creds'); }]]);
}

// ---- wiring -----------------------------------------------------------------
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => nap.portalNavigate(b.dataset.nav)));
$('#sync').addEventListener('click', () => doSync(false));
nap.on('sync:progress', (p) => setStatus(p.text));
nap.on('portal:url', (u) => { $('#portal-url').textContent = u; });
nap.on('creds:pending', offerSave);
nap.on('portal:blocked', (b) => banner('blocked', `Блокирана заявка към портала (режим „само четене“): ${b.method} ${new URL(b.url).pathname}`));

// the list of drafts can be folded away to leave more room for the form
const draftTab = $('#tab-drafts');
const foldDrafts = (folded) => {
  draftTab.classList.toggle('collapsed', folded);
  $('#draft-toggle').textContent = folded ? '›' : '‹';
  $('#draft-toggle').title = folded ? 'Покажи списъка с чернови' : 'Скрий списъка с чернови';
  try { localStorage.setItem('nap-drafts-folded', folded ? '1' : ''); } catch { /* ignore */ }
};
$('#draft-toggle').addEventListener('click', () => foldDrafts(!draftTab.classList.contains('collapsed')));
try { if (localStorage.getItem('nap-drafts-folded')) foldDrafts(true); } catch { /* storage unavailable */ }

(async () => {
  await refreshState();
  await refreshList();
  if (items.length) showDeclaration(items[0].id);
})();
