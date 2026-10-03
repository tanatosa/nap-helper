'use strict';
// Turns parsed statements (see statements.js) into the figures the annual
// declaration needs and writes them into a draft:
//   Приложение 8, Част I   - shares held abroad on 31 December
//   Приложение 8, Част III - dividends (code 8141) and the final tax on them
//   Приложение 6           - interest (code 603)
//   Приложение 5 / 13      - sales of financial assets (5: taxable, code 508;
//                            13: exempt, EU/EEA regulated market)
// Amounts are converted with the ECB rate of the day: to leva (x 1.95583) for
// tax years up to 2025, to euro from 2026. Every row keeps the source it came
// from, so the draft can show which statement produced which line.

const { BGN_PER_EUR } = require('./rates');
const exchanges = require('./exchanges');

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const fmt = (n) => round2(n).toFixed(2);
const bgDate = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
const DIVIDEND_TAX = 0.05; // чл. 46, ал. 3 ЗДДФЛ

// Country of the issuer, from the ISIN prefix.
const COUNTRY = {
  AT: 'Австрия', AU: 'Австралия', BE: 'Белгия', BM: 'Бермуда', BR: 'Бразилия', CA: 'Канада', CH: 'Швейцария', CN: 'Китай', CY: 'Кипър',
  CZ: 'Чехия', DE: 'Германия', DK: 'Дания', EE: 'Естония', ES: 'Испания', FI: 'Финландия', FR: 'Франция', GB: 'Великобритания', GG: 'Гърнзи',
  GR: 'Гърция', HK: 'Хонконг', HR: 'Хърватия', HU: 'Унгария', IE: 'Ирландия', IL: 'Израел', IN: 'Индия', IS: 'Исландия', IT: 'Италия',
  JE: 'Джърси', JP: 'Япония', KR: 'Южна Корея', KY: 'Кайманови острови', LI: 'Лихтенщайн', LT: 'Литва', LU: 'Люксембург', LV: 'Латвия',
  MT: 'Малта', MX: 'Мексико', NL: 'Нидерландия (Холандия)', NO: 'Норвегия', NZ: 'Нова Зеландия', PL: 'Полша', PT: 'Португалия', RO: 'Румъния',
  SE: 'Швеция', SG: 'Сингапур', SI: 'Словения', SK: 'Словакия', TW: 'Тайван', US: 'САЩ', ZA: 'Южна Африка',
};

// Venues whose sales are exempt by default (чл. 13, ал. 1, т. 3 ЗДДФЛ) - see exchanges.js, where the user can change them.
const EU_REGULATED = new Set(exchanges.CATALOGUE.filter((e) => exchanges.defaultExempt(e.code)).map((e) => e.code));
// Exchange-traded commodities/notes are debt securities, not fund units or shares (§ 1, т. 11, б. "а" ДР ЗДДФЛ), whatever the broker calls them.
const DEBT_LIKE = /\b(ETC|ETN|ETP)\b|\bPHYSICAL\b|COMMODIT/i;

const DEFAULTS = { dividendMethod: 'withheld', holdingsMode: 'positions' };

/**
 * @param statements parsed statements, each with .label (source) and .source (file name)
 * @param rates      Rates
 * @param taxYear    year of the declaration being drafted
 * @param options    {dividendMethod: 'withheld'|'credit'|'none', holdingsMode: 'positions'|'lots'}
 * @param previousHoldings rows declared last year: [{quantity, price, dateIso, local}] - used to recover acquisition dates
 * @param rules      the user's choices from the "Борси" page: {exchangeRules: {code: 'exempt'|'taxable'}, taxableSymbols: [], exemptSymbols: [], etcTaxable: bool}
 */
