'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { partsFromMenu, inlineIncludes, renderScript } = require('../src/xslt');

test('menu: parts are read from loadPart actions (escaped quotes, query strings)', () => {
  const menu = String.raw`{'btnText':'Приложение 6', 'action':'javascript:loadPart(\'/static/isfw/xslt/2025/dec50_app6.xslt\',1305, \'dec50_app6\',this,\'DEC2009.IPUBATDEC\')'},`
    + String.raw`{'action':'javascript:loadPart(\'/static/isfw/xslt/2025/dec50_app2.xslt?v=4\',1301, \'dec50_app2\',this)'},`
    + String.raw`{'action':'javascript:loadFileAttachments(\'DEC2009.IPUBATDEC.fileAttachments?ipDP_ID=1317\')'}`;
  assert.deepEqual(partsFromMenu(menu).map(({ xslt, id, key }) => ({ xslt, id, key })), [
    { xslt: '/static/isfw/xslt/2025/dec50_app6.xslt', id: '1305', key: 'dec50_app6' },
    { xslt: '/static/isfw/xslt/2025/dec50_app2.xslt?v=4', id: '1301', key: 'dec50_app2' },
  ]);
});

test('menu: titles, captions and status markers', () => {
  const menu = String.raw`{'btnText':'<span class=\"marker status2\">&nbsp;&nbsp;</span>
Приложение 6', 'action':'javascript:loadPart(\'/static/x/dec50_app6.xslt\',1305, \'dec50_app6\',this)'
                    , 'caption':'Доходи от други източници', 'id':'part_1305'}`;
  const [p] = partsFromMenu(menu);
  assert.deepEqual([p.title, p.caption, p.status], ['Приложение 6', 'Доходи от други източници', '2']);
});

test('xslt: includes are inlined', async () => {
  const main = '<xsl:stylesheet version="1.0" xmlns:xsl="x"><xsl:include href="https://h/t.xml"/><xsl:template match="/"/></xsl:stylesheet>';
  const inc = '<?xml version="1.0"?><xsl:stylesheet version="1.0" xmlns:xsl="x"><xsl:template name="a"/></xsl:stylesheet>';
  const out = await inlineIncludes(main, async (h) => { assert.equal(h, 'https://h/t.xml'); return inc; });
  assert.equal(out, '<xsl:stylesheet version="1.0" xmlns:xsl="x"><xsl:template name="a"/><xsl:template match="/"/></xsl:stylesheet>');
});

test('xslt: the render script embeds its inputs safely', () => {
  const s = renderScript('<a>`${x}</a>', '\n<?xml version="1.0"?><dec50/>', { taxyear: '2025' });
  assert.doesNotThrow(() => new Function(s)); // valid JavaScript
  assert.match(s, /"taxyear":"2025"/);
});
