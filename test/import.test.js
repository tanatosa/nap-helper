'use strict';
// All fixtures are synthetic: test/fixtures/ibkr.csv is a made-up Activity
// Statement in the real IBKR CSV layout, and the PDF readers are fed
// hand-written text items that mimic the page layouts of the real documents.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCsv } = require('../src/ibkr');
const etoro = require('../src/etoro');
const revolut = require('../src/revolut');
const iuvo = require('../src/iuvo');
const { parseFile, detectPdf, fingerprint } = require('../src/statements');
const { money, isoDate } = require('../src/pdftext');
const { Rates, parseEcbXml } = require('../src/rates');
const { compute, applyToDraft, previousHoldings, setTableRows } = require('../src/tax');
const { Store } = require('../src/store');

const fixture = (f) => path.join(__dirname, 'fixtures', f);
const tagged = (st, type, label) => Object.assign(st, { type, label, id: fingerprint(Object.assign(st, { type })) });
const statement = () => tagged(parseCsv(fs.readFileSync(fixture('ibkr.csv'), 'utf8'), 'ibkr.csv'), 'ibkr', 'IBKR');
const rates = new Rates({ '2020-10-06': { USD: 1.18 }, '2024-02-08': { USD: 1.08 }, '2024-03-01': { USD: 1.08 }, '2024-05-02': { USD: 1.07 }, '2024-06-03': { USD: 1.10 }, '2024-09-16': { USD: 1.11 }, '2024-12-30': { USD: 1.04 } });

/** One page of PDF text items: page([row, [col, text, height?], ...], ...) */
const page = (...rows) => rows.flatMap(([r, ...cells]) => cells.map(([c, s, h]) => ({ r, c, s, h: h || 6 })));

// ---- IBKR ----------------------------------------------------------------------
test('ibkr csv: sections are read, totals and forex rows are skipped', () => {
  const st = statement();
  assert.deepEqual(st.period, { from: '2024-01-01', to: '2024-12-31' });
  assert.equal(st.year, 2024);
  assert.equal(st.baseCurrency, 'EUR');
  assert.deepEqual([st.dividends.length, st.withholding.length, st.interest.length, st.positions.length, st.trades.length, st.corporateActions.length], [5, 4, 2, 3, 7, 1]);
  assert.equal(st.trades.find((t) => t.symbol === 'ETF2').quantity, -1000, 'quoted number with thousands separator');
  assert.deepEqual([st.dividends[0].symbol, st.dividends[0].isin], ['AAA', 'DE0000000001']);
  assert.equal(st.instruments.ETF2.exchange, 'IBIS2');
  assert.deepEqual(st.warnings, []);
});

test('dividends: reversals are netted, tax is matched, amounts converted to leva', () => {
  const r = compute(statement(), rates, 2024);
  assert.equal(r.unit, 'лв.');
  assert.deepEqual(r.dividends.map((d) => [d.source, d.symbol, d.country, d.gross, d.tax, d.method, d.due]), [
    ['IBKR', 'AAA', 'Германия', 58.67, 15.45, '1', 0], // 30.00 EUR x 1.95583, 7.90 EUR tax withheld
    ['IBKR', 'UUU', 'САЩ', 17.78, 0, '3', 0.89], // 10 USD / 1.10 x 1.95583, 5% due
  ]);
  assert.equal(r.dividendTaxDue, 0.89);
  assert.ok(r.warnings.some((w) => /^\[IBKR\] .*Payment in Lieu/.test(w)));
});

test('dividends: ordinary credit and "none" options', () => {
  const credit = compute(statement(), rates, 2024, { dividendMethod: 'credit' });
  assert.deepEqual(credit.dividends.map((d) => [d.method, d.allowed, d.recognised, d.due]), [['3', 2.93, 2.93, 0], ['3', 0.89, 0, 0.89]]);
  const none = compute(statement(), rates, 2024, { dividendMethod: 'none' });
  assert.deepEqual(none.dividends.map((d) => [d.method, d.due]), [['', null], ['', null]]);
  assert.equal(none.dividendTaxDue, null);
});

test('from tax year 2026 amounts are in euro; a statement for another year is flagged', () => {
  const r = compute(statement(), rates, 2026);
  assert.equal(r.unit, '€');
  assert.deepEqual(r.dividends.map((d) => d.gross), [30, 9.09]);
  assert.equal(r.interest.total, 30);
  assert.ok(r.warnings.some((w) => /е за 2024 г\., а черновата е за данъчна година 2026/.test(w)));
});

