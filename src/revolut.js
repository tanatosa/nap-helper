'use strict';
// Revolut statements (PDF). Three documents are recognised:
//   "Profit and Loss Statement"   - stock trading: sells and dividends, one part per currency
//   "Flexible Account Statement"  - one money market fund account: daily interest and fees
//   "Consolidated statement"      - yearly summary: Flexible Cash Funds per currency + commodities
// The same Flexible Cash Funds interest appears in both of the last two, so the
// import treats statements with identical content as one (see statements.js).

const { rowsOf, money, isoDate } = require('./pdftext');
const { emptyStatement, finish } = require('./ibkr');

const RE_ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const RE_ISO = /^\d{4}-\d{2}-\d{2}$/;
const RE_STAMP = /^[A-Z][a-z]{2} \d{1,2}, \d{4}/; // "Dec 31, 2023, 2:53:" / "Oct 6, 2020"
const round4 = (n) => Math.round(n * 10000) / 10000;

const titleOf = (pages) => (pages[0].slice().sort((a, b) => b.h - a.h)[0] || { s: '' }).s;
const isRevolut = (pages) => /Profit and Loss Statement|Flexible Account Statement|Consolidated statement/.test(titleOf(pages))
  && pages.some((p) => p.some((i) => /Revolut/.test(i.s)));

/** Trading "Profit and Loss Statement": tables "Sells" and "Dividends" per currency. */
function parsePnl(pages, st) {
  for (const items of pages) {
    const period = items.find((i) => /^\d{2} [A-Z][a-z]{2} \d{4} - \d{2} [A-Z][a-z]{2} \d{4}$/.test(i.s));
    if (period && !st.period) { const [a, b] = period.s.split(' - '); st.period = { from: isoDate(a), to: isoDate(b) }; }
    const heads = items.filter((i) => i.h > 8.5 && i.h < 10 && /^(Sells|Dividends)$/.test(i.s) && i.c < 100);
    for (const head of heads) {
      const next = heads.find((x) => x.r > head.r);
      const rows = rowsOf(items.filter((i) => i.r > head.r && (!next || i.r < next.r) && i.h > 5.5), 2);
      for (const row of rows) {
        const t = row.items.map((i) => i.s);
        if (!RE_ISO.test(t[0])) continue;
        const isin = t.find((x) => RE_ISIN.test(x)) || '';
        const cash = t.map(money).filter(Boolean);
        if (head.s === 'Dividends') {
          const [gross, tax] = cash;
          if (!gross) continue;
          const symbol = t[1];
          const description = `${t[2] || symbol} (${isin})`;
          st.dividends.push({ currency: gross.currency, date: t[0], symbol, isin, description, amount: gross.amount });
          // the tax column shows "-" when nothing was withheld; then the second amount is the net payment
          const taxCell = row.items.filter((i) => money(i.s))[1];
          const netCell = row.items.filter((i) => money(i.s))[2];
          if (tax && netCell && taxCell) st.withholding.push({ currency: tax.currency, date: t[0], symbol, isin, description, amount: -Math.abs(tax.amount) });
        } else if (RE_ISO.test(t[1])) {
          // Date acquired | Date sold | Symbol | Security name | ISIN | Country | Quantity | Cost basis | Gross proceeds | Gross PnL | Fees
          const [cost, proceeds] = cash;
          if (!cost || !proceeds) continue;
          st.sales.push({ category: 'Stocks', symbol: t[2], isin, currency: cost.currency, acquired: t[0], date: t[1], cost: cost.amount, proceeds: proceeds.amount });
        }
      }
    }
  }
  st.warnings.push('Revolut: отчетът не съдържа притежаваните акции към 31 декември – редовете в Приложение 8, Част I се въвеждат ръчно.');
}

/** Rows of a Flexible Cash Funds transaction table: date, description, value. */
function fundRows(items) {
  const stamps = items.filter((i) => RE_STAMP.test(i.s) && /\d:\d\d/.test(i.s)).sort((a, b) => a.r - b.r);
  return stamps.map((d) => {
    // description, ISIN and value sit on the date's row or on the two lines below it
    const near = items.filter((i) => i !== d && i.r >= d.r - 1.5 && i.r <= d.r + 13.5 && i.c > d.c + 40);
    const value = near.map((i) => money(i.s)).find(Boolean);
    const text = near.filter((i) => !money(i.s)).sort((a, b) => a.r - b.r || a.c - b.c).map((i) => i.s).join(' ');
    return { date: isoDate(d.s), text, value };
  }).filter((x) => x.date && x.value);
}

function addFundRows(rows, st, totals) {
  for (const x of rows) {
    const cur = x.value.currency;
    totals[cur] = totals[cur] || { interest: 0, fees: 0 };
    if (/Interest PAID/i.test(x.text)) {
      st.interest.push({ currency: cur, date: x.date, description: 'Flexible Cash Funds', amount: x.value.amount });
      totals[cur].interest += x.value.amount;
    } else if (/Service Fee/i.test(x.text)) totals[cur].fees += Math.abs(x.value.amount);
  }
}

