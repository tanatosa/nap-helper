'use strict';
// PDF text with positions, shared by the statement readers. Each page becomes a
// list of items {s: text, c: column, r: row, h: font height} in device space
// (x to the right, y downwards, page rotation applied).

const fs = require('fs');
const { pathToFileURL } = require('url');

async function pdfPages(buf) {
  // pdf.js is an ES module; in the packaged app it is unpacked from the asar archive (see package.json)
  let file = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const unpacked = file.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  if (unpacked !== file && fs.existsSync(unpacked)) file = unpacked;
  const pdfjs = await import(pathToFileURL(file).href);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0, useSystemFonts: false, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      const s = (it.str || '').trim();
      if (!s) continue;
      const t = pdfjs.Util.transform(vp.transform, it.transform);
      items.push({ s, c: t[4], r: t[5], h: Math.hypot(t[0], t[1]) });
    }
    pages.push(items);
  }
  await doc.destroy();
  return pages;
}

/** Group items into visual rows, each sorted left to right. */
function rowsOf(items, tol = 1.5) {
  const rows = [];
  for (const it of items) {
    const row = rows.find((x) => Math.abs(x.r - it.r) <= tol);
    if (row) row.items.push(it); else rows.push({ r: it.r, items: [it] });
  }
  rows.forEach((x) => x.items.sort((a, b) => a.c - b.c));
  return rows.sort((a, b) => a.r - b.r);
}

const SYMBOLS = { '€': 'EUR', US$: 'USD', $: 'USD', '£': 'GBP' };
const RE_MONEY = /^(-?)(US\$|[€$£])\s?([\d,]*\.?\d+)$/;

/** "US$1,539.64" / "-€0.025" -> {amount, currency}; null when the text is not a money amount. */
function money(s) {
  const m = String(s).trim().match(RE_MONEY);
  return m ? { amount: Number(m[3].replace(/,/g, '')) * (m[1] ? -1 : 1), currency: SYMBOLS[m[2]] } : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');
/** "Jan 1, 2024", "January 1, 2024", "01 Jan 2023", "JAN 1, 2023" -> "2024-01-01" (null if not a date). */
function isoDate(s) {
  const t = String(s).trim();
  let m = t.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})/);
  if (!m) { const x = t.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})/); if (x) m = [x[0], x[2], x[1], x[3]]; }
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1].toLowerCase());
  return mo < 0 ? null : `${m[3]}-${pad(mo + 1)}-${pad(m[2])}`;
}

module.exports = { pdfPages, rowsOf, money, isoDate };
