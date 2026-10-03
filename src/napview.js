'use strict';
// The "like NAP" view: pages that look like the portal's own, shown in a sandboxed frame.
//  - a filed declaration is the portal's viewDocument page as it was downloaded (it carries its own styles);
//  - a draft loaded from the portal is the form the portal draws from its XSLT stylesheets, with the
//    draft's current values put into the controls, a part menu like the portal's left menu, and parts
//    that are not ticked in "Част III" locked.
// Nothing from the page is trusted: scripts, frames, links to other files and event attributes are
// removed, and the only script is the one below (menu + reporting edits back to the app).

const cheerio = require('cheerio');
const { fixEntities } = require('./xslt');

const FORM_CSS = `
html, body { margin: 0; background: #fff; font: 9pt Verdana, Arial, sans-serif; color: #495668; }
table.form { margin: 20px auto; border: 1px solid #495668; font-size: 9pt; border-collapse: collapse; background-color: #fafafa; color: #495668; }
table.form th { padding: 3px; color: white; background-color: #627692; font-weight: bold; border: 1px solid #495668; text-align: center; }
table.form td { white-space: normal; border: 1px solid #495668; }
table.form tr.footer td { border-bottom: 1px solid #495668; background-color: #ced7e3; }
table.form tr.header td { border-bottom: 1px solid #495668; background-color: #ced7e3; }
table.form td.info { background-color: #f8faea; padding: 5px; text-align: justify; }
table.form td.index { background-color: #e8e8e8; font-size: 8pt; font-family: arial; white-space: nowrap; width: 50px; text-align: center; }
table.noborder, table.noborder td { border: 0 none; font-size: 9pt; color: #495668; }
span.value { display: inline-block; background-color: #E9EDEF; border: 1px solid #999; color: black; line-height: 10pt; min-width: 50px; margin: 0 5px; padding: 0 5px; }
span.checkbox { display: inline-block; margin: 0 4px; background-color: #E9EDEF; border: 1px solid #999; line-height: 10pt; text-align: center; width: 12pt; color: green; }
.right { text-align: right; } .center { text-align: center; } .left { text-align: left; }
input[type=text], input:not([type]), select, textarea { font: 9pt Verdana, Arial, sans-serif; color: #000; background: #fff; border: 1px solid #8399AC; padding: 1px 3px; box-sizing: border-box; max-width: 100%; }
input.cell, input.right, input.left { width: 96%; }
input[type=text]:focus, select:focus, textarea:focus { outline: 2px solid #9fb6d6; background: #fffff0; }
input[type=checkbox] { vertical-align: middle; }
table.form img, .invisible, .blockcontrols, #nap-main button:not([data-nap-add]):not([data-nap-remove]), #nap-main input[type=button], #nap-main input[type=submit] { display: none; }
#nap-main button[data-nap-add], #nap-main button[data-nap-remove] { font: 9pt Verdana, Arial, sans-serif; margin: 2px; padding: 2px 8px; border: 1px solid #627692; background: #e3eaf3; color: #1f2d44; border-radius: 3px; cursor: pointer; }
`;

const CHROME_CSS = `
#nap-head { background: #3c5170; color: #fff; padding: 8px 14px; font-size: 11pt; font-weight: bold; }
#nap-head small { font-weight: normal; opacity: .85; margin-left: 10px; }
#nap-layout { display: flex; align-items: flex-start; }
#nap-menu { width: 250px; flex: none; position: sticky; top: 0; max-height: 100vh; overflow: auto; background: #ced7e3; border-right: 1px solid #495668; padding: 6px 0; }
#nap-menu button { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid #b4c0d0; background: none; padding: 6px 10px 6px 28px; cursor: pointer; position: relative; color: #1f2d44; font: bold 9pt Verdana, Arial, sans-serif; }
#nap-menu button small { display: block; font-weight: normal; font-size: 7.5pt; color: #495668; margin-top: 2px; }
#nap-menu button:hover { background: #e3eaf3; }
#nap-menu button.active { background: #fff; box-shadow: inset 3px 0 0 #3c5170; }
#nap-menu button.locked { color: #8a96a6; cursor: not-allowed; }
#nap-menu button::before { content: ""; position: absolute; left: 9px; top: 9px; width: 11px; height: 11px; border-radius: 2px; background: #8e99a8; border: 1px solid #5f6b7a; } /* no status (e.g. Част V): darker grey than the locked / not-applicable ones */
#nap-menu button.status2::before { background: #3a9d5d; border-color: #1f6b3a; }
#nap-menu button.status4::before, #nap-menu button.locked::before { background: #c4ccd6; border-color: #8a96a6; }
#nap-main { flex: 1; min-width: 0; padding: 0 12px 40px; }
#nap-main > section { display: none; }
#nap-main > section.active { display: block; }
#nap-main .nap-locked { margin: 30px auto; max-width: 600px; padding: 14px; border: 1px solid #b08a2e; background: #fff4dc; text-align: center; }
`;