function compute(statements, rates, taxYear, options = {}, previousHoldings = [], rules = {}) {
  const list = Array.isArray(statements) ? statements : [statements];
  const opt = { ...DEFAULTS, ...options };
  if (opt.dividendMethod === 'asBefore') opt.dividendMethod = 'withheld'; // name used by earlier versions
  const euro = taxYear >= 2026;
  const unit = euro ? '€' : 'лв.';
  const local = (amount, currency, date) => rates.toEur(amount, currency, date) * (euro ? 1 : BGN_PER_EUR);
  const prev = previousHoldings.map((h) => ({ ...h }));
  const yearEnd = `${taxYear}-12-31`, yearStart = `${taxYear}-01-01`;

  const out = { taxYear, unit, options: opt, sources: [], dividends: [], holdings: [], interest: { total: 0, taxAbroad: 0, rows: [], bySource: {} },
    sales: { app5: null, app13: null, rows: [] }, other: [], fees: [], warnings: [] };
  if (rates.stale) out.warnings.push(rates.stale);

  // fills with their venue (Trade Confirmation Report), by symbol, day and side
  const fills = new Map();
  for (const st of list) {
    for (const f of st.executions || []) {
      const k = `${f.symbol}|${f.date}|${f.side}`;
      if (!fills.has(k)) fills.set(k, []);
      fills.get(k).push(f);
    }
  }
  const exemptSymbols = new Set((rules.exemptSymbols || []).map((x) => String(x).trim()).filter(Boolean));
  const taxableSymbols = new Set((rules.taxableSymbols || []).map((x) => String(x).trim()).filter(Boolean));

  for (const st of list) {
    const src = st.label || 'IBKR';
    const tag = { source: src, file: st.source };
    const warn = (w) => out.warnings.push(`[${src}] ${w}`);
    st.warnings.forEach(warn);
    const period = st.period || { from: yearStart, to: yearEnd };
    if (period.to < yearStart || period.from > yearEnd) warn(`Отчетът „${st.source}“ е за ${period.from.slice(0, 4)} г., а черновата е за данъчна година ${taxYear}.`);
    // A statement may run past the tax year; what is dated after 31 December belongs to the next declaration.
    let later = 0;
    const inYear = (x) => { if (x.date > yearEnd) { later++; return false; } return true; };
    const byIsin = (isin, what) => {
      const c = COUNTRY[(isin || '').slice(0, 2)];
      if (!c) warn(`${what}: държавата не е разпозната (ISIN ${isin || 'липсва'}) – попълнете я ръчно.`);
      return c || '';
    };

    // ---- dividends -------------------------------------------------------------
    const groups = new Map();
    const key = (x) => `${x.isin || x.symbol}|${x.date}|${x.currency}`;
    for (const d of st.dividends.filter(inYear)) {
      if (!groups.has(key(d))) groups.set(key(d), { ...d, amount: 0, tax: 0, inLieu: false });
      const g = groups.get(key(d));
      g.amount += d.amount;
      if (/in lieu/i.test(d.description)) g.inLieu = true;
    }
    for (const w of st.withholding.filter(inYear)) {
      if (!w.symbol) { out.interest.taxAbroad += local(-w.amount, w.currency, w.date); continue; }
      let g = groups.get(key(w));
      if (!g) { // tax booked on another day than the dividend: closest payment of the same security
        const same = [...groups.values()].filter((x) => (x.isin || x.symbol) === (w.isin || w.symbol) && x.currency === w.currency);
        g = same.sort((a, b) => Math.abs(new Date(a.date) - new Date(w.date)) - Math.abs(new Date(b.date) - new Date(w.date)))[0];
      }
      if (g) g.tax += -w.amount;
      else if (Math.abs(w.amount) > 0.004) warn(`Удържан данък без съответен дивидент: ${w.description} (${w.amount} ${w.currency}).`);
    }
    let nDiv = 0;
    for (const g of groups.values()) {
      if (Math.abs(g.amount) < 0.00005) continue; // booked and reversed
      const gross = round2(local(g.amount, g.currency, g.date));
      const tax = round2(local(Math.max(0, g.tax), g.currency, g.date));
      const row = { ...tag, symbol: g.symbol, isin: g.isin, date: g.date, currency: g.currency, amount: round2(g.amount), taxAbroad: round2(g.tax),
        country: byIsin(g.isin, `Дивидент ${g.symbol}`), gross, tax, method: '', allowed: null, recognised: null, due: null };
      if (opt.dividendMethod === 'withheld') {
        if (tax > 0) {
          Object.assign(row, { method: '1', allowed: 0, recognised: 0, due: 0 });
          if (tax < round2(gross * DIVIDEND_TAX) - 0.005) warn(`Дивидент ${g.symbol} от ${bgDate(g.date)}: удържаният в чужбина данък (${fmt(tax)}) е под 5% от брутния размер, а редът е с дължим данък 0.`);
        } else Object.assign(row, { method: '3', allowed: 0, recognised: 0, due: round2(gross * DIVIDEND_TAX) });
      } else if (opt.dividendMethod === 'credit') {
        const allowed = round2(gross * DIVIDEND_TAX);
        const recognised = Math.min(tax, allowed);
        Object.assign(row, { method: '3', allowed, recognised, due: round2(allowed - recognised) });
      }
      if (g.inLieu) warn(`${g.symbol} от ${bgDate(g.date)} включва „Payment in Lieu of Dividend“ (плащане вместо дивидент при заети акции) – декларирано е като дивидент.`);
      if (g.date < yearStart) warn(`Дивидент ${g.symbol} е с дата ${bgDate(g.date)}, преди данъчната година – проверете дали не е деклариран за предходната година.`);
      out.dividends.push(row);
      nDiv++;
    }

    // ---- holdings on 31 December ---------------------------------------------------
    let nHold = 0;
    for (const p of st.positions.filter((x) => x.category === 'Stocks' && x.quantity > 0)) {
      const info = st.instruments[p.symbol] || {};
      const where = byIsin(info.isin, `Акции ${p.symbol}`);
      let lots = p.lots.filter((l) => l.date).map((l) => ({ ...l }));
      let priorQty = 0, priorCost = 0;
      if (!lots.length) {
        // rebuild the lots from this period's trades; what was sold comes off the oldest shares first
        const trades = st.trades.filter((t) => t.symbol === p.symbol && t.category === 'Stocks').sort((a, b) => a.date.localeCompare(b.date));
        const bought = trades.filter((t) => t.quantity > 0).map((t) => ({ date: t.date, quantity: t.quantity, costBasis: Math.abs(t.basis) }));
        let sold = trades.filter((t) => t.quantity < 0).reduce((a, t) => a - t.quantity, 0);
        const start = p.quantity - bought.reduce((a, l) => a + l.quantity, 0) + sold;
        priorQty = Math.max(0, start - sold);
        sold = Math.max(0, sold - Math.max(0, start));
        for (const l of bought) {
          const take = Math.min(sold, l.quantity);
          if (take) { l.costBasis *= (l.quantity - take) / l.quantity; l.quantity -= take; sold -= take; }
        }
        lots = bought.filter((l) => l.quantity > 0.0000001);
        priorCost = p.costBasis - lots.reduce((a, l) => a + l.costBasis, 0);
        if (priorQty < 0.0000001) priorQty = 0;
      }
      const make = (quantity, cost, date) => {
        const row = { ...tag, symbol: p.symbol, isin: info.isin || '', country: where, quantity: round2(quantity), date, currency: p.currency, price: round2(cost), local: null };
        if (date) { row.local = round2(local(cost, p.currency, date)); return row; }
        // bought before this statement: look the purchase up among last year's rows
        const old = prev.find((h) => !h.used && Math.abs(h.quantity - row.quantity) < 0.0001 && Math.abs(h.price - row.price) < 0.011);
        if (old) { old.used = true; row.date = old.dateIso; row.local = old.local; row.fromPrevious = true; }
        else if (p.currency === 'EUR') row.local = round2(cost * (euro ? 1 : BGN_PER_EUR));
        return row;
      };
      const rows = [];
      if (opt.holdingsMode === 'positions') {
        // one row per security, dated with its latest purchase (as in the declarations filed so far)
        const row = make(p.quantity, p.costBasis, '');
        if (!row.fromPrevious && lots.length) {
          row.date = lots[lots.length - 1].date;
          if (p.currency !== 'EUR') row.local = priorQty ? null : round2(lots.reduce((a, l) => a + local(l.costBasis, p.currency, l.date), 0));
        }
        rows.push(row);
      } else {
        if (priorQty) rows.push(make(priorQty, priorCost, ''));
        for (const l of lots) rows.push(make(l.quantity, l.costBasis, l.date));
      }
      for (const row of rows) {
        const missing = [!row.date && 'датата на придобиване', row.local == null && `цената в ${unit}`].filter(Boolean);
        if (missing.length) warn(`Акции ${p.symbol} (${row.quantity} бр.): част от позицията е придобита преди периода на извлечението – попълнете ръчно ${missing.join(' и ')}.`);
      }
      out.holdings.push(...rows);
      nHold += rows.length;
    }

    // ---- interest ------------------------------------------------------------------
    const kindOf = (d) => (/Bond Coupon/i.test(d) ? 'Купони по облигации' : /SYEP|Securities Lent/i.test(d) ? 'Лихва от заети акции (SYEP)' : /Credit Interest/i.test(d) ? 'Лихва по парични наличности' : /Debit Interest/i.test(d) ? 'Платена лихва' : d || 'Други');
    const byKind = {};
    let total = 0;
    for (const i of st.interest.filter(inYear)) {
      const v = local(i.amount, i.currency, i.date);
      byKind[kindOf(i.description)] = (byKind[kindOf(i.description)] || 0) + v;
      if (i.amount > 0) total += v; // paid (debit) interest is not deducted from interest income
    }
    for (const [kind, v] of Object.entries(byKind)) out.interest.rows.push({ ...tag, kind, amount: round2(v) });
    if (total) out.interest.bySource[src] = round2((out.interest.bySource[src] || 0) + total);
    if (byKind['Купони по облигации']) warn('Сумата по код 603 включва купони по облигации. Лихвите по държавни облигации на държави от ЕС/ЕИП са необлагаеми (чл. 13, ал. 1, т. 9 ЗДДФЛ) – извадете ги, ако е приложимо.');

    // ---- sales ---------------------------------------------------------------------
    let nSales = 0, byListing = 0;
    // Where the deal was made: the venues of its fills when a Trade Confirmation is imported, else the listing exchange.
    // Returns [{share, exempt, exchange}] - one part per verdict, so a sale split between a regulated market and an MTF goes to both.
    const placesOf = (t, info) => {
      const listing = info.exchange || '';
      if (t.category !== 'Stocks') return [{ share: 1, exempt: false, exchange: listing, venue: false }];
      if (exemptSymbols.has(t.symbol) && !taxableSymbols.has(t.symbol)) {
        warn(`Продажба ${t.symbol}: зададен е като винаги необлагаем в раздел „Борси“ – третирана е като необлагаема (Приложение 13) независимо от борсата и вида на книжата. Това не отговаря на закона, който гледа мястото на сделката – уверете се, че е вярно.`);
        return [{ share: 1, exempt: true, exchange: listing, venue: false }];
      }
      const debt = taxableSymbols.has(t.symbol) ? 'е зададен като облагаем в раздел „Борси“' : rules.etcTaxable !== false && DEBT_LIKE.test(info.description || '') ? `„${info.description}“ изглежда ETC/ETN – дългова ценна книга, не дял на фонд или акция` : '';
      if (debt) {
        warn(`Продажба ${t.symbol}: ${debt}; третирана е като облагаема (Приложение 5) независимо от борсата.`);
        return [{ share: 1, exempt: false, exchange: listing, venue: false }];
      }
      const filled = fills.get(`${t.symbol}|${t.date}|${t.quantity < 0 ? 'SELL' : 'BUY'}`);
      const qty = new Map();
      for (const f of filled || [{ venue: listing, quantity: 1 }]) qty.set(f.venue, (qty.get(f.venue) || 0) + f.quantity);
      if (!filled) byListing++;
      const total = [...qty.values()].reduce((a, v) => a + v, 0) || 1;
      const parts = new Map();
      for (const [code, q] of qty) {
        const ex = exchanges.isExempt(code, rules.exchangeRules);
        const entry = exchanges.lookup(code);
        const exempt = ex === true;
        if (ex === null) warn(`Продажба ${t.symbol}: борсата „${code || '—'}“ не е в списъка – третирана е като облагаема. Задайте я в раздел „Борси“.`);
        else if ((entry && entry.status === 'unclear') || ex !== exchanges.defaultExempt(code)) {
          warn(`Продажба ${t.symbol} (${code}): ${entry && entry.status === 'unclear' ? 'не е сигурно дали това е регулиран пазар' : 'настройката е сменена ръчно'} – третирана е като ${exempt ? 'необлагаема (Приложение 13)' : 'облагаема (Приложение 5)'}, според раздел „Борси“.`);
        }
        const part = parts.get(exempt) || { share: 0, exempt, exchange: [], venue: !!filled };
        part.share += q / total;
        part.exchange.push(code || '—');
        parts.set(exempt, part);
      }
      return [...parts.values()].map((p) => ({ ...p, exchange: p.exchange.join(' + ') }));
    };
    // brokers that report each closing trade with its realised result (IBKR): both sides at the sale-date rate
    for (const t of st.trades.filter((x) => /(^|;)C(;|$)/.test(x.code) || Math.abs(x.realized) > 0.004).filter(inYear)) {
      const info = st.instruments[t.symbol] || {};
      // a long position is closed by a sale; a short one by buying back
      const sale = t.basis > 0 ? t.basis : t.proceeds + t.commission;
      const cost = t.basis > 0 ? -(t.proceeds + t.commission) : -t.basis;
      for (const p of placesOf(t, info)) {
        out.sales.rows.push({ ...tag, symbol: t.symbol, date: t.date, acquired: '', category: t.category, exchange: p.exchange, exchangeBasis: p.venue ? 'venue' : 'listing', currency: t.currency, app: p.exempt ? 13 : 5,
          sale: round2(local(sale, t.currency, t.date) * p.share), cost: round2(local(cost, t.currency, t.date) * p.share), result: round2(local(t.realized, t.currency, t.date) * p.share) });
      }
      nSales++;
    }
    if (nSales) warn('Продажбите са преизчислени по курса към датата на продажбата.');
    if (byListing) warn(`${byListing} продажби са разделени на Приложение 5/13 по борсата на основна регистрация на книжата, не по мястото на конкретната сделка. Импортирайте „Trade Confirmation“ на IBKR, за да се използва борсата на изпълнение.`);
    // sources that report closed lots with the purchase date: cost at the purchase-date rate, proceeds at the sale-date rate
    for (const s of st.sales.filter(inYear)) {
      const sale = round2(local(s.proceeds, s.currency, s.date));
      const cost = round2(local(s.cost, s.currency, s.acquired || s.date));
      out.sales.rows.push({ ...tag, symbol: s.symbol, date: s.date, acquired: s.acquired || '', category: s.category, exchange: '', currency: s.currency, app: 5, sale, cost, result: round2(sale - cost) });
      nSales++;
    }
    for (const c of st.corporateActions.filter((x) => Math.abs(x.realized) > 0.004).filter(inYear)) {
      out.other.push({ ...tag, date: c.date, description: c.description, amount: round2(local(c.realized, c.currency, c.date)) });
    }
    if (st.corporateActions.some((x) => Math.abs(x.realized) > 0.004)) warn('Падежи на облигации и други корпоративни действия с реализиран резултат са показани само в отчета и не са нанесени в черновата.');
    for (const o of st.otherIncome.filter(inYear)) out.other.push({ ...tag, date: o.date, description: o.description, amount: round2(local(o.amount, o.currency, o.date)) });
    for (const f of st.fees) out.fees.push({ ...tag, description: f.description, amount: round2(local(f.amount, f.currency, period.to > yearEnd ? yearEnd : period.to)) });
    if (later) warn(`${later} реда са с дата след 31.12.${taxYear} и не са включени.`);

    out.sources.push({ id: st.id, type: st.type, label: src, file: st.source, kind: st.kind || '', period: st.period,
      counts: { dividends: nDiv, holdings: nHold, interest: round2(total), sales: nSales, fills: (st.executions || []).length } });
  }

  out.dividendTaxDue = opt.dividendMethod === 'none' ? null : round2(out.dividends.reduce((a, r) => a + r.due, 0));
  out.interest.total = round2(Object.values(out.interest.bySource).reduce((a, v) => a + v, 0));
  out.interest.taxAbroad = round2(out.interest.taxAbroad);
  const bucket = (app) => {
    const rows = out.sales.rows.filter((r) => r.app === app);
    const b = { sale: 0, cost: 0, gains: 0, losses: 0, count: rows.length, bySource: {} };
    for (const r of rows) {
      b.sale += r.sale; b.cost += r.cost;
      if (r.result >= 0) b.gains += r.result; else b.losses += -r.result;
      b.bySource[r.source] = (b.bySource[r.source] || 0) + 1;
    }
    for (const k of ['sale', 'cost', 'gains', 'losses']) b[k] = round2(b[k]);
    return b;
  };
  out.sales.app5 = bucket(5);
  out.sales.app13 = bucket(13);
  out.warnings = [...new Set(out.warnings)];
  return out;
}

