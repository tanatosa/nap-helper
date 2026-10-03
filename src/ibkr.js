'use strict';
// Reads an Interactive Brokers Activity Statement (CSV or PDF) into the
// normalised statement structure shared by all sources (see statements.js).
// Nothing here knows about tax forms - see tax.js.
//
// statement = {
//   source, period: {from, to}, year, baseCurrency,
//   instruments: { [symbol]: {symbol, isin, exchange, type, category, description} },
//   dividends:   [{currency, date, symbol, isin, description, amount}],
//   withholding: [{currency, date, symbol, isin, description, amount}],   // symbol empty for tax on interest
//   interest:    [{currency, date, description, amount}],
//   positions:   [{category, currency, symbol, quantity, costBasis, lots: [{date, quantity, costBasis}]}],
//   trades:      [{category, currency, symbol, date, quantity, proceeds, commission, basis, realized, code}],
//   executions:  [{category, currency, symbol, date, side, quantity, price, proceeds, commission, venue}],  // fills with their venue (ibkr-confirm.js)
//   corporateActions: [{category, currency, date, description, proceeds, realized}],
//   sales:       [{category, symbol, isin, currency, date, acquired, proceeds, cost}],   // sources that report closed lots
//   otherIncome: [{description, currency, date, amount}],                               // shown in the report only
//   fees:        [{description, currency, amount}],                                     // shown in the report only
//   warnings: [],
// }

const { pdfPages, rowsOf } = require('./pdftext');

const num = (s) => {
  const v = Number(String(s == null ? '' : s).replace(/,/g, '').trim());
  return Number.isFinite(v) ? v : 0;
};
const isNumeric = (s) => /^-?[\d,]*\.?\d+$/.test(String(s).trim());
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_SECURITY = /^(.+?)\s*\(([A-Z]{2}[A-Z0-9]{9}\d)\)\s*(.*)$/;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const CATEGORIES = ['Stocks', 'Equity and Index Options', 'Forex', 'Bonds', 'Futures', 'Options On Futures', 'Warrants', 'CFDs', 'Funds', 'Treasury Bills', 'Structured Products'];