test('holdings: one row per position or one per purchase', () => {
  const pos = compute(statement(), rates, 2024).holdings;
  assert.deepEqual(pos.map((h) => [h.symbol, h.country, h.quantity, h.date, h.price, h.local]), [
    ['AAAd', 'Германия', 10, '', 501, 979.87], // bought before the statement period: no date
    ['ETF1', 'Ирландия', 300, '2024-06-03', 3030, 5926.16], // latest purchase
    ['UUU', 'САЩ', 30, '2024-03-01', 606, 1097.44],
  ]);
  const lots = compute(statement(), rates, 2024, { holdingsMode: 'lots' }).holdings;
  assert.deepEqual(lots.filter((h) => h.symbol === 'ETF1').map((h) => [h.quantity, h.date, h.price, h.local]), [[100, '2024-02-01', 1005, 1965.61], [200, '2024-06-03', 2025, 3960.56]]);
});

test('holdings: the acquisition date is recovered from the row declared last year', () => {
  const prev = [{ quantity: 10, price: 501, local: 979.87, dateIso: '2021-03-04' }];
  const row = compute(statement(), rates, 2024, {}, prev).holdings[0];
  assert.deepEqual([row.date, row.local, row.fromPrevious], ['2021-03-04', 979.87, true]);
  assert.equal(prev[0].used, undefined, 'the caller\'s list is not modified, so a recompute finds the row again');
});

test('interest and sales', () => {
  const r = compute(statement(), rates, 2024);
  assert.equal(r.interest.total, 58.67);
  assert.deepEqual(r.interest.bySource, { IBKR: 58.67 });
  assert.deepEqual(r.interest.rows.map((x) => [x.source, x.kind, x.amount]), [['IBKR', 'Лихва по парични наличности', 39.12], ['IBKR', 'Купони по облигации', 19.56]]);
  assert.equal(r.interest.taxAbroad, 1.96);
  assert.deepEqual(r.sales.rows.map((x) => [x.symbol, x.app, x.sale, x.cost, x.result]), [
    ['ETF2', 13, 9769.37, 7823.32, 1946.05], // ETF listed on Xetra: exempt
    ['USX', 5, 2008.84, 2376.24, -367.4], // US listing: taxable
    ['XYZ 18OCT24 85 P', 5, 0, 357.38, -357.38], // expired option
  ]);
  assert.deepEqual(r.sales.app5, { sale: 2008.84, cost: 2733.62, gains: 0, losses: 724.78, count: 2, bySource: { IBKR: 2 } });
  assert.equal(r.other.length, 1);
});

// ---- other sources (synthetic page layouts) ----------------------------------------
const etoroPages = () => [
  page([57, [52, 'Ivan Ivanov', 8], [723, 'eToro (Europe) Ltd.', 8]], [151, [52, 'Account Summary', 8], [694, 'JAN 1, 2024 to DEC 31, 2024', 8]]),
  page([27, [52, 'Closed Positions', 8], [694, 'JAN 1, 2024 to DEC 31, 2024', 8]], [61, [52, 'Action', 8], [160, 'Amount', 8]]),
  page([27, [52, 'Account Activity', 8]], [68, [52, 'Date', 8], [153, 'Type', 8]],
    [91, [52, '16-09-2024 00:13:40'], [149, 'Dividend'], [221, 'ZZZ/USD'], [304, '0.90'], [383, '-'], [452, '0.90'], [523, '100.90'], [600, '0.90'], [663, '1000000001'], [772, 'Stocks']]),
  page([27, [52, 'Dividends', 8], [694, 'JAN 1, 2024 to DEC 31, 2024', 8]], [68, [52, 'Date of Payment', 8], [158, 'Instrument Name', 8]],
    [91, [52, '16/09/2024'], [181, 'Zzz Corp'], [276, '0.90'], [368, '10 %'], [458, '0.1000'], [543, '1000000001'], [644, 'Stocks'], [747, 'US0000000007']],
    [158, [50, 'Should you have any inquiries please contact us at eToro Support']]),
];

