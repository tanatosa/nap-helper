'use strict';
// One entry point for every supported statement: recognises which broker a
// file comes from (or takes the type the user picked) and returns the
// normalised statement described in ibkr.js, tagged with its source.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pdfPages } = require('./pdftext');
const ibkr = require('./ibkr');
const ibkrConfirm = require('./ibkr-confirm');
const etoro = require('./etoro');
const revolut = require('./revolut');
const iuvo = require('./iuvo');

const SOURCES = {
  ibkr: { label: 'IBKR', name: 'Interactive Brokers', formats: 'CSV, PDF' },
  ibkrconfirm: { label: 'IBKR', name: 'Interactive Brokers – Trade Confirmation', formats: 'PDF' },
  revolut: { label: 'Revolut', name: 'Revolut', formats: 'PDF' },
  etoro: { label: 'eToro', name: 'eToro', formats: 'PDF' },
  iuvo: { label: 'Iuvo', name: 'Iuvo', formats: 'PDF' },
};

function detectPdf(pages) {
  if (ibkr.isIbkrPdf(pages)) return 'ibkr';
  if (ibkrConfirm.isConfirm(pages)) return 'ibkrconfirm';
  if (etoro.isEtoro(pages)) return 'etoro';
  if (iuvo.isIuvo(pages)) return 'iuvo';
  if (revolut.isRevolut(pages)) return 'revolut';
  return null;
}

/** Same data, whatever the file: used to recognise a statement that is already imported. */
function fingerprint(st) {
  const r2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
  const rows = [
    ...st.dividends.map((d) => ['d', d.date, d.isin || d.symbol, d.currency, r2(d.amount)]),
    ...st.withholding.map((d) => ['w', d.date, d.isin || d.symbol, d.currency, r2(d.amount)]),
    ...st.interest.map((d) => ['i', d.date, d.currency, r2(d.amount)]),
    ...st.positions.map((d) => ['p', d.symbol, d.quantity, r2(d.costBasis)]),
    ...st.trades.map((d) => ['t', d.date, d.symbol, d.quantity, r2(d.proceeds)]),
    ...st.sales.map((d) => ['s', d.date, d.symbol, r2(d.proceeds), r2(d.cost)]),
    ...(st.executions || []).map((d) => ['x', d.date, d.time, d.symbol, d.side, d.quantity, d.venue]),
  ].map((x) => x.join('|')).sort();
  return crypto.createHash('sha1').update(JSON.stringify([st.type, st.period, rows])).digest('hex').slice(0, 16);
}

/**
 * @param file path of the statement
 * @param type 'auto' or a key of SOURCES
 */
async function parseFile(file, type = 'auto') {
  const buf = fs.readFileSync(file);
  const name = path.basename(file);
  const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
  let st;
  if (isPdf) {
    const pages = await pdfPages(buf);
    if (!pages.length || !pages[0].length) throw new Error('PDF файлът няма текст (вероятно е сканирано изображение).');
    const t = type === 'auto' ? detectPdf(pages) : type;
    if (!t) throw new Error('Видът на извлечението не е разпознат – изберете източника ръчно.');
    if (!SOURCES[t]) throw new Error(`Непознат източник: ${t}`);
    st = { ibkr: ibkr.parsePdfPages, ibkrconfirm: ibkrConfirm.parsePages, etoro: etoro.parsePages, revolut: revolut.parsePages, iuvo: iuvo.parsePages }[t](pages, name);
    st.type = t;
  } else {
    const text = buf.toString('utf8');
    const t = type === 'auto' ? (ibkr.isIbkrCsv(text) ? 'ibkr' : null) : type;
    if (!t) throw new Error('Видът на файла не е разпознат – изберете източника ръчно.');
    if (t !== 'ibkr') throw new Error(`За ${SOURCES[t] ? SOURCES[t].name : t} се поддържа само PDF отчет.`);
    st = ibkr.parseCsv(text, name);
    st.type = 'ibkr';
  }
  const empty = !st.dividends.length && !st.interest.length && !st.positions.length && !st.trades.length && !st.executions.length && !st.sales.length && !st.otherIncome.length;
  if (empty && !st.period) throw new Error(`Файлът не прилича на отчет от ${SOURCES[st.type].name}.`);
  st.label = SOURCES[st.type].label;
  st.id = fingerprint(st);
  return st;
}

module.exports = { parseFile, detectPdf, fingerprint, SOURCES };