const SCRIPT = String.raw`
(function () {
  var menu = document.getElementById('nap-menu');
  var show = function (key) {
    [].forEach.call(document.querySelectorAll('#nap-main > section'), function (s) { s.className = s.getAttribute('data-part') === key ? 'active' : ''; });
    [].forEach.call(menu.querySelectorAll('button'), function (b) { b.classList[b.getAttribute('data-go') === key ? 'add' : 'remove']('active'); });
    window.scrollTo(0, 0);
  };
  menu.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (b && !b.classList.contains('locked')) show(b.getAttribute('data-go'));
  });
  var gates = function (el) {
    [].forEach.call(menu.querySelectorAll('button[data-gate]'), function (b) {
      var c = document.getElementsByName(b.getAttribute('data-gate'))[0];
      if (c && (!el || el === c)) b.classList[c.checked ? 'remove' : 'add']('locked');
    });
  };
  var send = function (e) {
    var t = e.target;
    if (!t || !t.name) return;
    if (/^dec50_part3_issetapp/.test(t.name)) gates(t);
    parent.postMessage({ napEdit: true, name: t.name, type: t.type, value: t.value, checked: !!t.checked }, '*');
  };
  document.addEventListener('input', send);
  document.addEventListener('change', send);
  // Dynamic rows of a table block (A8D1, ...): the same buttons as in the portal
  var blockRows = function (block) {
    return [].filter.call(document.querySelectorAll('tr[id^="' + block + ':"]'), function (r) { return r.id.split(':')[0] === block; });
  };
  var renumber = function (row, block, from, to) {
    var p = block + ':' + from;
    var swap = function (v) { return v === p || v.indexOf(p + '_') === 0 ? block + ':' + to + v.slice(p.length) : v; };
    [row].concat([].slice.call(row.querySelectorAll('*'))).forEach(function (el) {
      ['id', 'blockid'].forEach(function (a) { if (el.hasAttribute(a)) el.setAttribute(a, swap(el.getAttribute(a))); });
      if (el.hasAttribute('name')) el.setAttribute('name', el.getAttribute('name').replace('[' + from + ']', '[' + to + ']'));
    });
    var num = row.querySelector('td[id=num]');
    if (num) num.textContent = num.textContent.replace(/\d+(?=\.?\s*$)/, to);
  };
  var clearRow = function (row) {
    [].forEach.call(row.querySelectorAll('input, select, textarea'), function (el) {
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = false;
      else if (el.tagName === 'SELECT') el.selectedIndex = 0;
      else el.value = '';
    });
  };
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-nap-add], button[data-nap-remove]');
    if (!b) return;
    var add = b.hasAttribute('data-nap-add');
    var block = b.getAttribute(add ? 'data-nap-add' : 'data-nap-remove');
    var rows = blockRows(block);
    if (!rows.length) return;
    var last = rows[rows.length - 1];
    var n = +last.id.split(':')[1];
    if (add) {
      var copy = last.cloneNode(true);
      renumber(copy, block, n, n + 1);
      clearRow(copy);
      last.parentNode.insertBefore(copy, last.nextSibling);
    } else if (rows.length > 1) last.parentNode.removeChild(last);
    else clearRow(last);
    parent.postMessage({ napRows: add ? 'add' : rows.length > 1 ? 'remove' : 'clear', block: block }, '*');
  });
  var first = menu.querySelector('button:not(.locked)');
  if (first) show(first.getAttribute('data-go'));
})();
`;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Remove everything executable or loading from elsewhere. */
function sanitize($) {
  // the portal's "add row" / "remove last row" buttons are redone by the page script; remember which is which
  $('button[onclick]').each((_, el) => {
    const on = String(el.attribs.onclick);
    const kind = /addDynamicElement/.test(on) ? 'data-nap-add' : /removeDynamicElement/.test(on) ? 'data-nap-remove' : null;
    if (kind && el.attribs.id) el.attribs[kind] = el.attribs.id;
  });
  $('script, iframe, frame, object, embed, applet, link, base, meta[http-equiv]').remove();
  $('*').each((_, el) => {
    for (const a of Object.keys(el.attribs || {})) {
      const v = String(el.attribs[a]);
      if (/^on/i.test(a) || (/^(href|src|action|formaction|xlink:href)$/i.test(a) && !/^\s*(#|data:image\/)/i.test(v))) $(el).removeAttr(a);
    }
  });
  return $;
}

/** A filed declaration: the downloaded viewDocument page, made inert. */
function declarationPage(html) {
  const $ = sanitize(cheerio.load(html));
  $('head').prepend('<meta charset="utf-8">');
  return $.html();
}

const isOn = (v) => v === true || v === 'X' || v === 'true' || v === 'on';

/** Put the draft's values into the controls of the drawn form. */
function applyValues($, fields) {
  const byName = new Map();
  $('input[name], select[name], textarea[name]').each((_, el) => { const n = el.attribs.name; if (!byName.has(n)) byName.set(n, el); });
  for (const f of fields) {
    const el = f.name && byName.get(f.name);
    if (!el) continue;
    const $el = $(el);
    const v = f.value == null ? '' : f.value;
    if (el.tagName === 'select') {
      $el.find('option').each((_, o) => { if (String(o.attribs.value ?? $(o).text()) === String(v)) o.attribs.selected = 'selected'; else delete o.attribs.selected; });
    } else if (el.tagName === 'textarea') $el.text(String(v));
    else if ((el.attribs.type || '').toLowerCase() === 'checkbox') { if (isOn(v)) $el.attr('checked', 'checked'); else $el.removeAttr('checked'); }
    else $el.attr('value', String(v));
  }
}

const BLOCK_ROW = /^(\w+):(\d+)$/;
const rowsOf = ($, block) => $('tr[id]').filter((_, el) => el.attribs.id.split(':')[0] === block && BLOCK_ROW.test(el.attribs.id)).toArray();

/** A copy of a record row for index "to" with its ids and names renumbered and its values cleared. */
function cloneRow($, row, block, from, to) {
  const copy = $(row).clone();
  const p = block + ':' + from;
  const swap = (v) => (v === p || v.startsWith(p + '_') ? block + ':' + to + v.slice(p.length) : v);
  copy.find('*').addBack().each((_, el) => {
    for (const a of ['id', 'blockid']) if (el.attribs && el.attribs[a] != null) el.attribs[a] = swap(el.attribs[a]);
    if (el.attribs && el.attribs.name) el.attribs.name = el.attribs.name.replace('[' + from + ']', '[' + to + ']');
    if (el.attribs) { delete el.attribs.value; delete el.attribs.checked; }
  });
  copy.find('option').each((_, o) => { delete o.attribs.selected; });
  copy.find('textarea').text('');
  copy.find('td[id=num]').each((_, td) => { $(td).text($(td).text().replace(/\d+(?=\.?\s*$)/, String(to))); });
  return copy;
}

/** Make the form have exactly the record rows the draft has (rows can be added or removed in the simple view). */
function matchRows($, fields) {
  const want = new Map();
  for (const f of fields) {
    const m = BLOCK_ROW.exec(f.rowId || '');
    if (m) want.set(m[1], Math.max(want.get(m[1]) || 0, Number(m[2])));
  }
  for (const [block, max] of want) {
    let rows = rowsOf($, block);
    if (!rows.length) continue;
    while (rows.length > max && rows.length > 1) $(rows.pop()).remove();
    let last = rows[rows.length - 1];
    let n = Number(last.attribs.id.split(':')[1]);
    while (n < max) { const copy = cloneRow($, last, block, n, n + 1); $(last).after(copy); last = copy[0]; n++; }
  }
}

/** The portal fills country lists with a script; do the same, and make sure the draft's own value is among them. */
function fillCountries($, fields, countries) {
  const values = new Map(fields.filter((f) => f.name).map((f) => [f.name, f.value]));
  $('select[name]').each((_, sel) => {
    if (!/country/i.test(sel.attribs.name) || $(sel).find('option').length > 1) return;
    const foreign = /^dec50_app8_/.test(sel.attribs.name); // property abroad: Bulgaria is not on the list
    const list = countries.filter((c, i) => !(foreign && i === 0));
    const v = values.get(sel.attribs.name);
    if (v && !list.includes(v)) list.push(v);
    $(sel).append(list.map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join(''));
  });
}

/** A draft loaded from the portal: `parts` are [{ key, title, caption, status, html }]. */
function draftPage(parts, fields, { year, title, countries = [] } = {}) {
  const $ = sanitize(cheerio.load(`<body>${parts.map((p) => `<section data-part="${esc(p.key)}">${fixEntities(p.html)}</section>`).join('')}</body>`));
  matchRows($, fields);
  fillCountries($, fields, countries);
  applyValues($, fields);
  const gate = (key) => (/^dec50_app(\d+)$/.exec(key) || [])[1];
  const ticked = new Map(fields.filter((f) => /^dec50_part3_issetapp\d+$/.test(f.name || '')).map((f) => [f.name, isOn(f.value)]));
  const gateName = (key) => (gate(key) ? `dec50_part3_issetapp${gate(key)}` : null);
  const locked = (key) => { const g = gateName(key); return !!g && ticked.has(g) && !ticked.get(g); };
  const menu = parts.map((p) => `<button type="button" class="status${esc(p.status)}${locked(p.key) ? ' locked' : ''}" data-go="${esc(p.key)}"${gateName(p.key) ? ` data-gate="${esc(gateName(p.key))}"` : ''}>${esc(p.title)}${p.caption ? `<small>${esc(p.caption)}</small>` : ''}</button>`).join('');
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><title>${esc(title || 'Чернова')}</title><style>${FORM_CSS}${CHROME_CSS}</style></head><body>`
    + `<div id="nap-head">Декларация по чл. 50 от ЗДДФЛ${year ? ` за ${esc(year)} г.` : ''}<small>чернова – нищо не е подадено</small></div>`
    + `<div id="nap-layout"><nav id="nap-menu">${menu}</nav><div id="nap-main">${$('body').html()}</div></div><script>${SCRIPT}</script></body></html>`;
}

module.exports = { declarationPage, draftPage, applyValues, sanitize, FORM_CSS };