test('etoro: dividends are grossed up and named by ticker', () => {
  assert.equal(detectPdf(etoroPages()), 'etoro');
  const st = etoro.parsePages(etoroPages(), 'etoro.pdf');
  assert.deepEqual(st.period, { from: '2024-01-01', to: '2024-12-31' });
  assert.deepEqual(st.dividends.map((d) => [d.date, d.symbol, d.isin, d.currency, d.amount]), [['2024-09-16', 'ZZZ', 'US0000000007', 'USD', 1]]);
  assert.deepEqual(st.withholding.map((d) => [d.date, d.symbol, d.amount]), [['2024-09-16', 'ZZZ', -0.1]]);
  const r = compute(tagged(st, 'etoro', 'eToro'), rates, 2024);
  assert.deepEqual(r.dividends.map((d) => [d.source, d.symbol, d.country, d.gross, d.tax, d.method]), [['eToro', 'ZZZ', 'САЩ', 1.76, 0.18, '1']]);
});

const revolutPnl = () => [
  page([57, [178, 'USD Profit and Loss Statement', 15]], [84, [178, 'Period'], [237, '01 Jan 2024 - 06 Jan 2025']],
    [204, [28, 'Sells', 9]], [219, [28, 'Date acquired'], [130, 'Date sold'], [199, 'Symbol']],
    [234, [28, '2020-10-06'], [130, '2024-02-08'], [199, 'QQQ'], [253, 'Qqq Inc'], [359, 'US0000000008'], [389, 'US'], [448, '2'], [512, 'US$118'], [588, 'US$108'], [702, '-US$10'], [797, 'US$1']],
    [250, [28, 'Total'], [512, 'US$118'], [588, 'US$108']],
    [315, [135, 'Revolut Securities Europe UAB is an authorised financial brokerage firm', 5]]),
  page([57, [178, 'USD Profit and Loss Statement', 15]],
    [151, [28, 'Dividends', 9]], [165, [28, 'Date'], [122, 'Symbol'], [477, 'Gross Amount']],
    [180, [28, '2024-09-16'], [122, 'QQQ'], [180, 'Qqq Inc'], [293, 'US0000000008'], [413, 'US'], [477, 'US$2.22'], [589, 'US$0.22'], [787, 'US$2']],
    [186, [477, '3.91 BGN', 5], [589, '0.39 BGN', 5]],
    [204, [28, '2025-01-03'], [122, 'QQQ'], [180, 'Qqq Inc'], [293, 'US0000000008'], [413, 'US'], [477, 'US$5'], [589, '-'], [787, 'US$5']],
    [278, [28, 'Total'], [477, 'US$7.22'], [589, 'US$0.22'], [784, 'US$7']]),
];

test('revolut trading statement: dividends, sells with purchase date, rows after the tax year are left out', () => {
  assert.equal(detectPdf(revolutPnl()), 'revolut');
  const st = revolut.parsePages(revolutPnl(), 'pnl.pdf');
  assert.deepEqual(st.period, { from: '2024-01-01', to: '2025-01-06' });
  assert.deepEqual(st.dividends.map((d) => [d.date, d.symbol, d.amount]), [['2024-09-16', 'QQQ', 2.22], ['2025-01-03', 'QQQ', 5]]);
  assert.deepEqual(st.withholding.map((d) => [d.date, d.amount]), [['2024-09-16', -0.22]]);
  assert.deepEqual(st.sales, [{ category: 'Stocks', symbol: 'QQQ', isin: 'US0000000008', currency: 'USD', acquired: '2020-10-06', date: '2024-02-08', cost: 118, proceeds: 108 }]);
  const r = compute(tagged(st, 'revolut', 'Revolut'), rates, 2024);
  assert.equal(r.dividends.length, 1, 'the January 2025 dividend belongs to the next year');
  assert.ok(r.warnings.some((w) => /1 реда са с дата след 31\.12\.2024/.test(w)));
  // cost at the purchase-date rate (118 / 1.18), proceeds at the sale-date rate (108 / 1.08): no gain in leva
  assert.deepEqual(r.sales.rows.map((x) => [x.source, x.app, x.acquired, x.sale, x.cost, x.result]), [['Revolut', 5, '2020-10-06', 195.58, 195.58, 0]]);
});

