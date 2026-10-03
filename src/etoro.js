'use strict';
// eToro account statement (PDF). Only the "Dividends" page is used: one row per
// payment with the net amount and the tax withheld, both in USD. The ticker is
// taken from the "Account Activity" page (AAPL/USD), matched by position id.

const { rowsOf, isoDate } = require('./pdftext');
const { emptyStatement, finish } = require('./ibkr');

const RE_ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const RE_DMY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const isNum = (s) => /^-?[\d,]*\.?\d+$/.test(s);
const num = (s) => Number(String(s).replace(/,/g, ''));

const isEtoro = (pages) => pages[0].some((i) => /^eToro \(/.test(i.s)) || pages.some((p) => p.some((i) => /eToro’s analysis|eToro Support/.test(i.s)));

function parsePages(pages, source = 'etoro.pdf') {
  const st = emptyStatement(source);
  st.baseCurrency = 'USD';
  const tickers = {}; // position id -> ticker
  let closedRows = 0;
  for (const items of pages) {
    const rows = rowsOf(items, 2);
    const title = rows.length ? rows[0].items[0].s : '';
    for (const i of items) {
      const m = i.s.match(/^([A-Z]{3} \d{1,2}, \d{4}) to ([A-Z]{3} \d{1,2}, \d{4})$/);
      if (m && !st.period) st.period = { from: isoDate(m[1]), to: isoDate(m[2]) };
    }
    if (title === 'Account Activity') {
      for (const row of rows) {
        const t = row.items.map((i) => i.s);
        const detail = t.find((x) => /^[A-Z0-9.]+\/[A-Z]{3}$/.test(x));
        const id = t.find((x) => /^\d{8,}$/.test(x));
        if (detail && id) tickers[id] = detail.split('/')[0];
      }
    } else if (title === 'Closed Positions') {
      closedRows += rows.filter((row) => row.items.some((i) => /^\d{8,}$/.test(i.s))).length;
    } else if (title === 'Dividends') {
      for (const row of rows) {
        const t = row.items.map((i) => i.s);
        const d = (t[0] || '').match(RE_DMY);
        if (!d) continue;
        const date = `${d[3]}-${d[2]}-${d[1]}`;
        const isin = t.find((x) => RE_ISIN.test(x)) || '';
        const id = t.find((x) => /^\d{8,}$/.test(x)) || '';
        const pct = t.findIndex((x) => /^\d+(\.\d+)?\s?%$/.test(x));
        const numbers = t.map((x, k) => ({ x, k })).filter((o) => o.k > 0 && isNum(o.x) && o.x !== id);
        const net = numbers.length ? num(numbers[0].x) : 0;
        const taxItem = numbers.find((o) => o.k > pct && pct >= 0);
        const tax = taxItem ? num(taxItem.x) : 0;
        const name = t[1] && !isNum(t[1]) ? t[1] : '';
        const description = `${name} (${isin})`;
        st.dividends.push({ currency: 'USD', date, symbol: name, id, isin, description, amount: Math.round((net + tax) * 10000) / 10000 });
        if (tax) st.withholding.push({ currency: 'USD', date, symbol: name, id, isin, description, amount: -tax });
      }
    }
  }
  // tickers are known only after all pages have been read
  for (const list of [st.dividends, st.withholding]) {
    for (const row of list) { if (tickers[row.id]) row.symbol = tickers[row.id]; delete row.id; }
  }
  if (closedRows) st.warnings.push(`Отчетът съдържа ${closedRows} затворени позиции – продажбите от eToro не се импортират, въведете ги ръчно.`);
  st.warnings.push('eToro: отчетът не съдържа цена на придобиване на притежаваните акции – редовете в Приложение 8, Част I се въвеждат ръчно.');
  return finish(st);
}

module.exports = { parsePages, isEtoro };
