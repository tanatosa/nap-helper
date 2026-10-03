'use strict';
// The draft that the portal keeps for the logged-in user (GET DEC2009.IPUBATDEC.ajxGetXml) is a
// dec50 XML document: one element per part/application, leaves hold the values. This turns it into
// the app's draft shape (flat `fields`). Repeated elements (rows of a table) get a `rowId` like
// `app8.stocks:3`, so the drafts tab shows them as tables. Unknown layouts never throw.

const cheerio = require('cheerio');

const SECTIONS = {
  part1: 'Данни за декларатора', part3: 'Част III', part4: 'Част IV', part5: 'Част V',
  noi: 'Образец 2004', noiold: 'Образци 2004 за минали години',
  app2005: 'Образец 2005', app2006: 'Образец 2006',
};
const sectionName = (tag) => SECTIONS[tag] || (/^app(\d+)$/.exec(tag) ? `Приложение № ${/^app(\d+)$/.exec(tag)[1]}` : tag);

/**
 * The declaration says WINDOWS-1251 but the portal actually sends UTF-8 (read as 1251 it gives
 * "РќРРљРћР›РђР™"), so valid UTF-8 wins and the declared encoding is only the fallback.
 */
function decodeXml(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* not UTF-8 */ }
  const enc = (/^<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(buf.subarray(0, 200).toString('latin1')) || [])[1];
  try { return new TextDecoder(enc || 'windows-1251').decode(buf); } catch { return buf.toString('latin1'); }
}

function parseDraftXml(xml) {
  const start = xml.indexOf('<?xml') >= 0 ? xml.indexOf('<?xml') : xml.indexOf('<dec50');
  const $ = cheerio.load(start > 0 ? xml.slice(start) : xml, { xmlMode: true });
  const root = $.root().children().get(0);
  const warnings = [];
  if (!root || !/^dec\d+/.test(root.name)) throw new Error('Отговорът на портала не е XML на декларация.');
  const fields = [];
  const kids = (el) => (el.children || []).filter((c) => c.type === 'tag');
  const text = (el) => $(el).text().trim();

  const walk = (el, section, trail, rowId, rowNo) => {
    const children = kids(el);
    const seen = {};
    for (const c of children) {
      const same = children.filter((x) => x.name === c.name).length;
      const n = (seen[c.name] = (seen[c.name] || 0) + 1);
      const here = [...trail, c.name];
      if (c.name === 'partstatus') continue;
      if (kids(c).length) {
        // several siblings of the same name (rowenum, stocksenum...) are rows of a table
        if (same > 1) walk(c, section, here, `${trail.join('.')}:${n}`, String(n));
        else walk(c, section, here, rowId, rowNo);
        continue;
      }
      const value = text(c);
      const code = (/^(?:index|sum)(\d+)$/.exec(c.name) || [])[1] || '';
      fields.push({
        key: `${here.join('/')}${rowId ? `[${rowNo}]` : ''}`, section, part: '', group: trail.slice(1).join(' / '),
        rowId: rowId || undefined, rowNo: rowNo || undefined, code, name: here.join('/'),
        label: c.name, column: c.name, type: /^-?\d+(\.\d+)?$|^-?\.\d+$/.test(value) ? 'number' : 'text',
        previous: '', value,
      });
    }
  };
  for (const part of kids(root)) {
    const section = sectionName(part.name);
    if (kids(part).length) walk(part, section, [part.name], null, null);
  }
  const year = Number(text($('part1 > taxyear').get(0) || '')) || null;
  if (!year) warnings.push('В XML-а няма данъчна година.');
  if (!fields.length) warnings.push('XML-ът не съдържа попълнени полета.');
  return { taxYear: year, schema: root.name, fields, warnings };
}

/**
 * The portal fills its country lists with a script, so the drawn form has empty country selects and the
 * chosen country is lost. Field names follow the XML path (dec50_app8_stocks_stocksenum[2]_country =
 * app8/stocks/stocksenum[2]/country), so the value is taken from the XML and put in as a selected option.
 */
function fillCountriesFromXml(html, xml) {
  const $x = cheerio.load(xml.slice(Math.max(0, xml.indexOf('<dec'))), { xmlMode: true });
  const root = $x.root().children().get(0);
  const valueOf = (name) => {
    let el = root;
    for (const tok of name.split('_').slice(1)) {
      const m = /^([^[]+)(?:\[(\d+)\])?$/.exec(tok);
      if (!m || !el) return '';
      el = (el.children || []).filter((c) => c.type === 'tag' && c.name === m[1])[Number(m[2] || 1) - 1];
    }
    return el ? $x(el).text().trim() : '';
  };
  const $ = cheerio.load(`<body>${html}</body>`);
  $('select[name]').each((_, sel) => {
    if (!/country/i.test(sel.attribs.name) || $(sel).find('option').length > 1) return;
    const v = valueOf(sel.attribs.name);
    if (v) $(sel).append($('<option selected="selected"></option>').attr('value', v).text(v));
  });
  return $('body').html();
}

module.exports = { parseDraftXml, decodeXml, fillCountriesFromXml };