const revolutFund = () => [
  page([59, [362, 'Flexible Account Statement', 18]], [83, [522, 'From: Jan 1, 2024', 7]], [105, [526, 'To: Dec 31, 2024', 7]],
    [232, [309, 'Total Earned Interest', 9], [542, '€0.65', 9]], [249, [14, 'Revolut account', 9]],
    [445, [20, 'Dec 30, 2024, 2:53:', 9], [114, 'Service Fee Charged EUR Class', 9]], [451, [256, '-€0.025', 9]], [457, [20, '16 PM', 9], [114, 'IE0000000009', 9]],
    [491, [20, 'Dec 30, 2024, 2:53:', 9], [114, 'Interest PAID EUR Class R', 9]], [497, [256, '€0.325', 9]], [503, [20, '16 PM', 9], [114, 'IE0000000009', 9]],
    [537, [20, 'Jun 3, 2024, 11:37:', 9], [114, 'Interest PAID EUR Class R', 9]], [543, [256, '€0.325', 9]], [549, [20, '28 AM', 9], [114, 'IE0000000009', 9]],
    [583, [20, 'Jun 1, 2024, 1:26:', 9]], [589, [114, 'BUY EUR Class R IE0000000009', 9], [256, '€3,000', 9], [463, '1.00', 9], [554, '3,000', 9]]),
];

test('revolut flexible account: daily interest is summed and checked against the printed total', () => {
  const st = revolut.parsePages(revolutFund(), 'fund.pdf');
  assert.equal(st.kind, 'Flexible Account');
  assert.deepEqual(st.period, { from: '2024-01-01', to: '2024-12-31' });
  assert.deepEqual(st.interest.map((i) => [i.date, i.currency, i.amount]), [['2024-12-30', 'EUR', 0.325], ['2024-06-03', 'EUR', 0.325]]);
  assert.deepEqual(st.fees, [{ description: 'Такси Flexible Cash Funds', currency: 'EUR', amount: 0.025 }]);
  assert.ok(!st.warnings.some((w) => /не съвпадат/.test(w)));
  const off = revolutFund();
  off[0].find((i) => i.s === '€0.65').s = '€0.99';
  assert.ok(revolut.parsePages(off, 'fund.pdf').warnings.some((w) => /не съвпадат/.test(w)));
});

const iuvoPages = () => [
  page([164, [77, 'IUVO GROUP OÜ', 11]], [452, [77, 'Вашите приходи за периода', 11], [228, '2024-01-01 - 2024-12-31', 11]],
    [488, [78, 'Приходи от лихви', 11], [463, '100.00 EUR', 11]], [501, [476, '60.00 EUR', 9]], [504, [93, 'Оригинатори от България', 9]],
    [553, [78, 'Такси закъснение', 11], [468, '5.50 EUR', 11]],
    [619, [78, 'Печалби Вторичен пазар', 11], [474, '2.00 EUR', 11]],
    [684, [78, 'Бонус програми', 11]], [694, [474, '0.00 EUR', 11]],
    [753, [86, 'Общо', 11], [456, '107.50 EUR', 11]]),
  page([60, [77, 'Вашите разходи за периода', 11]], [121, [78, 'Такси Вторичен пазар', 11], [474, '1.25 EUR', 11]], [248, [86, 'Общо', 11], [466, '1.25 EUR', 11]]),
];

test('iuvo: yearly totals become interest; secondary-market gains and expenses are report-only', () => {
  assert.equal(detectPdf(iuvoPages()), 'iuvo');
  const st = iuvo.parsePages(iuvoPages(), 'iuvo.pdf');
  assert.deepEqual(st.period, { from: '2024-01-01', to: '2024-12-31' });
  assert.deepEqual(st.interest.map((i) => [i.description, i.amount, i.date]), [['Лихви по заеми', 100, '2024-12-31'], ['Такси за закъснение', 5.5, '2024-12-31']]);
  assert.deepEqual(st.otherIncome.map((i) => [i.description, i.amount]), [['Печалби от вторичен пазар', 2]]);
  assert.deepEqual(st.fees.map((f) => [f.description, f.amount]), [['Такси Вторичен пазар', 1.25]]);
});

// ---- several sources in one draft ------------------------------------------------
const several = () => [statement(), tagged(etoro.parsePages(etoroPages(), 'etoro.pdf'), 'etoro', 'eToro'),
  tagged(revolut.parsePages(revolutPnl(), 'pnl.pdf'), 'revolut', 'Revolut'), tagged(iuvo.parsePages(iuvoPages(), 'iuvo.pdf'), 'iuvo', 'Iuvo')];

