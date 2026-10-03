'use strict';
// Euro reference rates of the ECB. Until 2025 the BNB fixing was the same rates
// times the fixed 1.95583 BGN/EUR; from 2026 the euro reference rates apply
// directly. Checked against a filed declaration: the rate of the payment date
// itself (not the previous business day) reproduces the declared amounts.

const fs = require('fs');

const ECB_HIST_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml';
const BGN_PER_EUR = 1.95583;

function parseEcbXml(xml) {
  const table = {};
  const days = xml.split(/<Cube\s+time=/).slice(1);
  for (const d of days) {
    const date = (d.match(/^['"](\d{4}-\d{2}-\d{2})['"]/) || [])[1];
    if (!date) continue;
    const day = {};
    for (const m of d.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) day[m[1]] = Number(m[2]);
    table[date] = day;
  }
  return table;
}

class Rates {
  /** @param table {"2024-01-02": {USD: 1.0956, ...}} units of the currency per 1 EUR */
  constructor(table) {
    this.table = table || {};
    this.dates = Object.keys(this.table).sort();
  }

  get latest() { return this.dates[this.dates.length - 1] || null; }

  /** Units of `currency` per 1 EUR on `date`; weekends/holidays use the last published rate. */
  perEur(currency, date) {
    if (currency === 'EUR') return 1;
    if (currency === 'BGN') return BGN_PER_EUR;
    const d = new Date(date + 'T00:00:00Z');
    for (let i = 0; i < 10; i++) {
      const day = this.table[d.toISOString().slice(0, 10)];
      if (day && day[currency]) return day[currency];
      d.setUTCDate(d.getUTCDate() - 1);
    }
    throw new Error(`Няма курс на ЕЦБ за ${currency} към ${date}.`);
  }

  toEur(amount, currency, date) { return amount / this.perEur(currency, date); }
}

/**
 * Rates covering `needDate`, from the cache file when it is recent enough,
 * otherwise downloaded from the ECB and cached.
 */
async function loadRates({ cacheFile, fetch, needDate }) {
  let table = null;
  try { table = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* no cache yet */ }
  let rates = new Rates(table);
  // the ECB publishes on business days only, so allow a few days of slack
  const need = new Date(needDate + 'T00:00:00Z');
  need.setUTCDate(need.getUTCDate() - 5);
  if (rates.latest && rates.latest >= need.toISOString().slice(0, 10)) return rates;
  try {
    const res = await fetch(ECB_HIST_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fresh = parseEcbXml(await res.text());
    if (Object.keys(fresh).length < 100) throw new Error('неочакван формат');
    fs.writeFileSync(cacheFile, JSON.stringify(fresh));
    rates = new Rates(fresh);
  } catch (e) {
    if (!rates.latest) throw new Error(`Курсовете на ЕЦБ не могат да бъдат изтеглени: ${e.message}`);
    rates.stale = `Курсовете на ЕЦБ не бяха обновени (${e.message}); използвани са наличните до ${rates.latest}.`;
  }
  return rates;
}

module.exports = { Rates, loadRates, parseEcbXml, BGN_PER_EUR, ECB_HIST_URL };