/** Compare what was read with the totals printed in the summary. */
function checkFunds(st, totals, printed) {
  for (const [cur, p] of Object.entries(printed)) {
    const t = totals[cur] || { interest: 0, fees: 0 };
    if (p.interest != null && Math.abs(t.interest - p.interest) > 0.011) {
      st.warnings.push(`Revolut: прочетените лихви в ${cur} (${t.interest.toFixed(2)}) не съвпадат с отпечатаните в обобщението (${p.interest.toFixed(2)}); използван е сборът на дневните редове.`);
    }
  }
  for (const [cur, t] of Object.entries(totals)) if (t.fees > 0.004) st.fees.push({ description: 'Такси Flexible Cash Funds', currency: cur, amount: round4(t.fees) });
  if (st.interest.length) st.warnings.push('Revolut: лихвите от Flexible Cash Funds са нанесени брутно (таксите за управление не са приспаднати).');
}

function printedTotal(items, label) {
  const l = items.find((i) => label.test(i.s));
  if (!l) return null;
  const v = items.filter((i) => Math.abs(i.r - l.r) <= 2 && i.c > l.c).map((i) => money(i.s)).find(Boolean);
  return v || null;
}

function parseFund(pages, st) {
  const first = pages[0];
  const from = first.find((i) => /^From: /.test(i.s)), to = first.find((i) => /^To: /.test(i.s));
  if (from && to) st.period = { from: isoDate(from.s.slice(6)), to: isoDate(to.s.slice(4)) };
  const totals = {};
  for (const items of pages) addFundRows(fundRows(items), st, totals);
  const p = printedTotal(first, /^Total Earned Interest$/i);
  checkFunds(st, totals, p ? { [p.currency]: { interest: p.amount } } : {});
  if (p) st.baseCurrency = p.currency;
}

function parseConsolidated(pages, st) {
  const period = pages[0].find((i) => / - /.test(i.s) && isoDate(i.s) && isoDate(i.s.split(' - ')[1]));
  if (period) st.period = { from: isoDate(period.s), to: isoDate(period.s.split(' - ')[1]) };
  const totals = {}, printed = {};
  let section = '';
  for (const items of pages) {
    const heads = items.filter((i) => i.h > 11 && i.h < 13 && /^(Summary|Transactions|Information) (for|about) /.test(i.s)).sort((a, b) => a.r - b.r);
    const bounds = [{ r: -Infinity, s: section }, ...heads];
    bounds.forEach((head, k) => {
      const part = items.filter((i) => i.r > head.r && (!bounds[k + 1] || i.r < bounds[k + 1].r) && i.h < 11);
      const name = head.s;
      if (/^Summary for Flexible Cash Funds/.test(name)) {
        const v = printedTotal(part, /^Total earned interest$/i);
        if (v) printed[v.currency] = { interest: v.amount };
      } else if (/^Transactions for Flexible Cash Funds/.test(name)) addFundRows(fundRows(part), st, totals);
      else if (/^Transactions for Commodities/.test(name)) {
        for (const row of rowsOf(part, 2)) {
          const t = row.items.map((i) => i.s);
          const acquired = isoDate(t[0]), sold = isoDate(t[1] || '');
          const cash = t.map(money).filter(Boolean);
          if (!acquired || !sold || cash.length < 2) continue;
          st.sales.push({ category: 'Commodities', symbol: t[2], isin: '', currency: cash[0].currency, acquired, date: sold, cost: cash[0].amount, proceeds: cash[1].amount });
        }
      } else if (/^(Summary|Transactions) for /.test(name) && !/Commodities/.test(name)) {
        const w = `Revolut: раздел „${name}“ от консолидирания отчет не се поддържа – използвайте отделния отчет за този продукт.`;
        if (!st.warnings.includes(w)) st.warnings.push(w);
      }
    });
    if (heads.length) section = heads[heads.length - 1].s;
  }
  checkFunds(st, totals, printed);
}

function parsePages(pages, source = 'revolut.pdf') {
  const st = emptyStatement(source);
  const title = titleOf(pages);
  if (/Profit and Loss Statement/.test(title)) { st.kind = 'Търговия (P&L)'; parsePnl(pages, st); }
  else if (/Flexible Account Statement/.test(title)) { st.kind = 'Flexible Account'; parseFund(pages, st); }
  else if (/Consolidated statement/.test(title)) { st.kind = 'Консолидиран отчет'; parseConsolidated(pages, st); }
  else throw new Error('Непознат вид отчет от Revolut (поддържат се Profit and Loss Statement, Flexible Account Statement и Consolidated statement).');
  if (!st.baseCurrency) st.baseCurrency = 'EUR';
  return finish(st);
}

module.exports = { parsePages, isRevolut };
