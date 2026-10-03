'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDraftXml, decodeXml } = require('../src/portaldraft');

// synthetic data only
const XML = `<?xml version="1.0" encoding="WINDOWS-1251"?>
<dec50 xmlns="http://inetdec.nra.bg/xsd/dec50_2025.xsd">
  <app6><partstatus>2</partstatus><sum603>100.50</sum603></app6>
  <app8><stocks>
    <stocksenum><country>Германия</country><count>.78</count><acquiredate>2021-03-02</acquiredate></stocksenum>
    <stocksenum><country>САЩ</country><count>5</count><acquiredate>2022-01-01</acquiredate></stocksenum>
  </stocks></app8>
  <part1><taxyear>2025</taxyear><decegn/></part1>
</dec50>`;

test('portal draft XML: sections, codes, table rows', () => {
  const d = parseDraftXml(XML);
  assert.equal(d.taxYear, 2025);
  const f = (k) => d.fields.find((x) => x.key === k);
  assert.equal(f('app6/sum603').value, '100.50');
  assert.equal(f('app6/sum603').code, '603');
  assert.equal(f('app6/sum603').section, 'Приложение № 6');
  assert.equal(d.fields.some((x) => x.label === 'partstatus'), false);
  const rows = d.fields.filter((x) => x.label === 'country');
  assert.deepEqual(rows.map((x) => [x.rowId, x.value]), [['app8.stocks:1', 'Германия'], ['app8.stocks:2', 'САЩ']]);
  assert.equal(f('app8/stocks/stocksenum/count[1]').type, 'number');
});

test('portal draft XML: not a declaration', () => {
  assert.throws(() => parseDraftXml('<html></html>'));
});

test('portal draft XML: UTF-8 body despite the windows-1251 declaration', () => {
  const buf = Buffer.from('<?xml version="1.0" encoding="WINDOWS-1251"?><a>НИКОЛАЙ</a>', 'utf8');
  assert.match(decodeXml(buf), /НИКОЛАЙ/);
});

test('portal draft XML: real windows-1251 body', () => {
  const buf = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="WINDOWS-1251"?><a>'), Buffer.from([0xC0]), Buffer.from('</a>')]);
  assert.match(decodeXml(buf), /А<\/a>/);
});

test('portal draft XML: the chosen country goes into the empty country select', () => {
  const { fillCountriesFromXml } = require('../src/portaldraft');
  const xml = '<dec50><app8><stocks><stocksenum><country>Германия</country></stocksenum><stocksenum><country>САЩ</country></stocksenum></stocks></app8></dec50>';
  const html = '<select name="dec50_app8_stocks_stocksenum[2]_country"><option value=""></option></select><select name="dec50_app8_stocks_stocksenum[1]_country"><option value=""></option></select>';
  const out = fillCountriesFromXml(html, xml);
  assert.match(out, /stocksenum\[2\]_country"><option value=""><\/option><option selected="selected" value="САЩ">САЩ/);
  assert.match(out, /stocksenum\[1\]_country"><option value=""><\/option><option selected="selected" value="Германия">/);
});
