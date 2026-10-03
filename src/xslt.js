'use strict';
// The portal draws every part of a declaration by applying an XSLT stylesheet
// (/static/isfw/xslt/<year>/dec50_<part>.xslt) to the draft's XML (ajxGetXml). Applying the same
// stylesheets here gives the real form - labels, row codes, record rows and the field `name`s
// (dec50_app6_table1_rowenum[1]_value) - so the draft can be read by the ordinary declaration
// parser and its names match the live form. Electron-free: the transformation itself
// (XSLTProcessor) runs in a hidden page, see `renderScript`.

/** Parts listed in DEC2009.IPUBATDEC.leftmenu: [{ id, key, xslt }]. */
function partsFromMenu(menu) {
  const parts = [];
  const q = String.raw`(?:\\)?'`; // the menu escapes its quotes: \'
  const re = new RegExp(String.raw`loadPart\(\s*${q}([^'\\]+\.xslt[^'\\]*)${q}\s*,\s*(\d+)\s*,\s*${q}(\w+)${q}`, 'g');
  let m;
  const text = (t) => t.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim();
  while ((m = re.exec(menu))) {
    // the button text (with its status marker) stands before the action, the caption after it
    const from = menu.lastIndexOf("'btnText':'", m.index);
    const label = from < 0 ? '' : menu.slice(from + 11, menu.lastIndexOf("'", menu.indexOf("'action'", from) - 1));
    const cap = /'caption':'((?:\\.|[^'\\])*)'/.exec(menu.slice(m.index, m.index + 1500));
    parts.push({ xslt: m[1], id: m[2], key: m[3], title: text(label), caption: cap ? text(cap[1]) : '', status: (/marker status(\d+)/.exec(label) || [])[1] || '' });
  }
  return parts;
}

/** Replace <xsl:include href="..."/> by the included stylesheet's top-level content. */
async function inlineIncludes(xslt, fetchText) {
  const re = /<xsl:include\s+href="([^"]+)"\s*\/>/g;
  let out = xslt;
  for (const m of [...xslt.matchAll(re)]) {
    const inc = await fetchText(m[1]);
    const inner = inc.replace(/^[\s\S]*?<xsl:stylesheet[^>]*>/, '').replace(/<\/xsl:stylesheet>\s*$/, '');
    out = out.replace(m[0], () => inner);
  }
  return out;
}

/** JavaScript for a hidden page (no Node): applies `xslt` to `xml` and returns the HTML, or throws. */
function renderScript(xslt, xml, params) {
  return `(() => {
    const p = new DOMParser();
    const x = p.parseFromString(${JSON.stringify(xslt)}, 'application/xml');
    if (x.querySelector('parsererror')) throw new Error('XSLT: ' + x.querySelector('parsererror').textContent.slice(0, 200));
    const d = p.parseFromString(${JSON.stringify(xml.replace(/^[\s\S]*?(?=<\w)/, '').replace(/^<\?xml[^>]*\?>/, ''))}, 'application/xml');
    if (d.querySelector('parsererror')) throw new Error('XML: ' + d.querySelector('parsererror').textContent.slice(0, 200));
    const pr = new XSLTProcessor();
    pr.importStylesheet(x);
    for (const [k, v] of Object.entries(${JSON.stringify(params)})) pr.setParameter(null, k, v);
    const div = document.createElement('div');
    div.appendChild(pr.transformToFragment(d, document));
    return div.innerHTML;
  })()`;
}

/**
 * The stylesheets write `<![CDATA[&nbsp;]]>`, which the portal's own page lets through as markup; here it
 * comes out of the serializer as the text "&amp;nbsp;". Turn those back into the entities they stand for.
 */
const fixEntities = (html) => html
  // markup the stylesheets put in CDATA also arrives as escaped text: scripts are dropped, simple formatting tags restored
  .replace(/&lt;(script|style)\b[\s\S]*?&lt;\/\1&gt;/gi, '')
  .replace(/&lt;(\/?(?:br|b|i|u|sup|sub|small|strong|em)\s*\/?)&gt;/gi, '<$1>')
  .replace(/&amp;(nbsp|ndash|mdash|laquo|raquo|quot|#\d+|#x[0-9a-f]+);/gi, '&$1;');

module.exports = { fixEntities, partsFromMenu, inlineIncludes, renderScript };