test('several statements are combined and every figure keeps its source', () => {
  const r = compute(several(), rates, 2024);
  assert.deepEqual(r.dividends.map((d) => `${d.source}:${d.symbol}`), ['IBKR:AAA', 'IBKR:UUU', 'eToro:ZZZ', 'Revolut:QQQ']);
  assert.deepEqual(r.interest.bySource, { IBKR: 58.67, Iuvo: 206.34 }); // (100 + 5.50) EUR x 1.95583
  assert.equal(r.interest.total, 265.01);
  assert.deepEqual(r.sales.app5.bySource, { IBKR: 2, Revolut: 1 });
  assert.deepEqual(r.sources.map((s) => [s.label, s.counts.dividends, s.counts.holdings, s.counts.sales]), [['IBKR', 2, 3, 3], ['eToro', 1, 0, 0], ['Revolut', 1, 0, 1], ['Iuvo', 0, 0, 0]]);
  assert.deepEqual(r.other.map((o) => o.source), ['IBKR', 'Iuvo']);
});

test('the result is written into a draft with a source on every imported row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nap-import-'));
  try {
    const store = new Store(dir);
    const draft = store.draftFrom(store.importHtml(fixture('declaration.html')), 2024);
    const prev = previousHoldings(draft, 2024);
    assert.equal(prev.length, 3, 'rows declared last year');
    const result = compute(several(), rates, 2024, {}, prev);
    const out = applyToDraft(draft, result);
    const row = (id) => draft.fields.filter((f) => f.rowId === id);
    assert.deepEqual(row('A8D5:1').map((f) => f.value), ['AAA', 'Германия', '8141', '1', '58.67', '0.00', '0.00', '15.45', '0.00', '0.00', '0.00']);
    assert.deepEqual([1, 2, 3, 4].map((n) => row(`A8D5:${n}`)[0].source), ['IBKR', 'IBKR', 'eToro', 'Revolut']);
    assert.equal(row('A8D5:3')[0].file, 'etoro.pdf');
    assert.deepEqual(row('A8D5:4').filter((f) => f.name).map((f) => f.name), ['dec50_app8_part38al1_rowenum[4]_incomecode', 'dec50_app8_part38al1_rowenum[4]_methodcode']);
    assert.equal(row('A8D5:4')[0].rowNo, '1.4');
    assert.deepEqual(row('A8D1:2').map((f) => f.value), ['Ирландия', '300', '03.06.2024', '3030.00', '5926.16']);
    const f603 = draft.fields.find((f) => /^Обща сума на доходите с код 603/.test(f.label));
    assert.deepEqual([f603.value, f603.sources], ['265.01', { IBKR: 58.67, Iuvo: 206.34 }]);
    assert.equal(new Set(draft.fields.map((f) => f.key)).size, draft.fields.length, 'keys stay unique');
    assert.ok(out.skipped.some((s) => /Приложение 5/.test(s)) && out.skipped.some((s) => /Приложение 13/.test(s)));

    // a row added by hand survives a recompute; removing a source removes only its rows
    const manual = row('A8D5:4').map((f) => ({ ...f, rowId: 'A8D5:5', key: f.key + '~m', value: 'x', manual: true, source: undefined, file: undefined }));
    draft.fields.splice(draft.fields.indexOf(row('A8D5:4').pop()) + 1, 0, ...manual);
    applyToDraft(draft, compute(several().filter((s) => s.label !== 'eToro'), rates, 2024, {}, prev));
    assert.deepEqual([1, 2, 3, 4].map((n) => [row(`A8D5:${n}`)[0].source, !!row(`A8D5:${n}`)[0].manual]), [['IBKR', false], ['IBKR', false], ['Revolut', false], [undefined, true]]);
    assert.equal(row('A8D5:4')[0].value, 'x');
    assert.equal(row('A8D5:5').length, 0);

    // nothing imported any more: imported rows and totals are cleared, the manual row stays
    applyToDraft(draft, compute([], rates, 2024, {}, prev));
    assert.deepEqual([row('A8D5:1')[0].manual, row('A8D5:2').length], [true, 0]);
    assert.deepEqual([f603.value, f603.sources], ['', undefined]);
    assert.ok(row('A8D1:1').every((f) => f.value === '' && !f.source));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setTableRows reports a missing table', () => {
  assert.equal(setTableRows({ fields: [] }, 'A5D2', []), false);
});

