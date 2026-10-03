'use strict';
// Trading venues as IBKR codes them, and whether a sale of shares/ETFs made there is exempt
// (чл. 13, ал. 1, т. 3 ЗДДФЛ: deals "извършени на регулиран пазар и/или на пазар за растеж") or
// taxable (Приложение 5, код 508). The defaults are only a starting point - the user can change
// every venue on the "Борси" page, and the choices are kept in settings.json (see main.js).
//
// status:
//   regulated - a regulated market in the EU/EEA                     -> exempt by default
//   unclear   - the venue is (partly) an MTF / open market, so the   -> taxable by default, flagged
//               segment of the particular security decides
//   mtf       - not a regulated market (MTF, dark pool, SI)          -> taxable by default
//   outside   - outside the EU/EEA                                   -> taxable by default

const STATUS = {
  regulated: { label: 'Регулиран пазар (ЕС/ЕИП)', exempt: true },
  unclear: { label: 'Не е ясно', exempt: false },
  mtf: { label: 'Не е регулиран пазар (МСТ)', exempt: false },
  outside: { label: 'Извън ЕС/ЕИП', exempt: false },
};

const CATALOGUE = [
  // ---- regulated markets in the EU/EEA --------------------------------------------------------
  { code: 'IBIS', name: 'Xetra (Deutsche Börse)', country: 'Германия', status: 'regulated', note: 'Електронната търговия на Франкфуртската борса. Регулиран пазар.' },
  { code: 'IBIS2', name: 'Xetra (втори код на IBKR)', country: 'Германия', status: 'regulated', note: 'Втори код, който IBKR ползва за Xetra (често при ETF). Приема се за същия регулиран пазар.' },
  { code: 'FWB', name: 'Börse Frankfurt (парко)', country: 'Германия', status: 'regulated', note: 'Франкфуртската борса – регулиран пазар. Същата борса има и Open Market (МСТ); вижте FWB2.' },
  { code: 'AEB', name: 'Euronext Amsterdam', country: 'Нидерландия', status: 'regulated', note: 'Регулиран пазар на Euronext.' },
  { code: 'SBF', name: 'Euronext Paris', country: 'Франция', status: 'regulated', note: 'Регулиран пазар на Euronext.' },
  { code: 'ENEXT.BE', name: 'Euronext Brussels', country: 'Белгия', status: 'regulated', note: 'Регулиран пазар на Euronext.' },
  { code: 'BVL', name: 'Euronext Lisbon', country: 'Португалия', status: 'regulated', note: 'Регулиран пазар на Euronext.' },
  { code: 'ISED', name: 'Euronext Dublin', country: 'Ирландия', status: 'regulated', note: 'Регулиран пазар (бившата Irish Stock Exchange).' },
  { code: 'BVME', name: 'Borsa Italiana (Милано)', country: 'Италия', status: 'regulated', note: 'Регулиран пазар на Euronext Milan.' },
  { code: 'BVME.ETF', name: 'Borsa Italiana – ETFplus', country: 'Италия', status: 'regulated', note: 'Сегментът за ETF на Borsa Italiana.' },
  { code: 'BM', name: 'Bolsa de Madrid', country: 'Испания', status: 'regulated', note: 'Регулиран пазар.' },
  { code: 'VSE', name: 'Wiener Börse', country: 'Австрия', status: 'regulated', note: 'Регулиран пазар (Official Market и Second Regulated Market).' },
  { code: 'SFB', name: 'Nasdaq Stockholm', country: 'Швеция', status: 'regulated', note: 'Регулиран пазар.' },
  { code: 'CPH', name: 'Nasdaq Copenhagen', country: 'Дания', status: 'regulated', note: 'Регулиран пазар.' },
  { code: 'HEX', name: 'Nasdaq Helsinki', country: 'Финландия', status: 'regulated', note: 'Регулиран пазар.' },
  { code: 'OSE', name: 'Oslo Børs', country: 'Норвегия', status: 'regulated', note: 'Норвегия е в ЕИП, но не в ЕС – ЗДДФЛ не прави разлика при регулиран пазар, лицензиран по Директива 2014/65/ЕС.' },
  { code: 'WSE', name: 'Giełda Papierów Wartościowych (Варшава)', country: 'Полша', status: 'regulated', note: 'Регулиран пазар (основният пазар).' },
  { code: 'BUX', name: 'Budapest Stock Exchange', country: 'Унгария', status: 'regulated', note: 'Регулиран пазар.' },
  { code: 'PRA', name: 'Prague Stock Exchange', country: 'Чехия', status: 'regulated', note: 'Регулиран пазар (основният пазар).' },

  // ---- not clear: depends on the segment of the particular security -----------------------------
  { code: 'GETTEX', name: 'gettex (Börse München)', country: 'Германия', status: 'unclear', note: 'Повечето сделки са в „Freiverkehr“ (Open Market) – това е МСТ, не регулиран пазар. Част от книжата са допуснати и до регулирания пазар на Баварската борса.' },
  { code: 'GETTEX2', name: 'gettex (втори код на IBKR)', country: 'Германия', status: 'unclear', note: 'Същото като GETTEX. IBKR ползва втори код за част от инструментите.' },
  { code: 'TGATE', name: 'Tradegate Exchange (Берлин)', country: 'Германия', status: 'unclear', note: 'Търгува предимно в Freiverkehr (Open Market, МСТ). Регулиран е само сегментът за допуснатите книжа.' },
  { code: 'SWB', name: 'Börse Stuttgart / Euwax', country: 'Германия', status: 'unclear', note: 'Има регулиран пазар, но голяма част от търговията е в Open Market (МСТ).' },
  { code: 'SWB2', name: 'Börse Stuttgart (втори код на IBKR)', country: 'Германия', status: 'unclear', note: 'Същото като SWB.' },
  { code: 'FWB2', name: 'Börse Frankfurt (втори код на IBKR)', country: 'Германия', status: 'unclear', note: 'Не е ясно кой сегмент стои зад кода – Франкфурт има и регулиран пазар, и Open Market (МСТ).' },

  // ---- venues that are not regulated markets -------------------------------------------------
  { code: 'BATEDE', name: 'Cboe Europe (BATS), Германия', country: 'Германия', status: 'mtf', note: 'Многостранна система за търговия (МСТ). Не е регулиран пазар, освен ако е лицензирана като пазар за растеж.' },
  { code: 'CHIXDE', name: 'Cboe Europe (Chi-X), Германия', country: 'Германия', status: 'mtf', note: 'Многостранна система за търговия (МСТ). Не е регулиран пазар.' },
  { code: 'TRQXDE', name: 'Turquoise, Германия', country: 'Германия', status: 'mtf', note: 'Многостранна система за търговия (МСТ). Не е регулиран пазар.' },
  { code: 'EUDARK', name: 'Dark pool / вътрешно изпълнение (IBKR)', country: 'ЕС', status: 'mtf', note: 'Непрозрачна система за търговия – не е регулиран пазар. Чести са частичните изпълнения по този код.' },

  // ---- outside the EU/EEA --------------------------------------------------------------------
  { code: 'NYSE', name: 'New York Stock Exchange', country: 'САЩ', status: 'outside', note: 'Извън ЕС/ЕИП.' },
  { code: 'NASDAQ', name: 'Nasdaq', country: 'САЩ', status: 'outside', note: 'Извън ЕС/ЕИП.' },
  { code: 'ARCA', name: 'NYSE Arca', country: 'САЩ', status: 'outside', note: 'Извън ЕС/ЕИП. Тук са листнати много ETF.' },
  { code: 'AMEX', name: 'NYSE American', country: 'САЩ', status: 'outside', note: 'Извън ЕС/ЕИП.' },
  { code: 'BATS', name: 'Cboe BZX', country: 'САЩ', status: 'outside', note: 'Извън ЕС/ЕИП.' },
  { code: 'IEX', name: 'Investors Exchange', country: 'САЩ', status: 'outside', note: 'Извън ЕС/ЕИП.' },
  { code: 'PINK', name: 'OTC Markets (Pink)', country: 'САЩ', status: 'outside', note: 'Извънборсов пазар, извън ЕС/ЕИП.' },
  { code: 'LSE', name: 'London Stock Exchange', country: 'Великобритания', status: 'outside', note: 'След Брекзит Великобритания не е държава членка и не е в ЕИП.' },
  { code: 'LSEETF', name: 'London Stock Exchange – ETF', country: 'Великобритания', status: 'outside', note: 'След Брекзит Великобритания не е държава членка и не е в ЕИП.' },
  { code: 'SWX', name: 'SIX Swiss Exchange', country: 'Швейцария', status: 'outside', note: 'Швейцария не е в ЕС/ЕИП.' },
  { code: 'EBS', name: 'SIX Swiss Exchange (втори код)', country: 'Швейцария', status: 'outside', note: 'Швейцария не е в ЕС/ЕИП.' },
  { code: 'TSE', name: 'Toronto Stock Exchange', country: 'Канада', status: 'outside', note: 'Извън ЕС/ЕИП.' },
  { code: 'TSEJ', name: 'Tokyo Stock Exchange', country: 'Япония', status: 'outside', note: 'Извън ЕС/ЕИП.' },
  { code: 'SEHK', name: 'Hong Kong Stock Exchange', country: 'Хонконг', status: 'outside', note: 'Извън ЕС/ЕИП.' },
  { code: 'ASX', name: 'Australian Securities Exchange', country: 'Австралия', status: 'outside', note: 'Извън ЕС/ЕИП.' },
];

const BY_CODE = new Map(CATALOGUE.map((e) => [e.code, e]));

const lookup = (code) => BY_CODE.get(code) || null;
const defaultExempt = (code) => { const e = BY_CODE.get(code); return e ? STATUS[e.status].exempt : null; };

/**
 * Is a sale on this venue exempt? `overrides` is {code: 'exempt'|'taxable'} from the user's settings.
 * true / false, or null when the venue is neither known nor set by the user.
 */
function isExempt(code, overrides = {}) {
  const o = overrides && overrides[code];
  if (o === 'exempt') return true;
  if (o === 'taxable') return false;
  return defaultExempt(code);
}

/** Keep only well-formed overrides (used when reading/writing settings). */
function cleanOverrides(raw) {
  const out = {};
  for (const [code, v] of Object.entries(raw || {})) {
    if ((v === 'exempt' || v === 'taxable') && /^[A-Za-z0-9._-]{1,16}$/.test(code)) out[code.toUpperCase()] = v;
  }
  return out;
}

module.exports = { STATUS, CATALOGUE, lookup, defaultExempt, isExempt, cleanOverrides };
