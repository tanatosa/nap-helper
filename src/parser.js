'use strict';
// Format-agnostic parser for NRA declaration "viewDocument" pages.
//
// The form layout changes from year to year, so nothing here depends on a
// particular year's schema. The parser only relies on the rendering
// conventions of the portal's stylesheet:
//   span.value      - a filled-in value
//   span.checkbox   - a tick box ("X" when ticked)
//   select          - a code list (selected option is the value)
//   td.index        - the official row code (e.g. 4001)
//   th              - headings ("Приложение № N", "Част ...", "3. Име")
//   tr[id]          - a repeating record row (e.g. A8D5:3)
// Everything else (labels, column headers, sections) is derived from position.

const cheerio = require('cheerio');

const VALUE_SEL = 'span.value, span.checkbox, select, input, textarea';
const PARSER_VERSION = 1;

const clean = (s) => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

// Roman numerals in the portal are a mix of Latin and Cyrillic lookalikes.
const ROMAN = '[IVXІХ]+';
const RE_APPENDIX = /^(?:Образец\s*\d+\s*)?(Приложение\s*№\s*\d+)/i;
const RE_PART = new RegExp('^Част\\s+' + ROMAN, 'i');
const RE_GROUP = /^\d+(\.\d+)*\.?\s+\S/;
const RE_ROWNO = /^\d+(\.\d+)*\.?$/;

function parseNumber(raw) {
  const s = raw.replace(/\s/g, '');
  if (/^-?\d+([.,]\d+)?$/.test(s)) return Number(s.replace(',', '.'));
  return null;
}

/** Lay out a table's direct rows on a grid, honouring rowspan/colspan. */
function buildGrid($, table) {
  const rows = $(table).children('thead, tbody, tfoot').children('tr').add($(table).children('tr')).toArray();
  const occupied = []; // occupied[r][c] = true
  const cellCols = new Map(); // cell element -> {start, end}
  rows.forEach((tr, r) => {
    occupied[r] = occupied[r] || [];
    let c = 0;
    $(tr).children('td, th').each((_, cell) => {
      while (occupied[r][c]) c++;
      const cs = Math.max(1, parseInt($(cell).attr('colspan'), 10) || 1);
      const rs = Math.max(1, parseInt($(cell).attr('rowspan'), 10) || 1);
      for (let dr = 0; dr < rs; dr++) {
        occupied[r + dr] = occupied[r + dr] || [];
        for (let dc = 0; dc < cs; dc++) occupied[r + dr][c + dc] = true;
      }
      cellCols.set(cell, { start: c, end: c + cs - 1, row: r, rowEnd: r + rs - 1 });
      c += cs;
    });
  });
  return { rows, cellCols };
}