test('statement archive: copies go to <year>/statements and are not listed as declarations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nap-archive-'));
  try {
    const store = new Store(dir);
    const rel = store.saveStatement(fixture('ibkr.csv'), statement());
    assert.equal(rel, path.join('2024', 'statements', 'IBKR - ibkr.csv'));
    assert.equal(store.saveStatement(fixture('ibkr.csv'), statement()), rel, 'same content is stored once');
    assert.ok(fs.existsSync(path.join(dir, rel)));
    assert.deepEqual(store.list(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detection: csv by content, unknown files are rejected, a forced type is honoured', async () => {
  const st = await parseFile(fixture('ibkr.csv'));
  assert.deepEqual([st.type, st.label, st.id.length], ['ibkr', 'IBKR', 16]);
  await assert.rejects(parseFile(fixture('listing.html')), /не е разпознат/);
  await assert.rejects(parseFile(fixture('ibkr.csv'), 'iuvo'), /само PDF/);
  assert.equal(detectPdf([page([10, [10, 'Something else', 12]])]), null);
});

test('helpers: money, dates, ECB XML', () => {
  assert.deepEqual(money('US$1,539.64'), { amount: 1539.64, currency: 'USD' });
  assert.deepEqual(money('-€0.025'), { amount: -0.025, currency: 'EUR' });
  assert.equal(money('3.91 BGN'), null);
  assert.deepEqual(['Jan 1, 2024', 'January 1, 2024', '01 Jan 2023', 'JAN 1, 2023', 'Dec 31, 2023, 2:53:'].map(isoDate), ['2024-01-01', '2024-01-01', '2023-01-01', '2023-01-01', '2023-12-31']);
  const t = parseEcbXml('<Cube><Cube time="2024-05-03"><Cube currency="USD" rate="1.0744"/><Cube currency="GBP" rate="0.8559"/></Cube>\n<Cube time="2024-05-02"><Cube currency="USD" rate="1.0698"/></Cube></Cube>');
  const r = new Rates(t);
  assert.equal(r.perEur('USD', '2024-05-05'), 1.0744); // Sunday
  assert.equal(r.perEur('EUR', '2024-05-05'), 1);
  assert.equal(r.latest, '2024-05-03');
  assert.throws(() => r.perEur('JPY', '2024-05-03'));
});

// ---- where a sale was made: exchanges.js, the Trade Confirmation and the Борси settings -------------
const exchanges = require('../src/exchanges');
const confirm = require('../src/ibkr-confirm');

test('exchanges: defaults and the user\'s overrides', () => {
  assert.equal(exchanges.isExempt('IBIS'), true);
  assert.equal(exchanges.isExempt('GETTEX'), false, 'unclear venues are taxable until the user decides');
  assert.equal(exchanges.isExempt('NYSE'), false);
  assert.equal(exchanges.isExempt('NOSUCH'), null);
  assert.equal(exchanges.isExempt('GETTEX', { GETTEX: 'exempt' }), true);
  assert.equal(exchanges.isExempt('IBIS', { IBIS: 'taxable' }), false);
  assert.equal(exchanges.isExempt('NOSUCH', { NOSUCH: 'exempt' }), true);
  assert.deepEqual(exchanges.cleanOverrides({ gettex: 'exempt', BAD: 'maybe', 'x y': 'exempt' }), { GETTEX: 'exempt' });
  assert.equal(new Set(exchanges.CATALOGUE.map((e) => e.code)).size, exchanges.CATALOGUE.length, 'codes are unique');
  for (const e of exchanges.CATALOGUE) assert.ok(exchanges.STATUS[e.status] && e.note && e.name, e.code);
});

// A made-up Trade Confirmation: every order is printed as a summary row ("-" venue) and then once per fill.
const confirmPage = () => {
  const fill = (r, symbol, stamp, venue, side, qty, price, proceeds, comm, code) => [r,
    [10, 'U1234567'], [60, symbol], [100, stamp], [170, '2026-05-15'], [220, venue], [250, side], [280, qty], [310, price], [340, proceeds], [380, comm], [410, '0.00'], [440, 'LMT'], [470, code]];
  return page(
    [10, [10, 'Trade Confirmation Report']], [20, [10, 'January 1, 2026 - October 4, 2026']], [30, [10, 'Interactive Brokers Ireland Limited']], [40, [10, 'Base Currency'], [100, 'EUR']],
    [60, [10, 'Stocks']], [70, [10, 'EUR']],
    fill(80, 'ETF2', '2026-05-13, 07:15:57', '-', 'SELL', '-100', '110.00', '11,000.00', '-5.50', 'C'),
    fill(90, 'ETF2', '2026-05-13, 07:15:57', 'GETTEX', 'SELL', '-60', '110.00', '6,600.00', '-3.30', 'C'),
    fill(100, 'ETF2', '2026-05-13, 07:15:58', 'IBIS2', 'SELL', '-40', '110.00', '4,400.00', '-2.20', 'C'),
    [110, [10, 'Total ETF2 (Sold)'], [280, '-100'], [340, '11,000.00']],
    // the stamp split into a date and a time cell
    [120, [10, 'U1234567'], [60, 'XYZ'], [100, '2026-05-14,'], [130, '07:00:00'], [170, '2026-05-18'], [220, 'NYSE'], [250, 'BUY'], [280, '5'], [310, '10.00'], [340, '-50.00'], [380, '-1.00']],
    [130, [10, 'Forex']], [140, [10, 'GBP']],
    [150, [10, 'U1234567'], [60, 'EUR.GBP'], [100, '2026-04-15, 07:02:26'], [170, '2026-04-17'], [220, 'IDEALFX'], [250, 'BUY'], [280, '206.83'], [310, '0.86952'], [340, '-179.84']]);
};

test('trade confirmation: fills with their venue are read, order rows and forex are not', () => {
  const pages = [confirmPage()];
  assert.ok(confirm.isConfirm(pages));
  assert.equal(detectPdf(pages), 'ibkrconfirm');
  const st = confirm.parsePages(pages, 'confirm.pdf');
  assert.deepEqual(st.period, { from: '2026-01-01', to: '2026-10-04' });
  assert.equal(st.baseCurrency, 'EUR');
  assert.deepEqual(st.executions.map((x) => [x.symbol, x.date, x.time, x.side, x.venue, x.quantity, x.price, x.currency]), [
    ['ETF2', '2026-05-13', '07:15:57', 'SELL', 'GETTEX', 60, 110, 'EUR'],
    ['ETF2', '2026-05-13', '07:15:58', 'SELL', 'IBIS2', 40, 110, 'EUR'],
    ['XYZ', '2026-05-14', '07:00:00', 'BUY', 'NYSE', 5, 10, 'EUR'],
  ]);
  const a = tagged(st, 'ibkrconfirm', 'IBKR');
  assert.notEqual(a.id, statement().id);
});

const withFills = (fills) => { const st = statement(); st.executions = fills; return st; };
const etf2 = (r) => r.sales.rows.filter((x) => x.symbol === 'ETF2');

test('sales: the venue of the fills decides, and a sale split over venues goes to both appendices', () => {
  const fills = [
    { symbol: 'ETF2', date: '2024-05-02', side: 'SELL', venue: 'GETTEX', quantity: 250 },
    { symbol: 'ETF2', date: '2024-05-02', side: 'SELL', venue: 'IBIS', quantity: 750 },
  ];
  const r = compute(withFills(fills), rates, 2024);
  assert.deepEqual(etf2(r).map((x) => [x.app, x.exchange, x.exchangeBasis, x.sale, x.cost, x.result]), [
    [5, 'GETTEX', 'venue', 2442.34, 1955.83, 486.51],
    [13, 'IBIS', 'venue', 7327.03, 5867.49, 1459.54],
  ]);
  assert.ok(r.warnings.some((w) => /ETF2 \(GETTEX\).*не е сигурно.*облагаема/.test(w)));
  assert.ok(r.warnings.some((w) => /^\[IBKR\] 1 продажби са разделени на Приложение 5\/13 по борсата на основна регистрация/.test(w)), 'only USX has no fills and falls back to the listing');
  // the user decides that gettex counts as a regulated market
  const r2 = compute(withFills(fills), rates, 2024, {}, [], { exchangeRules: { GETTEX: 'exempt' } });
  assert.deepEqual(etf2(r2).map((x) => [x.app, x.exchange]), [[13, 'GETTEX + IBIS']]);
  assert.ok(r2.warnings.some((w) => /ETF2 \(GETTEX\).*необлагаема/.test(w)));
  // an unknown venue is taxable and reported
  const r3 = compute(withFills([{ symbol: 'ETF2', date: '2024-05-02', side: 'SELL', venue: 'NEWVENUE', quantity: 1000 }]), rates, 2024);
  assert.deepEqual(etf2(r3).map((x) => [x.app, x.exchange]), [[5, 'NEWVENUE']]);
  assert.ok(r3.warnings.some((w) => /„NEWVENUE“ не е в списъка/.test(w)));
});

test('sales: without fills the listing exchange is used and the report says so', () => {
  const r = compute(statement(), rates, 2024);
  assert.deepEqual(etf2(r).map((x) => [x.app, x.exchange, x.exchangeBasis]), [[13, 'IBIS2', 'listing']]);
  assert.ok(r.warnings.some((w) => /продажби са разделени на Приложение 5\/13 по борсата на основна регистрация/.test(w)));
});

test('sales: ETC/ETN are debt securities - taxable whatever the venue', () => {
  const st = withFills([{ symbol: 'ETF2', date: '2024-05-02', side: 'SELL', venue: 'IBIS', quantity: 1000 }]);
  st.instruments.ETF2.description = 'X IE PHYSICAL SILVER ETC';
  const r = compute(st, rates, 2024);
  assert.deepEqual(etf2(r).map((x) => x.app), [5]);
  assert.ok(r.warnings.some((w) => /ETF2.*ETC\/ETN.*облагаема/.test(w)));
  assert.deepEqual(etf2(compute(st, rates, 2024, {}, [], { etcTaxable: false })).map((x) => x.app), [13], 'the detection can be switched off');
  const named = compute(withFills([{ symbol: 'ETF2', date: '2024-05-02', side: 'SELL', venue: 'IBIS', quantity: 1000 }]), rates, 2024, {}, [], { taxableSymbols: ['ETF2'] });
  assert.deepEqual(etf2(named).map((x) => x.app), [5], 'a symbol the user listed is always taxable');
});

// ---- real statements (personal, git-ignored): run only where samples/ exists -----------
const samples = path.join(__dirname, '..', 'samples');
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (/_files$/.test(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)])) : []);
const real = walk(samples).filter((f) => /\.(csv|pdf)$/i.test(f));
const skip = !real.length && 'no local samples';