// ---- writing into a draft ------------------------------------------------------
const tableOf = (f) => (f.rowId && f.rowId.includes(':') ? f.rowId.split(':')[0] : null);
const bump = (text, re, n) => String(text || '').replace(re, (m, a, _old, b) => a + n + (b || ''));
const rowsById = (fields) => { const m = new Map(); for (const f of fields) { if (!m.has(f.rowId)) m.set(f.rowId, []); m.get(f.rowId).push(f); } return [...m.values()]; };

/**
 * Replace the imported rows of table `tid` with `rows` ([{values: {columnNo: value}, source, file}]).
 * Rows the user added by hand (manual: true) are kept after the imported ones.
 * Returns false when the draft has no such table.
 */
function setTableRows(draft, tid, rows) {
  const all = draft.fields.filter((f) => tableOf(f) === tid);
  if (!all.length) return false;
  const groups = rowsById(all);
  const manual = groups.filter((g) => g[0].manual);
  const reusable = groups.filter((g) => !g[0].manual);
  const template = groups[0];
  const wanted = [...rows.map((r) => ({ ...r, fields: null })), ...manual.map((g) => ({ fields: g }))];
  if (!wanted.length) wanted.push({ values: {}, fields: null });
  const out = [];
  wanted.forEach((w, k) => {
    const n = k + 1;
    const rowId = `${tid}:${n}`;
    // keep the field objects of existing rows where possible, so "previous" values stay attached
    const base = w.fields || reusable[k] || template;
    const oldId = base[0].rowId;
    const fields = base.map((f, i) => {
      const fresh = w.fields || reusable[k] ? f : { ...f, previous: '', added: true };
      const g = Object.assign(fresh, {
        rowId,
        rowNo: bump(f.rowNo, /^(.*?)(\d+)()$/, n),
        name: f.name ? bump(f.name, /(rowenum\[)(\d+)(\])/, n) : f.name,
        key: bump(String(f.key || '').split(oldId).join(rowId), /(rowenum\[)(\d+)(\])/, n),
      });
      if (!w.fields) {
        const v = w.values[f.columnNo] ?? w.values[`#${i}`];
        g.value = v == null ? '' : String(v);
        g.source = w.source; g.file = w.file;
        delete g.manual;
      }
      return g;
    });
    out.push(...fields);
  });
  const first = draft.fields.indexOf(all[0]);
  draft.fields = draft.fields.filter((f) => tableOf(f) !== tid);
  draft.fields.splice(first, 0, ...out);
  return true;
}

