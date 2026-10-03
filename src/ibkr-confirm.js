'use strict';
// Interactive Brokers "Trade Confirmation Report" (PDF). Unlike the Activity Statement it lists every
// fill with the venue it was executed on (column "Exchange"), but has no realised result and no cost
// basis. So it only fills `executions`; tax.js uses them to decide, per sale, on which market the
// deal was made (чл. 13, ал. 1, т. 3 ЗДДФЛ looks at the place of the deal, not at the listing).
//
// Every order is printed twice: once as a summary row with "-" in the Exchange column and then
// once per fill with the venue. Only the fills are read.

const { pdfPages, rowsOf } = require('./pdftext');
const { emptyStatement, finish, parsePeriod, num, CATEGORIES } = require('./ibkr');

const RE_STAMP = /^(\d{4}-\d{2}-\d{2}),?(?:\s+(\d{2}:\d{2}:\d{2}))?$/;

const isConfirm = (pages) => pages[0].some((i) => i.s === 'Trade Confirmation Report') && pages[0].some((i) => /Interactive Brokers/.test(i.s));

/** @param pages output of pdfPages() */
function parsePages(pages, source = 'pdf') {
  const st = emptyStatement(source);
  if (!pages.length) throw new Error('PDF файлът е празен.');
  for (const i of pages[0]) {
    if (!st.period) st.period = parsePeriod(i.s);
    if (i.s === 'Base Currency') { const v = pages[0].find((x) => Math.abs(x.r - i.r) <= 1.5 && x.c > i.c); if (v) st.baseCurrency = v.s; }
  }
  let category = '', currency = '';
  for (const items of pages) {
    for (const row of rowsOf(items).sort((a, b) => a.r - b.r)) {
      const cells = row.items.sort((a, b) => a.c - b.c).map((i) => i.s);
      if (cells.length === 1) {
        if (CATEGORIES.includes(cells[0])) category = cells[0];
        else if (/^[A-Z]{3}$/.test(cells[0])) currency = cells[0];
        continue;
      }
      // "2026-04-15, 07:02:26" is one cell or two, depending on how the PDF was written
      let at = cells.findIndex((c) => RE_STAMP.test(c));
      if (at < 1 || category === 'Forex') continue;
      const symbol = cells[at - 1];
      const stamp = cells[at].match(RE_STAMP);
      const time = stamp[2] || (/^\d{2}:\d{2}:\d{2}$/.test(cells[at + 1] || '') ? cells[++at] : '');
      const [, venue, side, quantity, price, proceeds, commission] = cells.slice(at + 1, at + 8); // settle date, venue, type, ...
      if (!venue || venue === '-' || !/^(BUY|SELL)$/.test(side)) continue; // the order summary row, totals, headers
      st.executions.push({
        category, currency, symbol, date: stamp[1], time, side, venue,
        quantity: Math.abs(num(quantity)), price: num(price), proceeds: num(proceeds), commission: num(commission),
      });
    }
  }
  if (!st.executions.length) st.warnings.push('В отчета не са открити сделки с борса на изпълнение.');
  return finish(st);
}

async function parsePdf(buf, source = 'pdf') {
  return parsePages(await pdfPages(buf), source);
}

module.exports = { isConfirm, parsePages, parsePdf };