test('local samples: every statement is recognised and consistent with its own printed totals', { skip }, async () => {
  const types = {};
  for (const f of real) {
    let st;
    try { st = await parseFile(f); } catch (e) { if (/не е разпознат/.test(e.message)) continue; throw e; } // e.g. the declaration PDF
    types[st.type] = (types[st.type] || 0) + 1;
    assert.ok(st.period && st.year, `${st.type}: period`);
    assert.ok(st.dividends.length + st.interest.length + st.positions.length + st.sales.length + st.executions.length > 0, `${st.type}: has data`);
    if (st.type === 'ibkr' || st.kind === 'Консолидиран отчет') assert.equal(st.warnings.filter((w) => /не съвпада/.test(w)).length, 0, `${st.type}: printed totals match`);
  }
  assert.ok(Object.keys(types).length >= 1);
});

test('local samples: the IBKR PDF reads the same data as the CSV', { skip: !real.some((f) => /U\d+.*\.csv$/i.test(f)) && 'no IBKR csv+pdf pair' }, async () => {
  for (const f of real.filter((x) => /U\d+.*\.csv$/i.test(x) && fs.existsSync(x.replace(/\.csv$/i, '.pdf')))) {
    const a = await parseFile(f);
    const b = await parseFile(f.replace(/\.csv$/i, '.pdf'));
    assert.equal(b.id, a.id, 'same fingerprint, so importing both does not double the figures');
    assert.deepEqual(b.trades.map((x) => [x.symbol, x.date, x.quantity, x.code]), a.trades.map((x) => [x.symbol, x.date, x.quantity, x.code]));
    assert.deepEqual(b.dividends.map((x) => x.description), a.dividends.map((x) => x.description));
  }
});
