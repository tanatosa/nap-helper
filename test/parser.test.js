'use strict';
// Fixtures in test/fixtures are synthetic: the real NRA form layout (tax year
// 2025) with every value replaced by made-up data.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseDeclaration, parseListingHtml } = require('../src/parser');
const { isWriteRequest } = require('../src/portal');

const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

test('declaration: metadata and tax summary', () => {
  const d = parseDeclaration(fixture('declaration.html'));
  assert.equal(d.meta.taxYear, 2025);
  assert.equal(d.meta.incomingNumber, '0000И0000001');
  assert.equal(d.meta.incomingDate, '01.03.2026');
  assert.equal(d.meta.formCode, '2001');
  assert.equal(d.meta.schema, 'http://inetdec.nra.bg/xsd/dec50_2025.xsd');
  assert.deepEqual(d.warnings, []);
  assert.equal(d.summary.taxBase, 50000);
  assert.equal(d.summary.tax, 5000);
  assert.equal(d.summary.taxWithheld, 4800);
  assert.equal(d.summary.taxDue, 200);
  assert.equal(d.summary.discount, 10);
  assert.equal(d.summary.taxDueAfterDiscount, 190);
  assert.equal(d.summary.overpaid, 0);
  assert.equal(d.summary.appendices.length, 3);
});

test('declaration: coded rows, selects and record tables', () => {
  const d = parseDeclaration(fixture('declaration.html'));
  const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f]));
  assert.equal(byKey['code:4001'].value, 50000);
  assert.equal(byKey['code:4011'].value, 190);
  assert.equal(byKey['dec50_app1_table1_rowenum[1]_code'].value, '101');
  assert.equal(new Set(d.fields.map((f) => f.key)).size, d.fields.length, 'keys are unique');
  const tables = d.sections.flatMap((s) => s.tables);
  const a8d5 = tables.find((t) => t.id === 'A8D5');
  assert.equal(a8d5.rows.length, 2);
  assert.equal(a8d5.columns.length, 11);
  const a8d1 = tables.find((t) => t.id === 'A8D1');
  assert.equal(a8d1.rows.length, 3);
  assert.equal(a8d1.rows[0].kind, 'Акции');
  // column headers spanning two header rows are joined
  assert.ok(a8d1.columns.includes('Обща цена на придобиване / В лева'));
  // an identifier (EIK) stays a string, not a number
  const eik = d.fields.find((f) => f.rowId === 'A1D1:1' && f.raw === '123456789');
  assert.equal(eik.type, 'text');
  // a label cell belongs to the value on its right
  assert.ok(d.fields.some((f) => f.label === '2. Код по т. 1' && f.type === 'select'));
});

test('declaration: unknown layout degrades to a warning instead of throwing', () => {
  const d = parseDeclaration('<html><body><div>Нещо съвсем различно</div></body></html>');
  assert.equal(d.fields.length, 0);
  assert.ok(d.warnings.length >= 1);
});

test('listing: rendered table fallback', () => {
  const rows = parseListingHtml(fixture('listing.html'));
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].TAXYEAR, rows[0].INNO, rows[0].DOCID, rows[0].EXPFILEID], ['2025', '0000И0000003', '1003', '9003']);
  assert.deepEqual([rows[0].HASATTACHMENTS, rows[0].FORMID, rows[0].DECID], [1, '1094', '77']);
  assert.equal(rows[1].STATUSTEXT, 'Коригирана');
  assert.deepEqual([rows[2].TAXYEAR, rows[2].DOCID, rows[2].HASPDF, rows[2].HASRESULT, rows[2].EXPFILEID], ['2024', '1001', 0, 0, undefined]);
});

test('read-only guard', () => {
  const u = 'https://portal.nra.bg/pls/pub/';
  assert.equal(isWriteRequest('GET', u + 'DEC2009.IPUBATDEC.viewDocument?pdoc_id=1'), false);
  assert.equal(isWriteRequest('GET', u + '!dec2009.ipubatdec.ajaxListDocuments?draw=1'), false);
  assert.equal(isWriteRequest('POST', u + '!dec2009.ipubatdec.ajaxListDocuments'), false);
  assert.equal(isWriteRequest('GET', u + 'DEC2009.IPUBATDEC.ajxGetXml'), false);
  assert.equal(isWriteRequest('POST', u + 'login.home'), false);
  assert.equal(isWriteRequest('POST', u + 'DEC2009.IPUBATDEC.submitDocument'), true);
  assert.equal(isWriteRequest('POST', u + 'dec50.saveDeclaration'), true);
  assert.equal(isWriteRequest('POST', 'https://example.com/pls/pub/dec50.saveDeclaration'), false);
});