function parsePeriod(text) {
  const one = (s) => {
    const m = String(s).trim().match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
    if (!m) return null;
    const mo = MONTHS.indexOf(m[1].toLowerCase());
    return mo < 0 ? null : `${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  };
  const parts = String(text).split(' - ');
  const from = one(parts[0]);
  const to = one(parts[1] || parts[0]);
  return from && to ? { from, to } : null;
}

function emptyStatement(source) {
  return { source, period: null, year: null, baseCurrency: null, instruments: {}, dividends: [], withholding: [], interest: [], positions: [], trades: [], executions: [], corporateActions: [], sales: [], otherIncome: [], fees: [], warnings: [] };
}

/** "BAS(DE000BASF111) Cash Dividend EUR 3.40 per Share (Ordinary Dividend)" -> symbol + isin */
function security(description) {
  const m = String(description).match(RE_SECURITY);
  return m ? { symbol: m[1].trim(), isin: m[2] } : { symbol: '', isin: '' };
}

function finish(st) {
  // the year most of the period lies in (some statements run a few days into January)
  if (st.period) st.year = new Date((Date.parse(st.period.from) + Date.parse(st.period.to)) / 2).getUTCFullYear();
  if (!st.period) st.warnings.push('Периодът на извлечението не е разпознат.');
  if (!st.baseCurrency) st.warnings.push('Базовата валута на сметката не е разпозната.');
  return st;
}

// ---- CSV ---------------------------------------------------------------------
function csvRows(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function parseCsv(text, source = 'csv') {
  const st = emptyStatement(source);
  const headers = {};
  for (const r of csvRows(text)) {
    const [section, kind] = r;
    if (kind === 'Header') { headers[section] = r.slice(2); continue; }
    if (kind !== 'Data') continue;
    const h = headers[section] || [];
    const o = {};
    h.forEach((name, i) => { if (name && !(name in o)) o[name] = r[i + 2]; });
    const cells = r.slice(2);

    if (section === 'Statement' && o['Field Name'] === 'Period') st.period = parsePeriod(o['Field Value']);
    else if (section === 'Account Information' && o['Field Name'] === 'Base Currency') st.baseCurrency = o['Field Value'];
    else if (section === 'Financial Instrument Information' && o.Symbol) {
      st.instruments[o.Symbol] = { symbol: o.Symbol, isin: o['Security ID'] || '', exchange: o['Listing Exch'] || '', type: o.Type || '', category: o['Asset Category'] || '', description: o.Description || '' };
    } else if (section === 'Dividends' || section === 'Withholding Tax' || section === 'Interest' || section === 'Payment In Lieu Of Dividends') {
      if (!RE_DATE.test(o.Date || '')) continue; // "Total" rows
      const row = { currency: o.Currency, date: o.Date, description: o.Description, amount: num(o.Amount) };
      if (section === 'Interest') st.interest.push(row);
      else (section === 'Withholding Tax' ? st.withholding : st.dividends).push({ ...row, ...security(o.Description) });
    } else if (section === 'Open Positions') {
      const kindOfRow = o.DataDiscriminator;
      if (kindOfRow === 'Summary') {
        st.positions.push({ category: o['Asset Category'], currency: o.Currency, symbol: o.Symbol, quantity: num(o.Quantity), costBasis: num(o['Cost Basis']), lots: [] });
      } else if (kindOfRow === 'Lot' && st.positions.length) {
        // lot rows carry the open date in one of the cells (the column differs between statement versions)
        const date = (cells.map((c) => String(c).slice(0, 10)).find((c) => RE_DATE.test(c))) || '';
        st.positions[st.positions.length - 1].lots.push({ date, quantity: num(o.Quantity), costBasis: num(o['Cost Basis']) });
      }
    } else if (section === 'Trades') {
      if (!/^(Order|Trade)$/.test(o.DataDiscriminator || '') || o['Asset Category'] === 'Forex') continue;
      st.trades.push({
        category: o['Asset Category'], currency: o.Currency, symbol: o.Symbol, date: String(o['Date/Time'] || '').slice(0, 10),
        quantity: num(o.Quantity), proceeds: num(o.Proceeds), commission: num(o['Comm/Fee']), basis: num(o.Basis), realized: num(o['Realized P/L']), code: o.Code || '',
      });
    } else if (section === 'Corporate Actions') {
      if (!RE_DATE.test(o['Report Date'] || '')) continue;
      st.corporateActions.push({ category: o['Asset Category'], currency: o.Currency, date: o['Report Date'], description: o.Description, proceeds: num(o.Proceeds), realized: num(o['Realized P/L']) });
    }
  }
  return finish(st);
}

// ---- PDF ---------------------------------------------------------------------
// The PDF is a print of the same report: landscape pages, some sections side
// by side in two lanes, long descriptions wrapped over two or three lines.
// Text items are placed on a (row, col) grid and each section is read with
// rules specific to its shape. Every currency block is checked against the
// "Total" line printed under it, so a misread shows up as a warning.

const LANE_SPLIT = 405;
const FULL_WIDTH = new Set(['Open Positions', 'Trades', 'Corporate Actions', 'Change in Dividend Accruals', 'Financial Instrument Information',
  'Mark-to-Market Performance Summary', 'Realized & Unrealized Performance Summary', 'Net Stock Position Summary', 'Forex Balances', 'Codes', 'Notes/Legal Notes',
  'Stock Yield Enhancement Program Securities Lent', 'Stock Yield Enhancement Program Securities Lent Activity', 'Stock Yield Enhancement Program Securities Lent Interest Details']);

/** Split pages into titled sections; returns [{name, items}] with page-unique row numbers. */
function pdfSections(pages) {
  const out = [];
  pages.forEach((all, pi) => {
    const items = all.filter((i) => i.h > 6.5); // drop the page footer
    const titles = items.filter((i) => i.h >= 9.5).sort((a, b) => a.r - b.r);
    for (const t of titles) {
      const right = t.c >= LANE_SPLIT;
      const full = FULL_WIDTH.has(t.s);
      const next = titles.filter((u) => u.r > t.r + 1 && (full || (u.c >= LANE_SPLIT) === right || (right && FULL_WIDTH.has(u.s))));
      const end = next.length ? next[0].r : Infinity;
      const inLane = (i) => full || (right ? i.c >= LANE_SPLIT : i.c < LANE_SPLIT);
      out.push({
        name: t.s, c0: t.c - 2,
        items: items.filter((i) => i !== t && i.h < 9.5 && i.r > t.r && i.r < end - 1 && inLane(i))
          .map((i) => ({ ...i, r: i.r + pi * 10000 })).sort((a, b) => a.r - b.r || a.c - b.c),
      });
    }
  });
  // a section continued on the next page repeats its title: merge
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && last.name === s.name) last.items.push(...s.items); else merged.push(s);
  }
  return merged;
}

/** Date | Description | Amount tables (Dividends, Interest, Withholding Tax). */
function pdfLedger(section, warnings) {
  const { items, c0, name } = section;
  const near = (i) => Math.abs(i.c - c0) <= 8;
  const dates = items.filter((i) => RE_DATE.test(i.s) && near(i));
  const marks = items.filter((i) => /^[A-Z]{3}$/.test(i.s) && near(i));
  const totals = items.filter((i) => /^Total/.test(i.s));
  const used = new Set([...dates, ...marks, ...totals]);
  const amountAt = (r) => items.filter((i) => Math.abs(i.r - r) <= 1.5 && isNumeric(i.s) && /\./.test(i.s)).sort((a, b) => b.c - a.c)[0];
  const rows = dates.map((d) => {
    const a = amountAt(d.r);
    if (a) used.add(a);
    const cur = marks.filter((m) => m.r < d.r).pop();
    return { r: d.r, currency: cur ? cur.s : '', date: d.s, amount: a ? num(a.s) : 0, parts: [] };
  });
  for (const t of totals) { const a = amountAt(t.r); if (a) used.add(a); t.amount = a ? num(a.s) : null; }
  for (const i of items) {
    if (used.has(i) || /^(Date|Description|Amount|Code|Amount Code)$/.test(i.s)) continue;
    let best = null;
    for (const row of rows) if (!best || Math.abs(row.r - i.r) < Math.abs(best.r - i.r)) best = row;
    if (best && Math.abs(best.r - i.r) <= 12) best.parts.push(i);
  }
  // check each currency block against its printed total
  for (const m of marks) {
    const nextMark = marks.find((x) => x.r > m.r);
    const block = rows.filter((x) => x.r > m.r && (!nextMark || x.r < nextMark.r));
    const total = totals.find((t) => t.s === 'Total' && t.r > m.r && (!nextMark || t.r < nextMark.r));
    const sum = block.reduce((a, x) => a + x.amount, 0);
    if (total && total.amount != null && Math.abs(sum - total.amount) > 0.015) {
      warnings.push(`PDF: сборът в „${name}“ за ${m.s} (${sum.toFixed(2)}) не съвпада с отпечатания (${total.amount.toFixed(2)}) – проверете редовете или използвайте CSV.`);
    }
  }
  return rows.map((x) => ({
    currency: x.currency, date: x.date, amount: x.amount,
    description: x.parts.sort((a, b) => a.r - b.r || a.c - b.c).map((p) => p.s).join(' ').replace(/\s+/g, ' ').replace(/- Reversal/, '- Reversal'),
  }));
}

/** Tables whose rows start with a symbol followed by right-aligned numbers (Open Positions, Trades). */
function pdfSymbolRows(section, minNumbers) {
  const out = [];
  let category = '', currency = '';
  const rows = rowsOf(section.items);
  for (const row of rows) {
    const first = row.items[0];
    if (first.c > 60) continue;
    if (row.items.length === 1 && CATEGORIES.includes(first.s)) { category = first.s; continue; }
    if (row.items.length === 1 && /^[A-Z]{3}$/.test(first.s)) { currency = first.s; continue; }
    if (/^(Total|Symbol|Description)/.test(first.s)) continue;
    const rest = row.items.slice(1);
    const numbers = rest.filter((i) => isNumeric(i.s));
    if (numbers.length < minNumbers) continue;
    const tail = rest[rest.length - 1];
    out.push({ r: row.r, category, currency, symbol: first.s, numbers: numbers.map((i) => num(i.s)), code: tail && !isNumeric(tail.s) && tail.c > 700 ? tail.s : '' });
  }
  return out;
}

function pdfInstruments(section, st) {
  let cols = null, category = '';
  for (const row of rowsOf(section.items)) {
    const texts = row.items.map((i) => i.s);
    if (texts.includes('Symbol') && texts.includes('Conid')) { cols = Object.fromEntries(row.items.map((i) => [i.s, i.c])); continue; }
    const first = row.items[0];
    if (!cols || first.c > 60) continue;
    if (row.items.length === 1) { if (CATEGORIES.includes(first.s)) category = first.s; continue; }
    const cell = (name) => { const c = cols[name]; const it = c == null ? null : row.items.find((i) => Math.abs(i.c - c) <= 6); return it ? it.s : ''; };
    if (!/^\d+$/.test(cell('Conid'))) continue;
    st.instruments[first.s] = { symbol: first.s, isin: cell('Security ID'), exchange: cell('Listing Exch'), type: cell('Type'), category, description: cell('Description') };
  }
}

/** @param pages output of pdfPages() */
function parsePdfPages(pages, source = 'pdf') {
  const st = emptyStatement(source);
  if (!pages.length) throw new Error('PDF файлът е празен.');
  for (const i of pages[0]) {
    if (!st.period) st.period = parsePeriod(i.s);
    if (i.s === 'Base Currency') { const v = pages[0].find((x) => Math.abs(x.r - i.r) <= 1.5 && x.c > i.c); if (v) st.baseCurrency = v.s; }
  }
  const sections = pdfSections(pages);
  if (!sections.some((s) => /^(Open Positions|Trades|Dividends|Interest)$/.test(s.name))) {
    throw new Error('Файлът не прилича на IBKR Activity Statement (не са открити познати раздели).');
  }
  for (const sec of sections) {
    if (sec.name === 'Dividends' || sec.name === 'Withholding Tax') {
      const rows = pdfLedger(sec, st.warnings).map((x) => ({ ...x, ...security(x.description) }));
      (sec.name === 'Dividends' ? st.dividends : st.withholding).push(...rows);
    } else if (sec.name === 'Interest') st.interest.push(...pdfLedger(sec, st.warnings));
    else if (sec.name === 'Open Positions') {
      for (const x of pdfSymbolRows(sec, 7)) st.positions.push({ category: x.category, currency: x.currency, symbol: x.symbol, quantity: x.numbers[0], costBasis: x.numbers[3], lots: [] });
    } else if (sec.name === 'Trades') {
      const stamps = sec.items.filter((i) => /^\d{4}-\d{2}-\d{2},?$/.test(i.s));
      for (const x of pdfSymbolRows(sec, 8)) {
        if (x.category === 'Forex') continue;
        const d = stamps.filter((i) => Math.abs(i.r - x.r) <= 6).sort((a, b) => Math.abs(a.r - x.r) - Math.abs(b.r - x.r))[0];
        const [quantity, , , proceeds, commission, basis, realized] = x.numbers;
        st.trades.push({ category: x.category, currency: x.currency, symbol: x.symbol, date: d ? d.s.slice(0, 10) : '', quantity, proceeds, commission, basis, realized, code: x.code });
      }
    } else if (sec.name === 'Financial Instrument Information') pdfInstruments(sec, st);
  }
  st.warnings.push('PDF извлечението съдържа закръглени до стотинка суми и не включва падежи на облигации; при възможност използвайте CSV.');
  return finish(st);
}

async function parsePdf(buf, source = 'pdf') {
  return parsePdfPages(await pdfPages(buf), source);
}

/** Is this the first page / the text of an IBKR Activity Statement? */
const isIbkrCsv = (text) => /^﻿?Statement,Header,Field Name/.test(text);
const isIbkrPdf = (pages) => pages[0].some((i) => i.s === 'Activity Statement') && pages[0].some((i) => /Interactive Brokers/.test(i.s));

module.exports = { parseCsv, parsePdf, parsePdfPages, isIbkrCsv, isIbkrPdf, csvRows, security, emptyStatement, finish, parsePeriod, num, CATEGORIES };
