'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { declarationPage, draftPage } = require('../src/napview');

// synthetic data only
const parts = [
  { key: 'dec50_part3', title: 'Част III', caption: 'Приложения', status: '2', html: '<table class="form"><tr><td><input type="checkbox" name="dec50_part3_issetapp6"/></td><td><input type="checkbox" name="dec50_part3_issetapp8" checked="checked"/></td></tr></table>' },
  { key: 'dec50_app6', title: 'Приложение 6', caption: '', status: '2', html: '<table class="form"><tr id="A6D1:1"><td><input type="text" name="dec50_app6_sum603" value="1" onblur="evil()"/><select name="dec50_app6_code"><option value="">-</option><option value="603">603</option></select></td></tr></table><script>evil()</script><a href="http://x">l</a>' },
  { key: 'dec50_app8', title: 'Приложение 8', caption: '', status: '4', html: '<input type="text" name="dec50_app8_x" value="9"/>' },
];
const fields = [
  { name: 'dec50_part3_issetapp6', value: 'X' }, { name: 'dec50_part3_issetapp8', value: '' },
  { name: 'dec50_app6_sum603', value: '2354.65' }, { name: 'dec50_app6_code', value: '603' },
];

test('draft page: values go into the controls, scripts are gone, unticked parts are locked', () => {
  const html = draftPage(parts, fields, { year: 2025 });
  assert.match(html, /name="dec50_app6_sum603" value="2354.65"/);
  assert.match(html, /<option value="603" selected="selected">/);
  assert.match(html, /name="dec50_part3_issetapp6" checked="checked"/);
  assert.doesNotMatch(html, /name="dec50_part3_issetapp8"[^>]*checked/);
  assert.doesNotMatch(html, /evil|href="http/);
  assert.match(html, /<button type="button" class="status4 locked" data-go="dec50_app8"/);
  assert.match(html, /<button type="button" class="status2" data-go="dec50_app6"/);
  assert.equal((html.match(/<script>/g) || []).length, 1); // only the page's own script
});

test('draft page: &nbsp; written as CDATA text comes out as a space, not as the literal entity', () => {
  const html = draftPage([{ key: 'k', title: 'K', status: '', html: '<td>a&amp;nbsp;b</td>' }], []);
  assert.doesNotMatch(html, /&amp;nbsp;/);
  assert.match(html, /a(&nbsp;| )b/);
});

test('draft page: script that the stylesheet wrote as CDATA text is not shown', () => {
  const html = draftPage([{ key: 'k', title: 'K', status: '', html: '<p>x</p>&lt;script type="text/javascript" defer="defer"&gt; var a = 1 &amp;&amp; 2; &lt;/script&gt;<p>y</p>' }], []);
  assert.doesNotMatch(html, /var a = 1|&lt;script/);
  assert.match(html, /<p>x<\/p><p>y<\/p>/);
});

test('declaration page: made inert, content kept', () => {
  const html = declarationPage('<html><head><meta http-equiv="refresh" content="0;url=x"><style>td{color:red}</style></head><body onload="x()"><script>x()</script><table class="form"><tr><td>Входящ</td></tr></table></body></html>');
  assert.match(html, /Входящ/);
  assert.match(html, /td\{color:red\}/);
  assert.doesNotMatch(html, /onload|<script|refresh/);
  assert.match(html, /<meta charset="utf-8">/);
});

const ROW = (n) => `<tr id="A8D1:${n}"><td id="num">${n}.</td><td><select name="dec50_app8_stocks_stocksenum[${n}]_country" id="A8D1:${n}_country" blockid="A8D1:${n}"><option value=""></option></select></td><td><input type="text" name="dec50_app8_stocks_stocksenum[${n}]_count" value="5"/></td></tr>`;
const BLOCK = `<table><tr><td><button type="button" id="A8D1" onclick="removeDynamicElement(this.id);">- ред</button><button type="button" id="A8D1" onclick="addDynamicElement(this.id);">+ ред</button></td></tr>${ROW(1)}</table>`;

test('draft page: country lists are filled, rows follow the draft, row buttons are kept', () => {
  const f = (n, c) => [
    { name: `dec50_app8_stocks_stocksenum[${n}]_country`, rowId: `A8D1:${n}`, value: c },
    { name: `dec50_app8_stocks_stocksenum[${n}]_count`, rowId: `A8D1:${n}`, value: String(n) },
  ];
  const html = draftPage([{ key: 'dec50_app8', title: 'П8', status: '2', html: BLOCK }], [...f(1, 'Германия'), ...f(2, 'САЩ'), ...f(3, '')], { countries: ['България', 'Германия', 'САЩ'] });
  assert.equal((html.match(/<tr id="A8D1:\d+"/g) || []).length, 3); // rows 2 and 3 were added
  assert.match(html, /<tr id="A8D1:3"><td id="num">3\.<\/td>/);
  assert.match(html, /name="dec50_app8_stocks_stocksenum\[3\]_country" id="A8D1:3_country" blockid="A8D1:3"/);
  assert.match(html, /<option value="Германия" selected="selected">/);
  assert.doesNotMatch(html, /<option value="България"/); // property abroad: Bulgaria is not offered
  assert.match(html, /name="dec50_app8_stocks_stocksenum\[2\]_count" value="2"/);
  assert.match(html, /data-nap-add="A8D1"/);
  assert.match(html, /data-nap-remove="A8D1"/);
  assert.doesNotMatch(html, /addDynamicElement|onclick/);
});

test('draft page: rows removed from the draft are removed from the form', () => {
  const two = `<table>${ROW(1)}${ROW(2)}</table>`;
  const html = draftPage([{ key: 'k', title: 'K', status: '', html: two }], [{ name: 'dec50_app8_stocks_stocksenum[1]_count', rowId: 'A8D1:1', value: '7' }]);
  assert.equal((html.match(/<tr id="A8D1:\d+"/g) || []).length, 1);
});