/** Rows of the holdings table as declared last year (taken once, before the first import overwrites them). */
function previousHoldings(draft, taxYear) {
  const rows = new Map();
  for (const f of draft.fields.filter((x) => tableOf(x) === 'A8D1')) {
    if (!rows.has(f.rowId)) rows.set(f.rowId, {});
    rows.get(f.rowId)[f.columnNo] = f.previous || f.value || '';
  }
  // amounts carried over from a declaration in leva into a draft in euro
  const baseYear = Number(String(draft.basedOn || '').slice(0, 4));
  const factor = taxYear >= 2026 && baseYear && baseYear <= 2025 ? 1 / BGN_PER_EUR : 1;
  return [...rows.values()].filter((r) => r['3'] && r['4']).map((r) => ({
    quantity: Number(r['3']), price: Number(r['5']), local: round2(Number(r['6']) * factor),
    dateIso: /^\d{2}\.\d{2}\.\d{4}$/.test(r['4']) ? r['4'].split('.').reverse().join('-') : '',
  })).filter((r) => r.dateIso);
}

/** Set a single field from the import, remembering how much each source contributed. */
function setField(f, value, sources) {
  f.value = value;
  if (sources && Object.keys(sources).length) f.sources = sources; else delete f.sources;
}

function applyToDraft(draft, result) {
  const applied = [], skipped = [];
  const u = result.unit;
  const inSection = (re) => draft.fields.filter((f) => re.test(f.section));
  const srcList = (o) => Object.keys(o).join(' + ');

  // Приложение 8, Част I
  const held = result.holdings.map((h) => ({ source: h.source, file: h.file, values: { 2: h.country, 3: String(h.quantity), 4: bgDate(h.date), 5: fmt(h.price), 6: h.local == null ? '' : fmt(h.local) } }));
  if (setTableRows(draft, 'A8D1', held)) { if (held.length) applied.push(`Приложение 8, Част I: ${held.length} реда акции`); }
  else if (held.length) skipped.push('Приложение 8, Част I (акции) – в черновата няма такава таблица');

  // Приложение 8, Част III
  const none = result.options.dividendMethod === 'none';
  const divs = result.dividends.map((d) => ({ source: d.source, file: d.file, values: {
    2: d.symbol, 3: d.country, 4: '8141', 5: d.method, 6: fmt(d.gross), 7: '0.00', 8: '0.00', 9: fmt(d.tax),
    10: none ? '' : fmt(d.allowed), 11: none ? '' : fmt(d.recognised), 12: none ? '' : fmt(d.due),
  } }));
  const total8 = inSection(/Приложение № 8/).find((f) => /^Обща сума на окончателния данък по чл\. 38, ал\. 1 /.test(f.label));
  if (setTableRows(draft, 'A8D5', divs)) {
    if (divs.length) applied.push(`Приложение 8, Част III: ${divs.length} реда дивиденти`);
    if (total8 && divs.length && result.dividendTaxDue != null) {
      const per = {};
      for (const d of result.dividends) per[d.source] = round2((per[d.source] || 0) + d.due);
      setField(total8, fmt(result.dividendTaxDue), per);
      applied.push(`Приложение 8: дължим окончателен данък ${fmt(result.dividendTaxDue)} ${u}`);
    } else if (total8 && total8.sources) setField(total8, '', null);
  } else if (divs.length) skipped.push('Приложение 8, Част III (дивиденти) – в черновата няма такава таблица');

  // Приложение 6, код 603
  const app6 = inSection(/Приложение № 6/);
  const partI = app6.find((f) => /^Обща сума на доходите с код 603/.test(f.label));
  const inPartII = (f) => /Част ІІ|Част II/.test(f.part || '');
  const partII = app6.find((f) => inPartII(f) && (f.rowNo === '603' || /(^|\D)603(\D|$)/.test(f.label)) && f !== partI);
  const totals6 = app6.filter((f) => /^Общ размер на облагаемия доход|^Годишна данъчна основа за доходите по чл\. 35/.test(f.label));
  const interest = result.interest.total;
  if (partI && (interest || partI.sources)) {
    const v = interest ? fmt(interest) : '';
    const per = interest ? result.interest.bySource : null;
    setField(partI, v, per);
    if (partII) setField(partII, v, per);
    // totals of Part II when 603 is the only code used
    const others = app6.filter((f) => inPartII(f) && f !== partII && (/^60[1456]$/.test(f.rowNo || '') || /(^|\D)601(\D|$)/.test(f.label)));
    if (others.every((f) => !Number(f.value))) for (const f of totals6) setField(f, v, per);
    if (interest) applied.push(`Приложение 6, код 603: ${fmt(interest)} ${u} (${srcList(result.interest.bySource)})`);
  } else if (interest) skipped.push(`Приложение 6, код 603 (${fmt(interest)} ${u}) – в черновата няма Приложение 6`);

  // Приложение 5, код 508
  const s5 = result.sales.app5;
  const row5 = s5.count ? [{ source: srcList(s5.bySource), values: { 2: '508', 3: fmt(s5.sale), 4: fmt(s5.cost), 5: fmt(s5.gains), 6: fmt(s5.losses) } }] : [];
  const has5 = setTableRows(draft, 'A5D2', row5);
  if (s5.count && has5) applied.push(`Приложение 5, код 508: ${s5.count} продажби (${srcList(s5.bySource)})`);
  else if (s5.count) skipped.push(`Приложение 5, код 508 (продажна цена ${fmt(s5.sale)}, цена на придобиване ${fmt(s5.cost)}, печалби ${fmt(s5.gains)}, загуби ${fmt(s5.losses)} ${u}) – в черновата няма Приложение 5`);
  const s13 = result.sales.app13;
  if (s13.count) skipped.push(`Приложение 13 (необлагаеми продажби на регулиран пазар в ЕС/ЕИП: ${s13.count} сделки, продажна цена ${fmt(s13.sale)}, цена на придобиване ${fmt(s13.cost)} ${u}) – въведете ръчно`);

  return { applied, skipped };
}

module.exports = { compute, applyToDraft, previousHoldings, setTableRows, COUNTRY, EU_REGULATED, DEBT_LIKE };