function parseDeclaration(html) {
  const $ = cheerio.load(html);
  const warnings = [];
  const bodyText = clean($('body').text());

  // ---- metadata -----------------------------------------------------------
  const meta = { parserVersion: PARSER_VERSION };
  let m = bodyText.match(/Входящ номер\s*:\s*([^\s,]+)[\s\S]{0,20}?дата\s*:\s*(\d{2}\.\d{2}\.\d{4})/);
  if (m) { meta.incomingNumber = m[1]; meta.incomingDate = m[2]; }
  m = bodyText.match(/Образец\s*(\d{4})/);
  if (m) meta.formCode = m[1];
  const h1 = $('h1').toArray().map((e) => clean($(e).text())).filter((t) => !/АГЕНЦИЯ/.test(t));
  if (h1.length) meta.title = h1[0];
  const h2 = clean($('h2').first().text());
  if (h2) meta.subtitle = h2;
  $('th').each((_, th) => {
    if (meta.taxYear || !/Данъчна година/.test($(th).text())) return;
    const digits = $(th).nextAll('td').toArray().map((td) => clean($(td).text())).join('');
    if (/^\d{4}$/.test(digits)) meta.taxYear = Number(digits);
  });
  const xmlns = $('form').toArray().map((f) => Object.entries(f.attribs || {}).find(([k]) => k.startsWith('xmlns'))).find(Boolean);
  if (xmlns) {
    meta.schema = xmlns[1];
    if (!meta.taxYear) { const y = xmlns[1].match(/(20\d{2})/); if (y) meta.taxYear = Number(y[1]); }
  }

  // ---- fields -------------------------------------------------------------
  const MAIN = meta.title ? 'Декларация' : 'Документ';
  let section = MAIN, part = '', group = '';
  const fields = [];
  const grids = new Map();
  const headerCache = new Map();
  const gridOf = (table) => {
    if (!grids.has(table)) grids.set(table, buildGrid($, table));
    return grids.get(table);
  };

  const ownValues = (tr) => $(tr).find(VALUE_SEL).toArray().filter((el) => $(el).closest('tr')[0] === tr);

  // Column headers of a table: rows that carry no values and look like headers.
  const headersOf = (table) => {
    if (headerCache.has(table)) return headerCache.get(table);
    const { rows, cellCols } = gridOf(table);
    const labels = []; // labels[col] = [texts]
    const numbers = []; // numbers[col] = "5"
    for (const tr of rows) {
      if (ownValues(tr).length) continue;
      const cells = $(tr).children('td, th').toArray();
      if (cells.length < 2) continue;
      const texts = cells.map((c) => clean($(c).text()));
      const isNumberRow = cells.length >= 3 && texts.every((t) => /^\d+$/.test(t));
      const isHeader = $(tr).hasClass('header') || cells.every((c) => c.tagName === 'th');
      if (!isNumberRow && !isHeader) continue;
      cells.forEach((cell, i) => {
        const pos = cellCols.get(cell);
        if (!pos || !texts[i]) return;
        for (let c = pos.start; c <= pos.end; c++) {
          if (isNumberRow) numbers[c] = texts[i];
          else (labels[c] = labels[c] || []).push({ text: texts[i], row: pos.row, rowEnd: pos.rowEnd });
        }
      });
    }
    const res = { labels, numbers };
    headerCache.set(table, res);
    return res;
  };

  const readValue = (el) => {
    const $el = $(el);
    if (el.tagName === 'select') {
      const opt = $el.find('option[selected]').last();
      const raw = clean(opt.attr('value') != null ? opt.attr('value') : opt.text());
      const text = clean(opt.text());
      return { type: 'select', raw, value: raw, text: text !== raw ? text : undefined, options: $el.find('option').toArray().map((o) => clean($(o).attr('value') ?? $(o).text())).filter(Boolean) };
    }
    if (el.tagName === 'input') {
      const t = ($el.attr('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return { type: 'checkbox', raw: $el.attr('checked') != null ? 'X' : '', value: $el.attr('checked') != null };
      if (t === 'hidden' || t === 'button' || t === 'submit') return null;
      const raw = clean($el.attr('value'));
      const n = parseNumber(raw);
      return { type: n == null ? 'text' : 'number', raw, value: n == null ? raw : n };
    }
    if ($el.hasClass('checkbox')) {
      const raw = clean($el.text());
      return { type: 'checkbox', raw, value: raw !== '' };
    }
    const raw = clean($el.text());
    const n = parseNumber(raw);
    // Identifiers (EIK/EGN) look numeric but must stay strings.
    const numeric = n != null && ($el.hasClass('right') || /[.,]\d{2}$/.test(raw));
    return { type: numeric ? 'number' : 'text', raw, value: numeric ? n : raw };
  };

  const labelOfCell = (cell) => {
    const c = $(cell).clone();
    c.find(VALUE_SEL + ', button, table').remove();
    return clean(c.text()).replace(/\s*-$/, '');
  };

  $('body').find('th, tr').each((_, el) => {
    if (el.tagName === 'th') {
      const t = clean($(el).text());
      if (!t) return;
      const a = t.match(RE_APPENDIX);
      if (a) { section = t.replace(/^Образец\s*\d+\s*/i, '').replace(/^(Приложение\s*№\s*\d+)\s*/i, '$1 – '); part = ''; group = ''; return; }
      if (RE_PART.test(t)) { part = t; group = ''; return; }
      if (t.length < 120 && RE_GROUP.test(t) && $(el).siblings('td, th').length === 0) group = t;
      return;
    }

    const tr = el;
    const values = ownValues(tr);
    if (!values.length) return;
    const table = $(tr).closest('table')[0];
    const { cellCols } = gridOf(table);
    const headers = headersOf(table);
    const cells = $(tr).children('td, th').toArray();
    const rowId = $(tr).attr('id') || undefined;

    // Label cells are attributed to the next value cell on their right; trailing
    // label cells (none in practice) and rows with one label for many values fall
    // back to the whole row's text.
    let code, rowNo;
    const rowLabels = [];
    const labelBefore = new Map(); // value cell -> label
    let run = [];
    cells.forEach((cell, i) => {
      if ($(cell).find(VALUE_SEL).length) { labelBefore.set(cell, run.join(' | ')); run = []; return; }
      const t = labelOfCell(cell);
      if (!t) return;
      if ($(cell).hasClass('index')) code = t;
      else if (i === 0 && RE_ROWNO.test(t) || $(cell).attr('id') === 'num') rowNo = t.replace(/\.$/, '');
      else { rowLabels.push(t); run.push(t); }
    });
    const rowLabel = rowLabels.join(' | ');
    const trRow = (cellCols.get(cells[0]) || {}).row;

    for (const cell of cells) {
      const els = $(cell).find(VALUE_SEL).toArray().filter((e) => $(e).closest('tr')[0] === tr);
      if (!els.length) continue;
      const pos = cellCols.get(cell) || { start: 0 };
      const own = labelOfCell(cell);
      const colLabel = [...new Set((headers.labels[pos.start] || [])
        .filter((h) => h.row < trRow).map((h) => h.text))].join(' / ');
      els.forEach((e, idx) => {
        const v = readValue(e);
        if (!v) return;
        const name = $(e).attr('name') || undefined;
        const f = {
          section, part: part || undefined, group: group || undefined,
          rowId, rowNo, code,
          label: own || labelBefore.get(cell) || rowLabel || colLabel || '',
          column: !own && rowLabel && colLabel ? colLabel : (rowId && colLabel ? colLabel : undefined),
          columnNo: headers.numbers[pos.start],
          name,
          ...v,
        };
        if (els.length > 1) f.seq = idx + 1;
        fields.push(f);
      });
    }
  });

  // ---- stable keys --------------------------------------------------------
  const seen = new Map();
  for (const f of fields) {
    let key;
    if (f.name) key = f.name;
    else if (f.rowId) key = `${f.rowId}#${f.columnNo || f.column || f.label}`;
    else if (f.code) key = `code:${f.code}`;
    else key = [f.section, f.part, f.group, f.rowNo, f.label.slice(0, 60)].filter(Boolean).join('/');
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    f.key = n === 1 ? key : `${key}~${n}`;
  }

  // ---- derived views ------------------------------------------------------
  const sections = [];
  const secIndex = new Map();
  for (const f of fields) {
    const id = `${f.section}\u0000${f.part || ''}`;
    if (!secIndex.has(id)) {
      secIndex.set(id, { section: f.section, part: f.part, fields: [], tables: [] });
      sections.push(secIndex.get(id));
    }
    const sec = secIndex.get(id);
    if (f.rowId && /:/.test(f.rowId)) {
      const tid = f.rowId.split(':')[0];
      let t = sec.tables.find((x) => x.id === tid);
      if (!t) sec.tables.push(t = { id: tid, columns: [], rows: [] });
      let row = t.rows.find((r) => r.rowId === f.rowId);
      if (!row) t.rows.push(row = { rowId: f.rowId, rowNo: f.rowNo, kind: f.label !== f.column ? f.label : undefined, cells: {} });
      const col = f.column || f.label || f.columnNo || `#${Object.keys(row.cells).length + 1}`;
      if (!t.columns.includes(col)) t.columns.push(col);
      row.cells[col] = f.text ? `${f.raw} – ${f.text}` : f.raw;
    } else {
      sec.fields.push(f);
    }
  }
  // Drop record rows that are entirely empty (the form always renders one blank row).
  for (const s of sections) {
    for (const t of s.tables) t.rows = t.rows.filter((r) => Object.values(r.cells).some((v) => v && v !== '-'));
    s.tables = s.tables.filter((t) => t.rows.length);
  }

  const pick = (re) => {
    const f = fields.find((x) => x.type === 'number' && x.section === MAIN && re.test(x.label));
    return f ? f.value : undefined;
  };
  const summary = {
    taxBase: pick(/^Обща годишна данъчна основа/),
    tax: pick(/^Данък върху общата годишна данъчна основа(?!,)/),
    taxWithheld: pick(/^Данъци,? подлежащи на приспадане/),
    taxDue: pick(/^Дължим данък за довнасяне(?!,)/),
    discount: pick(/^Отстъпка/),
    taxDueAfterDiscount: pick(/^Дължим данък за довнасяне, намален/),
    overpaid: pick(/^Надвнесен данък/),
    appendices: [...new Set(fields.map((f) => f.section).filter((s) => s !== MAIN))],
  };

  if (!fields.length) warnings.push('Не са открити полета – форматът вероятно е променен. Запазен е само оригиналният HTML.');
  if (!meta.taxYear) warnings.push('Данъчната година не е разпозната.');

  return { meta, summary, sections, fields, warnings, filled: fields.filter((f) => f.raw !== '' && f.value !== false).length };
}

/** Parse the portal's "submitted documents" table when the JSON API is unavailable. */
function parseListingHtml(html) {
  const $ = cheerio.load(html);
  const table = $('#atdec').length ? $('#atdec') : $('table.dataTable').first();
  const heads = table.find('thead th').toArray().map((th) => clean($(th).text()));
  const col = (re) => heads.findIndex((h) => re.test(h));
  const ix = {
    form: col(/Формуляр/), year: col(/период/i), inno: col(/Вх\.?\s*номер/i), date: col(/Дата/),
    status: col(/Статус/), signer: col(/Метод/), user: col(/Потребител/),
  };
  const rows = [];
  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).children('td').toArray();
    if (tds.length < 4) return;
    const h = $(tr).html() || '';
    const txt = (i) => (i >= 0 && tds[i] ? clean($(tds[i]).text()) : '');
    const g = (re) => { const x = h.replace(/&amp;/g, '&').match(re); return x ? x[1] : undefined; };
    const att = h.replace(/&amp;/g, '&').match(/viewAttachments\?ipform_id=(\d+)&ipdec_id=(\d+)/);
    const docId = g(/viewDocument\?pdoc_id=(\d+)/) || g(/[?&]ipdoc_id=(\d+)(?![^'"]*showResult)/);
    rows.push({
      FORMNAME: txt(ix.form), TAXYEAR: txt(ix.year), INNO: txt(ix.inno), INNODATE: txt(ix.date),
      STATUSTEXT: txt(ix.status), SIGNER: txt(ix.signer), USERINFO: txt(ix.user),
      DOCID: docId,
      HASHTML: /viewDocument\?pdoc_id=/.test(h) ? 1 : 0,
      HASPDF: /download\?[^"']*ipdoc_id=/.test(h.replace(/&amp;/g, '&')) ? 1 : 0,
      HASATTACHMENTS: att ? 1 : 0, FORMID: att ? att[1] : undefined, DECID: att ? att[2] : undefined,
      EXPFILEID: g(/showResult\?ipdoc_id=(\d+)/), HASRESULT: /showResult\?ipdoc_id=/.test(h) ? 1 : 0,
    });
  });
  return rows.filter((r) => r.INNO || r.DOCID);
}

module.exports = { parseDeclaration, parseListingHtml, clean, PARSER_VERSION };
