'use strict';
// Iuvo yearly income statement (PDF, Bulgarian). It has no individual payments,
// only totals for the period: interest, late fees, secondary-market gains,
// bonuses and iuvoSAVE interest, followed by the expenses on the second page.

const { emptyStatement, finish } = require('./ibkr');

const RE_AMOUNT = /^(-?[\d\s.,]+) ([A-Z]{3})$/;
const isIuvo = (pages) => pages[0].some((i) => /IUVO GROUP/i.test(i.s));

// label on the statement -> how it is treated
const INCOME = [
  { re: /^Приходи от лихви/, name: 'Лихви по заеми', interest: true },
  { re: /^Такси закъснение/, name: 'Такси за закъснение', interest: true },
  { re: /^Печалби от лихви/, name: 'Лихви iuvoSAVE', interest: true },
  { re: /^Печалби Вторичен пазар/, name: 'Печалби от вторичен пазар', interest: false },
  { re: /^Бонус програми/, name: 'Бонус програми', interest: false },
];

function parsePages(pages, source = 'iuvo.pdf') {
  const st = emptyStatement(source);
  const all = pages.flatMap((items, p) => items.map((i) => ({ ...i, r: i.r + p * 10000, page: p })));
  const text = all.map((i) => i.s).join(' ');
  const period = text.match(/(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
  if (period) st.period = { from: period[1], to: period[2] };
  const expensesFrom = (all.find((i) => /^Вашите разходи/.test(i.s)) || { r: Infinity }).r;
  const amounts = all.filter((i) => RE_AMOUNT.test(i.s));
  const amountFor = (label) => {
    // the amount sits on the label's row or up to a line below it, at the same font size
    const a = amounts.filter((x) => Math.abs(x.h - label.h) < 1 && x.r >= label.r - 2 && x.r <= label.r + 12).sort((x, y) => x.r - y.r)[0];
    if (!a) return null;
    const m = a.s.match(RE_AMOUNT);
    return { amount: Number(m[1].replace(/\s/g, '').replace(',', '.')), currency: m[2] };
  };
  const date = st.period ? st.period.to : '';
  for (const label of all.filter((i) => i.c < 92 && i.h > 10)) {
    const kind = INCOME.find((k) => k.re.test(label.s));
    const a = (kind || /^(Такси|Загуби)/.test(label.s)) ? amountFor(label) : null;
    if (!a) continue;
    if (!st.baseCurrency) st.baseCurrency = a.currency;
    if (label.r > expensesFrom) { if (a.amount) st.fees.push({ description: label.s, currency: a.currency, amount: a.amount }); continue; }
    if (!kind || !a.amount) continue;
    const row = { currency: a.currency, date, description: kind.name, amount: a.amount };
    if (kind.interest) st.interest.push(row); else st.otherIncome.push(row);
  }
  if (!st.interest.length && !st.otherIncome.length) st.warnings.push('В отчета на Iuvo не са открити приходи.');
  if (st.otherIncome.length) st.warnings.push('Печалбите от вторичен пазар и бонусите от Iuvo са показани само в отчета и не са нанесени в черновата.');
  return finish(st);
}

module.exports = { parsePages, isIuvo };
